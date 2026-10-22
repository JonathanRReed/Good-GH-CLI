import { getGitPath } from "./paths.ts";
/**
 * Worktree management. Depends on exec/branch/stack only.
 */

import { run, type RunOptions } from "../../utils/exec.ts";
import { existsSync, appendFileSync, readFileSync, copyFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, isAbsolute, resolve } from "node:path";
import { execGitWithRetry } from "./exec.ts";
import { getCurrentBranch, getRepoRoot, hasBranch, hasCommits } from "./branch.ts";
import { getBranchMergeBase, setBranchMergeBase } from "./stack.ts";

export interface WorktreeInfo {
  path: string;
  head: string;
  branch: string | null;
  detached: boolean;
  isBare: boolean;
  locked: boolean;
  lockReason: string | null;
  prunable: boolean;
  pruneReason: string | null;
}


export interface WorktreeAddResult {
  copiedEnvFiles: string[];
}


function sameDirectory(left: string, right: string): boolean {
  try {
    const leftStat = statSync(left, { bigint: true });
    const rightStat = statSync(right, { bigint: true });
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch {
    return false;
  }
}


function isStrictDescendant(directory: string, candidate: string): boolean {
  let current = realpathSync(candidate);
  let movedToParent = false;

  while (true) {
    if (sameDirectory(directory, current)) return movedToParent;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
    movedToParent = true;
  }
}


export async function worktreeList(cwd = process.cwd(), options: Omit<RunOptions, "cwd"> = {}): Promise<WorktreeInfo[]> {
  const { stdout } = await run("git", ["worktree", "list", "--porcelain", "-z"], { ...options, cwd });
  const entries: WorktreeInfo[] = [];
  for (const block of stdout.split("\0\0")) {
    const entry: WorktreeInfo = {
      path: "", head: "", branch: null, detached: false, isBare: false,
      locked: false, lockReason: null, prunable: false, pruneReason: null,
    };
    for (const field of block.split("\0")) {
      if (field.startsWith("worktree ")) entry.path = field.slice(9);
      else if (field.startsWith("HEAD ")) entry.head = field.slice(5);
      else if (field.startsWith("branch ")) entry.branch = field.slice(7).replace(/^refs\/heads\//, "");
      else if (field === "detached") entry.detached = true;
      else if (field === "bare") entry.isBare = true;
      else if (field === "locked" || field.startsWith("locked ")) {
        entry.locked = true;
        entry.lockReason = field.slice(7) || null;
      } else if (field === "prunable" || field.startsWith("prunable ")) {
        entry.prunable = true;
        entry.pruneReason = field.slice(9) || null;
      }
    }
    if (entry.path) entries.push(entry);
  }
  return entries;
}


export async function worktreeAdd(
  branch: string,
  targetPath: string,
  baseBranch?: string,
  cwd = process.cwd(),
  options: { copyEnv?: boolean } = {},
): Promise<WorktreeAddResult> {
  return createWorktree(branch, targetPath, baseBranch, cwd, { ...options, development: true, submodules: true });
}

export async function checkoutForReview(
  branch: string,
  targetPath: string,
  options: { cwd?: string; baseBranch?: string; submodules?: boolean; detached?: boolean; reuse?: boolean } = {},
): Promise<WorktreeAddResult> {
  const cwd = options.cwd ?? process.cwd();
  if (options.detached) {
    const root = await getRepoRoot(cwd);
    const target = resolve(root, targetPath);
    if (existsSync(target)) {
      const tree = (await worktreeList(root)).find(tree => sameDirectory(tree.path, target));
      if (!options.reuse || !tree || !tree.detached || tree.locked) {
        throw new Error(`Refusing to reuse '${target}': expected an unlocked, detached review worktree.`);
      }
      const status = await run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: target });
      if (status.stdout) throw new Error(`Review checkout '${target}' is dirty. Commit, stash, or remove its changes before retrying.`);
      await run("git", ["-c", "core.hooksPath=", "checkout", "--detach", branch], { cwd: target });
    } else {
      await run("git", ["-c", "core.hooksPath=", "worktree", "add", "--detach", "--", target, branch], { cwd: root });
    }
    return { copiedEnvFiles: [] };
  }
  return createWorktree(branch, targetPath, options.baseBranch, cwd, {
    development: false, copyEnv: false, submodules: options.submodules ?? false,
  });
}

