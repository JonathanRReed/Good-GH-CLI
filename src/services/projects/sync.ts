import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import { ExecError, run } from "../../utils/exec.ts";
import { getConfig } from "../config.ts";
import { NON_INTERACTIVE_ENV } from "../git/exec.ts";
import { worktreeList, type WorktreeInfo } from "../git/worktree.ts";
import { acquireProcessLock } from "../process-lock.ts";
import { checkoutCreator, projectPath, redactRemoteUrl, within } from "./discovery.ts";
import { gitLine, projectLockPath, projectNetworkOptions, safeTrackingFetch } from "./git.ts";
import type { IndexedClone } from "./types.ts";

export type SyncOutcome =
  | { outcome: "updated"; old: string; new: string }
  | { outcome: "up-to-date" }
  | { outcome: "skipped"; reason: string }
  | { outcome: "failed" | "uncertain"; message: string };
export type CheckoutSyncResult = { path: string; branch: string | null } & SyncOutcome;
type FetchResult = { remote: string } & ({ outcome: "updated" } | { outcome: "failed" | "uncertain"; message: string });
type ForkResult = { outcome: "skipped"; reason: string } | { target: string; outcome: "updated" } | { target: string; outcome: "uncertain"; message: string };
export type CloneSyncResult = {
  commonDir: string; name: string; checkouts: CheckoutSyncResult[]; fetches: FetchResult[]; forkUpstream: ForkResult;
} & ({ outcome: "updated" | "up-to-date" } | { outcome: "skipped"; reason: string } | { outcome: "failed" | "uncertain"; message: string });
export interface ProjectSyncResult {
  schemaVersion: 1;
  status: "succeeded" | "partially_completed" | "failed" | "cancelled" | "no_op";
  cancelled: boolean;
  clones: CloneSyncResult[];
}
export interface ProjectSyncOptions {
  concurrency?: number;
  timeoutMs?: number;
  includeHostWorktrees?: boolean;
  hostWorktreeDirs?: string[];
  /** The command obtains confirmation before granting this capability. */
  forkUpstream?: boolean;
  dryRun?: boolean;
  signal?: AbortSignal;
}

const activeSyncs = new Set<AbortController>();
export function cancelActiveSyncs(): boolean {
  for (const controller of activeSyncs) controller.abort();
  return activeSyncs.size > 0;
}

