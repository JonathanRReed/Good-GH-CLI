#!/usr/bin/env bun
/**
 * Performance budgets (see docs/PERF.md). Exits non-zero on breach.
 * Portable alternative to `timeout(1)`, which macOS lacks.
 */
import { ExecError, run } from "../src/utils/exec.ts";
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
  }).catch(async (err: unknown) => {
    const msg = String(err);
    if (/timed out|timeout/i.test(msg)) {
      if (label === "status --json") await diagnoseStatusBudget();
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

async function diagnoseStatusBudget(): Promise<void> {
  try {
    const result = await run("bun", ["run", join(root, "scripts", "status-probes.ts")], {
      cwd: root,
      timeoutMs: 22_000,
      reject: false,
      maxOutputBytes: 8_192,
    });
    reportStatusProbes(`${result.stdout}\n${result.stderr}`);
  } catch (error) {
    if (error instanceof ExecError) reportStatusProbes(`${error.stdout}\n${error.stderr}`);
  }
}

function reportStatusProbes(output: string): void {
  const allowed = /^probe (?:getStatus|getRepoRoot|worktreeList|getAheadBehind|getAheadOfDefault|getActivePullRequest|getGitHubAuthStatus|checkSubmodules|getStatusProviders|getConfig|expandAliasCold|createProgramCold|getConfigCold) elapsed=\d+ms success=(?:true|false)(?: errorKind=(?:exec|error|deadline))?$/;
  for (const line of output.split(/\r?\n/)) {
    if (allowed.test(line) || /^probe-start (?:getStatus|getRepoRoot|worktreeList|getAheadBehind|getAheadOfDefault|getActivePullRequest|getGitHubAuthStatus|checkSubmodules|getStatusProviders|getConfig|expandAliasCold|createProgramCold|getConfigCold)$/.test(line)) console.error(line);
  }
}

await within("startup (--version)", 2_000, ["--version"]);
await within("status --json", 10_000, ["status", "--json"]);
console.error("budgets ok");
