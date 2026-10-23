import { getFlags } from "../services/runtime.ts";
import { isAbsolute, join } from "node:path";

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Inherit only these keys and basic process essentials; filter overrides too. */
  envAllowlist?: readonly string[];
  stdio?: "pipe" | "inherit";
  input?: string;
  timeoutMs?: number;
  reject?: boolean;
  /** Aggregate stdout/stderr byte budget for captured subprocesses. */
  maxOutputBytes?: number;
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

  constructor(command: string, args: string[], result: RunResult, reason?: "timeout" | "output_limit") {
    const label = `${command} ${args.join(" ")}`.trim();
    const detail = reason === "timeout" ? "timed out" : reason === "output_limit" ? "exceeded output limit" : `exited with code ${result.exitCode}`;
    const stderrPart = result.stderr.trim() ? `\n${result.stderr.trim().slice(0, 4000)}` : "";
    super(`${label} ${detail}${stderrPart}`);
    this.name = "ExecError";
    this.stdout = result.stdout;
    this.stderr = result.stderr;
    this.exitCode = result.exitCode;
  }
}

const liveChildren = new Set<{ pid: number; kill: (signal?: number | NodeJS.Signals) => void }>();
const terminationPromises = new WeakMap<object, Promise<void>>();
const WINDOWS_TREE_KILL_TIMEOUT_MS = 2_000;

/**
 * Kills a child and, where the platform allows it, everything it spawned. AI
 * CLIs fork helpers; killing only the direct child leaves those running and
 * holding the terminal.
 */
function terminate(child: { pid: number; kill: (signal?: number | NodeJS.Signals) => void }): Promise<void> {
  const existing = terminationPromises.get(child);
  if (existing) return existing;

  let termination: Promise<void>;
  if (process.platform === "win32") {
    termination = terminateWindowsTree(child);
  } else {
    terminateUnixTree(child);
    termination = Promise.resolve();
  }
  terminationPromises.set(child, termination);
  return termination;
}

function terminateUnixTree(child: { pid: number; kill: (signal?: number | NodeJS.Signals) => void }): void {
  try {
    process.kill(-child.pid, "SIGKILL");
    return;
  } catch {
    // Not a group leader (or already gone); fall through to the direct kill.
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Already exited
  }
}

async function terminateWindowsTree(child: { pid: number; kill: (signal?: number | NodeJS.Signals) => void }): Promise<void> {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (Number.isSafeInteger(child.pid) && child.pid > 0 && systemRoot && isAbsolute(systemRoot)) {
    const killerPath = join(systemRoot, "System32", "taskkill.exe");
    let killer: Bun.Subprocess | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      killer = Bun.spawn([killerPath, "/PID", String(child.pid), "/T", "/F"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      const timedOut = new Promise<undefined>((resolve) => {
        timeoutId = setTimeout(() => {
          try {
            killer?.kill("SIGKILL");
          } catch {
            // The tree-kill utility already exited.
          }
          resolve(undefined);
        }, WINDOWS_TREE_KILL_TIMEOUT_MS);
      });
      const exitCode = await Promise.race([killer.exited, timedOut]);
      if (exitCode === 0) return;
    } catch {
      // taskkill is unavailable or failed; try to stop the tracked child itself.
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  try {
    child.kill("SIGTERM");
  } catch {
    // The child already exited, or the tree-kill utility stopped it.
  }
}

/** Terminates every subprocess this process started. Used by the signal handler. */
export async function killAllChildren(): Promise<void> {
  await Promise.all([...liveChildren].map(terminate));
  liveChildren.clear();
}

const commandCache = new Map<string, boolean>();

/**
 * Resolves a binary on PATH. Cached because provider availability is probed on
 * nearly every command and PATH does not change mid-process.
 */
export function commandExists(command: string): boolean {
  const key = `${command}\0${process.env.PATH ?? ""}\0${process.env.PATHEXT ?? ""}`;
  const cached = commandCache.get(key);
  if (cached !== undefined) return cached;
  const found = Bun.which(command) !== null;
  if (commandCache.size > 128) commandCache.clear();
  commandCache.set(key, found);
  return found;
}

/**
 * Bun-native subprocess runner (drop-in replacement for the execa patterns used here).
 * Captures stdout/stderr as text, supports inherited stdio, stdin input, timeouts,
 * and execa-style `reject: false` semantics.
 */
export async function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const inherit = options.stdio === "inherit" && !getFlags().json;
  const inheritedEnv = { ...process.env, ...options.env };
  const allowed = new Set([
    "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE",
    "SystemRoot", "SYSTEMROOT", "WINDIR", "PATHEXT", "USERPROFILE",
    ...options.envAllowlist ?? [],
  ]);
  const env = options.envAllowlist === undefined ? inheritedEnv
    : Object.fromEntries(Object.entries(inheritedEnv).filter(([key]) => allowed.has(key)));
  const proc = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env,
    stdin: options.input !== undefined ? "pipe" : inherit ? "inherit" : "ignore",
    stdout: inherit ? "inherit" : "pipe",
    stderr: inherit ? "inherit" : "pipe",
    // Piped children get their own process group so a timeout or Ctrl-C can
    // take their helpers down with them. Inherited-stdio children (git log in
    // a pager, an editor) must stay in ours to keep the terminal's job control.
    detached: !inherit && process.platform !== "win32",
  });

  liveChildren.add(proc);

  let timedOut = false;
  let outputExceeded = false;
  let outputBytes = 0;
  const maxOutputBytes = options.maxOutputBytes ?? 16 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? (inherit ? undefined : 120_000);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs) {
    timeoutId = setTimeout(() => {
      timedOut = true;
      void terminate(proc);
    }, timeoutMs);
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

  async function capture(stream: ReadableStream<Uint8Array> | null | undefined): Promise<string> {
    if (!stream) return "";
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        outputBytes += value.byteLength;
        if (outputBytes > maxOutputBytes) {
          outputExceeded = true;
          void terminate(proc);
        } else if (!outputExceeded) chunks.push(value);
      }
      return Buffer.concat(chunks).toString("utf8");
    } finally { reader.releaseLock(); }
  }

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      capture(proc.stdout),
      capture(proc.stderr),
      proc.exited,
      stdinDone,
    ]);

    const result: RunResult = { stdout, stderr, exitCode: exitCode ?? 0 };

    if (outputExceeded) throw new ExecError(command, args, result, "output_limit");
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
