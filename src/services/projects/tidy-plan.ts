import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";
import { getConfig, type GoodGhConfig } from "../config.ts";
import { worktreeList } from "../git/worktree.ts";
import { run } from "../../utils/exec.ts";
import { discoverProjects, projectPath, remoteIdentity } from "./discovery.ts";
import { checkoutCreator } from "./hosts.ts";
import { gitLine, inventoryGitOptions, projectGit } from "./git.ts";
import { protectReflog, reflogWork } from "./reflog.ts";
import { within } from "./paths.ts";
import { volumeAvailable } from "./volumes.ts";
export { volumeAvailable } from "./volumes.ts";
import type { TidyAudit } from "./tidy-audit.ts";
import type { Checkout, Clone, HostClaim } from "./types.ts";

export interface TidyOptions {
  remoteBranches?: boolean;
  /** Exact checkout paths, each requiring a new plan approval. */
  allowIgnored?: string[];
  allowUnknown?: string[];
  /** Plain Git checkouts strictly below these directories. Host-owned checkouts are never covered. */
  allowUnknownUnder?: string[];
  staleDays?: number;
}
export interface RefProof { ref: string; oid: string }
export interface TidyProof {
  commonDir: string;
  cloneIdentity: string;
  refs: RefProof[];
  remoteRefs: RefProof[];
  stash: string;
}
interface ActionBase { id: string; proof: TidyProof }
export type TidyAction = ActionBase & (
  | { kind: "delete-local-branch"; branch: string; tip: string; integration: RefProof }
  | { kind: "delete-remote-branch"; branch: string; tip: string; integration: RefProof; destination: string; login: string }
  | { kind: "remove-checkout"; checkout: Checkout; checkoutIdentity: string; fileState: string; allowIgnored: boolean; allowUnknown: boolean; integration: RefProof | null }
  | { kind: "prune-worktree-metadata"; entries: Checkout[]; registry: string; expire: string; dryRun: string }
);
export interface TidyNotice { target: string; reason: string }
export interface TidyClonePlan {
  commonDir: string;
  name: string;
  fetchedAt: string | null;
  actions: TidyAction[];
  kept: TidyNotice[];
  hostManual: (TidyNotice & { host: HostClaim["host"] })[];
  hints: (TidyNotice & { kind: "stale-repo" | "gc-hint" })[];
}
export interface TidyPlan { schemaVersion: 1; snapshotId: string; options: TidyOptions; clones: TidyClonePlan[]; audit?: TidyAudit }
export function tidyDigest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function directoryIdentity(path: string): string {
  const info = lstatSync(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Not a regular directory: ${path}`);
  return `${realpathSync.native(path)}:${info.dev}:${info.ino}:${info.birthtimeNs}`;
}
export function fetchedAt(commonDir: string): string | null {
  try { return statSync(join(commonDir, "FETCH_HEAD")).mtime.toISOString(); } catch { return null; }
}
/** A recent fetch covers only the OIDs it recorded, not every remote in the clone. */
async function requireFreshRemoteRefs(commonDir: string, refs: RefProof[], maxDays: number): Promise<void> {
  const fetchDate = fetchedAt(commonDir);
  const stale = (date: number) => Date.now() - date > maxDays * 86400000;
  const oldReason = `remote refs older than ${maxDays} days; run with --fetch`;
  if (fetchDate && stale(Date.parse(fetchDate))) throw new Error(oldReason);
  let fetchedOids = new Set<string>();
  try { fetchedOids = new Set(readFileSync(join(commonDir, "FETCH_HEAD"), "utf8").split("\n").map(line => line.split("\t")[0] ?? "")); } catch { /* Per-ref reflogs must prove age instead. */ }
  if (!refs.length) throw new Error("remote refs fetch age unknown; run with --fetch");
  for (const ref of refs) {
    if (fetchDate && fetchedOids.has(ref.oid)) continue;
    const symbolic = await run("git", ["symbolic-ref", "--quiet", ref.ref], { ...inventoryGitOptions, cwd: commonDir, reject: false });
    if (symbolic.exitCode > 1) throw new Error("remote refs fetch age unknown; run with --fetch");
    const name = symbolic.exitCode === 0 ? gitLine(symbolic.stdout) : ref.ref;
    const result = await projectGit(commonDir, ["reflog", "show", "-n1", "--date=unix", "--format=%gd", name, "--"]);
    const match = /@\{(\d+)\}/.exec(result.stdout);
    if (!match?.[1]) throw new Error("remote refs fetch age unknown; run with --fetch");
    if (stale(Number(match[1]) * 1000)) throw new Error(oldReason);
  }
}
export async function freshClone(clone: Clone, config: GoodGhConfig = getConfig()): Promise<Clone> {
  const source = clone.checkouts.find(checkout => existsSync(join(checkout.path, ".git")) || checkout.bare)?.path;
  if (!source) throw new Error("No readable checkout; identity cannot be proved");
  const discovered = await discoverProjects({ config: { ...config, project_roots: [], project_exclude: [] }, registered: [source], scanHostLocations: false });
  const fresh = discovered.clones.find(candidate => candidate.commonDir === clone.commonDir);
  if (!fresh || realpathSync.native(fresh.commonDir) !== clone.commonDir) throw new Error("Clone identity changed or cannot be proved");
  return fresh;
}
export async function refsForTidy(commonDir: string): Promise<RefProof[]> {
  const text = (await projectGit(commonDir, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)", "refs/heads/", "refs/remotes/", "refs/ggh/merged-prs/", "refs/stash"])).stdout;
  return text.split("\n").filter(Boolean).map(line => {
    const [ref, oid, symbolic] = line.split("\0");
    if (!ref || !oid || !/^[a-f0-9]{40,64}$/.test(oid)) throw new Error("Cannot parse exact ref identity");
    if (ref.startsWith("refs/heads/") && symbolic) throw new Error(`Symbolic local branch ${ref}; keep until it is a direct ref`);
    return { ref, oid };
  });
}
export async function unpublishedCount(commonDir: string, oid: string): Promise<number> {
  const text = (await projectGit(commonDir, ["--no-replace-objects", "rev-list", "--count", oid, "--not", "--remotes", "--"])).stdout.trim();
  if (!/^\d+$/.test(text)) throw new Error("Cannot prove remote reachability");
  return Number(text);
}
async function ancestor(commonDir: string, tip: string, destination: string): Promise<boolean> {
  const result = await run("git", ["--no-replace-objects", "merge-base", "--is-ancestor", tip, destination], { ...inventoryGitOptions, cwd: commonDir, timeoutMs: 3000, reject: false });
  if (result.exitCode > 1) throw new Error("Cannot prove ancestry");
  return result.exitCode === 0;
}
export async function configValue(cwd: string, key: string): Promise<string | null> {
  const result = await run("git", ["config", "--get", key], { ...inventoryGitOptions, cwd, reject: false });
  if (result.exitCode === 1) return null;
  if (result.exitCode !== 0) throw new Error("Cannot inspect Git configuration");
  return gitLine(result.stdout);
}
export async function cachedLogin(host: string): Promise<string | null> {
  // `gh config get` reads the saved active user without validating a token online.
  // Environment tokens can select another account, whose identity is not provable offline.
  if (["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"].some(key => process.env[key])) return null;
  try {
    const result = await run("gh", ["config", "get", "user", "--host", host], { reject: false, timeoutMs: 3000 });
    const login = result.stdout.trim();
    return result.exitCode === 0 && /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(login) ? login : null;
  } catch { return null; }
}
export async function remoteOwnership(commonDir: string, branch: string): Promise<{ destination: string; login: string } | null> {
  const push = await configValue(commonDir, `branch.${branch}.pushRemote`) ?? await configValue(commonDir, "remote.pushDefault") ?? await configValue(commonDir, `branch.${branch}.remote`) ?? "origin";
  if (push !== "origin") return null;
  const url = (await projectGit(commonDir, ["remote", "get-url", "origin"])).stdout.trim();
  const destination = (await projectGit(commonDir, ["remote", "get-url", "--push", "--all", "origin"])).stdout.trim();
  if (url !== destination || destination.includes("\n")) return null;
  const repo = remoteIdentity(url);
  if (!repo) return null;
  const login = await cachedLogin(repo.host);
  if (!login || login.toLowerCase() !== repo.owner.toLowerCase()) return null;
  // Never expose credential-bearing URLs in the serializable plan.
  if (/^https?:\/\/[^/]*@/.test(destination) || /[?#]/.test(destination)) return null;
  return { destination, login };
}
export function missingPath(path: string): boolean {
  try { lstatSync(path); return false; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw new Error("Cannot prove that checkout path is missing", { cause: error });
  }
}
export async function hostClaims(checkout: Checkout, commonDir: string, config: GoodGhConfig): Promise<HostClaim[]> {
  const claims = [...checkout.hostClaims];
  const creator = checkoutCreator(checkout.path, config, false);
  if (creator !== "unknown" && creator !== "ggh") claims.push({ host: creator, evidence: "Host worktree location" });
  if (checkout.createdBy !== "unknown" && checkout.createdBy !== "ggh") claims.push({ host: checkout.createdBy, evidence: "Checkout provenance" });
  if (checkout.branch && await configValue(commonDir, `branch.${checkout.branch}.t3-merge-base-ref`) !== null) claims.push({ host: "t3", evidence: "t3-merge-base-ref" });
  return claims;
}

/** Also catches nested repositories that normal Git status does not describe. */
function protectNested(checkout: string): void {
  const pending = [checkout];
  let visited = 0;
  while (pending.length) {
    const directory = pending.pop();
    if (!directory) continue;
    if (++visited > 10000) throw new Error("Nested repository scan limit reached");
    const entries = readdirSync(directory, { withFileTypes: true });
    if (directory !== checkout && ["HEAD", "objects", "refs"].every(name => entries.some(entry => entry.name === name))) throw new Error("Nested bare repository present");
    for (const entry of entries) {
      if (entry.name === ".git") { if (directory !== checkout) throw new Error("Nested repository present"); continue; }
      if (entry.isDirectory()) pending.push(join(directory, entry.name));
    }
  }
}
const OPERATION_MARKERS = ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "sequencer"];
/** State that lives only in a worktree's own gitdir and disappears with its metadata. */
async function protectWorktreeMetadata(commonDir: string, checkout: Checkout): Promise<void> {
  for (const marker of OPERATION_MARKERS) if (existsSync(join(checkout.gitDir, marker))) throw new Error(`Git operation in progress: ${marker}`);
  const pending = [join(checkout.gitDir, "refs")];
  while (pending.length) {
    const directory = pending.pop();
    if (!directory || !existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) pending.push(join(directory, entry.name));
      else throw new Error("Per-worktree refs present");
    }
  }
  if (!checkout.head || !existsSync(join(checkout.gitDir, "index"))) return;
  const staged = await run("git", ["--git-dir", checkout.gitDir, "diff-index", "--cached", "--quiet", checkout.head, "--"], { ...inventoryGitOptions, cwd: commonDir, reject: false });
  if (staged.exitCode === 1) throw new Error("Staged changes in the missing checkout's index");
  if (staged.exitCode !== 0) throw new Error("Cannot inspect the missing checkout's index");
}
export async function checkoutFileState(checkout: Checkout, allowIgnored: boolean): Promise<string> {
  directoryIdentity(checkout.path);
  const reverse = readFileSync(join(checkout.gitDir, "gitdir"), "utf8");
  if (projectPath(dirname(resolve(checkout.gitDir, gitLine(reverse)))) !== checkout.path) throw new Error("Checkout gitdir backlink changed");
  const actualHead = (await projectGit(checkout.path, ["rev-parse", "--verify", "HEAD"])).stdout.trim();
  if (actualHead !== checkout.head) throw new Error("Checkout HEAD changed");
  const flags = (await projectGit(checkout.path, ["ls-files", "-v", "-z"])).stdout;
  if (flags.split("\0").some(record => /^[a-zS] /.test(record))) throw new Error("Assume-unchanged or skip-worktree index entries hide file state");
  for (const marker of OPERATION_MARKERS) {
    if (existsSync(join(checkout.gitDir, marker))) throw new Error(`Git operation in progress: ${marker}`);
  }
  // Disable ignore-submodules configuration: submodule and nested work never disappear behind it.
  const status = (await projectGit(checkout.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored", "--ignore-submodules=none"])).stdout;
  const records = status.split("\0").filter(Boolean);
  if (records.some(record => !record.startsWith("!! "))) throw new Error("Staged, unstaged, or untracked work present");
  if (records.length && !allowIgnored) throw new Error("Ignored files present; keep unless this path is approved with --allow-ignored");
  const index = (await projectGit(checkout.path, ["ls-files", "--stage", "-z"])).stdout;
  if (index.split("\0").some(record => record.startsWith("160000 "))) throw new Error("Submodule present");
  protectNested(checkout.path);
  const ignored = (await projectGit(checkout.path, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])).stdout.split("\0").filter(Boolean).sort().map(path => {
    const info = lstatSync(join(checkout.path, path), { bigint: true });
    return [path, String(info.dev), String(info.ino), String(info.size), String(info.mtimeNs), String(info.ctimeNs)];
  });
  return tidyDigest({ status, index, ignored });
}
function action<T extends Omit<TidyAction, "id">>(value: T): T & { id: string } { return { ...value, id: tidyDigest(value) }; }
function reason(error: unknown): string { return error instanceof Error ? error.message : "Unknown Git state"; }

export async function classifyTidyClone(input: Clone, options: TidyOptions = {}, config = getConfig()): Promise<TidyClonePlan> {
  const result: TidyClonePlan = { commonDir: input.commonDir, name: input.displayName, fetchedAt: fetchedAt(input.commonDir), actions: [], kept: [], hostManual: [], hints: [] };
  try {
    const clone = await freshClone(input, config);
    const commonDir = clone.commonDir;
    if (existsSync(join(commonDir, "info", "grafts"))) throw new Error("Commit grafts present; ancestry is unprovable");
    if (existsSync(join(commonDir, "shallow"))) throw new Error("Shallow history; keep until full ancestry is available");
    const refs = await refsForTidy(commonDir);
    const remoteRefs = refs.filter(ref => ref.ref.startsWith("refs/remotes/"));
    const hasStash = refs.some(ref => ref.ref === "refs/stash");
    const stash = tidyDigest(hasStash ? (await projectGit(commonDir, ["reflog", "show", "--format=%H%x00%gd%x00%gs", "refs/stash"])).stdout : "");
    const cloneIdentity = directoryIdentity(commonDir);
    const trees = await worktreeList(commonDir, inventoryGitOptions);
    const defaults: RefProof[] = [];
    for (const remote of clone.remotes) {
      const head = await run("git", ["symbolic-ref", "--quiet", `refs/remotes/${remote.name}/HEAD`], { ...inventoryGitOptions, cwd: commonDir, reject: false });
      if (head.exitCode > 1) throw new Error("Cannot determine remote default branch");
      const target = refs.find(ref => ref.ref === head.stdout.trim());
      if (target) defaults.push(target);
    }
    const integrationFor = async (tip: string, branch: string | null): Promise<RefProof | null> => {
      const recorded = branch ? refs.filter(ref => ref.ref === `refs/ggh/merged-prs/${branch}`) : [];
      for (const destination of [...defaults, ...recorded]) if (await ancestor(commonDir, tip, destination.oid)) return destination;
      return null;
    };
    let publication: Promise<void> | undefined;
    const freshPublication = () => publication ??= requireFreshRemoteRefs(commonDir, remoteRefs, config.tidy_max_fetch_age_days ?? 30);
    const proof = (specific: RefProof[]): TidyProof => ({ commonDir, cloneIdentity, refs: specific, remoteRefs, stash });
    // One proof for every local branch deletion, whether or not a checkout is removed first.
    const branchAction = async (ref: RefProof): Promise<TidyAction> => {
      const branch = ref.ref.slice(11);
      if (hasStash) throw new Error("Clone has stashes");
      const integration = await integrationFor(ref.oid, branch);
      if (!integration) throw new Error("Exact tip is not proven merged by ancestry");
      if (await unpublishedCount(commonDir, ref.oid)) throw new Error("Commits unreachable from every remote ref");
      await freshPublication();
      await protectReflog(commonDir, { branch });
      if (defaults.some(target => target.ref.replace(/^refs\/remotes\/[^/]+\//, "") === branch)) throw new Error("Default branch");
      return action({ kind: "delete-local-branch", branch, tip: ref.oid, integration, proof: proof([ref, integration]) });
    };
    // Branches held by a checkout wait for that checkout's removal in this same plan.
    const checkedOut = new Map<string, RefProof>();
    for (const ref of refs.filter(ref => ref.ref.startsWith("refs/heads/"))) {
      const branch = ref.ref.slice(11);
      try {
        if (trees.some(tree => tree.branch === branch)) { checkedOut.set(branch, ref); continue; }
        result.actions.push(await branchAction(ref));
      } catch (error) { result.kept.push({ target: branch, reason: reason(error) }); }
    }
    const releaseBranch = async (checkout: Checkout): Promise<void> => {
      const ref = checkout.branch ? checkedOut.get(checkout.branch) : undefined;
      if (!checkout.branch || !ref) return;
      checkedOut.delete(checkout.branch);
      try {
        if (trees.filter(tree => tree.branch === checkout.branch).length !== 1) throw new Error("Checked out in a worktree");
        if (ref.oid !== checkout.head) throw new Error("Checked out in a worktree whose HEAD differs from the branch tip");
        result.actions.push(await branchAction(ref));
      } catch (error) { result.kept.push({ target: checkout.branch, reason: reason(error) }); }
    };
    for (const checkout of clone.checkouts) {
      try {
        const claims = await hostClaims(checkout, commonDir, config);
        const host = claims[0]?.host;
        if (host) {
          const name = { t3: "T3 Code's worktree cleanup", claude: "Claude Code's worktree cleanup", cursor: "Cursor's worktree cleanup", codex: "Codex's worktree cleanup" }[host];
          result.hostManual.push({ target: checkout.path, host, reason: `Remove from ${name}; ggh cannot verify live threads or queued turns` });
          continue;
        }
        if (!existsSync(checkout.path)) { result.kept.push({ target: checkout.path, reason: "Checkout path missing; metadata is considered separately" }); continue; }
        if (trees[0]?.path === checkout.path || checkout.gitDir === commonDir || checkout.bare) throw new Error("Main or bare worktree");
        if (checkout.path === projectPath(process.cwd())) throw new Error("Current checkout is in use by this command");
        if (checkout.locked) throw new Error("Locked worktree");
        if (checkout.prunable) throw new Error("Broken checkout gitdir");
        if (!checkout.head) throw new Error("HEAD is unknown");
        if (hasStash) throw new Error("Clone has stashes");
        const allowUnknown = (options.allowUnknown ?? []).map(projectPath).includes(checkout.path)
          || (options.allowUnknownUnder ?? []).some(directory => directory !== checkout.path && within(projectPath(directory), checkout.path));
        if (checkout.createdBy !== "ggh" && !allowUnknown) throw new Error("Unknown provenance; keep unless this path is approved with --allow-unknown or --allow-unknown-under");
        if (await unpublishedCount(commonDir, checkout.head)) throw new Error("Unpublished commits in checkout HEAD");
        const integration = await integrationFor(checkout.head, checkout.branch);
        if (checkout.branch && !integration) throw new Error("Exact branch tip is not proven merged by ancestry");
        await freshPublication();
        await protectReflog(commonDir, { checkout });
        if (checkout.branch) await protectReflog(commonDir, { branch: checkout.branch });
        const allowIgnored = (options.allowIgnored ?? []).map(projectPath).includes(checkout.path);
        const fileState = await checkoutFileState(checkout, allowIgnored);
        const actual = realpathSync.native(gitLine((await projectGit(checkout.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout));
        if (actual !== commonDir) throw new Error("Checkout changed clone identity");
        result.actions.push(action({ kind: "remove-checkout", checkout, checkoutIdentity: tidyDigest([directoryIdentity(checkout.path), directoryIdentity(checkout.gitDir)]), fileState, allowIgnored, allowUnknown, integration, proof: proof([{ ref: checkout.branch ? `refs/heads/${checkout.branch}` : "HEAD", oid: checkout.head }, ...integration ? [integration] : []]) }));
        await releaseBranch(checkout);
      } catch (error) { result.kept.push({ target: checkout.path, reason: reason(error) }); }
    }
    if (options.remoteBranches) for (const ref of refs.filter(ref => ref.ref.startsWith("refs/remotes/origin/") && !ref.ref.endsWith("/HEAD"))) {
      const branch = ref.ref.slice(20);
      try {
        if (hasStash) throw new Error("Clone has stashes");
        await freshPublication();
        if (defaults.some(target => target.ref === ref.ref)) throw new Error("Remote default branch");
        const integration = await integrationFor(ref.oid, branch);
        if (!integration) throw new Error("Remote tip is not proven merged by ancestry");
        if (await unpublishedCount(commonDir, integration.oid)) throw new Error("Integration commit is not reachable from remote refs");
        const owned = await remoteOwnership(commonDir, branch);
        if (!owned) throw new Error("Ownership unproven offline; requires cached gh login, own origin, and push remote origin");
        result.actions.push(action({ kind: "delete-remote-branch", branch, tip: ref.oid, integration, ...owned, proof: proof([ref, integration]) }));
      } catch (error) { result.kept.push({ target: ref.ref, reason: reason(error) }); }
    }
    // Each missing entry is pruned on its own proof, so one unsafe entry never blocks the rest.
    const prunable = clone.checkouts.filter(checkout => checkout.prunable);
    if (prunable.length) {
      let expire = "3.months.ago";
      let listing: string[] | Error;
      try {
        expire = await configValue(commonDir, "gc.worktreePruneExpire") ?? expire;
        const dryRun = await projectGit(commonDir, ["worktree", "prune", "--dry-run", "--verbose", `--expire=${expire}`]);
        listing = (dryRun.stdout + dryRun.stderr).split(/\r?\n/).filter(Boolean);
      } catch (error) { listing = error instanceof Error ? error : new Error("Cannot list prunable worktree metadata"); }
      for (const checkout of prunable) {
        try {
          if (listing instanceof Error) throw listing;
          if (hasStash) throw new Error("Clone has stashes");
          if (!missingPath(checkout.path)) throw new Error(`Existing checkout: ${checkout.path}`);
          if (checkout.locked) throw new Error(`Locked entry: ${checkout.path}`);
          if (!await volumeAvailable(checkout.path)) throw new Error(`Volume looks unmounted: ${checkout.path}`);
          if ((await hostClaims(checkout, commonDir, config)).length) throw new Error(`Host-owned metadata: ${checkout.path}`);
          if (dirname(checkout.gitDir) !== join(commonDir, "worktrees")) throw new Error("Worktree metadata outside the clone registry");
          const line = listing.find(entry => entry.startsWith(`Removing worktrees/${basename(checkout.gitDir)}:`));
          if (!line) throw new Error("Prunable metadata is still protected by Git's expiry");
          if (!checkout.head) throw new Error(`Unpublished or unknown HEAD in missing checkout: ${checkout.path}`);
          if (checkout.branch) {
            // The branch ref keeps its commits; only history unique to this entry's reflog would go.
            const ref = refs.find(item => item.ref === `refs/heads/${checkout.branch}`);
            if (!ref || ref.oid !== checkout.head) throw new Error(`Branch tip differs from the missing checkout's HEAD: ${checkout.path}`);
            const orphaned = await reflogWork(commonDir, { checkout }, true);
            if (orphaned.commits.length) throw new Error(`reflog holds ${orphaned.commits.length} commits no ref keeps: ${checkout.path}`);
            if (orphaned.truncated) throw new Error(`reflog scan limit reached; unique history unknown: ${checkout.path}`);
          } else {
            if (await unpublishedCount(commonDir, checkout.head)) throw new Error(`Unpublished or unknown HEAD in missing checkout: ${checkout.path}`);
            await freshPublication();
            await protectReflog(commonDir, { checkout });
          }
          await protectWorktreeMetadata(commonDir, checkout);
          result.actions.push(action({ kind: "prune-worktree-metadata", entries: [checkout], registry: tidyDigest([directoryIdentity(checkout.gitDir), statSync(join(checkout.gitDir, "gitdir")).mtimeMs]), expire, dryRun: line, proof: proof([{ ref: checkout.branch ? `refs/heads/${checkout.branch}` : "HEAD", oid: checkout.head }]) }));
          await releaseBranch(checkout);
        } catch (error) { result.kept.push({ target: checkout.path, reason: reason(error) }); }
      }
    }
    for (const branch of checkedOut.keys()) result.kept.push({ target: branch, reason: "Checked out in a worktree" });
    const newest = (await projectGit(commonDir, ["for-each-ref", "--sort=-committerdate", "--format=%(committerdate:unix)", "refs/heads/", "refs/remotes/"])).stdout.trim().split("\n").map(Number).filter(Number.isFinite);
    for (const checkout of clone.checkouts.filter(checkout => !checkout.branch && checkout.head)) {
      const date = Number((await projectGit(commonDir, ["log", "-1", "--format=%ct", checkout.head ?? "HEAD", "--"])).stdout.trim());
      if (Number.isFinite(date)) newest.push(date);
    }
    const last = Math.max(0, ...newest.map(seconds => seconds * 1000), result.fetchedAt ? Date.parse(result.fetchedAt) : 0);
    if (last && Date.now() - last > (options.staleDays ?? 120) * 86400000) result.hints.push({ kind: "stale-repo", target: commonDir, reason: `No commits or recorded fetch in ${options.staleDays ?? 120} days; report only` });
    const objects = (await projectGit(commonDir, ["count-objects", "-v"])).stdout;
    if (/^count: [1-9]/m.test(objects) || /^garbage: [1-9]/m.test(objects)) result.hints.push({ kind: "gc-hint", target: commonDir, reason: "Loose or garbage objects present; inspect git count-objects -v. No GC executed" });
  } catch (error) { result.actions = []; result.kept.push({ target: input.commonDir, reason: reason(error) }); }
  return result;
}
/**
 * Binds the decisions and their exact ref/OID proofs. Fetch timestamps and
 * report-only hints are left out: a fresh `--fetch` must reproduce the same
 * snapshot when it observed the same refs, or approval could never match.
 */
