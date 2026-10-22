import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recordCompletedEffect } from "../runtime.ts";
import type { CloneMode } from "../config.ts";
import { run } from "../../utils/exec.ts";
import { execGitWithRetry, NON_INTERACTIVE_ENV } from "./exec.ts";

export type CloneProtocol = "ssh" | "https" | "http" | "git" | "file";
export interface CloneTransport {
  url: string;
  protocol: CloneProtocol;
  allowFallback: boolean;
}

export function redactCloneCredentials(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/]+@/gi, "$1***@");
}

function expandPath(path: string, cwd: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(cwd, path);
}

export function cloneDestination(repo: string, options: { cwd?: string; cloneRoot?: string; to?: string } = {}): string {
  const cwd = options.cwd ?? process.cwd();
  if (options.to) return expandPath(options.to, cwd);
  const name = repo.trim().replace(/\/+$/, "").split(/[/:]/).at(-1)?.replace(/\.git$/, "");
  if (!name || name === "." || name === ".." || /[\0\r\n]/.test(name)) throw new Error("Invalid repository name. Pass --to <directory>.");
  return join(options.cloneRoot ? expandPath(options.cloneRoot, cwd) : cwd, name);
}

function parseRemote(input: string): URL | null {
  try {
    if (input.includes("://")) return new URL(input);
    const scp = /^(?:([^@/]+)@)?(\[[^\]]+\]|[^/:]+):(.+)$/.exec(input);
    if (scp) return new URL(`ssh://${scp[1] ?? "git"}@${scp[2]}/${scp[3]}`);
  } catch { /* Invalid URL, rejected by the caller. */ }
  return null;
}

function rewriteProtocol(url: URL, protocol: "ssh" | "https"): string {
  // Construct rather than mutate URL.protocol: file and non-special SSH URLs
  // cannot reliably be switched to HTTPS with the URL setter.
  return `${protocol}://${protocol === "ssh" ? "git@" : ""}${url.host}${url.pathname}`;
}

export function cloneTransport(input: string, preferred: "ssh" | "https" = "https", requested?: "ssh" | "https", host = "github.com"): CloneTransport {
  const explicit = parseRemote(input);
  const derived = explicit === null;
  let url: string;
  if (explicit) {
    url = requested && ["ssh:", "https:", "http:", "git:"].includes(explicit.protocol)
      ? rewriteProtocol(explicit, requested) : input;
  } else {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(input) || input.split("/").some(part => part === "." || part === "..")) {
      throw new Error("Use OWNER/REPO or a repository URL.");
    }
    const path = input.replace(/\/+$/, "").replace(/\.git$/, "") + ".git";
    const protocol = requested ?? preferred;
    url = protocol === "ssh" ? host.includes(":") ? `ssh://git@${host}/${path}` : `git@${host}:${path}` : `https://${host}/${path}`;
  }
  const parsed = parseRemote(url);
  const scheme = parsed?.protocol;
  const protocol = scheme === "ssh:" ? "ssh" : scheme === "https:" ? "https" : scheme === "http:" ? "http" : scheme === "git:" ? "git" : scheme === "file:" ? "file" : null;
  if (!protocol) throw new Error("Unsupported clone URL protocol.");
  return { url, protocol, allowFallback: derived && protocol === "ssh" && requested !== "ssh" };
}

export function httpsFallback(transport: CloneTransport, diagnostic: string): string | null {
  if (!transport.allowFallback || transport.protocol !== "ssh" ||
      !/permission denied.*(?:publickey|password)|authentication failed|host key verification failed|remote host identification has changed|no supported authentication methods/i.test(diagnostic)) return null;
  const parsed = parseRemote(transport.url);
  return parsed ? rewriteProtocol(parsed, "https") : null;
}

function remoteIdentity(input: string, cwd: string): string {
  const parsed = parseRemote(input);
  if (parsed?.protocol === "file:") return `file:${realpathSync(fileURLToPath(parsed))}`;
  if (parsed) return `${parsed.host.toLowerCase()}/${parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "").toLowerCase()}`;
  return `file:${realpathSync(resolve(cwd, input))}`;
}

