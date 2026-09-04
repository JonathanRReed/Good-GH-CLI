import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const CACHE_VERSION = 2;
const ENTRY_NAME = /^entry-v2-[a-f0-9]{64}\.json$/;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;

/** The intended location, even when caching is disabled by a filesystem error. */
export function getCacheDir(): string {
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "good-gh");
}

/** Failure disables caching; it must never widen cleanup into a shared directory. */
function cacheDir(): string | null {
  const dir = getCacheDir();
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) return null;
    if (process.getuid && st.uid !== process.getuid()) return null;
    if (process.platform !== "win32") chmodSync(dir, 0o700);
    return dir;
  } catch {
    return null;
  }
}

function entryName(key: string): string {
  return `entry-v2-${createHash("sha256").update(key).digest("hex")}.json`;
}

export interface CacheOptions {
  ttlMs?: number;
  refresh?: boolean;
}
interface CacheEntry<T> {
  version: number;
  key: string;
  at: number;
  value: T;
}

/** Only an owned, regular, bounded file with a matching envelope is a cache entry. */
function readEntry<T>(dir: string, name: string): CacheEntry<T> | null {
  if (!ENTRY_NAME.test(name)) return null;
  let fd: number | undefined;
  try {
    const file = join(dir, name);
    const st = lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_ENTRY_BYTES) return null;
    if (process.getuid && st.uid !== process.getuid()) return null;
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const entry = JSON.parse(readFileSync(fd, "utf8")) as CacheEntry<T>;
    if (!entry || entry.version !== CACHE_VERSION || typeof entry.key !== "string" ||
        entryName(entry.key) !== name || !Number.isFinite(entry.at) || entry.at < 0 ||
        !Object.prototype.hasOwnProperty.call(entry, "value")) return null;
    return entry;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function atomicWrite(dir: string, name: string, data: string): void {
  if (Buffer.byteLength(data) > MAX_ENTRY_BYTES) return;
  const temporary = mkdtempSync(join(dir, ".write-"));
  try {
    const file = join(temporary, "entry");
    writeFileSync(file, data, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(file, join(dir, name));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export async function cached<T>(key: string, fetcher: () => Promise<T>, options: CacheOptions = {}): Promise<T> {
  const ttlMs = options.ttlMs ?? 60_000;
  const dir = cacheDir();
  if (!dir || ttlMs <= 0) return fetcher();
  const name = entryName(key);
  if (!options.refresh) {
    const entry = readEntry<T>(dir, name);
    const age = entry ? Date.now() - entry.at : -1;
    if (entry && entry.key === key && age >= 0 && age < ttlMs) return entry.value;
  }
  const value = await fetcher();
  try {
    atomicWrite(dir, name, JSON.stringify({ version: CACHE_VERSION, key, at: Date.now(), value }));
  } catch {
    // A cache write is optional; the fresh response remains usable.
  }
  return value;
}

function removeEntries(matches: (key: string) => boolean): number {
  const dir = cacheDir();
  if (!dir) return 0;
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      const entry = readEntry(dir, name);
      if (!entry || !matches(entry.key)) continue;
      try {
        rmSync(join(dir, name), { force: true });
        removed++;
      } catch {
        // An unreadable entry must not prevent cleanup of other owned entries.
      }
    }
  } catch {
    // Disabled or unreadable cache.
  }
  return removed;
}

export function clearCache(): number {
  return removeEntries(() => true);
}

/** Evict this request family across namespaces; never return another namespace's data. */
export function invalidateCache(prefix: string): number {
  return removeEntries((key) => key.startsWith(prefix));
}
