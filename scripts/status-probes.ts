#!/usr/bin/env bun
/** Bounded, value-free timings for the reads used by `status`. */
import {
  checkSubmodules,
  getAheadBehind,
  getAheadOfDefault,
  getRepoRoot,
  getStatus,
  worktreeList,
} from "../src/services/git.ts";
import { getActivePullRequest } from "../src/services/github/prs.ts";
import { getGitHubAuthStatus } from "../src/services/github/client.ts";
import { getConfig } from "../src/services/config.ts";
import { getStatusProviders } from "../src/services/ai/index.ts";
import { killAllChildren } from "../src/utils/exec.ts";

import { expandAlias } from "../src/commands/alias.ts";
import { createProgram } from "../src/index.ts";

const DEADLINE_MS = 18_000;

type ProbeResult = {
  name: string;
  elapsedMs: number;
  success: boolean;
  errorKind?: "exec" | "error" | "deadline";
};

const probes: Array<{ name: string; run: () => unknown }> = [
  { name: "getStatus", run: getStatus },
  { name: "getRepoRoot", run: getRepoRoot },
  { name: "worktreeList", run: worktreeList },
  { name: "getAheadBehind", run: getAheadBehind },
  { name: "getAheadOfDefault", run: getAheadOfDefault },
  { name: "getActivePullRequest", run: getActivePullRequest },
  { name: "getGitHubAuthStatus", run: getGitHubAuthStatus },
  { name: "checkSubmodules", run: checkSubmodules },
  { name: "getStatusProviders", run: getStatusProviders },
  { name: "getConfig", run: getConfig },
];

function errorKind(error: unknown): ProbeResult["errorKind"] {
  if (error instanceof Error && error.name === "ExecError") return "exec";
  return "error";
}

async function measure(probe: (typeof probes)[number]): Promise<ProbeResult> {
  const start = performance.now();
  console.error(`probe-start ${probe.name}`);
  try {
    await probe.run();
    return { name: probe.name, elapsedMs: Math.round(performance.now() - start), success: true };
  } catch (error) {
    return {
      name: probe.name,
      elapsedMs: Math.round(performance.now() - start),
      success: false,
      errorKind: errorKind(error),
    };
  }
}

const startupProbes: typeof probes = [
  { name: "expandAliasCold", run: () => expandAlias(["status", "--json"]) },
  { name: "createProgramCold", run: createProgram },
  { name: "getConfigCold", run: getConfig },
];
const completedProbes = new Map<string, ProbeResult>();
function report(result: ProbeResult): void {
  const error = result.errorKind ? ` errorKind=${result.errorKind}` : "";
  console.error(`probe ${result.name} elapsed=${result.elapsedMs}ms success=${result.success}${error}`);
}
async function measured(probe: (typeof probes)[number]): Promise<ProbeResult> {
  const result = await measure(probe);
  completedProbes.set(probe.name, result);
  report(result);
  return result;
}
let deadlineId: ReturnType<typeof setTimeout> | undefined;
const deadline = new Promise<undefined>((resolve) => {
  deadlineId = setTimeout(() => resolve(undefined), DEADLINE_MS);
});

// Match CLI startup order before starting reads in parallel. Cold ACL checks
// run synchronously, so print each start before entering the checked function.
const measurements = (async () => {
  const startup: ProbeResult[] = [];
  for (const probe of startupProbes) startup.push(await measured(probe));
  return [...startup, ...await Promise.all(probes.map(measured))];
})();
const completed = await Promise.race([measurements, deadline]);
if (deadlineId !== undefined) clearTimeout(deadlineId);

const results = completed ?? [...startupProbes, ...probes].map((probe): ProbeResult =>
  completedProbes.get(probe.name) ?? {
    name: probe.name,
    elapsedMs: DEADLINE_MS,
    success: false,
    errorKind: "deadline",
  },
);

if (!completed) await killAllChildren();

for (const result of results) {
  if (!completedProbes.has(result.name)) report(result);
}

if (!completed) process.exitCode = 1;