export async function alreadyCloned(repoUrl: string, destination: string): Promise<boolean> {
  try {
    const root = await run("git", ["rev-parse", "--show-toplevel"], { cwd: destination, reject: false });
    if (root.exitCode !== 0 || realpathSync(root.stdout.trim()) !== realpathSync(destination)) return false;
    const remote = await run("git", ["config", "--local", "--get", "remote.origin.url"], { cwd: destination, reject: false });
    return remote.exitCode === 0 && remoteIdentity(remote.stdout.trim(), destination) === remoteIdentity(repoUrl, process.cwd());
  } catch { return false; }
}

export class CloneProgress {
  private pending = "";
  private droppingLine = false;
  private lastOutput: number;
  private stalled = false;
  readonly tail: string[] = [];

  constructor(private readonly onProgress: (line: string) => void = () => {}, private readonly stallAfterMs = 20_000, now = Date.now()) {
    this.lastOutput = now;
  }

  output(text: string, stderr = true, now = Date.now()): void {
    this.lastOutput = now;
    this.stalled = false;
    if (!stderr) return;
    if (this.droppingLine) {
      const end = text.search(/[\r\n]/);
      if (end < 0) return;
      text = text.slice(end + 1);
      this.droppingLine = false;
    }
    const lines = (this.pending + text).split(/[\r\n]/);
    this.pending = lines.pop() ?? "";
    for (const line of lines) this.line(line);
    // Dropping an oversized partial line must not expose a credential suffix
    // whose URL scheme fell outside the retained buffer.
    if (this.pending.length > 4096) {
      this.pending = "";
      this.droppingLine = true;
      this.line("Clone output line omitted: exceeded 4096 characters.");
    }
  }

  private line(raw: string): void {
    const line = redactCloneCredentials(raw.trim()).slice(-1000);
    if (!line) return;
    this.onProgress(line);
    if (!/^(?:remote: )?(?:Receiving objects|Resolving deltas|Counting objects|Compressing objects|Updating files|Checking out files|Enumerating objects|Filtering content):/i.test(line)) {
      this.tail.push(line);
      if (this.tail.length > 4) this.tail.shift();
    }
  }

  tick(now = Date.now()): void {
    if (!this.stalled && now - this.lastOutput >= this.stallAfterMs) {
      this.stalled = true;
      this.onProgress("stalled: no output for 20 seconds; still cloning. Ctrl-C to cancel.");
    }
  }

  finish(): void { this.line(this.pending); this.pending = ""; }
}

export class CloneCancelledError extends Error {
  constructor() { super("Clone cancelled."); }
}

const activeClones = new Map<AbortController, Promise<void>>();

export async function cancelActiveClones(): Promise<boolean> {
  const hadClones = activeClones.size > 0;
  for (const controller of activeClones.keys()) controller.abort();
  await Promise.all(activeClones.values());
  return hadClones;
}

