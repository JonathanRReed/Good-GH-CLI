/**
 * Git execution with lock-file retry. Leaf module: only depends on utils/exec.
 */

import { run } from "../../utils/exec.ts";

export const NON_INTERACTIVE_ENV = Object.freeze({
  GCM_INTERACTIVE: "never",
  GIT_ASKPASS: "",
  GIT_TERMINAL_PROMPT: "0",
  SSH_ASKPASS: "",
  SSH_ASKPASS_REQUIRE: "never",
});

/**
 * Executes a git command with exponential backoff retry if index.lock or HEAD.lock is encountered.
 *
 * Policy: every git command that MUTATES state goes through here (commit,
 * push, pull, clone, checkout, stash, worktree add/remove, apply...).
 * Pure reads use `run("git", ...)` directly — retrying a read that failed
 * for a real reason only delays its error.
 */


export async function execGitWithRetry(
  args: string[],
  options: {
    cwd?: string;
    maxRetries?: number;
    delayMs?: number;
    nonInteractive?: boolean;
    env?: NodeJS.ProcessEnv;
    /** Inherit stdio (push/pull/clone progress). Implies no output capture. */
    stdio?: "inherit";
    /** Stdin payload (apply). */
    input?: string;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  const cwd = options.cwd || process.cwd();
  const maxRetries = options.maxRetries ?? 3;
  let delay = options.delayMs ?? 250;
  // Default to non-interactive when stdin is not a TTY so git never blocks on credential prompts
  const nonInteractive = options.nonInteractive ?? !process.stdin.isTTY;
  const env = nonInteractive
    ? { ...process.env, ...options.env, ...NON_INTERACTIVE_ENV }
    : options.env
      ? { ...process.env, ...options.env }
      : undefined;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await run("git", args, { cwd, env, stdio: options.stdio, input: options.input });
    } catch (err: unknown) {
      lastErr = err;
      const errStr = String(err);
      const isLockError =
        errStr.includes("index.lock") ||
        errStr.includes("HEAD.lock") ||
        (errStr.includes("Unable to create") && errStr.includes(".lock"));

      if (isLockError && attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 1.5;
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}
