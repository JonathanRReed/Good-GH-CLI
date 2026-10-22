import { createHash } from "node:crypto";
import { join } from "node:path";
import { readCacheValue, writeCacheValue } from "../cache.ts";
import { getConfigDir } from "../config.ts";
import { getActiveHost, getGitHubAuthStatus, ghGlobal } from "../github/client.ts";
import { acquireProcessLock } from "../process-lock.ts";
import { privateProjectDirectory } from "./index-store.ts";
import type { IndexedClone, RemoteRepoId } from "./types.ts";
import type { RemoteField, RemoteFieldName, RemoteFields, RemoteRepository, RemoteResult, UnclonedRepository, UnclonedResult } from "./remote-types.ts";

const ALL_FIELDS: RemoteFieldName[] = ["defaultBranch", "archived", "fork", "permission", "authored", "reviewRequested", "defaultCi"];
const TTL = 5 * 60_000;
const RESERVE = 500;
const RATE_FIELDS = "rateLimit { remaining resetAt cost }";
interface Budget { remaining: number; resetAt: string; cost: number; retryAt?: string }
interface GraphError { message: string; path: (string | number)[] }
interface Response { data: Record<string, unknown>; errors: GraphError[]; budget: Budget | null; retryAt?: string; failed: boolean }
export interface RemoteOptions {
  refresh?: boolean;
  uncloned?: boolean;
  fields?: RemoteFieldName[];
  ttlMs?: number;
  reserve?: number;
  timeoutMs?: number;
  maxBatches?: number;
  maxUnclonedPages?: number;
  localClones?: IndexedClone[];
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected remote object");
  return Object.fromEntries(Object.entries(value));
}
function string(value: unknown): string { if (typeof value !== "string") throw new Error("Expected remote string"); return value; }
function nullableString(value: unknown): string | null { return value === null ? null : string(value); }
function count(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid remote count"); return value; }
function boolean(value: unknown): boolean { if (typeof value !== "boolean") throw new Error("Expected remote boolean"); return value; }
function array<T>(value: unknown, parse: (item: unknown) => T): T[] { if (!Array.isArray(value)) throw new Error("Expected remote array"); return value.map(parse); }
function timestamp(value: unknown): string { const text = string(value); if (!Number.isFinite(Date.parse(text))) throw new Error("Invalid remote timestamp"); return text; }
function budget(value: unknown): Budget {
  const row = object(value);
  return { remaining: count(row.remaining), resetAt: timestamp(row.resetAt), cost: count(row.cost), ...(row.retryAt ? { retryAt: timestamp(row.retryAt) } : {}) };
}
export function remoteRepoKey(repo: RemoteRepoId): string { return `${repo.host}/${repo.owner}/${repo.name}`.toLowerCase(); }
export function cloneRemoteIds(clone: IndexedClone): RemoteRepoId[] {
  return [...new Map([...(clone.primary ? [clone.primary] : []), ...clone.remotes.flatMap(remote => remote.repo ? [remote.repo] : [])].map(repo => [remoteRepoKey(repo), repo])).values()];
}
function unavailable(reason: string, retryAt?: string): RemoteField<never> { return { state: "unavailable", reason, ...(retryAt ? { retryAt } : {}) }; }
function empty(repo: RemoteRepoId, login: string | null, fields: RemoteFieldName[], reason: string, retryAt?: string): RemoteRepository {
  return Object.assign({ repo, login }, Object.fromEntries(fields.map(field => [field, unavailable(reason, retryAt)])));
}
function parseValue<K extends RemoteFieldName>(key: K, value: unknown): RemoteFields[K];
function parseValue(key: RemoteFieldName, value: unknown): RemoteFields[RemoteFieldName] {
  switch (key) {
    case "archived": return boolean(value);
    case "permission": case "defaultCi": return nullableString(value);
    case "reviewRequested": return count(value);
    case "defaultBranch": { if (value === null) return null; const row = object(value); return { name: string(row.name), oid: string(row.oid) }; }
    case "fork": { const row = object(value); return { isFork: boolean(row.isFork), parent: nullableString(row.parent) }; }
    case "authored": {
      const row = object(value);
      return { count: count(row.count), pullRequests: array(row.pullRequests, value => {
        const pr = object(value);
        return { number: count(pr.number), title: string(pr.title), headRefName: string(pr.headRefName), statusCheckRollup: nullableString(pr.statusCheckRollup), reviewDecision: nullableString(pr.reviewDecision) };
      }).slice(0, 3) };
    }
  }
}
function readField<T>(value: unknown, parse: (value: unknown) => T): RemoteField<T> {
  const row = object(value);
  if (row.state === "ok") return { state: "ok", value: parse(row.value), observedAt: timestamp(row.observedAt) };
  if (row.state === "unavailable") return unavailable(string(row.reason), row.retryAt ? timestamp(row.retryAt) : undefined);
  if (row.state === "unknown") return { state: "unknown", reason: string(row.reason) };
  if (row.state === "error") return { state: "error", message: string(row.message) };
  throw new Error("Invalid remote field");
}
function cachedRepository(value: unknown): RemoteRepository {
  const row = object(value); const repo = object(row.repo);
  const result: RemoteRepository = { repo: { host: string(repo.host), owner: string(repo.owner), name: string(repo.name) }, login: nullableString(row.login) };
  for (const key of ALL_FIELDS) if (row[key] !== undefined) Object.assign(result, { [key]: readField(row[key], value => parseValue(key, value)) });
  return result;
}
function unclonedRepo(value: unknown): UnclonedRepository { const row = object(value); return { nameWithOwner: string(row.nameWithOwner), pushedAt: row.pushedAt === null ? null : timestamp(row.pushedAt) }; }
function cachedUncloned(value: unknown): UnclonedResult {
  const row = object(value);
  return { host: string(row.host), login: nullableString(row.login), count: readField(row.count, count), repositories: readField(row.repositories, value => array(value, unclonedRepo)), scanned: count(row.scanned), complete: boolean(row.complete) };
}

export function remoteBatchQuery(repos: RemoteRepoId[], login: string, fields: RemoteFieldName[]): string {
  const selected = new Set(fields);
  const parts = repos.flatMap((repo, index) => {
    const metadata: string[] = [];
    if (selected.has("defaultBranch") || selected.has("defaultCi")) metadata.push(`defaultBranchRef { ${selected.has("defaultBranch") ? "name" : ""} target { ... on Commit { ${selected.has("defaultBranch") ? "oid" : ""} ${selected.has("defaultCi") ? "statusCheckRollup { state }" : ""} } } }`);
    if (selected.has("archived")) metadata.push("isArchived");
    if (selected.has("fork")) metadata.push("isFork parent { nameWithOwner }");
    if (selected.has("permission")) metadata.push("viewerPermission");
    const aliases = metadata.length ? [`r${index}: repository(owner: ${JSON.stringify(repo.owner)}, name: ${JSON.stringify(repo.name)}) { ${metadata.join(" ")} }`] : [];
    const scope = `repo:${repo.owner}/${repo.name} is:pr is:open`;
    if (selected.has("authored")) aliases.push(`p${index}: search(type: ISSUE, query: ${JSON.stringify(`${scope} author:${login} sort:updated-desc`)}, first: 3) { issueCount nodes { ... on PullRequest { number title headRefName reviewDecision commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } }`);
    if (selected.has("reviewRequested")) aliases.push(`v${index}: search(type: ISSUE, query: ${JSON.stringify(`${scope} review-requested:${login}`)}, first: 1) { issueCount }`);
    return aliases;
  });
  return `query { ${parts.join("\n")} ${RATE_FIELDS} }`;
}
function retryTime(headers: Map<string, string>): string | undefined {
  const retry = headers.get("retry-after");
  if (retry) { const date = /^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry); if (Number.isFinite(date)) return new Date(date).toISOString(); }
  if (headers.get("x-ratelimit-remaining") === "0") { const date = Number(headers.get("x-ratelimit-reset")) * 1000; if (Number.isFinite(date) && date > Date.now()) return new Date(date).toISOString(); }
  return undefined;
}
async function graphql(host: string, query: string, timeoutMs: number): Promise<Response> {
  // --include preserves retry/reset headers even when gh exits nonzero for GraphQL partial errors.
  const result = await ghGlobal(["api", "graphql", "--hostname", host, "--include", "--input", "-"], { input: JSON.stringify({ query }), reject: false, timeoutMs });
  const start = result.stdout.indexOf("{");
  const headers = new Map(result.stdout.slice(0, start).split(/\r?\n/).flatMap(line => { const split = line.indexOf(":"); return split < 0 ? [] : [[line.slice(0, split).toLowerCase(), line.slice(split + 1).trim()]]; }));
  let row: Record<string, unknown>;
  try { row = object(JSON.parse(result.stdout.slice(start))); }
  catch { throw new Error(result.stderr.trim().slice(0, 200) || "GitHub returned invalid JSON"); }
  const data = row.data ? object(row.data) : {};
  let rate: Budget | null = null;
  try { rate = budget(data.rateLimit); } catch { /* Missing budget stops further batches. */ }
  const errors = row.errors ? array(row.errors, value => {
    const error = object(value);
    return { message: string(error.message), path: error.path ? array(error.path, value => typeof value === "number" ? value : string(value)) : [] };
  }) : [];
  const retryAt = retryTime(headers);
  const limited = errors.some(error => /rate limit|secondary limit/i.test(error.message)) || /rate limit|secondary limit|HTTP (403|429)/i.test(result.stderr);
  return { data, errors, budget: rate, retryAt: retryAt ?? (limited ? new Date(Date.now() + 60_000).toISOString() : undefined), failed: result.exitCode !== 0 || !row.data };
}
function fieldError(response: Response, alias: string, path?: string): string | undefined {
  return response.errors.find(error => !error.path.length || error.path[0] === alias && (!path || error.path.length === 1 || error.path[1] === path))?.message;
}
function parseRepository(repo: RemoteRepoId, login: string, index: number, fields: RemoteFieldName[], response: Response): RemoteRepository {
  const result: RemoteRepository = { repo, login };
  const at = new Date().toISOString();
  for (const key of fields) {
    const alias = `${key === "authored" ? "p" : key === "reviewRequested" ? "v" : "r"}${index}`;
    const path = { defaultBranch: "defaultBranchRef", archived: "isArchived", fork: "isFork", permission: "viewerPermission", authored: "nodes", reviewRequested: "issueCount", defaultCi: "defaultBranchRef" }[key];
    try {
      const metadataAlias = `r${index}`;
      const inaccessible = response.data[metadataAlias] === null ? fieldError(response, metadataAlias) ?? "Repository not found or inaccessible" : undefined;
      const relevantErrors = key === "defaultBranch" ? { ...response, errors: response.errors.filter(error => !(error.path[0] === alias && error.path.includes("statusCheckRollup"))) } : key === "defaultCi" ? { ...response, errors: response.errors.filter(error => !(error.path[0] === alias && error.path[2] === "name")) } : response;
      const error = inaccessible ?? fieldError(relevantErrors, alias, path) ?? (key === "fork" ? fieldError(response, alias, "parent") : undefined);
      if (error) throw new Error(error);
      if (!response.data[alias]) throw new Error("Repository not found, inaccessible, or field unavailable");
      const row = object(response.data[alias]);
      let value: unknown;
      switch (key) {
        case "defaultBranch": value = row.defaultBranchRef === null ? null : { name: object(row.defaultBranchRef).name, oid: object(object(row.defaultBranchRef).target).oid }; break;
        case "defaultCi": { const ref = row.defaultBranchRef; const target = ref === null ? null : object(ref).target; const rollup = target === null ? null : object(target).statusCheckRollup; value = rollup === null ? null : object(rollup).state; break; }
        case "archived": value = row.isArchived; break;
        case "fork": value = { isFork: row.isFork, parent: row.parent === null ? null : object(row.parent).nameWithOwner }; break;
        case "permission": value = row.viewerPermission; break;
        case "reviewRequested": value = row.issueCount; break;
        case "authored": value = { count: row.issueCount, pullRequests: array(row.nodes, value => {
          const pr = object(value); const commits = array(object(pr.commits).nodes, object); const rollup = commits[0] ? object(commits[0].commit).statusCheckRollup : null;
          return { number: pr.number, title: pr.title, headRefName: pr.headRefName, reviewDecision: pr.reviewDecision, statusCheckRollup: rollup === null ? null : object(rollup).state };
        }) }; break;
      }
      Object.assign(result, { [key]: { state: "ok", value: parseValue(key, value), observedAt: at } });
    } catch (error) { Object.assign(result, { [key]: unavailable(error instanceof Error ? error.message : String(error), response.retryAt) }); }
  }
  return result;
}

