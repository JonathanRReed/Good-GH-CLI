import { run } from "../utils/exec.ts";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ChangedFile } from "../utils/diff.ts";


// Domain modules. git.ts is the facade: everything stays importable from here,
// but stash/stack/worktree/branch/exec live in ./git/ next to this file.
export { getGitPath } from "./git/paths.ts";
export { NON_INTERACTIVE_ENV, execGitWithRetry } from "./git/exec.ts";
export type { BranchInfo } from "./git/branch.ts";
export {
  getCommitCount,
  getCurrentBranch,
  getRemoteTrackingBranch,
  getRemotes,
  getRepoRoot,
  hasBranch,
  hasCommits,
  isDetachedHead,
  listBranches,
} from "./git/branch.ts";
export type { StackNode } from "./git/stack.ts";
export {
  getAllMergeBases,
  getBranchMergeBase,
  getInProgressOperation,
  getRebaseBranch,
  getRestackBase,
  getStackAncestors,
  getStackDescendants,
  getStackGraph,
  hasRemoteBranch,
  isAncestor,
  isRebaseInProgress,
  recordParentTip,
  restackBranch,
  setBranchMergeBase,
} from "./git/stack.ts";
export type { WorktreeAddResult, WorktreeInfo } from "./git/worktree.ts";
export { worktreeAdd, worktreeList, worktreeRemove } from "./git/worktree.ts";
export type { StashEntry } from "./git/stash.ts";
export { stashDiff, stashDrop, stashList, stashPop, stashPush } from "./git/stash.ts";
export {
  clone,
  countUniqueCommits,
  deleteLocalBranch,
  detectDefaultBranch,
  detectComparisonBase, detectPullRequestBase,
  discardFiles,
  fetchPrune,
  getAheadBehind,
  getAheadOfDefault,
  getGoneBranches,
  isBranchMergedInto,
  pullRebase,
  push,
  resolveConflict,
} from "./git/sync.ts";

// What the remaining core functions below still call from the domain modules.
import { execGitWithRetry } from "./git/exec.ts";
import {
  getCommitCount,
  getCurrentBranch,
  getRemotes,
  getRepoRoot,
  isDetachedHead,
} from "./git/branch.ts";
import { getBranchMergeBase, setBranchMergeBase } from "./git/stack.ts";

export interface GitStatusResult {
  isRepo: boolean;
  branch: string;
  isDetached?: boolean;
  staged: ChangedFile[];
  unstaged: ChangedFile[];
  untracked: ChangedFile[];
  conflicts: ChangedFile[];
  hasChanges: boolean;
}


