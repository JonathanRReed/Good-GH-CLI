/**
 * Stacked-branch graph (git-config parent pointers) and restack. Depends on exec/branch only.
 */

import { run } from "../../utils/exec.ts";
import { existsSync, readFileSync } from "node:fs";
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
