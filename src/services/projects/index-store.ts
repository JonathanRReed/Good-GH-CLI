import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { getConfig, getConfigDir, type GoodGhConfig } from "../config.ts";
import { assertWindowsPrivateDirectory } from "../private-storage.ts";
import { recordCompletedEffect } from "../runtime.ts";
import { acquireProcessLock } from "../process-lock.ts";
import { discoverProjects, projectExcluded, projectPath, redactRemoteUrl } from "./discovery.ts";
import type { Checkout, DiscoveryCoverage, IndexedClone, ProjectIndexFile, RemoteRepoId } from "./types.ts";

export function projectIndexPath(configDir = getConfigDir()): string { return join(configDir, "projects.json"); }

export function privateProjectDirectory(dir: string, create: boolean): void {
  assertWindowsPrivateDirectory(dir, create);
  if (!existsSync(dir)) { if (!create) return; mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new Error(`Unsafe project index directory: ${dir}`);
  if (process.platform !== "win32") chmodSync(dir, 0o700);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
function string(value: unknown): string { if (typeof value !== "string") throw new Error("Expected a string"); return value; }
function path(value: unknown): string { const text = string(value); if (!isAbsolute(text) || text.includes("\0")) throw new Error("Expected an absolute path"); return text; }
function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw new Error("Expected an array"); return value; }
function nullableString(value: unknown): string | null { return value === null ? null : string(value); }
function reason(value: unknown): { reason: string } | null { return value === null ? null : { reason: string(object(value).reason) }; }
function repo(value: unknown): RemoteRepoId | null {
  if (value === null) return null;
  const row = object(value);
  return { host: string(row.host), owner: string(row.owner), name: string(row.name) };
}
function checkout(value: unknown): Checkout {
  const row = object(value);
  const creator = row.createdBy;
  if (creator !== "ggh" && creator !== "t3" && creator !== "cursor" && creator !== "claude" && creator !== "codex" && creator !== "unknown") throw new Error("Invalid checkout creator");
  if (typeof row.bare !== "boolean") throw new Error("Invalid bare flag");
  return {
    path: path(row.path), gitDir: path(row.gitDir), branch: nullableString(row.branch), head: nullableString(row.head), bare: row.bare,
    locked: reason(row.locked), prunable: reason(row.prunable), createdBy: creator,
    hostClaims: array(row.hostClaims).map(value => {
      const claim = object(value);
      const host = claim.host;
      if (host !== "t3" && host !== "codex" && host !== "cursor" && host !== "claude") throw new Error("Invalid host claim");
      return { host, evidence: string(claim.evidence) };
    }),
  };
}
function clone(value: unknown): IndexedClone {
  const row = object(value);
  return {
    commonDir: path(row.commonDir), displayName: string(row.displayName), primary: repo(row.primary),
    remotes: array(row.remotes).map(value => { const remote = object(value); return { name: string(remote.name), url: redactRemoteUrl(string(remote.url)), repo: repo(remote.repo) }; }),
    checkouts: array(row.checkouts).map(checkout), lastSeen: string(row.lastSeen), ...(row.missing === true ? { missing: true } : {}),
    sources: array(row.sources).map(value => {
      if (value !== "root-scan" && value !== "ggh-clone" && value !== "worktree-list" && value !== "host-location" && value !== "registered") throw new Error("Invalid discovery source");
      return value;
    }),
  };
}
function coverage(value: unknown): DiscoveryCoverage {
  const row = object(value);
  if (typeof row.truncated !== "boolean") throw new Error("Invalid coverage flag");
  return { roots: array(row.roots).map(path), truncated: row.truncated, skipped: array(row.skipped).map(value => { const item = object(value); return { path: path(item.path), reason: string(item.reason) }; }) };
}

export function readProjectIndex(configDir = getConfigDir()): ProjectIndexFile {
  privateProjectDirectory(configDir, false);
  const file = projectIndexPath(configDir);
  const info = lstatSync(file, { throwIfNoEntry: false });
  if (!info) return { version: 1, updatedAt: new Date(0).toISOString(), roots: [], excluded: [], registered: [], clones: [] };
  try {
    if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024 || (process.getuid && info.uid !== process.getuid()) || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) throw new Error("Unsafe project index file");
    const row = object(JSON.parse(readFileSync(file, "utf8")));
    if (row.version !== 1) throw new Error("Unsupported project index version");
    return { version: 1, updatedAt: string(row.updatedAt), roots: array(row.roots).map(path), excluded: array(row.excluded).map(string), registered: array(row.registered).map(path), clones: array(row.clones).map(clone), ...(row.coverage ? { coverage: coverage(row.coverage) } : {}) };
  } catch (error) { throw new Error(`Cannot read ${file}. Inspect it or move it aside before refreshing. ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
}

export async function updateProjectIndex(update: (current: ProjectIndexFile) => ProjectIndexFile, configDir = getConfigDir()): Promise<ProjectIndexFile> {
  privateProjectDirectory(configDir, true);
  const release = await acquireProcessLock(join(configDir, "projects.lock"));
  const temporary = join(configDir, `.projects.${randomUUID()}.tmp`);
  try {
    const next = update(readProjectIndex(configDir));
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(next)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, projectIndexPath(configDir));
    recordCompletedEffect("projects_index_updated");
    return next;
  } finally {
    try { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
    finally { await release(); }
  }
}

export async function refreshProjectIndex(options: { configDir?: string; config?: GoodGhConfig } = {}): Promise<ProjectIndexFile> {
  const configDir = options.configDir ?? getConfigDir();
  const config = options.config ?? getConfig();
  const before = readProjectIndex(configDir);
  // Git probes happen outside the write lock; merge against the latest user choices.
  const discovered = await discoverProjects({ config, registered: before.registered, excluded: before.excluded, known: before.clones });
  return updateProjectIndex(current => {
    const excluded = [...config.project_exclude ?? [], ...current.excluded];
    const roots = (config.project_roots ?? []).map(projectPath);
    const clones = new Map(discovered.clones.map(clone => [clone.commonDir, clone]));
    const checkoutOwners = new Map(discovered.clones.flatMap(clone => clone.checkouts.map(checkout => [checkout.path, clone.commonDir] as const)));
    for (const previous of current.clones) {
      if (clones.has(previous.commonDir)) continue;
      if (existsSync(previous.commonDir)) clones.set(previous.commonDir, previous);
      else if (!previous.missing || current.updatedAt !== before.updatedAt) clones.set(previous.commonDir, { ...previous, missing: true });
    }
    for (const [key, clone] of clones) {
      clone.checkouts = clone.checkouts.filter(checkout => !projectExcluded(checkout.path, excluded, roots) && (!checkoutOwners.has(checkout.path) || checkoutOwners.get(checkout.path) === clone.commonDir));
      if (!clone.checkouts.length) clones.delete(key);
    }
    return { ...current, updatedAt: new Date().toISOString(), roots, clones: [...clones.values()], coverage: discovered.coverage };
  }, configDir);
}

export async function registerProject(path: string, configDir = getConfigDir()): Promise<ProjectIndexFile> {
  const canonical = projectPath(path);
  return updateProjectIndex(current => ({ ...current, registered: [...new Set([...current.registered, canonical])], excluded: current.excluded.filter(value => value !== canonical) }), configDir);
}

export async function forgetProject(path: string, configDir = getConfigDir()): Promise<ProjectIndexFile> {
  const canonical = projectPath(path);
  return updateProjectIndex(current => ({ ...current, registered: current.registered.filter(value => value !== canonical), excluded: [...new Set([...current.excluded, canonical])], clones: current.clones.flatMap(clone => {
    const checkouts = clone.checkouts.filter(checkout => !projectExcluded(checkout.path, [canonical]));
    return checkouts.length ? [{ ...clone, checkouts }] : [];
  }) }), configDir);
}
