import { assertWindowsPrivateDirectory } from "../private-storage.ts";
/**
 * Stacked-branch graph (git-config parent pointers) and restack. Depends on exec/branch only.
 */

import { run } from "../../utils/exec.ts";
import { existsSync, readFileSync } from "node:fs";
import { link, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { execGitWithRetry } from "./exec.ts";
import { getCurrentBranch, listBranches, resolveBranchRef } from "./branch.ts";

export interface StackNode {
  branch: string;
  parent: string | null;
  /** The recorded `gh-merge-base` value, even when that branch no longer exists. */
  recordedParent?: string | null;
  /** Whether `recordedParent` exists as a local branch. */
  parentExists?: boolean;
  children: string[];
  /** Commits this branch adds on top of its parent. */
  ahead: number;
  /** Commits the parent has that this branch is missing (needs a restack). */
  behind: number;
  isCurrent: boolean;
}

export interface StackRecoveryEntry {
  branch: string;
  parent: string;
  originalTip: string;
  expectedTip: string;
  state: "pending" | "completed" | "failed" | "unknown";
  pushState?: "pending" | "completed" | "failed" | "unknown";
  remote?: string;
  pullRequestUrl?: string;
}

export interface StackRecoveryCheckpoint {
  schemaVersion: 1;
  operationId: string;
  mode: "restack" | "submit";
  selected: string;
  originalBranch: string;
  entries: StackRecoveryEntry[];
  activeIndex: number;
  resources: string[];
}

function validOperationId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

async function recoveryDirectory(cwd: string): Promise<string> {
  const result = await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd });
  const directory = join(result.stdout.trim(), "ggh-stack-recovery");
  assertWindowsPrivateDirectory(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== "win32" && (info.mode & 0o077) !== 0) || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
    throw new Error("Stack recovery storage has unsafe ownership or type.");
  }
  return directory;
}

function checkpointPath(directory: string): string {
  return join(directory, "active.json");
}

const MAX_STACK_RECOVERY_BYTES = 64 * 1024;

function parseCheckpoint(value: unknown): StackRecoveryCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Stack recovery checkpoint is corrupt.");
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1 || typeof raw.operationId !== "string" || !validOperationId(raw.operationId) ||
      (raw.mode !== "restack" && raw.mode !== "submit") || typeof raw.selected !== "string" ||
      typeof raw.originalBranch !== "string" || !Array.isArray(raw.entries) || raw.entries.length > 100 ||
      !Number.isInteger(raw.activeIndex) || (raw.activeIndex as number) < 0 || (raw.activeIndex as number) > raw.entries.length ||
      !Array.isArray(raw.resources) || !raw.resources.every((url) => typeof url === "string" && URL.canParse(url))) {
    throw new Error("Stack recovery checkpoint is invalid.");
  }
  const entries = raw.entries.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Stack recovery entry is invalid.");
    const entry = item as Record<string, unknown>;
    if (typeof entry.branch !== "string" || !entry.branch || typeof entry.parent !== "string" || !entry.parent ||
        typeof entry.originalTip !== "string" || !/^[0-9a-f]{40,64}$/i.test(entry.originalTip) ||
        typeof entry.expectedTip !== "string" || !/^[0-9a-f]{40,64}$/i.test(entry.expectedTip) ||
        !["pending", "completed", "failed", "unknown"].includes(String(entry.state)) ||
        (entry.pushState !== undefined && !["pending", "completed", "failed", "unknown"].includes(String(entry.pushState))) ||
        (entry.remote !== undefined && (typeof entry.remote !== "string" || !entry.remote.trim() || /[\0\r\n]/.test(entry.remote))) ||
        (entry.pullRequestUrl !== undefined && (typeof entry.pullRequestUrl !== "string" || !URL.canParse(entry.pullRequestUrl)))) {
      throw new Error("Stack recovery entry is invalid.");
    }
    return {
      branch: entry.branch,
      parent: entry.parent,
      originalTip: entry.originalTip,
      expectedTip: entry.expectedTip,
      state: entry.state as StackRecoveryEntry["state"],
      ...(typeof entry.pushState === "string" ? { pushState: entry.pushState as NonNullable<StackRecoveryEntry["pushState"]> } : {}),
      ...(typeof entry.remote === "string" ? { remote: entry.remote } : {}),
      ...(typeof entry.pullRequestUrl === "string" ? { pullRequestUrl: entry.pullRequestUrl } : {}),
    };
  });
  return {
    schemaVersion: 1,
    operationId: raw.operationId,
    mode: raw.mode,
    selected: raw.selected,
    originalBranch: raw.originalBranch,
    entries,
    activeIndex: raw.activeIndex as number,
    resources: [...raw.resources] as string[],
  };
}

