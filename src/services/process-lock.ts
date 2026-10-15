import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rmdir, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

interface LockOwner {
  schemaVersion: 1;
  pid: number;
  host: string;
  token: string;
  startedAt: string;
}
export type ProcessLockStatus =
  | { state: "unlocked" }
  | { state: "active" | "abandoned"; owner: LockOwner }
  | { state: "unknown"; reason: string };

type LockView =
  | { kind: "unlocked"; status: { state: "unlocked" } }
  | { kind: "legacy"; status: ProcessLockStatus }
  | { kind: "directory"; status: ProcessLockStatus; files: string[] };

const HOST = hostname();
const HOST_ID = createHash("sha256").update(HOST).digest("hex").slice(0, 16);
const OWNER_NAME = /^([a-f0-9]{16})\.([1-9]\d*)\.([a-f0-9-]{36})\.owner$/;

function alive(owner: LockOwner): ProcessLockStatus {
  try { process.kill(owner.pid, 0); return { state: "active", owner }; }
  catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ESRCH") return { state: "abandoned", owner };
    if (code === "EPERM") return { state: "active", owner };
    return { state: "unknown", reason: "Cannot determine whether the lock owner is running." };
  }
}

async function view(path: string): Promise<LockView> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return { kind: "unlocked", status: { state: "unlocked" } };
  if (info.isSymbolicLink() || (process.platform !== "win32" && (info.mode & 0o077) !== 0) ||
      (typeof process.getuid === "function" && info.uid !== process.getuid())) {
    throw new Error(`Lock has unsafe ownership or type: ${path}`);
  }
  if (info.isFile()) return { kind: "legacy", status: { state: "unknown", reason: "Legacy lock has no verifiable process owner. Stop other ggh commands before recovery." } };
  if (!info.isDirectory()) throw new Error(`Lock has unsafe type: ${path}`);
  const files = await readdir(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (files.length > 32 || files.some(file => !OWNER_NAME.test(file))) throw new Error(`Lock contains unexpected files. Inspect ${path}; no files were removed.`);
  let unknownReason: string | undefined;
  let abandonedOwner: LockOwner | undefined;
  for (const file of files) {
    const match = OWNER_NAME.exec(file);
    if (!match?.[2] || !match[3]) throw new Error("Invalid lock owner filename.");
    if (match[1] !== HOST_ID) {
      unknownReason = "Lock belongs to another host. Verify that owner's commands have stopped.";
      continue;
    }
    const pid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid lock owner PID.");
    const owner: LockOwner = { schemaVersion: 1, pid, host: HOST, token: match[3], startedAt: new Date(0).toISOString() };
    const ownerInfo = await lstat(join(path, file)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!ownerInfo) { unknownReason = "Lock ownership changed during inspection."; continue; }
    if (!ownerInfo.isFile() || ownerInfo.isSymbolicLink() || ownerInfo.size > 4096) throw new Error("Lock owner file has unsafe type or size.");
    try {
      const raw: unknown = JSON.parse(await readFile(join(path, file), "utf8"));
      if (raw && typeof raw === "object" && "startedAt" in raw && typeof raw.startedAt === "string") owner.startedAt = raw.startedAt;
    } catch { /* Filename ownership remains available before metadata is written. */ }
    const next = alive(owner);
    if (next.state === "active") return { kind: "directory", files, status: next };
    if (next.state === "unknown") unknownReason = next.reason;
    else if (next.state === "abandoned") abandonedOwner ??= next.owner;
  }
  const status: ProcessLockStatus = unknownReason || !abandonedOwner
    ? { state: "unknown", reason: unknownReason ?? "Lock initialization was interrupted. Stop other ggh commands before recovery." }
    : { state: "abandoned", owner: abandonedOwner };
  return { kind: "directory", files, status };
}

export async function inspectProcessLock(path: string): Promise<ProcessLockStatus> {
  return (await view(path)).status;
}

export async function recoverProcessLock(path: string, options: { allowUnknown?: boolean } = {}): Promise<void> {
  const snapshot = await view(path);
  const status = snapshot.status;
  if (status.state === "unlocked") return;
  if (status.state === "active") throw new Error(`Lock owner PID ${status.owner.pid} is active; it will not be unlocked.`);
  if (status.state === "unknown" && !options.allowUnknown) throw new Error(`Lock ownership is unknown. Explicitly authorize unknown-owner recovery after stopping other commands. ${status.reason}`);
  if (snapshot.kind === "legacy") {
    await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  } else if (snapshot.kind === "directory") {
    // Names identify the inspected owner. A concurrent replacement uses different names.
    for (const file of snapshot.files) await unlink(join(path, file)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    await rmdir(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }
}

export async function acquireProcessLock(path: string, waitMs = 5000): Promise<() => Promise<void>> {
  const deadline = Date.now() + waitMs;
  const record: LockOwner = { schemaVersion: 1, pid: process.pid, host: HOST, token: randomUUID(), startedAt: new Date().toISOString() };
  const ownerName = `${HOST_ID}.${record.pid}.${record.token}.owner`;
  const ownerPath = join(path, ownerName);
  for (;;) {
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      const status = await inspectProcessLock(path);
      if (status.state === "abandoned") {
        try { await recoverProcessLock(path); continue; }
        catch (recoveryError) { if (Date.now() >= deadline) throw recoveryError; }
      }
      if (Date.now() >= deadline) throw new Error(`Operation lock is ${status.state}. Inspect it or use ggh operation unlock <id> before retrying.`, { cause: error });
      await new Promise(resolve => setTimeout(resolve, 20));
      continue;
    }
    try {
      const handle = await open(ownerPath, "wx", 0o600);
      try { await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      const names = await readdir(path);
      if (names.length !== 1 || names[0] !== ownerName) throw new Error("Lock ownership changed during acquisition.");
    } catch (error) {
      await unlink(ownerPath).catch(() => undefined);
      await rmdir(path).catch(() => undefined);
      if (Date.now() < deadline) continue;
      throw error;
    }
    return async () => {
      try { await unlink(ownerPath); }
      catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
      await rmdir(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error; });
    };
  }
}
