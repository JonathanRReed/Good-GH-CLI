export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: "pipe" | "inherit";
  input?: string;
  timeoutMs?: number;
  reject?: boolean;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class ExecError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;

  constructor(command: string, args: string[], result: RunResult, reason?: "timeout") {
    const label = `${command} ${args.join(" ")}`.trim();
    const detail = reason === "timeout" ? "timed out" : `exited with code ${result.exitCode}`;
    const stderrPart = result.stderr.trim() ? `\n${result.stderr.trim()}` : "";
    super(`${label} ${detail}${stderrPart}`);
    this.name = "ExecError";
    this.stdout = result.stdout;
    this.stderr = result.stderr;
    this.exitCode = result.exitCode;
  }
}

const liveChildren = new Set<{ kill: (signal?: number) => void }>();

/** Terminates every subprocess this process started. Used by the signal handler. */
export function killAllChildren(): void {
  for (const child of liveChildren) {
    try {
      child.kill(9);
    } catch {
      // Already exited
    }
  }
  liveChildren.clear();
}

const commandCache = new Map<string, boolean>();

/**
 * Resolves a binary on PATH. Cached because provider availability is probed on
 * nearly every command and PATH does not change mid-process.
 */
export function commandExists(command: string): boolean {
  const cached = commandCache.get(command);
  if (cached !== undefined) return cached;
  const found = Bun.which(command) !== null;
  commandCache.set(command, found);
  return found;
}

/**
 * Bun-native subprocess runner (drop-in replacement for the execa patterns used here).
 * Captures stdout/stderr as text, supports inherited stdio, stdin input, timeouts,
 * and execa-style `reject: false` semantics.
 */
export async function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const inherit = options.stdio === "inherit";
  const proc = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdin: inherit ? "inherit" : options.input !== undefined ? "pipe" : "ignore",
    stdout: inherit ? "inherit" : "pipe",
    stderr: inherit ? "inherit" : "pipe",
  });

  liveChildren.add(proc);

  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  if (options.timeoutMs) {
    timeoutId = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill(9);
      } catch {
        // Process already exited
      }
    }, options.timeoutMs);
  }

  if (options.input !== undefined && proc.stdin) {
    proc.stdin.write(options.input);
    proc.stdin.end();
  }

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
      proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
      proc.exited,
    ]);

    const result: RunResult = { stdout, stderr, exitCode: exitCode ?? 0 };

    if (timedOut) {
      throw new ExecError(command, args, result, "timeout");
    }
    if (result.exitCode !== 0 && options.reject !== false) {
      throw new ExecError(command, args, result);
    }
    return result;
  } finally {
    liveChildren.delete(proc);
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