async function cloneAttempt(url: string, destination: string, mode: CloneMode, options: { cwd: string; signal: AbortSignal; onProgress?: (line: string) => void; stallAfterMs?: number }): Promise<void> {
  if (options.signal.aborted) throw new CloneCancelledError();
  const args = ["clone", "--progress"];
  if (mode === "blobless") args.push("--filter=blob:none");
  if (mode === "shallow") args.push("--depth", "1");
  args.push("--", url, destination);
  const proc = Bun.spawn(["git", ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...NON_INTERACTIVE_ENV, GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: process.platform !== "win32",
  });
  let stopping: Promise<void> | undefined;
  const stop = (): void => {
    stopping ??= (async () => {
      if (process.platform === "win32") {
        const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
        if (systemRoot) await run(join(systemRoot, "System32", "taskkill.exe"), ["/PID", String(proc.pid), "/T", "/F"], { reject: false, timeoutMs: 2000 }).catch(() => {});
      } else {
        try { process.kill(-proc.pid, "SIGKILL"); return; } catch { /* Child already exited. */ }
      }
      try { proc.kill("SIGKILL"); } catch { /* Child already exited. */ }
    })();
  };
  options.signal.addEventListener("abort", stop, { once: true });
  if (options.signal.aborted) stop();
  const progress = new CloneProgress(options.onProgress, options.stallAfterMs);
  const timer = setInterval(() => progress.tick(), Math.min(options.stallAfterMs ?? 1000, 1000));
  async function drain(stream: ReadableStream<Uint8Array>, stderr: boolean): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of stream) progress.output(decoder.decode(chunk, { stream: true }), stderr);
    progress.output(decoder.decode(), stderr);
  }
  try {
    const [exitCode] = await Promise.all([proc.exited, drain(proc.stdout, false), drain(proc.stderr, true)]);
    progress.finish();
    if (options.signal.aborted) throw new CloneCancelledError();
    if (exitCode !== 0) throw new Error(`Clone failed (exit ${exitCode}).\n${progress.tail.join("\n")}`);
  } catch (error) {
    stop();
    await proc.exited;
    throw error;
  } finally {
    clearInterval(timer);
    options.signal.removeEventListener("abort", stop);
    await stopping;
  }
}

export async function clone(repoUrl: string, destination: string, mode: CloneMode = "standard", cwd = process.cwd(), options: {
  transport?: CloneTransport;
  signal?: AbortSignal;
  onProgress?: (line: string) => void;
  onFallback?: () => void;
  stallAfterMs?: number;
} = {}): Promise<{ alreadyCloned: boolean; fallbackUsed: boolean; protocol: CloneProtocol }> {
  destination = resolve(cwd, destination);
  const transport = options.transport ?? cloneTransport(repoUrl);
  let existing: ReturnType<typeof lstatSync> | undefined;
  try { existing = lstatSync(destination); } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error("Destination must be a directory, not a symlink.");
    if (await alreadyCloned(repoUrl, destination)) return { alreadyCloned: true, fallbackUsed: false, protocol: transport.protocol };
    if (readdirSync(destination).length) throw new Error(`Refusing non-empty destination '${destination}': it is not a clone of the same repository.`);
  }
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let settle = () => {};
  activeClones.set(controller, new Promise<void>(resolve => { settle = resolve; }));
  let owned: ReturnType<typeof lstatSync> | undefined;
  let complete = false;
  const cleanup = (): void => {
    if (!owned || complete) return;
    try {
      const current = lstatSync(destination);
      if (current.dev === owned.dev && current.ino === owned.ino && !current.isSymbolicLink()) rmSync(destination, { recursive: true, force: true });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  };
  try {
    if (signal.aborted) throw new CloneCancelledError();
    if (!existing) {
      mkdirSync(dirname(destination), { recursive: true });
      mkdirSync(destination);
      owned = lstatSync(destination);
    }
    let fallbackUsed = false;
    let protocol = transport.protocol;
    try {
      await cloneAttempt(repoUrl, destination, mode, { ...options, cwd, signal });
    } catch (error) {
      const fallback = error instanceof CloneCancelledError ? null : httpsFallback(transport, error instanceof Error ? error.message : String(error));
      if (!fallback || signal.aborted) throw error;
      // Git normally removes its failed clone. Only clear our own directory.
      cleanup();
      if (owned) { mkdirSync(destination); owned = lstatSync(destination); }
      options.onFallback?.();
      await cloneAttempt(fallback, destination, mode, { ...options, cwd, signal });
      fallbackUsed = true;
      protocol = "https";
    }
    if (signal.aborted) throw new CloneCancelledError();
    await execGitWithRetry(["config", "--local", "ggh.created", "true"], { cwd: destination });
    await execGitWithRetry(["config", "--local", "ggh.createdAt", new Date().toISOString()], { cwd: destination });
    complete = true;
    recordCompletedEffect("repository_cloned");
    return { alreadyCloned: false, fallbackUsed, protocol };
  } finally {
    try { cleanup(); } finally { settle(); activeClones.delete(controller); }
  }
}
