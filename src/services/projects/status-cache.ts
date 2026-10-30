import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { replaceFile } from "../../utils/replace-file.ts";
import { join } from "node:path";
import { getConfigDir, type GoodGhConfig } from "../config.ts";
import { acquireProcessLock } from "../process-lock.ts";
import { privateProjectDirectory } from "./index-store.ts";
import type { CheckoutStatus, CloneStatus, CommitSummary, FieldState, ProjectIndexFile } from "./types.ts";

interface StatusSnapshot { version: 1; scope: string; observedAt: string; statuses: CloneStatus[] }
export function projectStatusPath(configDir = getConfigDir()): string { return join(configDir, "projects-status.json"); }
export function projectStatusScope(index: ProjectIndexFile, config: GoodGhConfig): string {
  return JSON.stringify([config.project_roots, config.project_exclude, config.host_worktree_dirs, config.project_scan_depth, index.excluded, index.registered]);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected status object");
  return Object.fromEntries(Object.entries(value));
}
function string(value: unknown): string { if (typeof value !== "string") throw new Error("Expected status string"); return value; }
function timestamp(value: unknown): string { const result = string(value); if (!Number.isFinite(Date.parse(result))) throw new Error("Invalid status timestamp"); return result; }
function count(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid status count"); return value; }
function array<T>(value: unknown, parse: (item: unknown) => T): T[] { if (!Array.isArray(value)) throw new Error("Expected status array"); return value.map(parse); }
function field<T>(value: unknown, parse: (value: unknown) => T): FieldState<T> {
  const row = object(value);
  if (row.state === "ok") return { state: "ok", value: parse(row.value), observedAt: timestamp(row.observedAt) };
  if (row.state === "unknown") return { state: "unknown", reason: string(row.reason) };
  if (row.state === "error") return { state: "error", message: string(row.message) };
  throw new Error("Invalid status field");
}
function commit(value: unknown): CommitSummary { const row = object(value); return { oid: string(row.oid), subject: string(row.subject), committedAt: timestamp(row.committedAt) }; }
function checkout(value: unknown): CheckoutStatus {
  const row = object(value);
  return {
    path: string(row.path),
    dirty: field(row.dirty, value => { const v = object(value); return { staged: count(v.staged), unstaged: count(v.unstaged), untracked: count(v.untracked), conflicted: count(v.conflicted) }; }),
    upstream: field(row.upstream, value => { if (value === null) return null; const v = object(value); return { name: string(v.name), ahead: count(v.ahead), behind: count(v.behind), fetchedAt: v.fetchedAt === null ? null : timestamp(v.fetchedAt) }; }),
    operation: field(row.operation, value => { if (value === null || value === "merge" || value === "rebase" || value === "cherry-pick" || value === "revert" || value === "bisect") return value; throw new Error("Invalid operation"); }),
  };
}
function status(value: unknown): CloneStatus {
  const row = object(value);
  return {
    commonDir: string(row.commonDir), checkouts: array(row.checkouts, checkout), stashes: field(row.stashes, count),
    newestStash: field(row.newestStash, value => value === null ? null : string(value)),
    unpublished: field(row.unpublished, value => array(value, value => { const v = object(value); return { ref: string(v.ref), commits: count(v.commits) }; })),
    mergedBranches: field(row.mergedBranches, value => array(value, string)), lastCommit: field(row.lastCommit, value => value === null ? null : commit(value)),
  };
}

export function readProjectStatusCache(scope: string, configDir = getConfigDir()): StatusSnapshot | null {
  privateProjectDirectory(configDir, false);
  const file = projectStatusPath(configDir);
  const info = lstatSync(file, { throwIfNoEntry: false });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024 || (process.getuid && info.uid !== process.getuid()) || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) throw new Error(`Unsafe project status cache: ${file}`);
  try {
    const row = object(JSON.parse(readFileSync(file, "utf8")));
    if (row.version !== 1 || row.scope !== scope) return null;
    return { version: 1, scope, observedAt: timestamp(row.observedAt), statuses: array(row.statuses, status) };
  } catch { return null; }
}

export async function writeProjectStatusCache(scope: string, statuses: CloneStatus[], configDir = getConfigDir()): Promise<void> {
  privateProjectDirectory(configDir, true);
  const release = await acquireProcessLock(join(configDir, "projects-status.lock"));
  const temporary = join(configDir, `.projects-status.${randomUUID()}.tmp`);
  try {
    readProjectStatusCache(scope, configDir);
    const snapshot: StatusSnapshot = { version: 1, scope, observedAt: new Date().toISOString(), statuses };
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(snapshot)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await replaceFile(temporary, projectStatusPath(configDir));
  } finally {
    try { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
    finally { await release(); }
  }
}