export async function readStackRecovery(cwd = process.cwd()): Promise<StackRecoveryCheckpoint | null> {
  const directory = await recoveryDirectory(cwd);
  return readStackRecoveryFromCommonDir(join(directory, ".."));
}

/** Inventory reads existing state without creating recovery storage. */
export async function readStackRecoveryFromCommonDir(commonDir: string): Promise<StackRecoveryCheckpoint | null> {
  const directory = join(commonDir, "ggh-stack-recovery");
  const storage = await lstat(directory).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (!storage) return null;
  if (!storage.isDirectory() || storage.isSymbolicLink() || (process.platform !== "win32" && (storage.mode & 0o077) !== 0) || (typeof process.getuid === "function" && storage.uid !== process.getuid())) throw new Error("Stack recovery storage has unsafe ownership or type.");
  const path = checkpointPath(directory);
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STACK_RECOVERY_BYTES || (process.platform !== "win32" && (info.mode & 0o077) !== 0) || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
    throw new Error("Stack recovery checkpoint has unsafe ownership or type.");
  }
  let value: unknown;
  try { value = JSON.parse(await readFile(path, "utf8")); }
  catch { throw new Error("Stack recovery checkpoint is corrupt."); }
  return parseCheckpoint(value);
}

export async function createStackRecovery(checkpoint: StackRecoveryCheckpoint, cwd = process.cwd()): Promise<void> {
  const directory = await recoveryDirectory(cwd);
  const validated = parseCheckpoint(checkpoint);
  const json = `${JSON.stringify(validated, null, 2)}\n`;
  if (Buffer.byteLength(json) > MAX_STACK_RECOVERY_BYTES) throw new Error("Stack recovery checkpoint exceeds 64 KiB. Reduce the stack size before starting this operation.");
  const path = checkpointPath(directory);
  let handle;
  try { handle = await open(path, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("A stack recovery checkpoint already exists. Resume or abort it before starting another stack operation.", { cause: error });
    }
    throw error;
  }
  let writeError: unknown;
  try { await handle.writeFile(json, "utf8"); await handle.sync(); }
  catch (error) { writeError = error; }
  finally { await handle.close(); }
  if (writeError !== undefined) { await unlink(path).catch(() => undefined); throw writeError; }
}

