import { run } from "../../utils/exec.ts";

/** Git resolves linked worktrees, common metadata, and core.hooksPath itself. */
export async function getGitPath(path: string, cwd = process.cwd()): Promise<string> {
  const { stdout } = await run("git", ["rev-parse", "--path-format=absolute", "--git-path", path], { cwd });
  const resolved = stdout.trim();
  if (!resolved) throw new Error(`Git could not resolve its ${path} path.`);
  return resolved;
}
