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
  deadlineMs?: number;
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
function retryable(reason: string): boolean { return /timed? out|timeout|50[24]|something went wrong|resource limit|respond to your request in time/i.test(reason); }
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

function remoteSearch(repos: RemoteRepoId[], login: string, field: "authored" | "reviewRequested", cursor?: string): string {
  const scope = repos.map(repo => `repo:${repo.owner}/${repo.name}`).join(" ");
  const filter = field === "authored" ? `author:${login} sort:updated-desc` : `review-requested:${login}`;
  const details = field === "authored" ? "id number title headRefName" : "";
  return `${field}: search(type: ISSUE, query: ${JSON.stringify(`is:pr is:open ${filter} ${scope}`)}, first: 100${cursor ? `, after: ${JSON.stringify(cursor)}` : ""}) { issueCount pageInfo { hasNextPage endCursor } nodes { ... on PullRequest { repository { nameWithOwner } ${details} } } }`;
}
export function remoteBatchQuery(repos: RemoteRepoId[], login: string, fields: RemoteFieldName[]): string {
  const selected = new Set(fields);
  const parts = repos.flatMap((repo, index) => {
    const metadata: string[] = [];
    if (selected.has("defaultBranch") || selected.has("defaultCi")) metadata.push(`defaultBranchRef { ${selected.has("defaultBranch") ? "name" : ""} target { ... on Commit { ${selected.has("defaultBranch") ? "oid" : ""} ${selected.has("defaultCi") ? "statusCheckRollup { state }" : ""} } } }`);
    if (selected.has("archived")) metadata.push("isArchived");
    if (selected.has("fork")) metadata.push("isFork parent { nameWithOwner }");
    if (selected.has("permission")) metadata.push("viewerPermission");
    return metadata.length ? [`r${index}: repository(owner: ${JSON.stringify(repo.owner)}, name: ${JSON.stringify(repo.name)}) { ${metadata.join(" ")} }`] : [];
  });
  for (const field of ["authored", "reviewRequested"] as const) if (selected.has(field)) parts.push(remoteSearch(repos, login, field));
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
  const status = /^HTTP\/\S+ (\d+)/m.exec(result.stdout)?.[1];
  let row: Record<string, unknown>;
  try { row = object(JSON.parse(result.stdout.slice(start))); }
  catch {
    const retryAt = retryTime(headers);
    if (retryAt) return { data: {}, errors: [{ message: "GitHub retry delay", path: [] }], budget: null, retryAt, failed: true };
    throw new Error(`${status ? `HTTP ${status}: ` : ""}${result.stderr.trim().slice(0, 200) || "GitHub returned invalid JSON"}`);
  }
  if (status === "502" || status === "504") throw new Error(`HTTP ${status}: ${typeof row.message === "string" ? row.message : "GitHub request failed"}`);
  if (!row.data && !row.errors) row.errors = [{ message: typeof row.message === "string" ? row.message : result.stderr.trim().slice(0, 200) || "GitHub request failed" }];
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
  const deadline = performance.now() + (options.deadlineMs ?? 20_000);
  const fields = [...new Set(options.fields ?? ALL_FIELDS)].sort();
  const repos = [...new Map(clones.flatMap(cloneRemoteIds).map(repo => [remoteRepoKey(repo), repo])).values()].sort((a, b) => remoteRepoKey(a).localeCompare(remoteRepoKey(b)));
  const localRepos = (options.localClones ?? clones).flatMap(cloneRemoteIds);
  const hosts = [...new Set([...repos.map(repo => repo.host.toLowerCase()), ...(options.uncloned ? [getActiveHost().toLowerCase()] : [])])];
  const output: RemoteResult = { repositories: [], uncloned: [], requests: 0, cost: 0 };
  for (const host of hosts) {
    const requested = repos.filter(repo => repo.host.toLowerCase() === host);
    let login: string | null = null;
    try {
      if (performance.now() >= deadline) throw new Error("deadline");
      const auth = await getGitHubAuthStatus(host, true, Math.max(1, deadline - performance.now()));
      if (!auth.authenticated || !auth.login || auth.host?.toLowerCase() !== host) throw new Error("GitHub authentication unavailable");
      const authenticatedLogin = auth.login;
      login = authenticatedLogin;
      const principal = JSON.stringify([host, login.toLowerCase()]);
      const repoCacheKey = (repo: RemoteRepoId) => `projects-remote-repo:v2:${JSON.stringify([host, authenticatedLogin.toLowerCase(), remoteRepoKey(repo)])}`;
      const unclonedCacheKey = `projects-remote-uncloned:v2:${JSON.stringify([principal, localRepos.map(remoteRepoKey).sort()])}`;
      const cacheAllowed = !["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"].some(key => process.env[key]);
      const configDir = getConfigDir(); privateProjectDirectory(configDir, true);
      const release = await acquireProcessLock(join(configDir, `projects-remote-${createHash("sha256").update(host).digest("hex")}.lock`), Math.max(0, deadline - performance.now()));
      try {
        const cachedRepos = new Map<string, RemoteRepository>();
        const pending: RemoteRepoId[] = [];
        for (const repo of requested) {
          if (!options.refresh && cacheAllowed) {
            try {
              const hit = readCacheValue(repoCacheKey(repo), options.ttlMs ?? TTL);
              if (hit) {
                const saved = cachedRepository(hit);
                if (remoteRepoKey(saved.repo) === remoteRepoKey(repo) && saved.login?.toLowerCase() === authenticatedLogin.toLowerCase()) {
                  for (const key of ALL_FIELDS) {
                    const field = saved[key];
                    if (field?.state !== "ok" || Date.now() - Date.parse(field.observedAt) < 0 || Date.now() - Date.parse(field.observedAt) >= (options.ttlMs ?? TTL)) delete saved[key];
                  }
                  cachedRepos.set(remoteRepoKey(repo), saved);
                }
              }
            } catch { /* Invalid entries are fetched again. */ }
          }
          const saved = cachedRepos.get(remoteRepoKey(repo));
          if (!saved || fields.some(key => saved[key]?.state !== "ok")) pending.push(repo);
        }
        const budgetKey = `projects-remote-budget:v1:${principal}`;
        let rate: Budget | null = null;
        try { const saved = readCacheValue(budgetKey, 24 * 3600_000); if (saved) rate = budget(saved); } catch { /* Invalid budget is re-read from GitHub. */ }
        let stopped: string | undefined;
        let batches = 0;
        const hostResult: Pick<RemoteResult, "repositories" | "uncloned"> = { repositories: [], uncloned: [] };
        const request = async (query: string, size = 1, estimatedCost = 1): Promise<Response> => {
          const now = Date.now();
          if (performance.now() >= deadline) stopped = "deadline";
          else if (rate?.retryAt && Date.parse(rate.retryAt) > now) stopped = "GitHub retry delay";
          else if (rate && Date.parse(rate.resetAt) > now && rate.remaining - estimatedCost < (options.reserve ?? RESERVE)) stopped = "Foreground rate-limit reserve";
          if (!stopped && batches >= (options.maxBatches ?? 200)) stopped = "Request batch cap reached";
          if (stopped) throw new Error(stopped);
          batches++; output.requests++;
          if (rate && Date.parse(rate.resetAt) > now) {
            rate = { ...rate, remaining: Math.max(0, rate.remaining - estimatedCost) };
            writeCacheValue(budgetKey, rate);
          }
          try {
            const response = await graphql(host, query, Math.max(1, Math.min(options.timeoutMs ?? 2500 + Math.min(size, 10) * 350, deadline - performance.now())));
            if (response.budget) {
              rate = response.budget; output.cost += rate.cost;
              if (response.retryAt) rate.retryAt = response.retryAt;
              writeCacheValue(budgetKey, rate);
            } else if (response.retryAt) {
              rate = { remaining: 0, cost: 0, resetAt: response.retryAt, retryAt: response.retryAt };
              writeCacheValue(budgetKey, rate);
            }
            if (response.retryAt) stopped = "GitHub retry delay";
            const reason = response.errors.find(error => retryable(error.message))?.message;
            if (!stopped && reason && retryable(reason)) throw new Error(reason);
            if (!response.budget) stopped ??= "Rate-limit budget unavailable";
            return response;
          } catch (error) {
            if (performance.now() >= deadline) stopped = "deadline";
            throw new Error(stopped ?? (error instanceof Error ? error.message : String(error)), { cause: error });
          }
        };
        const expandSearches = async (response: Response, batch: RemoteRepoId[], needed: RemoteFieldName[]): Promise<void> => {
          for (const field of ["authored", "reviewRequested"] as const) {
            if (!needed.includes(field)) continue;
            const alias = field === "authored" ? "p" : "v";
            try {
              const nodes: Record<string, unknown>[] = [];
              let pageResponse = response;
              let complete = false;
              let expected: number | undefined;
              for (let page = 0; page < 10; page++) {
                const error = fieldError(pageResponse, field);
                if (error) throw new Error(error);
                const connection = object(pageResponse.data[field]);
                expected ??= count(connection.issueCount);
                nodes.push(...array(connection.nodes, object));
                const info = object(connection.pageInfo);
                if (!boolean(info.hasNextPage)) { complete = true; break; }
                if (page === 9) break;
                const cursor = string(info.endCursor);
                if (!cursor) throw new Error("Missing search pagination cursor");
                pageResponse = await request(`query { ${remoteSearch(batch, authenticatedLogin, field, cursor)} ${RATE_FIELDS} }`);
              }
              if (!complete || nodes.length !== expected) throw new Error("Incomplete PR search results");
              const grouped = new Map<string, Record<string, unknown>[]>();
              for (const node of nodes) {
                const name = string(object(node.repository).nameWithOwner).toLowerCase();
                const group = grouped.get(name) ?? []; group.push(node); grouped.set(name, group);
              }
              const checkErrors = new Map<string, string>();
              if (field === "authored") {
                const latest = [...grouped.values()].flatMap(nodes => nodes.slice(0, 3));
                if (latest.length) {
                  const ids = latest.map(node => string(node.id));
                  const details = await request(`query { nodes(ids: ${JSON.stringify(ids)}) { ... on PullRequest { id reviewDecision commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } ${RATE_FIELDS} }`, latest.length, Math.max(1, Math.round(latest.length / 100)));
                  const rows = array(details.data.nodes, node => node === null ? null : object(node));
                  for (const [index, node] of latest.entries()) {
                    const detail = rows[index];
                    const error = details.errors.find(error => !error.path.length || error.path[0] === "nodes" && (error.path.length === 1 || error.path[1] === index))?.message;
                    if (error || !detail || detail.id !== node.id) checkErrors.set(string(node.id), error ?? "PR checks unavailable");
                    else Object.assign(node, { reviewDecision: detail.reviewDecision, commits: detail.commits });
                  }
                }
              }
              for (const [index, repo] of batch.entries()) {
                const matches = grouped.get(`${repo.owner}/${repo.name}`.toLowerCase()) ?? [];
                const error = matches.slice(0, 3).map(node => typeof node.id === "string" ? checkErrors.get(node.id) : undefined).find(Boolean);
                if (error) response.errors.push({ message: error, path: [`${alias}${index}`] });
                response.data[`${alias}${index}`] = { issueCount: matches.length, nodes: matches.slice(0, 3) };
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (!stopped && retryable(message)) throw error;
              response.errors.push(...batch.map((_, index) => ({ message, path: [`${alias}${index}`] })));
            }
          }
        };
        const fetchBatch = async (batch: RemoteRepoId[]): Promise<void> => {
          const needed = fields.filter(key => batch.some(repo => cachedRepos.get(remoteRepoKey(repo))?.[key]?.state !== "ok"));
          try {
            const response = await request(remoteBatchQuery(batch, authenticatedLogin, needed), batch.length);
            await expandSearches(response, batch, needed);
            for (const [index, repo] of batch.entries()) {
              const missing = fields.filter(key => cachedRepos.get(remoteRepoKey(repo))?.[key]?.state !== "ok");
              const fresh = parseRepository(repo, authenticatedLogin, index, missing, response);
              cachedRepos.set(remoteRepoKey(repo), { ...cachedRepos.get(remoteRepoKey(repo)), ...fresh });
            }
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            if (!stopped && batch.length > 1 && retryable(reason)) {
              const middle = Math.ceil(batch.length / 2);
              await fetchBatch(batch.slice(0, middle));
              await fetchBatch(batch.slice(middle));
              return;
            }
            for (const repo of batch) {
              const missing = fields.filter(key => cachedRepos.get(remoteRepoKey(repo))?.[key]?.state !== "ok");
              cachedRepos.set(remoteRepoKey(repo), { ...cachedRepos.get(remoteRepoKey(repo)), ...empty(repo, login, missing, reason, rate?.retryAt) });
            }
          }
        };
        // Scalar metadata plus two search connections estimate 1 point. PR checks
        // use a separate query for at most three PRs per repo, with one commit each.
        for (let offset = 0; offset < pending.length; offset += 100) await fetchBatch(pending.slice(offset, offset + 100));
        for (const repo of requested) {
          const result = cachedRepos.get(remoteRepoKey(repo));
          if (!result) continue;
          const selected: RemoteRepository = { repo, login };
          const successes: RemoteRepository = { repo, login };
          for (const key of ALL_FIELDS) {
            if (fields.includes(key) && result[key]) Object.assign(selected, { [key]: result[key] });
            if (result[key]?.state === "ok") Object.assign(successes, { [key]: result[key] });
          }
          hostResult.repositories.push(selected);
          if (cacheAllowed && (options.ttlMs ?? TTL) > 0 && ALL_FIELDS.some(key => successes[key])) writeCacheValue(repoCacheKey(repo), successes);
        }
        let savedUncloned: UnclonedResult[] = [];
        if (options.uncloned && !options.refresh && cacheAllowed) {
          try {
            const hit = readCacheValue(unclonedCacheKey, options.ttlMs ?? TTL);
            if (hit) savedUncloned = array(hit, cachedUncloned).filter(result => result.complete && result.count.state === "ok" && result.repositories.state === "ok");
          } catch { /* Invalid entries are fetched again. */ }
        }
        hostResult.uncloned.push(...savedUncloned);
        if (options.uncloned && !savedUncloned.length) {
          const found: UnclonedRepository[] = []; let scanned = 0; let complete = false; let cursor: string | null = null;
          for (let page = 0; page < (options.maxUnclonedPages ?? 10); page++) {
            try {
              const response = await request(`query { viewer { repositories(first: 100, ownerAffiliations: [OWNER], orderBy: {field: PUSHED_AT, direction: DESC}${cursor ? `, after: ${JSON.stringify(cursor)}` : ""}) { nodes { nameWithOwner pushedAt } pageInfo { hasNextPage endCursor } } } ${RATE_FIELDS} }`);
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
        if (cacheAllowed && (options.ttlMs ?? TTL) > 0 && hostResult.uncloned.every(result => result.complete)) {
          if (hostResult.uncloned.length) writeCacheValue(unclonedCacheKey, hostResult.uncloned);
        }
      } finally { await release(); }
    } catch (error) {
      const reason = performance.now() >= deadline ? "deadline" : error instanceof Error ? error.message : String(error);
      output.repositories.push(...requested.map(repo => empty(repo, login, fields, reason)));
      if (options.uncloned) output.uncloned.push({ host, login, count: unavailable(reason), repositories: unavailable(reason), scanned: 0, complete: false });
    }
  }
  return output;
}
