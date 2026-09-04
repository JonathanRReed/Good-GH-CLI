#!/usr/bin/env bun
/**
 * Performance budgets (see docs/PERF.md). Exits non-zero on breach.
 * Portable alternative to `timeout(1)`, which macOS lacks.
 */
import { run } from "../src/utils/exec.ts";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const bundle = join(root, "dist", "ggh.js");

async function within(
  label: string,
  ms: number,
  args: string[],
): Promise<void> {
  const start = performance.now();
  const result = await run("bun", [bundle, ...args], {
    cwd: root,
    timeoutMs: ms,
    reject: false,
  }).catch((err: unknown) => {
    const msg = String(err);
    if (/timed out|timeout/i.test(msg)) {
      console.error(`BUDGET BREACH: ${label} exceeded ${ms}ms`);
      process.exit(1);
    }
    throw err;
  });
  const elapsed = Math.round(performance.now() - start);
  console.error(`${label}: ${elapsed}ms (budget ${ms}ms, exit ${result.exitCode})`);
  if (result.exitCode !== 0) {
    console.error(`BUDGET BREACH: ${label} exited with ${result.exitCode}`);
    process.exit(1);
  }
}

await within("startup (--version)", 2_000, ["--version"]);
await within("status --json", 10_000, ["status", "--json"]);
console.error("budgets ok");