export async function readProjectRemotes(clones: IndexedClone[], options: RemoteOptions = {}): Promise<RemoteResult> {
  const fields = [...new Set(options.fields ?? ALL_FIELDS)].sort();
  const repos = [...new Map(clones.flatMap(cloneRemoteIds).map(repo => [remoteRepoKey(repo), repo])).values()].sort((a, b) => remoteRepoKey(a).localeCompare(remoteRepoKey(b)));
  const localRepos = (options.localClones ?? clones).flatMap(cloneRemoteIds);
  const hosts = [...new Set([...repos.map(repo => repo.host.toLowerCase()), ...(options.uncloned ? [getActiveHost().toLowerCase()] : [])])];
  const output: RemoteResult = { repositories: [], uncloned: [], requests: 0, cost: 0 };
  for (const host of hosts) {
    const requested = repos.filter(repo => repo.host.toLowerCase() === host);
    let login: string | null = null;
    try {
      const auth = await getGitHubAuthStatus(host, true);
      if (!auth.authenticated || !auth.login || auth.host?.toLowerCase() !== host) throw new Error("GitHub authentication unavailable");
      const authenticatedLogin = auth.login;
      login = authenticatedLogin;
      const principal = JSON.stringify([host, login.toLowerCase()]);
      const cacheKey = `projects-remote:v1:${JSON.stringify([principal, requested.map(remoteRepoKey), fields, options.uncloned ? localRepos.map(remoteRepoKey).sort() : null])}`;
      const cacheAllowed = !["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"].some(key => process.env[key]);
      const configDir = getConfigDir(); privateProjectDirectory(configDir, true);
      const release = await acquireProcessLock(join(configDir, `projects-remote-${createHash("sha256").update(host).digest("hex")}.lock`));
      try {
        const hit = options.refresh || !cacheAllowed ? null : readCacheValue(cacheKey, options.ttlMs ?? TTL);
        if (hit) {
          try { const row = object(hit); const cached = array(row.repositories, cachedRepository); const uncloned = array(row.uncloned, cachedUncloned); output.repositories.push(...cached); output.uncloned.push(...uncloned); continue; }
          catch { /* Invalid cache values are fetched again. */ }
        }
        const budgetKey = `projects-remote-budget:v1:${principal}`;
        let rate: Budget | null = null;
        try { const saved = readCacheValue(budgetKey, 24 * 3600_000); if (saved) rate = budget(saved); } catch { /* Invalid budget is re-read from GitHub. */ }
        let stopped: string | undefined;
        let batches = 0;
        const hostResult: RemoteResult = { repositories: [], uncloned: [], requests: 0, cost: 0 };
        const request = async (query: string): Promise<Response | null> => {
          const now = Date.now();
          if (rate?.retryAt && Date.parse(rate.retryAt) > now) stopped = "GitHub retry delay";
          else if (rate && Date.parse(rate.resetAt) > now && rate.remaining < (options.reserve ?? RESERVE)) stopped = "Foreground rate-limit reserve";
          if (batches >= (options.maxBatches ?? 40)) stopped = "Request batch cap reached";
          if (stopped) return null;
          batches++; output.requests++;
          try {
            const response = await graphql(host, query, options.timeoutMs ?? 10_000);
            rate = response.budget;
            if (rate) { output.cost += rate.cost; if (response.retryAt) rate.retryAt = response.retryAt; writeCacheValue(budgetKey, rate); }
            else { stopped = "Rate-limit budget unavailable"; if (response.retryAt) { rate = { remaining: 0, cost: 0, resetAt: response.retryAt, retryAt: response.retryAt }; writeCacheValue(budgetKey, rate); } }
            if (response.retryAt) stopped = "GitHub retry delay";
            if (response.failed && !Object.keys(response.data).length) stopped ??= response.errors[0]?.message ?? "GitHub request failed";
            return response;
          } catch (error) { stopped = error instanceof Error ? error.message : String(error); return null; }
        };
        for (let offset = 0; offset < requested.length; offset += 25) {
          const batch = requested.slice(offset, offset + 25);
          const response = await request(remoteBatchQuery(batch, login, fields));
          hostResult.repositories.push(...batch.map((repo, index) => response ? parseRepository(repo, authenticatedLogin, index, fields, response) : empty(repo, login, fields, stopped ?? "Remote unavailable", rate?.retryAt ?? rate?.resetAt)));
        }
        if (options.uncloned) {
          const found: UnclonedRepository[] = []; let scanned = 0; let complete = false; let cursor: string | null = null;
          for (let page = 0; page < (options.maxUnclonedPages ?? 10); page++) {
            const response = await request(`query { viewer { repositories(first: 100, ownerAffiliations: [OWNER], orderBy: {field: PUSHED_AT, direction: DESC}${cursor ? `, after: ${JSON.stringify(cursor)}` : ""}) { nodes { nameWithOwner pushedAt } pageInfo { hasNextPage endCursor } } } ${RATE_FIELDS} }`);
            if (!response) break;
            try {
              if (fieldError(response, "viewer")) throw new Error(fieldError(response, "viewer"));
              const connection = object(object(response.data.viewer).repositories);
              const nodes = array(connection.nodes, unclonedRepo); scanned += nodes.length;
              found.push(...nodes.filter(repo => !localRepos.some(local => remoteRepoKey(local) === `${host}/${repo.nameWithOwner}`.toLowerCase())));
              const info = object(connection.pageInfo);
              if (!boolean(info.hasNextPage)) { complete = true; break; }
              cursor = string(info.endCursor); if (!cursor) throw new Error("Missing pagination cursor");
            } catch (error) { stopped = error instanceof Error ? error.message : String(error); break; }
          }
          const at = new Date().toISOString(); const reason = stopped ?? "Uncloned repository page cap reached";
          hostResult.uncloned.push({ host, login, scanned, complete, count: complete ? { state: "ok", value: found.length, observedAt: at } : unavailable(reason, rate?.retryAt ?? rate?.resetAt), repositories: scanned || complete ? { state: "ok", value: found.sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? "")).slice(0, 10), observedAt: at } : unavailable(reason) });
        }
        output.repositories.push(...hostResult.repositories); output.uncloned.push(...hostResult.uncloned);
        if (cacheAllowed) writeCacheValue(cacheKey, hostResult);
      } finally { await release(); }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      output.repositories.push(...requested.map(repo => empty(repo, login, fields, reason)));
      if (options.uncloned) output.uncloned.push({ host, login, count: unavailable(reason), repositories: unavailable(reason), scanned: 0, complete: false });
    }
  }
  return output;
}