const syncEnv = projectNetworkOptions;
function remaining(deadline: number): number {
  const ms = deadline - Date.now();
  if (ms <= 0) throw new Error("Clone sync deadline exceeded");
  return ms;
}
async function git(cwd: string, args: string[], deadline: number, reject = true) {
  return run("git", ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`, "-c", "submodule.recurse=false", ...args], { ...syncEnv, cwd, timeoutMs: remaining(deadline), reject });
}
function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/(?:[a-z][a-z0-9+.-]*:\/\/|[^\s/]+@)[^\s]+/gi, url => redactRemoteUrl(url)).slice(0, 4000);
}
function hostOwned(path: string, options: ProjectSyncOptions): boolean {
  const config = getConfig();
  const canonical = projectPath(path);
  return (options.hostWorktreeDirs ?? Object.values(config.host_worktree_dirs ?? {})).some(root => within(projectPath(root), canonical))
    || checkoutCreator(canonical, config, false) !== "unknown"
    || /\/\.(?:t3|codex|claude|cursor)\/worktrees[^/]*\//.test(canonical.replaceAll(sep, "/"));
}

async function checkoutState(checkout: WorktreeInfo, commonDir: string, deadline: number): Promise<SyncOutcome | { outcome: "ready"; branch: string; old: string; new: string }> {
  if (checkout.locked) return { outcome: "skipped", reason: "locked" };
  if (checkout.isBare) return { outcome: "skipped", reason: "bare" };
  const cwd = checkout.path;
  const identity = gitLine((await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], deadline)).stdout);
  if (projectPath(identity) !== commonDir) return { outcome: "skipped", reason: "identity-changed" };
  const gitDir = gitLine((await git(cwd, ["rev-parse", "--absolute-git-dir"], deadline)).stdout);
  if (["index.lock", "HEAD.lock", "locked"].some(file => existsSync(join(gitDir, file))) || existsSync(join(commonDir, "packed-refs.lock"))) return { outcome: "skipped", reason: "locked" };
  if (["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer", "BISECT_LOG"].some(file => existsSync(join(gitDir, file)))) return { outcome: "skipped", reason: "busy-operation" };
  const branchResult = await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], deadline, false);
  if (branchResult.exitCode === 1) return { outcome: "skipped", reason: "detached" };
  if (branchResult.exitCode !== 0) throw new Error(branchResult.stderr || "Cannot read HEAD");
  const branch = gitLine(branchResult.stdout);
  if (branch !== checkout.branch) return { outcome: "skipped", reason: "identity-changed" };
  if (existsSync(join(commonDir, "refs", "heads", `${branch}.lock`))) return { outcome: "skipped", reason: "locked" };
  const status = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"], deadline);
  if (status.stdout) return { outcome: "skipped", reason: "dirty" };
  const upstream = await git(cwd, ["rev-parse", "--verify", "@{upstream}^{commit}"], deadline, false);
  if (upstream.exitCode !== 0) return { outcome: "skipped", reason: "no-upstream" };
  const old = gitLine((await git(cwd, ["rev-parse", "--verify", "HEAD^{commit}"], deadline)).stdout);
  const next = gitLine(upstream.stdout);
  if (old === next) return { outcome: "up-to-date" };
  const ancestor = await git(cwd, ["merge-base", "--is-ancestor", old, next], deadline, false);
  if (ancestor.exitCode === 1) return { outcome: "skipped", reason: "diverged" };
  if (ancestor.exitCode !== 0) throw new Error(ancestor.stderr || "Cannot prove fast-forward ancestry");
  return { outcome: "ready", branch, old, new: next };
}

async function syncCheckout(checkout: WorktreeInfo, commonDir: string, deadline: number, options: ProjectSyncOptions): Promise<CheckoutSyncResult> {
  const identity = { path: checkout.path, branch: checkout.branch };
  if (!options.includeHostWorktrees && hostOwned(checkout.path, options)) return { ...identity, outcome: "skipped", reason: "host-owned" };
  if (options.signal?.aborted) return { ...identity, outcome: "skipped", reason: "cancelled" };
  try {
    const state = await checkoutState(checkout, commonDir, deadline);
    if (state.outcome !== "ready") return { ...identity, ...state };
    if (options.dryRun) return { ...identity, outcome: "skipped", reason: "dry-run" };
    // Recheck file state, HEAD, locks and upstream immediately before the effect.
    const currentList = await worktreeList(commonDir, { ...syncEnv, timeoutMs: remaining(deadline) });
    const live = currentList.find(row => projectPath(row.path) === projectPath(checkout.path));
    if (!live || live.branch !== state.branch) return { ...identity, outcome: "skipped", reason: "identity-changed" };
    const recheck = await checkoutState(live, commonDir, deadline);
    if (recheck.outcome !== "ready") return { ...identity, ...recheck };
    if (recheck.old !== state.old || recheck.new !== state.new) return { ...identity, outcome: "skipped", reason: "state-changed" };
    if (options.signal?.aborted) return { ...identity, outcome: "skipped", reason: "cancelled" };
    try {
      await git(checkout.path, ["merge", "--ff-only", "--no-edit", "--no-autostash", "--no-overwrite-ignore", state.new], deadline);
      const head = gitLine((await git(checkout.path, ["rev-parse", "--verify", "HEAD^{commit}"], deadline)).stdout);
      const branch = gitLine((await git(checkout.path, ["symbolic-ref", "--quiet", "--short", "HEAD"], deadline)).stdout);
      if (head !== state.new || branch !== state.branch) return { ...identity, outcome: "uncertain", message: "Checkout changed during fast-forward; inspect HEAD before retrying" };
      return { ...identity, outcome: "updated", old: state.old, new: state.new };
    } catch (error) {
      // A killed merge may have committed its ref before the runner saw success.
      return { ...identity, outcome: "uncertain", message: message(error) };
    }
  } catch (error) { return { ...identity, outcome: "failed", message: message(error) }; }
}

async function syncClone(clone: IndexedClone, options: ProjectSyncOptions): Promise<CloneSyncResult> {
  const commonDir = projectPath(clone.commonDir);
  const result: CloneSyncResult = { commonDir, name: clone.displayName, outcome: "up-to-date", checkouts: [], fetches: [], forkUpstream: { outcome: "skipped", reason: "not-requested" } };
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  let release: (() => Promise<void>) | undefined;
  try {
    // Resolve against the common directory itself, never through a cached checkout.
    const identity = gitLine((await git(commonDir, ["rev-parse", "--path-format=absolute", "--git-common-dir"], deadline)).stdout);
    if (projectPath(identity) !== commonDir) throw new Error("Clone identity changed; refresh the project index");
    release = await acquireProcessLock(projectLockPath(commonDir), Math.min(30000, remaining(deadline)));
    const checkouts = await worktreeList(commonDir, { ...syncEnv, timeoutMs: remaining(deadline) });
    const remotes = (await git(commonDir, ["remote"], deadline)).stdout.split(/\r?\n/).filter(Boolean);
    if (options.forkUpstream && !options.signal?.aborted) {
      const repo = clone.primary;
      if (!repo) result.forkUpstream = { outcome: "skipped", reason: "no-fork-target" };
      else {
        const target = `${repo.host}/${repo.owner}/${repo.name}`;
        if (options.dryRun) result.forkUpstream = { outcome: "skipped", reason: "dry-run" };
        else {
          try {
            await run("gh", ["repo", "sync", target], { cwd: commonDir, env: { ...NON_INTERACTIVE_ENV, GH_PROMPT_DISABLED: "1" }, timeoutMs: remaining(deadline) });
            result.forkUpstream = { target, outcome: "updated" };
          } catch (error) { result.forkUpstream = { target, outcome: "uncertain", message: message(error) }; }
        }
      }
    }
    for (const remote of remotes) {
      if (options.signal?.aborted || options.dryRun) break;
      try {
        await safeTrackingFetch(commonDir, remote, deadline);
        result.fetches.push({ remote, outcome: "updated" });
      } catch (error) {
        const uncertain = error instanceof ExecError && /timed out|exceeded output limit/.test(error.message);
        result.fetches.push({ remote, outcome: uncertain ? "uncertain" : "failed", message: message(error) });
      }
    }
    for (const checkout of checkouts) {
      if (result.fetches.some(fetch => fetch.outcome !== "updated")) result.checkouts.push({ path: checkout.path, branch: checkout.branch, outcome: "skipped", reason: "fetch-failed" });
      else result.checkouts.push(await syncCheckout(checkout, commonDir, deadline, options));
    }
    const failure = [...result.fetches, ...result.checkouts].find(row => row.outcome === "failed");
    const uncertain = [...result.fetches, result.forkUpstream, ...result.checkouts].find(row => row.outcome === "uncertain");
    if (uncertain?.outcome === "uncertain") return { ...result, outcome: "uncertain", message: uncertain.message };
    if (failure?.outcome === "failed") return { ...result, outcome: "failed", message: failure.message };
    if (result.checkouts.some(row => row.outcome === "updated") || result.forkUpstream.outcome === "updated") return { ...result, outcome: "updated" };
    if (result.checkouts.length && result.checkouts.every(row => row.outcome === "skipped")) return { ...result, outcome: "skipped", reason: "checkouts-skipped" };
    return result;
  } catch (error) {
    const detail = message(error);
    return { ...result, outcome: "failed", message: detail, checkouts: clone.checkouts.map(row => ({ path: row.path, branch: row.branch, outcome: "failed", message: detail })) };
  } finally { await release?.(); }
}

export async function syncProjects(clones: readonly IndexedClone[], options: ProjectSyncOptions = {}): Promise<ProjectSyncResult> {
  const concurrency = options.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) throw new Error("Sync concurrency must be between 1 and 64");
  if (!Number.isSafeInteger(options.timeoutMs ?? 120_000) || (options.timeoutMs ?? 120_000) < 1 || (options.timeoutMs ?? 120_000) > 2_147_483_647) throw new Error("Sync timeout must be 1..2147483647 milliseconds");
  const selected = [...new Map(clones.map(clone => [projectPath(clone.commonDir), clone])).values()];
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  activeSyncs.add(controller);
  const results: CloneSyncResult[] = [];
  let index = 0;
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, async () => {
      while (!controller.signal.aborted) {
        const slot = index++; const clone = selected[slot]; if (!clone) return;
        results[slot] = await syncClone(clone, { ...options, signal: controller.signal });
      }
    }));
    for (const [slot, clone] of selected.entries()) if (!results[slot]) results[slot] = {
      commonDir: projectPath(clone.commonDir), name: clone.displayName, outcome: "skipped", reason: "cancelled", fetches: [],
      forkUpstream: { outcome: "skipped", reason: "cancelled" }, checkouts: clone.checkouts.map(row => ({ path: row.path, branch: row.branch, outcome: "skipped", reason: "cancelled" })),
    };
    const failed = results.some(row => row.outcome === "failed" || row.outcome === "uncertain");
    const completed = results.some(row => row.fetches.some(fetch => fetch.outcome === "updated") || row.forkUpstream.outcome === "updated" || row.checkouts.some(checkout => checkout.outcome === "updated"));
    return { schemaVersion: 1, cancelled: controller.signal.aborted, status: controller.signal.aborted ? completed ? "partially_completed" : "cancelled" : failed ? completed ? "partially_completed" : "failed" : results.length ? "succeeded" : "no_op", clones: results };
  } finally {
    activeSyncs.delete(controller); options.signal?.removeEventListener("abort", abort);
  }
}
