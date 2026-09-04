/**
 * Remote sync: push, pull, clone, prune, and ahead/behind queries.
 * Depends on exec/branch/stack only.
 */

import { run } from "../../utils/exec.ts";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { CloneMode } from "../config.ts";
import { execGitWithRetry } from "./exec.ts";
import { getCurrentBranch, getRemoteTrackingBranch, getRemotes, getRepoRoot, hasBranch, isDetachedHead } from "./branch.ts";
import { getBranchMergeBase } from "./stack.ts";

export async function push(
  options: { remote?: string; branch?: string; setUpstream?: boolean; noVerify?: boolean; forceWithLease?: boolean; cwd?: string } = {},
): Promise<void> {
  const cwd = options.cwd || process.cwd();

  const [detached, remotes] = await Promise.all([isDetachedHead(cwd), getRemotes(cwd)]);

  if (detached) {
    throw new Error("Cannot push from a detached HEAD state. Please create or checkout a branch first.");
  }

  if (remotes.length === 0) {
    throw new Error("No git remotes configured. Please add a remote (e.g. `git remote add origin <url>`) before pushing.");
  }

  const remote = options.remote || (remotes.includes("origin") ? "origin" : (remotes.at(0) ?? "origin"));
  const branch = options.branch || (await getCurrentBranch(cwd));

  const args = ["push"];
  if (options.noVerify) {
    args.push("--no-verify");
  }
  if (options.forceWithLease) {
    args.push("--force-with-lease");
  }
  if (options.setUpstream) {
    args.push("-u", remote, branch);
  } else {
    // Check if tracking branch exists for this branch
    const tracking = await getRemoteTrackingBranch(cwd, branch);
    if (!tracking) {
      args.push("-u", remote, branch);
    }
  }

  await execGitWithRetry(args, { cwd, stdio: "inherit" });
}


export async function pullRebase(cwd = process.cwd()): Promise<void> {
  await execGitWithRetry(["pull", "--rebase"], { cwd, stdio: "inherit" });
}


export async function fetchPrune(cwd = process.cwd()): Promise<void> {
  await execGitWithRetry(["fetch", "--prune"], { cwd });
}


export async function getGoneBranches(cwd = process.cwd()): Promise<string[]> {
  try {
    const { stdout } = await run(
      "git",
      ["for-each-ref", "--format=%(refname:short)%00%(upstream:short)%00%(upstream:track)", "refs/heads"],
      { cwd },
    );
    const gone: string[] = [];
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\0");
      const name = parts[0]?.trim() || "";
      const track = parts[2]?.trim() || "";
      if (track.includes("gone")) gone.push(name);
    }
    return gone;
  } catch {
    return [];
  }
}


export async function deleteLocalBranch(
  branch: string,
  force = false,
  cwd = process.cwd(),
): Promise<void> {
  const flag = force ? "-D" : "-d";
  await execGitWithRetry(["branch", flag, branch], { cwd });
}


export async function isBranchMergedInto(
  branch: string,
  base: string,
  cwd = process.cwd(),
): Promise<boolean> {
  try {
    const { stdout } = await run("git", ["branch", "--merged", base, "--format=%(refname:short)"], { cwd });
    return stdout
      .split("\n")
      .map((b) => b.trim())
      .filter(Boolean)
      .includes(branch);
  } catch {
    return false;
  }
}


export async function countUniqueCommits(
  branch: string,
  base: string,
  cwd = process.cwd(),
): Promise<number> {
  try {
    const { stdout } = await run("git", ["rev-list", "--count", `${base}..${branch}`], { cwd });
    return parseInt(stdout.trim(), 10) || 0;
  } catch {
    return 0;
  }
}


export async function getAheadBehind(
  cwd = process.cwd(),
): Promise<{ ahead: number; behind: number; hasUpstream: boolean }> {
  try {
    const { stdout } = await run(
      "git",
      ["rev-list", "--left-right", "--count", "HEAD...@{u}"],
      { cwd },
    );
    const parts = stdout.trim().split(/\s+/).map(Number);
    return { ahead: parts[0] || 0, behind: parts[1] || 0, hasUpstream: true };
  } catch {
    return { ahead: 0, behind: 0, hasUpstream: false };
  }
}

/**
 * Detects the repository's default branch: recorded merge-base first, then main/master fallback.
 */


export async function getAheadOfDefault(
  defaultBranch?: string,
  cwd = process.cwd(),
): Promise<number> {
  try {
    // Branch probes are independent: overlap current with default detection
    // instead of paying three sequential spawns.
    const currentPromise = getCurrentBranch(cwd);
    const actualDefault =
      defaultBranch && (await hasBranch(defaultBranch, cwd))
        ? defaultBranch
        : await detectDefaultBranch(cwd);
    const current = await currentPromise;
    if (!actualDefault || current === actualDefault) return 0;

    const { stdout } = await run(
      "git",
      ["rev-list", "--count", `${actualDefault}..HEAD`],
      { cwd },
    );
    return parseInt(stdout.trim(), 10) || 0;
  } catch {
    return 0;
  }
}


export async function detectDefaultBranch(cwd = process.cwd()): Promise<string> {
  try {
    const current = await getCurrentBranch(cwd);
    const recordedBase = await getBranchMergeBase(current, cwd);
    if (recordedBase && (await hasBranch(recordedBase, cwd))) {
      return recordedBase;
    }
  } catch {
    // Fall through to main/master detection
  }

  const [hasMain, hasMaster] = await Promise.all([hasBranch("main", cwd), hasBranch("master", cwd)]);
  if (hasMain) return "main";
  if (hasMaster) return "master";
  return "main";
}


export async function clone(
  repoUrl: string,
  destination: string,
  mode: CloneMode = "standard",
  cwd = process.cwd(),
): Promise<void> {
  const args = ["clone"];

  if (mode === "blobless") {
    args.push("--filter=blob:none");
  } else if (mode === "shallow") {
    args.push("--depth", "1");
  }

  args.push("--", repoUrl, destination);
  await execGitWithRetry(args, { cwd, stdio: "inherit" });
}


export async function resolveConflict(
  file: string,
  strategy: "ours" | "theirs" | "mark",
  cwd = process.cwd(),
): Promise<void> {
  if (strategy === "ours") {
    await execGitWithRetry(["checkout", "--ours", "--", file], { cwd });
    await execGitWithRetry(["add", "--", file], { cwd });
  } else if (strategy === "theirs") {
    await execGitWithRetry(["checkout", "--theirs", "--", file], { cwd });
    await execGitWithRetry(["add", "--", file], { cwd });
  } else if (strategy === "mark") {
    await execGitWithRetry(["add", "--", file], { cwd });
  }
}


export async function discardFiles(
  files: { path: string; staged?: boolean; untracked?: boolean }[],
  cwd = process.cwd(),
): Promise<void> {
  const hasUntracked = files.some((f) => f.untracked);
  const root = hasUntracked ? await getRepoRoot(cwd) : "";

  for (const f of files) {
    if (f.untracked) {
      rmSync(join(root, f.path), { force: true, recursive: true });
    } else if (f.staged) {
      await execGitWithRetry(["restore", "--staged", "--worktree", "--", f.path], { cwd });
    } else {
      await execGitWithRetry(["restore", "--", f.path], { cwd });
    }
  }
}
