/**
 * Helpers used only by tests. Moved out of src/services/git.ts
 * so production code does not ship test-only surface.
 */

import { run } from "../src/utils/exec.ts";
import { getRemotes, hasBranch } from "../src/services/git.ts";

export async function hasRemote(name = "origin", cwd = process.cwd()): Promise<boolean> {
  const remotes = await getRemotes(cwd);
  return remotes.includes(name);
}


export async function getUnmergedCommits(
  branch: string,
  base = "main",
  cwd = process.cwd(),
): Promise<string[]> {
  try {
    const [baseExists, masterExists] = await Promise.all([
      hasBranch(base, cwd),
      hasBranch("master", cwd),
    ]);
    const actualBase = baseExists ? base : masterExists ? "master" : "HEAD";
    const { stdout } = await run("git", ["cherry", actualBase, branch], { cwd });
    return stdout
      .split("\n")
      .filter((line) => line.startsWith("+"))
      .map((line) => line.slice(2).trim());
  } catch {
    return [];
  }
}
