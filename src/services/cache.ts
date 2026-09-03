import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Short-lived disk cache for read-only `gh` responses. `ggh clone` was fetching
 * 100 repositories plus 30 starred on every invocation before it could draw a
 * menu; that round trip dominates the perceived speed of the whole tool.
 */
function cacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  const dir = join(base, "good-gh");
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return tmpdir();
  }
}

function keyPath(key: string): string {
  return join(cacheDir(), `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`);
}

export interface CacheOptions {
  /** How long the entry stays fresh, in milliseconds. */
  ttlMs?: number;
  /** Ignore any existing entry and refetch. */
  refresh?: boolean;
}

/**
 * Returns the cached value when it is still fresh, otherwise calls `fetcher`
 * and stores the result. A cache failure is never fatal: a read or write error
 * simply means the value is fetched live.
 */
export async function cached<T>(
  key: string,
  fetcher: () => Promise<T>,
  options: CacheOptions = {},
): Promise<T> {
  const ttlMs = options.ttlMs ?? 60_000;
  const file = keyPath(key);

  if (!options.refresh && ttlMs > 0) {
    try {
      if (existsSync(file)) {
        const entry = JSON.parse(readFileSync(file, "utf-8")) as { at: number; value: T };
        if (Date.now() - entry.at < ttlMs) return entry.value;
      }
    } catch {
      // Corrupt or unreadable entry: fall through and refetch.
    }
  }

  const value = await fetcher();

  try {
    writeFileSync(file, JSON.stringify({ at: Date.now(), value }), "utf-8");
  } catch {
    // Read-only cache directory; the value is still correct.
  }

  return value;
}

/** Removes every cached response. Exposed as `ggh config cache-clear`. */
export function clearCache(): number {
  const dir = cacheDir();
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      rmSync(join(dir, name), { force: true });
      removed++;
    }
  } catch {
    // Nothing to clear
  }
  return removed;
}

export function getCacheDir(): string {
  return cacheDir();
}
