import { existsSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../utils/exec.ts";
import { getRepoRoot } from "./branch.ts";

export type ChangeTuple = [xy: string, path: string] | [xy: string, path: string, origPath: string];

export interface CheckoutState {
  /** Canonical worktree root. */
  root: string;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  counts: { staged: number; unstaged: number; untracked: number; conflicts: number };
  operation: string | null;
  changes: ChangeTuple[];
  submodules: Array<[path: string, marker: string]>;
  rawChanges: string[];
  /** Absolute git dir, or "" when unavailable. */
  gitDir: string;
}

/** Parses `git status --porcelain=v2 --branch -z` output. */
export function parseCheckoutStatus(stdout: string): Omit<CheckoutState, "root" | "operation" | "gitDir"> {
  let branch: string | null = null;
  let head: string | null = null;
  const rawChanges: string[] = [];
  const changes: ChangeTuple[] = [];
  const submodules: Array<[path: string, marker: string]> = [];
  const counts = { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 };
  let rename: [xy: string, path: string] | undefined;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  for (const field of stdout.split("\0")) {
    if (!field) continue;
    if (rename) { rawChanges.push(field); changes.push([...rename, field]); rename = undefined; continue; }
    if (field.startsWith("# branch.head ")) branch = field.slice(14) === "(detached)" ? null : field.slice(14);
    if (field.startsWith("# branch.oid ")) head = field.slice(13) === "(initial)" ? null : field.slice(13);
    if (!field.startsWith("# ")) {
      rawChanges.push(field);
      if (field.startsWith("? ") || field.startsWith("! ")) {
        changes.push([field.startsWith("? ") ? "??" : "!!", field.slice(2)]);
        if (field.startsWith("? ")) counts.untracked++;
      } else {
        // Split only the fixed metadata prefix. Paths may contain spaces and newlines.
        const match = /^(1|2) (\S{2}) (\S{4}) (?:\S+ ){5}([\s\S]*)$/.exec(field);
        const unmerged = /^u (\S{2}) (\S{4}) (?:\S+ ){7}([\s\S]*)$/.exec(field);
        const xy = unmerged?.[1] ?? match?.[2];
        const marker = unmerged?.[2] ?? match?.[3];
        let path = unmerged?.[3] ?? match?.[4];
        if (!xy || !marker || path === undefined) throw new Error("Invalid porcelain-v2 change record.");
        if (field.startsWith("2 ")) {
          const separator = path.indexOf(" ");
          if (separator < 0) throw new Error("Invalid porcelain-v2 rename record.");
          path = path.slice(separator + 1);
          rename = [xy, path];
        } else changes.push([xy, path]);
        if (marker !== "N...") submodules.push([path, marker]);
        if (unmerged) counts.conflicts++;
        else {
          if (xy[0] !== ".") counts.staged++;
          if (xy[1] !== ".") counts.unstaged++;
        }
      }
    }
    if (field.startsWith("# branch.upstream ")) upstream = field.slice(18);
    const ab = /^# branch\.ab \+(\d+) -(\d+)$/.exec(field);
    if (ab) { ahead = Number(ab[1]); behind = Number(ab[2]); }
  }
  return { branch, head, upstream, ahead, behind, counts, changes, submodules, rawChanges };
}

/**
 * Reads branch, HEAD, drift, change counts and any in-progress operation in one
 * porcelain-v2 pass. Null outside a worktree; throws when a worktree's status cannot be read.
 */
export async function readCheckoutState(options: { untracked: "all" | "no"; cwd?: string }): Promise<CheckoutState | null> {
  const [root, branchInfo, gitDir] = await Promise.all([
    getRepoRoot(options.cwd).catch(() => ""),
    run("git", ["status", "--porcelain=v2", "--branch", "-z", options.untracked === "all" ? "-uall" : "--untracked-files=no"], { reject: false, cwd: options.cwd }),
    run("git", ["rev-parse", "--absolute-git-dir"], { reject: false, cwd: options.cwd }),
  ]);
  if (!root) return null;
  if (branchInfo.exitCode !== 0) throw new Error(branchInfo.stderr || "Cannot read Git status.");
  const directory = gitDir.stdout.trim();
  let operation: string | null = null;
  for (const [file, name] of [
    ["rebase-merge", "rebase"], ["rebase-apply", "rebase"], ["MERGE_HEAD", "merge"],
    ["CHERRY_PICK_HEAD", "cherry-pick"], ["REVERT_HEAD", "revert"], ["sequencer", "sequencer"], ["BISECT_LOG", "bisect"],
  ] as const) {
    if (directory && existsSync(join(directory, file))) { operation = name; break; }
  }
  return { root, ...parseCheckoutStatus(branchInfo.stdout), operation, gitDir: directory };
}
