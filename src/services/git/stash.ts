/**
 * Stash management. Depends on exec only.
 */

import { run } from "../../utils/exec.ts";
import { execGitWithRetry } from "./exec.ts";

export interface StashEntry {
  ref: string;
  date: string;
  message: string;
}


export async function stashList(cwd = process.cwd()): Promise<StashEntry[]> {
  try {
    const { stdout } = await run("git", ["stash", "list", "--pretty=format:%gd%x00%cr%x00%gs"], { cwd });
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.split("\0");
        return {
          ref: parts[0]?.trim() || "",
          date: parts[1]?.trim() || "",
          message: parts[2]?.trim() || "",
        };
      });
  } catch {
    return [];
  }
}


export async function stashPush(message?: string, cwd = process.cwd()): Promise<void> {
  const args = ["stash", "push", "-u"];
  if (message && message.trim().length > 0) {
    args.push("-m", message.trim());
  }
  await execGitWithRetry(args, { cwd });
}


export async function stashPop(ref?: string, cwd = process.cwd()): Promise<void> {
  const args = ["stash", "pop"];
  if (ref) {
    args.push(ref);
  }
  await execGitWithRetry(args, { cwd });
}


export async function stashDrop(ref: string, cwd = process.cwd()): Promise<void> {
  await execGitWithRetry(["stash", "drop", ref], { cwd });
}


export async function stashDiff(ref: string, cwd = process.cwd()): Promise<string> {
  try {
    const { stdout } = await run("git", ["stash", "show", "-p", "-u", ref], { cwd });
    return stdout;
  } catch {
    return "";
  }
}
