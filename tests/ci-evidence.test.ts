import { describe, expect, test } from "bun:test";
import { extractEvidence, needsFullJobLog } from "../src/services/ci-evidence.ts";
import { replayCli, type ReplayResponse } from "../bench/agent/replay.ts";
import { specimens, ciResponses, recordedRun } from "../bench/agent/cases.ts";

const zod = specimens[0]!;
const vscode = specimens[1]!;
const args = (target = String(zod.pr)) => ["ci", "why", target, "-R", "colinhacks/zod", "--agent"];
const runPrefix = ["run", "view", String(zod.run), "--json"];
const jobPrefix = ["run", "view", String(zod.run), "--job", "96139983606"];
function replace(responses: ReplayResponse[], prefix: string[], response: Omit<ReplayResponse, "command" | "prefix">) {
  return [{ command: "gh" as const, prefix, ...response }, ...responses];
}

describe("CI evidence", () => {
  test("finds Zod pipe type errors and source locations in the large recorded log", async () => {
    const out = await replayCli(args(), ciResponses(zod));
    expect(out.exitCode).toBe(0);
    expect(out.unexpected).toEqual([]);
    const { result } = JSON.parse(out.stdout);
    expect(result.headSha).toBe("611a961879eef8379c44f778b113316b084180fa");
    expect(result.failures[0].logSource).toBe("failed-step");
    expect(out.stdout).toContain("'pipe' implicitly has return type 'any'");
    expect(out.stdout).toContain("Type of property 'pipe' circularly references itself");
    expect(out.stdout).toContain("recursive-types.test.ts:456:9");
    expect(out.stdout).toContain("recursive-types.test.ts:457:14");
    expect(result.failures[0].truncated.bytesTotal).toBeGreaterThan(200_000);
    expect(result.failures[0].truncated.bytesShown).toBeLessThan(6144);
    expect(out.calls.some(call => call.at(-3) === "--job" && call.at(-1) === "--log")).toBe(false);
  });

  test("follows VS Code deferral into the full job log and keeps the original line number", async () => {
    const out = await replayCli(["ci", "why", String(vscode.pr), "-R", vscode.repo, "--agent"], ciResponses(vscode));
    expect(out.exitCode).toBe(0);
    expect(out.unexpected).toEqual([]);
    const { result } = JSON.parse(out.stdout);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]).toMatchObject({ job: "Screenshots", logSource: "full-job", truncated: { bytesTotal: 536918 } });
    expect(result.failures[0].evidence).toContainEqual(expect.objectContaining({ line: 685, text: expect.stringContaining("SessionChatInputToolbar depends on UNKNOWN service quickInputService") }));
    expect(result.unavailable).toContainEqual(expect.objectContaining({ job: "Screenshots & Tests", source: "full-job" }));
  });

  test("reads a finished job's log through the jobs API while its run is still in progress", async () => {
    const pending = { stderr: `run ${zod.run} is still in progress; logs will be available when it is complete`, exitCode: 1 };
    const log = "2026-10-22T20:00:00.0000000Z src/types.ts(12,3): error TS2322: Type 'string' is not assignable to type 'number'.\n";
    const responses = [
      { command: "gh" as const, prefix: ["api", "--allow-escape-sequences", "repos/{owner}/{repo}/actions/jobs/96139983606/logs"], stdout: log },
      ...replace(ciResponses(zod), [...jobPrefix, "--log-failed"], pending),
    ];
    const out = await replayCli(args(), responses);
    expect(out.exitCode).toBe(0);
    expect(out.unexpected).toEqual([]);
    const { result } = JSON.parse(out.stdout);
    expect(result.failures[0].logSource).toBe("full-job");
    expect(out.stdout).toContain("error TS2322");
    expect(result.unavailable.some((item: { source: string }) => item.source === "failed-step")).toBe(false);
  });

  test("excludes stale-run evidence instead of blaming the current PR head", async () => {
    const out = await replayCli(args(), replace(ciResponses(zod), runPrefix, { stdout: JSON.stringify({ ...recordedRun(zod), headSha: "stale" }) }));
    const { result } = JSON.parse(out.stdout);
    expect(out.unexpected).toEqual([]);
    expect(result.runs[0].stale).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.unavailable[0].source).toBe("stale-run");
    expect(out.calls.some(call => call.includes("--log-failed"))).toBe(false);
  });

  test("returns a clean bundle without log requests when every job passes", async () => {
    const run = recordedRun(zod);
    run.conclusion = "success";
    run.jobs = run.jobs.map((job: object) => ({ ...job, conclusion: "success" }));
    const out = await replayCli(args(), replace(ciResponses(zod), runPrefix, { stdout: JSON.stringify(run) }));
    expect(out.unexpected).toEqual([]);
    expect(JSON.parse(out.stdout).result).toMatchObject({ failures: [], unavailable: [] });
    expect(out.calls.some(call => call.includes("--log-failed"))).toBe(false);
  });

  test("selects only the latest run per workflow and reports workflows with missing run details", async () => {
    const head = "611a961879eef8379c44f778b113316b084180fa";
    let responses = replace(ciResponses(zod), ["api", `repos/{owner}/{repo}/actions/runs?head_sha=${head}&per_page=100&page=1`], {
      stdout: JSON.stringify({ workflow_runs: [{ id: zod.run, workflow_id: 1 }, { id: 7, workflow_id: 1 }, { id: 9, workflow_id: 2 }] }),
    });
    responses = replace(responses, ["run", "view", "9", "--json"], { stderr: "Run deleted", exitCode: 1 });
    const out = await replayCli(args(), responses);
    expect(out.exitCode).toBe(0);
    expect(out.unexpected).toEqual([]);
    const { result } = JSON.parse(out.stdout);
    expect(result.runs).toHaveLength(1);
    expect(result.unavailable).toContainEqual(expect.objectContaining({ source: "run", runId: 9 }));
    expect(out.calls.some(call => call[1] === "run" && call[3] === "7")).toBe(false);
  });

  test("discloses missing runs and run-list failures for the pinned revision", async () => {
    const head = "611a961879eef8379c44f778b113316b084180fa";
    for (const response of [{ stdout: '{"workflow_runs":[]}' }, { stderr: "HTTP 403", exitCode: 1 }]) {
      const out = await replayCli(args(), replace(ciResponses(zod), ["api", `repos/{owner}/{repo}/actions/runs?head_sha=${head}&per_page=100&page=1`], response));
      expect(out.unexpected).toEqual([]);
      expect(JSON.parse(out.stdout).result).toMatchObject({ headSha: head, runs: [], failures: [], unavailable: [expect.objectContaining({ source: "runs" })] });
    }
  });

  test("discloses unavailable failed-step and full-job logs", async () => {
    const out = await replayCli(args(), replace(ciResponses(zod), [...jobPrefix, "--log-failed"], { stderr: "Logs expired", exitCode: 1 }));
    const { result } = JSON.parse(out.stdout);
    expect(out.unexpected).toEqual([]);
    expect(result.failures[0]).toMatchObject({ evidence: [], truncated: { bytesTotal: 0, bytesShown: 0 } });
    expect(result.unavailable.map((item: { source: string }) => item.source)).toEqual(["annotations", "failed-step", "full-job", "log"]);
  });

  test("discloses even a zero byte budget without dropping the failure identity", async () => {
    const out = await replayCli([...args(), "--max-bytes", "0"], ciResponses(zod));
    const { result } = JSON.parse(out.stdout);
    expect(result.failures[0]).toMatchObject({ evidence: [], truncated: { bytesShown: 0 } });
    expect(result.failures[0].truncated.bytesTotal).toBeGreaterThan(200_000);
    expect(result.failures[0].job).toContain("TypeScript");
  });

  test("paginates check-run annotations and discloses their separate byte budget", async () => {
    let responses = replace(ciResponses(zod), ["api", "repos/{owner}/{repo}/actions/jobs/96139983606"], { stdout: '{"check_run_url":"https://api.github.com/repos/colinhacks/zod/check-runs/123"}' });
    const annotation = { path: "src/test.ts", start_line: 9, end_line: 10, annotation_level: "failure", title: "Type error", message: "pipe fails" };
    responses = replace(responses, ["api", "repos/{owner}/{repo}/check-runs/123/annotations?per_page=100&page=1"], { stdout: JSON.stringify(Array.from({ length: 100 }, () => annotation)) });
    responses = replace(responses, ["api", "repos/{owner}/{repo}/check-runs/123/annotations?per_page=100&page=2"], { stdout: "[]" });
    const out = await replayCli([...args(), "--max-bytes", "256"], responses);
    expect(out.unexpected).toEqual([]);
    const failure = JSON.parse(out.stdout).result.failures[0];
    expect(failure.annotations).toContainEqual({ path: "src/test.ts", startLine: 9, endLine: 10, level: "failure", title: "Type error", message: "pipe fails", rawDetails: "" });
    expect(failure.annotationsTruncated.bytesTotal).toBeGreaterThan(failure.annotationsTruncated.bytesShown);
    expect(failure.annotationsTruncated.bytesShown).toBeLessThanOrEqual(256);
  });

  test("supports the current PR, PR URLs, run URLs, and an explicit run ID", async () => {
    for (const target of [[], ["pr"], [`https://github.com/${zod.repo}/pull/${zod.pr}`], [String(zod.run), "--run"], [`https://github.com/${zod.repo}/actions/runs/${zod.run}`]]) {
      const out = await replayCli(["ci", "why", ...target, "-R", zod.repo, "--agent"], ciResponses(zod));
      expect(out.exitCode).toBe(0);
      expect(out.unexpected).toEqual([]);
      expect(JSON.parse(out.stdout).result.headSha).toBe("611a961879eef8379c44f778b113316b084180fa");
    }
  });

  test("uses a missing numeric PR as a run ID, but never hides authentication failures", async () => {
    for (const [message, code] of [["HTTP 404: Not Found", 0], ["GraphQL: Could not resolve to a PullRequest with the number of 32274929243.", 0], ["HTTP 401: Unauthorized", 1]] as const) {
      const out = await replayCli(args(String(zod.run)), replace(ciResponses(zod), ["pr", "view"], { stderr: message, exitCode: 1 }));
      expect(out.exitCode).toBe(code);
      expect(out.unexpected).toEqual([]);
      expect(out.calls.some(call => call.includes("--log-failed"))).toBe(code === 0);
    }
  });

  test("rejects malformed budgets and targets before accessing GitHub", async () => {
    for (const tail of [["--max-bytes", "6kb"], ["--context", "-1"], ["--context", "101"], ["--max-bytes", "999999999999999999"], ["--run"]]) {
      const out = await replayCli(["ci", "why", "--agent", ...tail], []);
      expect(out.exitCode).toBe(1);
      expect(out.calls).toEqual([]);
      expect(JSON.parse(out.stdout).error.code).toBe("invalid_arguments");
    }
  });

  test("registers a versioned result schema and renders grouped human evidence", async () => {
    const schema = await replayCli(["agent", "schema"], []);
    const result = JSON.parse(schema.stdout);
    expect(result.supportedCommandPaths).toContainEqual(["ci", "why"]);
    expect(result.coreResultSchemas.ciWhy.schema.properties.schemaVersion.const).toBe(1);
    const human = await replayCli(["ci", "why", String(zod.pr), "-R", zod.repo], ciResponses(zod));
    expect(human.stdout).toContain("[failed-step]");
    expect(human.stdout).toContain("truncated:");
    expect(human.stdout).toContain("recursive-types.test.ts:456:9");
    expect(human.unexpected).toEqual([]);
  });

  test("extracts deterministic deduplicated errors, stack frames, and context within UTF-8 budgets", () => {
    const log = "setup\nnearby\nError: broken\n    at app (src/app.ts:12:4)\nError: broken\n日本語\nlast\n";
    const selected = extractEvidence(log, 1024, 1);
    expect(selected).toEqual(extractEvidence(log, 1024, 1));
    expect(selected.evidence).toContainEqual({ line: 4, text: "    at app (src/app.ts:12:4)" });
    expect(selected.evidence.filter(line => line.text === "Error: broken")).toHaveLength(1);
    expect(selected.evidence).toContainEqual({ line: 2, text: "nearby" });
    expect(Buffer.byteLength(JSON.stringify(extractEvidence(log, 60, 2).evidence))).toBeLessThanOrEqual(60);
    for (const summary of ["", "summary: 4 tests failed", "##[error]Process completed with exit code 1.\n"]) expect(needsFullJobLog(summary)).toBe(true);
    expect(needsFullJobLog("Error: concrete failure in app.ts:20\n".repeat(5))).toBe(false);
  });
});