export function tidySnapshot(plan: Pick<TidyPlan, "schemaVersion" | "options" | "clones" | "audit">): string {
  const clones = plan.clones.map(clone => ({ commonDir: clone.commonDir, name: clone.name, actions: clone.actions, kept: clone.kept, hostManual: clone.hostManual }));
  return tidyDigest({ schemaVersion: plan.schemaVersion, options: plan.options, clones, ...(plan.audit ? { audit: plan.audit } : {}) });
}
/** A broad directory approval must name one agent area, never a whole volume or home. */
function unknownDirectory(path: string): string {
  const resolved = projectPath(path);
  // Breadth comes first: a volume root or home is too broad whether or not it is mounted.
  const homes = [homedir(), process.env.HOME].filter((home): home is string => Boolean(home)).map(projectPath);
  if (resolved === parse(resolved).root || homes.includes(resolved)) throw new Error(`--allow-unknown-under is too broad: ${path}. Name the directory that holds the agent checkouts`);
  let info;
  try { info = statSync(resolved); } catch { throw new Error(`--allow-unknown-under directory does not exist: ${path}`); }
  if (!info.isDirectory()) throw new Error(`--allow-unknown-under must name a directory: ${path}`);
  return resolved;
}
export async function buildTidyPlan(clones: readonly Clone[], options: TidyOptions = {}, config = getConfig()): Promise<TidyPlan> {
  const normalized: TidyOptions = { remoteBranches: options.remoteBranches ?? false, allowIgnored: [...new Set((options.allowIgnored ?? []).map(projectPath))].sort(), allowUnknown: [...new Set((options.allowUnknown ?? []).map(projectPath))].sort(), allowUnknownUnder: [...new Set((options.allowUnknownUnder ?? []).map(unknownDirectory))].sort(), staleDays: options.staleDays ?? 120 };
  if (!Number.isSafeInteger(normalized.staleDays) || (normalized.staleDays ?? 0) < 1) throw new Error("--stale-days must be a positive integer");
  const plans: TidyClonePlan[] = [];
  for (const clone of [...new Map(clones.map(clone => [clone.commonDir, clone])).values()].sort((a, b) => a.commonDir.localeCompare(b.commonDir))) plans.push(await classifyTidyClone(clone, normalized, config));
  const plan = { schemaVersion: 1 as const, options: normalized, clones: plans };
  return { ...plan, snapshotId: tidySnapshot(plan) };
}
