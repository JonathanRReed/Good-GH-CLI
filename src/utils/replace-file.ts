import { rename } from "node:fs/promises";

const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);
const DELAYS_MS = [10, 25, 50, 100, 200, 400];

/**
 * Atomically replaces `to` with `from`. On Windows, a rename over a file that
 * another process (a reader, an indexer, antivirus) briefly holds open fails
 * with EPERM, EACCES or EBUSY; retry those for about 0.8 s before giving up.
 */
export async function replaceFile(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const delay = DELAYS_MS[attempt];
      if (process.platform !== "win32" || !code || !TRANSIENT.has(code) || delay === undefined) throw error;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}
