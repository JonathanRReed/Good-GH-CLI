/**
 * Local branch and repository inspection. Leaf module: only shells git directly.
 */

import { run } from "../../utils/exec.ts";
import { realpathSync } from "node:fs";

export interface BranchInfo {
  name: string;
  current: boolean;
  commit: string;
}


export async function getRepoRoot(cwd = process.cwd()): Promise<string> {
  const { stdout } = await run("git", ["rev-parse", "--show-toplevel"], { cwd });
  // Git for Windows can expand an 8.3 path such as RUNNER~1 to its long form.
  // Canonicalising here keeps later containment and equality checks reliable.
  return realpathSync(stdout.trim());
}


export async function hasCommits(cwd = process.cwd()): Promise<boolean> {
  try {
    await run("git", ["rev-parse", "--verify", "HEAD"], { cwd });
    return true;
  } catch {
    return false;
  }
}


export async function hasBranch(branch: string, cwd = process.cwd()): Promise<boolean> {
  try {
    await run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd });
    return true;
  } catch {
    return false;
  }
}


export async function getCurrentBranch(cwd = process.cwd()): Promise<string> {
  // `rev-parse --abbrev-ref HEAD` fails on an unborn branch (a fresh repo with no
  // commits), which would report the branch as "HEAD" and trip the detached-HEAD
  // guards. `branch --show-current` resolves it, and returns "" when detached.
  try {
    const { stdout } = await run("git", ["branch", "--show-current"], { cwd });
    const name = stdout.trim();
    if (name) return name;
  } catch {
    // Fall through to rev-parse
  }

  try {
    const { stdout } = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
    return stdout.trim() || "HEAD";
  } catch {
    return "HEAD";
  }
}


export async function listBranches(cwd = process.cwd()): Promise<BranchInfo[]> {
  try {
    const { stdout } = await run(
      "git",
      // NUL-delimited so branch names containing "|" (or subjects containing "|") parse correctly
      ["for-each-ref", "--format=%(refname:short)%00%(HEAD)%00%(subject)", "refs/heads"],
      { cwd },
    );
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.split("\0");
        const name = parts[0]?.trim() || "";
        const head = parts[1]?.trim() || "";
        const commit = parts[2]?.trim() || "";
        return {
          name,
          current: head === "*",
          commit,
        };
      });
  } catch {
    return [];
  }
}


export async function isDetachedHead(cwd = process.cwd()): Promise<boolean> {
  try {
    await run("git", ["symbolic-ref", "-q", "HEAD"], { cwd });
    return false;
  } catch {
    return true;
  }
}


export async function getCommitCount(cwd = process.cwd()): Promise<number> {
  try {
    const { stdout } = await run("git", ["rev-list", "--count", "HEAD"], { cwd });
    return parseInt(stdout.trim(), 10) || 0;
  } catch {
    return 0;
  }
}


export async function getRemotes(cwd = process.cwd()): Promise<string[]> {
  try {
    const { stdout } = await run("git", ["remote"], { cwd });
    return stdout
      .split("\n")
      .map((r) => r.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}


export async function getRemoteTrackingBranch(cwd = process.cwd(), branch?: string): Promise<string | null> {
  try {
    const ref = branch ? `${branch}@{u}` : "@{u}";
    const { stdout } = await run("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", ref], { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}


/** Resolve a branch for local Git operations without changing its GitHub name. */
export async function resolveBranchRef(branch: string, cwd = process.cwd()): Promise<string> {
  if (!branch || branch.startsWith("-") || branch.includes("\0")) throw new Error("Invalid branch reference.");
  const refs = [`refs/heads/${branch}`,
    ...[...new Set(["origin", ...await getRemotes(cwd)])].map((remote) => `refs/remotes/${remote}/${branch}`), branch];
  for (const ref of refs) {
    const result = await run("git", ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], { cwd, reject: false });
    if (result.exitCode === 0) return ref;
  }
  throw new Error(`Branch/reference "${branch}" is not available locally. Fetch it before continuing.`);
}
