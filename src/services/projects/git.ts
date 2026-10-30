import { availableParallelism } from "node:os";
import { join } from "node:path";
import { NON_INTERACTIVE_ENV } from "../git/exec.ts";
import { run, type RunOptions, type RunResult } from "../../utils/exec.ts";

// Inventory must neither inherit another checkout's GIT_DIR nor refresh indexes.
export const inventoryGitOptions: RunOptions = {
  envAllowlist: ["GIT_OPTIONAL_LOCKS", "GIT_NO_LAZY_FETCH", "GIT_TERMINAL_PROMPT"], env: { GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
};

/** Network operations preserve credential helpers, but never prompt for SSH input. */
export const projectNetworkOptions: RunOptions = {
  envAllowlist: ["SSH_AUTH_SOCK", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST", "GH_CONFIG_DIR", "GH_PROMPT_DISABLED", "GIT_TERMINAL_PROMPT", "GIT_ASKPASS", "GCM_INTERACTIVE", "SSH_ASKPASS", "SSH_ASKPASS_REQUIRE", "GIT_SSH_COMMAND", "GIT_NO_LAZY_FETCH"],
  env: { ...NON_INTERACTIVE_ENV, GH_PROMPT_DISABLED: "1", GIT_NO_LAZY_FETCH: "1", GIT_SSH_COMMAND: "ssh -oBatchMode=yes" },
};
export function projectLockPath(commonDir: string): string { return join(commonDir, "ggh.lock"); }

/** Prune only tracking refs, including in bare clones with mirror refspecs. */
export async function safeTrackingFetch(commonDir: string, remote: string, deadline: number): Promise<void> {
  const timeoutMs = deadline - Date.now();
  if (timeoutMs <= 0) throw new Error("Project fetch deadline exceeded");
  await run("git", ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`, "-c", "submodule.recurse=false", "fetch", "--prune", "--atomic", "--no-tags", "--no-prune-tags", "--refmap=", "--no-recurse-submodules", "--no-auto-maintenance", "--", remote, `+refs/heads/*:refs/remotes/${remote}/*`], { ...projectNetworkOptions, cwd: commonDir, timeoutMs });
}

export async function projectGit(cwd: string, args: string[], deadline = Date.now() + 3000, input?: string): Promise<RunResult> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Project deadline exceeded");
  return run("git", ["--no-replace-objects", "-c", "core.fsmonitor=false", ...args], { ...inventoryGitOptions, cwd, timeoutMs: remaining, input });
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
