/**
 * Worktree management. Depends on exec/branch/stack only.
 */

import { run } from "../../utils/exec.ts";
import { existsSync, appendFileSync, readFileSync, copyFileSync, realpathSync } from "node:fs";
import { join, isAbsolute, relative } from "node:path";
import { execGitWithRetry } from "./exec.ts";
import { getCurrentBranch, getRepoRoot, hasBranch, hasCommits } from "./branch.ts";
import { getBranchMergeBase, setBranchMergeBase } from "./stack.ts";

export interface WorktreeInfo {
  path: string;
  head: string;
  branch: string;
  isBare: boolean;
}


export interface WorktreeAddResult {
  copiedEnvFiles: string[];
}


export async function worktreeList(cwd = process.cwd()): Promise<WorktreeInfo[]> {
  const { stdout } = await run("git", ["worktree", "list", "--porcelain"], { cwd });
  const entries: WorktreeInfo[] = [];

  const blocks = stdout.split("\n\n");
  for (const block of blocks) {
    if (!block.trim()) continue;
    let path = "";
    let head = "";
    let branch = "";
    let isBare = false;

    const lines = block.split("\n");
    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        path = line.replace("worktree ", "").trim();
      } else if (line.startsWith("HEAD ")) {
        head = line.replace("HEAD ", "").trim();
      } else if (line.startsWith("branch ")) {
        branch = line.replace("branch refs/heads/", "").trim();
      } else if (line === "bare") {
        isBare = true;
      }
    }

    if (path) {
      entries.push({ path, head, branch: branch || head, isBare });
    }
  }

  return entries;
}


export async function worktreeAdd(
  branch: string,
  targetPath: string,
  baseBranch?: string,
  cwd = process.cwd(),
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
    const canonicalPath = realpathSync(resolvedPath);
    // Never recursively delete anything outside the repository
    const rel = relative(repoRoot, canonicalPath);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(
        `Refusing to clean up '${resolvedPath}': it is outside the repository root '${repoRoot}'.`,
      );
    }

    const activeTrees = await worktreeList(repoRoot);
    const isActive = activeTrees.some((w) => {
      if (!existsSync(w.path)) return false;
      return realpathSync(w.path) === canonicalPath;
    });
    if (isActive) {
      throw new Error(`Worktree directory '${resolvedPath}' is already an active worktree.`);
    }
    throw new Error(
      `Refusing to replace existing directory '${resolvedPath}'. Move or remove it explicitly, then retry.`,
    );
  }

  // Ensure .worktrees is ignored in .git/info/exclude
  const excludePath = join(repoRoot, ".git", "info", "exclude");
  if (existsSync(excludePath)) {
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

  // A fresh worktree with no .env cannot run the project, so carry them over.
  const copiedEnvFiles: string[] = [];
  const envFileCandidates = [".env", ".env.local", ".env.development"];
  for (const envName of envFileCandidates) {
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
  if (existsSync(gitmodulesPath)) {
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
  if (branchAlreadyExists) {
    const existingBase = await getBranchMergeBase(branch, repoRoot);
    if (!existingBase) await setBranchMergeBase(branch, base, repoRoot);
  } else {
    await setBranchMergeBase(branch, base, repoRoot);
  }

  return { copiedEnvFiles };
}


export async function worktreeRemove(
  targetPath: string,
  force = false,
  cwd = process.cwd(),
): Promise<void> {
  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push("--", targetPath);
  await execGitWithRetry(args, { cwd });
  await execGitWithRetry(["worktree", "prune"], { cwd });
}
