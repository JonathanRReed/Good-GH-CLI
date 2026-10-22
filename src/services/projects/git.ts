import { availableParallelism } from "node:os";
import { run, type RunOptions, type RunResult } from "../../utils/exec.ts";

// Inventory must neither inherit another checkout's GIT_DIR nor refresh indexes.
export const inventoryGitOptions: RunOptions = {
  envAllowlist: ["GIT_OPTIONAL_LOCKS", "GIT_NO_LAZY_FETCH", "GIT_TERMINAL_PROMPT"], env: { GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
};

export async function projectGit(cwd: string, args: string[], deadline = Date.now() + 3000): Promise<RunResult> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Project deadline exceeded");
  return run("git", ["-c", "core.fsmonitor=false", ...args], { ...inventoryGitOptions, cwd, timeoutMs: remaining });
}

export function gitLine(text: string): string { return text.replace(/\r?\n$/, ""); }

export async function projectPool<T, R>(items: readonly T[], worker: (item: T) => Promise<R>, concurrency = Math.min(16, availableParallelism())): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) throw new Error("Project workers must be between 1 and 64.");
  const results: R[] = [];
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const slot = index++;
      const item = items[slot];
      if (item === undefined) return;
      results[slot] = await worker(item);
    }
  }));
  return results;
}