export async function isGitRepo(cwd = process.cwd()): Promise<boolean> {
  try {
    const { stdout } = await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Checks `isGitRepo()` and calls `fail()` with a helpful message if not.
 * Returns `true` when safe to proceed. Replaces ~28 copies of the same guard.
 */


export async function requireGitRepo(cwd = process.cwd()): Promise<boolean> {
  if (await isGitRepo(cwd)) return true;
  const { fail } = await import("../utils/ui.ts");
  fail("Not a git repository. Run `git init` or navigate to a repository.");
  return false;
}


export async function switchBranch(
  branch: string,
  create = false,
  cwd = process.cwd(),
  baseBranch?: string,
): Promise<void> {
  const current = await getCurrentBranch(cwd);
  const args = create
    ? baseBranch
      ? ["checkout", "-b", branch, baseBranch]
      : ["checkout", "-b", branch]
    : ["checkout", branch];
  await execGitWithRetry(args, { cwd });
  if (create) {
    const base = baseBranch || current;
    await setBranchMergeBase(branch, base, cwd);
  }
}


export async function renameBranch(
  oldName: string,
  newName: string,
  cwd = process.cwd(),
): Promise<void> {
  await execGitWithRetry(["branch", "-m", oldName, newName], { cwd });
  const mergeBase = await getBranchMergeBase(oldName, cwd);
  if (mergeBase) {
    await setBranchMergeBase(newName, mergeBase, cwd);
  }
}


export async function fetchPullRequestBranch(
  prNumber: number,
  localBranch: string,
  cwd = process.cwd(),
): Promise<void> {
  const remotes = await getRemotes(cwd);
  const remote = remotes.includes("origin") ? "origin" : remotes[0] || "origin";
  await run(
    "git",
    ["fetch", "--quiet", "--no-tags", remote, `+refs/pull/${prNumber}/head:refs/heads/${localBranch}`],
    { cwd },
  );
}


export async function findPrTemplate(cwd = process.cwd()): Promise<string | null> {
  try {
    const repoRoot = await getRepoRoot(cwd);
    const candidates = [
      join(repoRoot, ".github", "pull_request_template.md"),
      join(repoRoot, ".github", "PULL_REQUEST_TEMPLATE.md"),
      join(repoRoot, "pull_request_template.md"),
      join(repoRoot, "PULL_REQUEST_TEMPLATE.md"),
      join(repoRoot, ".github", "PULL_REQUEST_TEMPLATE", "pull_request_template.md"),
    ];

    for (const c of candidates) {
      if (existsSync(c)) {
        return readFileSync(c, "utf-8");
      }
    }
  } catch {
    // Best-effort
  }
  return null;
}

/**
 * Lists all available PR templates by scanning `.github/PULL_REQUEST_TEMPLATE/`
 * and the common single-template locations. Returns `{ name, path, content }`.
 */


export async function listPrTemplates(cwd = process.cwd()): Promise<Array<{ name: string; path: string; content: string }>> {
  try {
    const repoRoot = await getRepoRoot(cwd);
    const results: Array<{ name: string; path: string; content: string }> = [];
    const seen = new Set<string>();

    // Multi-template directory: .github/PULL_REQUEST_TEMPLATE/*.md
    const multiDir = join(repoRoot, ".github", "PULL_REQUEST_TEMPLATE");
    if (existsSync(multiDir)) {
      try {
        const entries = readdirSync(multiDir).filter((f) => f.toLowerCase().endsWith(".md"));
        for (const f of entries) {
          const p = join(multiDir, f);
          const name = f.replace(/\.md$/i, "");
          if (!seen.has(p)) {
            seen.add(p);
            results.push({ name, path: p, content: readFileSync(p, "utf-8") });
          }
        }
      } catch {
        // ignore
      }
    }

    // Single-template locations
    const singleCandidates = [
      { name: "default", path: join(repoRoot, ".github", "pull_request_template.md") },
      { name: "default", path: join(repoRoot, ".github", "PULL_REQUEST_TEMPLATE.md") },
      { name: "default", path: join(repoRoot, "pull_request_template.md") },
      { name: "default", path: join(repoRoot, "PULL_REQUEST_TEMPLATE.md") },
    ];
    for (const c of singleCandidates) {
      if (existsSync(c.path) && !seen.has(c.path)) {
        seen.add(c.path);
        results.push({ name: c.name, path: c.path, content: readFileSync(c.path, "utf-8") });
        break; // only one "default"
      }
    }

    return results;
  } catch {
    return [];
  }
}

/** Finds a specific named PR template. Returns null if not found. */


export async function findPrTemplateByName(name: string, cwd = process.cwd()): Promise<string | null> {
  const templates = await listPrTemplates(cwd);
  const match = templates.find((t) => t.name.toLowerCase() === name.toLowerCase());
  return match?.content ?? null;
}


export async function getStatus(cwd = process.cwd()): Promise<GitStatusResult> {
  // Probe repo state and porcelain status in parallel (independent git calls)
  const [inRepo, isDetached, branch, statusResult] = await Promise.all([
    isGitRepo(cwd),
    isDetachedHead(cwd),
    getCurrentBranch(cwd),
    run(
      "git",
      ["-c", "core.quotepath=false", "status", "--porcelain=v1", "-z", "-uall"],
      { cwd, reject: false },
    ).catch(() => ({ stdout: "", stderr: "", exitCode: 128 })),
  ]);

  if (!inRepo) {
    return {
      isRepo: false,
      branch: "",
      isDetached: false,
      staged: [],
      unstaged: [],
      untracked: [],
      conflicts: [],
      hasChanges: false,
    };
  }

  const stdout = statusResult.stdout;

  const staged: ChangedFile[] = [];
  const unstaged: ChangedFile[] = [];
  const untracked: ChangedFile[] = [];
  const conflicts: ChangedFile[] = [];

  // With -z, `git status --porcelain=v1` emits NUL-separated records.
  // Normal entries are `XY <path>\0`. Renames and copies are
  // `XY <new_path>\0<old_path>\0`; the score is never printed in -z mode,
  // so the path always begins at the third character.
  const rawEntries = stdout.split("\0");
  let i = 0;
  while (i < rawEntries.length) {
    const entry = rawEntries[i];
    if (!entry) {
      i++;
      continue;
    }

    const x = entry[0];
    const y = entry[1] || " ";
    const filePath = entry.length > 3 ? entry.slice(3) : "";

    // For renames/copies, consume the original path so it is not reported
    // as a separate file. `filePath` is already the new (target) path.
    if ((x === "R" || x === "C") && i + 1 < rawEntries.length) {
      i++;
    }

    // Merge conflict states
    if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
      conflicts.push({ path: filePath, status: "conflict", staged: false });
      i++;
      continue;
    }

    if (x === "?" && y === "?") {
      untracked.push({ path: filePath, status: "untracked", staged: false });
      i++;
      continue;
    }

    // Staged changes (X column)
    if (x !== " " && x !== "?") {
      let status: ChangedFile["status"] = "modified";
      if (x === "A") status = "added";
      else if (x === "D") status = "deleted";
      else if (x === "R" || x === "C") status = "renamed";
      staged.push({ path: filePath, status, staged: true });
    }

    // Unstaged changes (Y column)
    if (y !== " " && y !== "?") {
      let status: ChangedFile["status"] = "modified";
      if (y === "D") status = "deleted";
      unstaged.push({ path: filePath, status, staged: false });
    }

    i++;
  }

  const hasChanges =
    staged.length > 0 || unstaged.length > 0 || untracked.length > 0 || conflicts.length > 0;

  return {
    isRepo: true,
    branch,
    isDetached,
    staged,
    unstaged,
    untracked,
    conflicts,
    hasChanges,
  };
}


export async function stageFiles(files: string[], cwd = process.cwd()): Promise<void> {
  if (files.length === 0) return;
  await execGitWithRetry(["add", "--", ...files], { cwd });
}


export async function stageAll(cwd = process.cwd()): Promise<void> {
  await execGitWithRetry(["add", "-A"], { cwd });
}

/** Unstages all staged changes (equivalent to `git reset HEAD --`). */


export async function unstageAll(cwd = process.cwd()): Promise<void> {
  await execGitWithRetry(["reset", "HEAD", "--"], { cwd });
}


export async function getStagedDiff(cwd = process.cwd()): Promise<string> {
  const { stdout } = await run("git", ["diff", "--cached"], { cwd });
  return stdout;
}


export async function getStagedDiffStat(cwd = process.cwd()): Promise<string> {
  try {
    const { stdout } = await run("git", ["diff", "--cached", "--stat"], { cwd });
    return stdout.trim();
  } catch {
    return "";
  }
}

/**
 * Diff of the current branch against its merge base with `baseBranch`
 * (`git diff base...HEAD`). This is what a Pull Request actually contains —
 * the staged diff is empty once the commit has been made.
 */


export async function getBranchDiff(baseBranch: string, cwd = process.cwd()): Promise<string> {
  try {
    const { stdout } = await run("git", ["diff", `${baseBranch}...HEAD`], { cwd });
    return stdout;
  } catch {
    return "";
  }
}


export async function getBranchDiffStat(baseBranch: string, cwd = process.cwd()): Promise<string> {
  try {
    const { stdout } = await run("git", ["diff", "--stat", `${baseBranch}...HEAD`], { cwd });
    return stdout.trim();
  } catch {
    return "";
  }
}

/** Subjects of the commits this branch adds on top of `baseBranch`, newest first. */


export async function getCommitsSinceBase(
  baseBranch: string,
  limit = 50,
  cwd = process.cwd(),
): Promise<string[]> {
  try {
    const { stdout } = await run(
      "git",
      ["log", `${baseBranch}..HEAD`, "--pretty=format:%s", "-n", String(limit)],
      { cwd },
    );
    return stdout.split("\n").filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}


export async function getRecentCommits(count = 10, cwd = process.cwd()): Promise<string[]> {
  try {
    const { stdout } = await run("git", ["log", `-n`, `${count}`, "--oneline"], { cwd });
    return stdout.split("\n").filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
}

/** Returns the subject line of a specific commit. */


export async function getCommitSubject(sha: string, cwd = process.cwd()): Promise<string> {
  const { stdout } = await run("git", ["log", "-1", "--pretty=format:%s", sha], { cwd });
  return stdout.trim();
}

/** Returns true if the given ref resolves to a valid commit. */


export async function isValidCommit(sha: string, cwd = process.cwd()): Promise<boolean> {
  try {
    await run("git", ["rev-parse", "--verify", `${sha}^{commit}`], { cwd });
    return true;
  } catch {
    return false;
  }
}

/** Applies a unified diff patch to the working tree with `git apply`. */


export async function applyPatch(patch: string, cwd = process.cwd()): Promise<void> {
  await execGitWithRetry(["apply", "--whitespace=fix"], { cwd, input: patch });
}


export interface CommitOptions {
  /** Internal alternate-index environment for snapshot-preserving split commits. */
  env?: NodeJS.ProcessEnv;
  noVerify?: boolean;
  gpgSign?: boolean;
  signoff?: boolean;
  amend?: boolean;
  fixup?: string;
  cwd?: string;
}


export interface LargeFileCheckResult {
  blocked: Array<{ path: string; sizeMB: number }>;
  warnings: Array<{ path: string; sizeMB: number }>;
}


export async function checkLargeFiles(
  files: ChangedFile[],
  cwd = process.cwd(),
): Promise<LargeFileCheckResult> {
  const blocked: LargeFileCheckResult["blocked"] = [];
  const warnings: LargeFileCheckResult["warnings"] = [];
  const wanted = new Set(files.filter((f) => f.status !== "deleted").map((f) => f.path));
  if (wanted.size === 0) return { blocked, warnings };
  const { stdout } = await run("git", ["ls-files", "--stage", "-z"], { cwd });
  const entries: Array<{ path: string; oid: string }> = [];
  for (const record of stdout.split("\0")) {
    if (!record) continue;
    const match = /^(\d+) ([a-f0-9]+) ([0-3])\t([\s\S]*)$/.exec(record);
    if (!match || !wanted.has(match[4]!)) continue;
    if (match[3] !== "0") throw new Error("Cannot inspect an unmerged index.");
    wanted.delete(match[4]!);
    if (match[1] !== "160000") entries.push({ path: match[4]!, oid: match[2]! });
  }
  if (wanted.size) throw new Error(`Files are missing from the staged index: ${[...wanted].join(", ")}`);
  if (entries.length === 0) return { blocked, warnings };
  const objects = await run("git", ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], {
    cwd, input: entries.map((e) => e.oid).join("\n") + "\n",
  });
  const sizes = objects.stdout.trim().split("\n");
  for (const [i, entry] of entries.entries()) {
    const fields = sizes[i]?.split(" ");
    const size = Number(fields?.[2]);
    if (fields?.[0] !== entry.oid || fields[1] !== "blob" || !Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Cannot determine staged object size for ${entry.path}.`);
    }
    const item = { path: entry.path, sizeMB: Math.round(size / (1024 * 1024) * 10) / 10 };
    if (size >= 100 * 1024 * 1024) blocked.push(item);
    else if (size >= 50 * 1024 * 1024) warnings.push(item);
  }

  return { blocked, warnings };
}


export interface SubmoduleStatus {
  name: string;
  status: "dirty" | "uninitialized" | "conflict";
  commit: string;
}


export async function checkSubmodules(cwd = process.cwd()): Promise<SubmoduleStatus[]> {
  // No .gitmodules, no submodules: skip the scan entirely. `git submodule
  // status` walks the worktree and costs 100ms+ on large repos for nothing.
  if (!existsSync(join(cwd, ".gitmodules"))) return [];
  try {
    const { stdout } = await run("git", ["submodule", "status"], { cwd });
    const results: SubmoduleStatus[] = [];
    const lines = stdout.split("\n").filter(Boolean);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const flag = line[0];
      const parts = trimmed.split(/\s+/);
      const commit = parts[0]?.replace(/^[-+U]/, "") || "";
      const name = parts[1] || "";

      if (flag === "+") {
        results.push({ name, status: "dirty", commit });
      } else if (flag === "-") {
        results.push({ name, status: "uninitialized", commit });
      } else if (flag === "U") {
        results.push({ name, status: "conflict", commit });
      }
    }
    return results;
  } catch {
    return [];
  }
}


export async function squashCommits(
  count: number,
  cwd = process.cwd(),
): Promise<{ previousMessages: string[]; stagedCount: number }> {
  if (count <= 1) {
    throw new Error("Squash count must be at least 2.");
  }
  const total = await getCommitCount(cwd);
  if (total < count) {
    throw new Error(`Cannot squash ${count} commits: only ${total} commit(s) available.`);
  }

  const { stdout } = await run("git", ["log", `-n`, count.toString(), "--pretty=format:%s"], { cwd });
  const previousMessages = stdout.split("\n").filter(Boolean);

  await execGitWithRetry(["reset", "--soft", `HEAD~${count}`], { cwd });
  const status = await getStatus(cwd);
  return { previousMessages, stagedCount: status.staged.length };
}


export async function commit(
  subject: string,
  body?: string,
  optionsOrCwd: CommitOptions | string = {},
): Promise<string> {
  if (!subject || subject.trim().length === 0) {
    throw new Error("Commit message cannot be empty.");
  }

  const options = typeof optionsOrCwd === "string" ? { cwd: optionsOrCwd } : optionsOrCwd || {};
  const cwd = options.cwd || process.cwd();
  const args = ["commit", "-m", subject.trim()];
  if (options.amend) {
    args.push("--amend");
  }
  if (options.fixup) {
    args.push(`--fixup=${options.fixup}`);
  }
  if (body && body.trim().length > 0) {
    args.push("-m", body.trim());
  }
  if (options.noVerify) {
    args.push("--no-verify");
  }
  if (options.gpgSign) {
    args.push("-S");
  }
  if (options.signoff) {
    args.push("-s");
  }
  const { stdout } = await execGitWithRetry(args, { cwd, env: options.env });
  return stdout;
}


export async function undoCommit(cwd = process.cwd()): Promise<void> {
  const count = await getCommitCount(cwd);
  if (count <= 1) {
    // Only root commit exists. Soft reset to unborn state using update-ref
    await execGitWithRetry(["update-ref", "-d", "HEAD"], { cwd });
  } else {
    await execGitWithRetry(["reset", "--soft", "HEAD~1"], { cwd });
  }
}


export async function gitPassthrough(args: string[], cwd = process.cwd()): Promise<number> {
  const result = await run("git", args, {
    cwd,
    stdio: "inherit",
    reject: false,
  });
  return result.exitCode ?? 0;
}

/* ------------------------------------------------------------------ *
 * Branch stacks
 *
 * Every branch created through ggh already records its parent in git config as
 * `branch.<name>.gh-merge-base`. Read together, those pointers form a tree —
 * which is exactly the data structure a stacked-pull-request workflow needs.
 * ------------------------------------------------------------------ */

export { resolveBranchRef } from "./git/branch.ts";
