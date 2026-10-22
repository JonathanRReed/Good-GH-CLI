import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getGitPath } from "./paths.ts";

const MARKER = "ggh-created";

export async function markGghCheckout(cwd: string): Promise<void> {
  writeFileSync(await getGitPath(MARKER, cwd), "ggh\n", { mode: 0o600, flag: "wx" });
}

export function isGghCheckout(gitDir: string): boolean {
  const marker = join(gitDir, MARKER);
  try { return lstatSync(marker).isFile() && readFileSync(marker, "utf8") === "ggh\n"; }
  catch { return false; }
}