async function createWorktree(
  branch: string,
  targetPath: string,
  baseBranch: string | undefined,
  cwd: string,
  options: { development: boolean; copyEnv?: boolean; submodules: boolean },
): Promise<WorktreeAddResult> {
  const repoRoot = await getRepoRoot(cwd);
  if (!(await hasCommits(repoRoot))) {
    throw new Error(
      "Cannot create a worktree in an empty repository with no commits. Please make an initial commit first.",
    );
  }

  const resolvedPath = isAbsolute(targetPath) ? targetPath : join(repoRoot, targetPath);

  // If destination folder exists on disk, check if it's an orphaned worktree directory
  if (existsSync(resolvedPath)) {
    // Never recursively delete anything outside the repository
    if (!isStrictDescendant(repoRoot, resolvedPath)) {
      throw new Error(
        `Refusing to clean up '${resolvedPath}': it is outside the repository root '${repoRoot}'.`,
      );
    }

    const activeTrees = await worktreeList(repoRoot);
    const isActive = activeTrees.some((w) => sameDirectory(w.path, resolvedPath));
    if (isActive) {
      throw new Error(`Worktree directory '${resolvedPath}' is already an active worktree.`);
    }
    throw new Error(
      `Refusing to replace existing directory '${resolvedPath}'. Move or remove it explicitly, then retry.`,
    );
  }

  // Ensure .worktrees is ignored in .git/info/exclude
  const excludePath = await getGitPath("info/exclude", repoRoot);
  if (options.development && existsSync(excludePath)) {
    const content = readFileSync(excludePath, "utf-8");
    if (!content.includes(".worktrees")) {
      appendFileSync(excludePath, "\n.worktrees/\n");
    }
  }

  const branchAlreadyExists = await hasBranch(branch, repoRoot);
  const base = baseBranch || (await getCurrentBranch(cwd));

  const args = branchAlreadyExists
    ? ["worktree", "add", "--", resolvedPath, branch]
    : ["worktree", "add", "-b", branch, "--", resolvedPath, base];

  await execGitWithRetry(args, { cwd: repoRoot });

  // Environment files are copied only for an explicit development checkout request.
  const copiedEnvFiles: string[] = [];
  const envFileCandidates = [".env", ".env.local", ".env.development"];
  for (const envName of options.copyEnv ? envFileCandidates : []) {
    const srcEnv = join(repoRoot, envName);
    const destEnv = join(resolvedPath, envName);
    if (existsSync(srcEnv) && !existsSync(destEnv)) {
      try {
        copyFileSync(srcEnv, destEnv);
        copiedEnvFiles.push(envName);
      } catch {
        // Best-effort
      }
    }
  }

  // A worktree starts with empty submodule directories; initialise them.
  const gitmodulesPath = join(resolvedPath, ".gitmodules");
  if (options.submodules && existsSync(gitmodulesPath)) {
    try {
      await execGitWithRetry(["submodule", "update", "--init", "--recursive"], {
        cwd: resolvedPath,
        stdio: "inherit",
      });
    } catch {
      // Best-effort
    }
  }

  // Record the parent so `ggh stack` can reconstruct the branch tree later.
  // If the branch already existed with a recorded parent, leave it in place.
  if (options.development) {
    const existingBase = branchAlreadyExists ? await getBranchMergeBase(branch, repoRoot) : null;
    if (!existingBase) await setBranchMergeBase(branch, base, repoRoot);
  }

  return { copiedEnvFiles };
}


export async function worktreeRemove(
  targetPath: string,
  force = false,
  cwd = process.cwd(),
): Promise<void> {
  const list = await worktreeList(cwd);
  const resolvedPath = resolve(cwd, targetPath);
  const target = list.find(entry => entry.path === resolvedPath || sameDirectory(entry.path, resolvedPath));
  if (!target) throw new Error(`Not a registered worktree: '${targetPath}'.`);
  if (!force) {
    const currentRoot = await getRepoRoot(cwd);
    if (sameDirectory(target.path, currentRoot)) throw new Error("Refusing to remove the current worktree. Pass --force to override.");
    if (target === list[0]) throw new Error("Refusing to remove the main worktree. Pass --force to override.");
    if (target.locked) throw new Error(`Worktree is locked${target.lockReason ? `: ${target.lockReason}` : ""}. Pass --force to override.`);
    const { stdout } = await run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: target.path });
    if (stdout.length) throw new Error("Worktree has uncommitted or untracked changes. Pass --force to override.");
  }
  const args = ["worktree", "remove"];
  if (force) args.push("--force", "--force");
  args.push("--", target.path);
  await execGitWithRetry(args, { cwd });
}