interface StackLockRecord {
  schemaVersion: 1;
  pid: number;
  token: string;
  command: string;
  startedAt: string;
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export async function acquireStackOperationLock(
  cwd = process.cwd(),
  command = "stack operation",
): Promise<() => Promise<void>> {
  const directory = await recoveryDirectory(cwd);
  const path = join(directory, "operation.lock");
  const token = randomUUID();
  const temp = join(directory, `.operation-${token}.tmp`);
  const record: StackLockRecord = { schemaVersion: 1, pid: process.pid, token, command, startedAt: new Date().toISOString() };
  const handle = await open(temp, "wx", 0o600);
  let writeError: unknown;
  try { await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8"); await handle.sync(); }
  catch (error) { writeError = error; }
  finally { await handle.close(); }
  if (writeError !== undefined) { await unlink(temp).catch(() => undefined); throw writeError; }
  // Publish complete owner metadata exclusively. Contenders never see an empty record.
  try { await link(temp, path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const info = await lstat(path).catch(() => null);
    if (info && info.size > 4 * 1024) {
      throw new Error(`Stack operation lock exceeds 4 KiB. Inspect ${path}; do not remove it while a stack command may be running.`, { cause: error });
    }
    if (!info || !info.isFile() || info.isSymbolicLink() || (process.platform !== "win32" && (info.mode & 0o077) !== 0) || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
      throw new Error(`Stack operation lock has unsafe ownership or type. Inspect ${path}; do not remove it while a stack command may be running.`, { cause: error });
    }
    let record: unknown;
    try { record = JSON.parse(await readFile(path, "utf8")); }
    catch (readError) { throw new Error(`Stack operation lock is unreadable. Verify no ggh stack command is running, then remove ${path} to recover.`, { cause: readError }); }
    if (!record || typeof record !== "object" || Array.isArray(record) || typeof (record as Record<string, unknown>).pid !== "number") {
      throw new Error(`Stack operation lock is invalid. Verify no ggh stack command is running, then remove ${path} to recover.`, { cause: error });
    }
    const pid = (record as Record<string, unknown>).pid as number;
    const active = Number.isInteger(pid) && pid > 0 && processIsAlive(pid);
    throw new Error(active
      ? `Another stack command is active with PID ${pid}. Wait for it to finish. If it is stuck, inspect ${path} before removing it.`
      : `A stale stack lock for PID ${pid} remains. Verify that process is gone, then remove ${path} to recover.`, { cause: error });
  }
  finally { await unlink(temp).catch(() => undefined); }

  return async () => {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(path, "utf8")); }
    catch { return; }
    if (raw && typeof raw === "object" && !Array.isArray(raw) && (raw as Record<string, unknown>).token === token) {
      await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
  };
}

export async function writeStackRecovery(checkpoint: StackRecoveryCheckpoint, cwd = process.cwd()): Promise<void> {
  const directory = await recoveryDirectory(cwd);
  const validated = parseCheckpoint(checkpoint);
  const json = `${JSON.stringify(validated, null, 2)}\n`;
  if (Buffer.byteLength(json) > MAX_STACK_RECOVERY_BYTES) throw new Error("Stack recovery checkpoint exceeds 64 KiB. Inspect the saved operation before changing it.");
  const path = checkpointPath(directory);
  const temp = join(directory, `.active-${randomUUID()}.tmp`);
  const handle = await open(temp, "wx", 0o600);
  try { await handle.writeFile(json, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temp, path); }
  catch (error) { await unlink(temp).catch(() => undefined); throw error; }
}

export async function clearStackRecovery(cwd = process.cwd()): Promise<void> {
  const directory = await recoveryDirectory(cwd);
  await unlink(checkpointPath(directory)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
}

export async function getBranchTip(branch: string, cwd = process.cwd()): Promise<string> {
  const result = await run("git", ["rev-parse", "--verify", "--quiet", "--end-of-options", `refs/heads/${branch}^{commit}`], { cwd });
  return result.stdout.trim();
}

export async function setBranchTipIfUnchanged(branch: string, next: string, expected: string, cwd = process.cwd()): Promise<void> {
  await execGitWithRetry(["update-ref", `refs/heads/${branch}`, next, expected], { cwd });
}

export async function protectStackTip(operationId: string, index: number, tip: string, cwd = process.cwd()): Promise<void> {
  if (!validOperationId(operationId) || !Number.isInteger(index) || index < 0 || index > 99 || !/^[0-9a-f]{40,64}$/i.test(tip)) {
    throw new Error("Invalid stack recovery tip.");
  }
  await execGitWithRetry(["update-ref", `refs/ggh/stack-recovery/${operationId}/${index}`, tip], { cwd });
}

export async function clearProtectedStackTips(operationId: string, count: number, cwd = process.cwd()): Promise<void> {
  if (!validOperationId(operationId)) throw new Error("Invalid stack recovery operation id.");
  for (let index = 0; index < count; index += 1) {
    await execGitWithRetry(["update-ref", "-d", `refs/ggh/stack-recovery/${operationId}/${index}`], { cwd, maxRetries: 1 }).catch(() => undefined);
  }
}

/** Reads every recorded parent pointer in one git call. */


export async function getBranchMergeBase(
  branch?: string,
  cwd = process.cwd(),
): Promise<string | null> {
  try {
    const targetBranch = branch || (await getCurrentBranch(cwd));
    const { stdout } = await run("git", ["config", `branch.${targetBranch}.gh-merge-base`], { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}


export async function setBranchMergeBase(
  branch: string,
  baseBranch: string,
  cwd = process.cwd(),
): Promise<void> {
  try {
    await run("git", ["config", `branch.${branch}.gh-merge-base`, baseBranch], { cwd });
    await recordParentTip(branch, baseBranch, cwd);
  } catch {
    // Best-effort
  }
}

/**
 * Remembers where the parent's tip was when the child last sat on it. After
 * the parent is amended or rebased, this is the point the child's own commits
 * start from — without it, `git rebase parent` replays the parent's old
 * commits too and conflicts with their rewritten versions.
 */


export async function recordParentTip(branch: string, parent: string, cwd = process.cwd()): Promise<void> {
  const { stdout } = await run("git", ["rev-parse", "--verify", "--quiet", `${parent}^{commit}`], { cwd, reject: false });
  const sha = stdout.trim();
  if (sha) await run("git", ["config", `branch.${branch}.gh-merge-base-sha`, sha], { cwd, reject: false });
}

/**
 * The commit the child's unique work begins after. Prefers the recorded parent
 * tip, then git's reflog-based fork point, then the plain merge base.
 */


export async function getRestackBase(branch: string, parent: string, cwd = process.cwd()): Promise<string> {
  const recorded = await run("git", ["config", `branch.${branch}.gh-merge-base-sha`], { cwd, reject: false });
  const sha = recorded.stdout.trim();
  if (sha) {
    const ancestor = await run("git", ["merge-base", "--is-ancestor", sha, branch], { cwd, reject: false });
    if (ancestor.exitCode === 0) return sha;
  }
  const forkPoint = await run("git", ["merge-base", "--fork-point", parent, branch], { cwd, reject: false });
  if (forkPoint.exitCode === 0 && forkPoint.stdout.trim()) return forkPoint.stdout.trim();
  const base = await run("git", ["merge-base", parent, branch], { cwd });
  return base.stdout.trim();
}


export async function isAncestor(
  ancestor: string,
  descendant: string,
  cwd = process.cwd(),
): Promise<boolean> {
  try {
    await run("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd });
    return true;
  } catch {
    return false;
  }
}


export async function hasRemoteBranch(
  branch: string,
  remote = "origin",
  cwd = process.cwd(),
): Promise<boolean> {
  try {
    const { stdout } = await run("git", ["ls-remote", "--heads", remote, branch], { cwd });
    return stdout.trim().includes(branch);
  } catch {
    return false;
  }
}


export async function getAllMergeBases(cwd = process.cwd()): Promise<Map<string, string>> {
  const bases = new Map<string, string>();
  try {
    const { stdout } = await run("git", ["config", "--get-regexp", "^branch\\..*\\.gh-merge-base$"], {
      cwd,
      reject: false,
    });
    for (const line of stdout.split("\n")) {
      const match = line.match(/^branch\.(.+)\.gh-merge-base\s+(.+)$/);
      if (match) {
        const branchName = match.at(1);
        const baseName = match.at(2)?.trim();
        if (branchName !== undefined && baseName !== undefined) bases.set(branchName, baseName);
      }
    }
  } catch {
    // No recorded bases yet
  }
  return bases;
}


export async function getStackGraph(cwd = process.cwd()): Promise<Map<string, StackNode>> {
  const [branches, bases, current] = await Promise.all([
    listBranches(cwd),
    getAllMergeBases(cwd),
    getCurrentBranch(cwd),
  ]);

  const known = new Set(branches.map((b) => b.name));
  const graph = new Map<string, StackNode>();

  for (const branch of branches) {
    const recordedParent = bases.get(branch.name) ?? null;
    const parentExists = recordedParent ? known.has(recordedParent) : false;
    const parent = recordedParent && parentExists && recordedParent !== branch.name ? recordedParent : null;
    graph.set(branch.name, {
      branch: branch.name,
      parent,
      recordedParent,
      parentExists,
      children: [],
      ahead: 0,
      behind: 0,
      isCurrent: branch.name === current,
    });
  }

  for (const node of graph.values()) {
    if (node.parent) graph.get(node.parent)?.children.push(node.branch);
  }

  await Promise.all(
    [...graph.values()].map(async (node) => {
      if (!node.parent) return;
      try {
        const { stdout } = await run(
          "git",
          ["rev-list", "--left-right", "--count", `${node.parent}...${node.branch}`],
          { cwd },
        );
        const [behind, ahead] = stdout.trim().split(/\s+/).map(Number);
        node.behind = behind || 0;
        node.ahead = ahead || 0;
      } catch {
        // Unrelated histories; leave both at zero
      }
    }),
  );

  return graph;
}

/** Walks from a branch down to the root, nearest parent first. */


export function getStackAncestors(graph: Map<string, StackNode>, branch: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>([branch]);
  let cursor = graph.get(branch)?.parent ?? null;
  while (cursor && !seen.has(cursor)) {
    chain.push(cursor);
    seen.add(cursor);
    cursor = graph.get(cursor)?.parent ?? null;
  }
  return chain;
}

/** Every branch stacked on top of `branch`, parents before children. */


export function getStackDescendants(graph: Map<string, StackNode>, branch: string): string[] {
  const out: string[] = [];
  const queue = [...(graph.get(branch)?.children ?? [])];
  const seen = new Set<string>([branch]);
  while (queue.length > 0) {
    const next = queue.shift() as string;
    if (seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    queue.push(...(graph.get(next)?.children ?? []));
  }
  return out;
}

/** Rebases `branch` onto its recorded parent. Returns false on conflict. */


export async function restackBranch(
  branch: string,
  parent: string,
  cwd = process.cwd(),
): Promise<{ ok: boolean; message: string }> {
  try {
    await execGitWithRetry(["checkout", branch], { cwd });
    const parentRef = await resolveBranchRef(parent, cwd);
    const base = await getRestackBase(branch, parentRef, cwd);
    await execGitWithRetry(["rebase", "--onto", parentRef, base, branch], { cwd });
    await recordParentTip(branch, parentRef, cwd);
    return { ok: true, message: `${branch} rebased onto ${parent}` };
  } catch (err) {
    const text = String(err);
    if (/conflict/i.test(text)) {
      return { ok: false, message: `${branch} has conflicts against ${parent}. Resolve, then run \`ggh stack restack --continue\`.` };
    }
    return { ok: false, message: text };
  }
}


export async function getRebaseBranch(cwd = process.cwd()): Promise<string | null> {
  try {
    const [{ stdout: mergeDir }, { stdout: applyDir }] = await Promise.all([
      run("git", ["rev-parse", "--git-path", "rebase-merge"], { cwd, reject: false }),
      run("git", ["rev-parse", "--git-path", "rebase-apply"], { cwd, reject: false }),
    ]);
    const headName = existsSync(mergeDir.trim())
      ? join(mergeDir.trim(), "head-name")
      : existsSync(applyDir.trim())
        ? join(applyDir.trim(), "head-name")
        : null;
    if (headName && existsSync(headName)) {
      return readFileSync(headName, "utf-8").replace(/^refs\/heads\//, "").trim();
    }
  } catch {
    // Fall through
  }
  return null;
}


export async function getInProgressOperation(
  cwd = process.cwd(),
): Promise<"rebase" | "merge" | "cherry-pick" | null> {
  try {
    const [rebaseMerge, rebaseApply, mergeHead, cherryPickHead] = await Promise.all([
      run("git", ["rev-parse", "--git-path", "rebase-merge"], { cwd }).then((r) => r.stdout.trim()),
      run("git", ["rev-parse", "--git-path", "rebase-apply"], { cwd }).then((r) => r.stdout.trim()),
      run("git", ["rev-parse", "--git-path", "MERGE_HEAD"], { cwd }).then((r) => r.stdout.trim()),
      run("git", ["rev-parse", "--git-path", "CHERRY_PICK_HEAD"], { cwd }).then((r) => r.stdout.trim()),
    ]);

    if (existsSync(rebaseMerge) || existsSync(rebaseApply)) return "rebase";
    if (existsSync(mergeHead)) return "merge";
    if (existsSync(cherryPickHead)) return "cherry-pick";
  } catch {
    // Fall through to null
  }
  return null;
}


export async function isRebaseInProgress(cwd = process.cwd()): Promise<boolean> {
  try {
    const [{ stdout: mergeDir }, { stdout: applyDir }] = await Promise.all([
      run("git", ["rev-parse", "--git-path", "rebase-merge"], { cwd }),
      run("git", ["rev-parse", "--git-path", "rebase-apply"], { cwd }),
    ]);
    return existsSync(mergeDir.trim()) || existsSync(applyDir.trim());
  } catch {
    return false;
  }
}
