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

const liveChildren = new Set<{ pid: number; kill: (signal?: number | NodeJS.Signals) => void }>();

/**
 * Kills a child and, where the platform allows it, everything it spawned. AI
 * CLIs fork helpers; killing only the direct child leaves those running and
 * holding the terminal.
 */
function terminate(child: { pid: number; kill: (signal?: number | NodeJS.Signals) => void }): void {
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Not a group leader (or already gone); fall through to the direct kill.
    }
  }
  try {
    child.kill(process.platform === "win32" ? "SIGTERM" : "SIGKILL");
  } catch {
    // Already exited
  }
}

/** Terminates every subprocess this process started. Used by the signal handler. */
export function killAllChildren(): void {
  for (const child of liveChildren) terminate(child);
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
    // Piped children get their own process group so a timeout or Ctrl-C can
    // take their helpers down with them. Inherited-stdio children (git log in
    // a pager, an editor) must stay in ours to keep the terminal's job control.
    detached: !inherit && process.platform !== "win32",
  });

  liveChildren.add(proc);

  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  if (options.timeoutMs) {
    timeoutId = setTimeout(() => {
      timedOut = true;
      terminate(proc);
    }, options.timeoutMs);
  }

  // Writing a large prompt and awaiting the flush; a child that exits early
  // (not installed, bad flag) closes the pipe, which must not become our error.
  const stdin = proc.stdin;
  const stdinDone =
    options.input !== undefined && stdin
      ? (async () => {
          try {
            stdin.write(options.input!);
            await stdin.flush();
            await stdin.end();
          } catch {
            // EPIPE: the child is gone; its exit code tells the real story.
          }
        })()
      : Promise.resolve();

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
      proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
      proc.exited,
      stdinDone,
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
