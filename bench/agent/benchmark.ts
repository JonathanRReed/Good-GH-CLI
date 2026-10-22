import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ciResponses, recordedRun, specimens, statusResponses } from "./cases.ts";
import { recorded, replayCli } from "./replay.ts";
import { dirtyStatusCase } from "./dirty-status.ts";
import { nativeCi } from "./native.ts";

interface ExpectedEvidence { label: string; pattern: string }
const ciEvidence: Record<string, ExpectedEvidence[]> = {
  zod: [
    { label: "PR head revision", pattern: "611a961879eef8379c44f778b113316b084180fa" },
    { label: "recursive pipe return type", pattern: "'pipe' implicitly has return type 'any'" },
    { label: "circular pipe type", pattern: "Type of property 'pipe' circularly references itself" },
    { label: "first source location", pattern: "recursive-types\\.test\\.ts:456:9" },
    { label: "second source location", pattern: "recursive-types\\.test\\.ts:457:14" },
  ],
  vscode: [
    { label: "PR head revision", pattern: JSON.parse(recorded("vscode-pr-json")).headRefOid },
    { label: "missing dependency", pattern: "SessionChatInputToolbar depends on UNKNOWN service quickInputService" },
    { label: "deferring failed step", pattern: "Fail if fixtures had errors" },
    { label: "second failed job", pattern: "Screenshots & Tests" },
  ],
};

export function recall(output: string, expected: ExpectedEvidence[]) {
  const missing = expected.filter(item => !new RegExp(item.pattern, "m").test(output)).map(item => item.label);
  return { recall: (expected.length - missing.length) / expected.length, missing };
}
function metrics(output: string, expected: ExpectedEvidence[], toolCalls: number) {
  const bytes = Buffer.byteLength(output);
  return { ...recall(output, expected), bytes, tokens: bytes / 4, toolCalls };
}

const results = [];
for (const specimen of specimens) {
  for (const kind of ["ci", "status", "run"] as const) {
    const ci = nativeCi(specimen);
    const run = recordedRun(specimen);
    let expected: ExpectedEvidence[];
    let nativeOutput: string;
    let commands: string[];
    let command: string[];
    if (kind === "ci") {
      expected = ciEvidence[specimen.name] ?? [];
      nativeOutput = ci.output;
      commands = ci.commands;
      command = ["ci", "why", String(specimen.pr), "-R", specimen.repo, "--agent"];
    } else if (kind === "status") {
      expected = [
        { label: "branch", pattern: "main" },
        { label: "HEAD identity", pattern: /# branch\.oid ([a-f0-9]+)/.exec(recorded(`${specimen.name}-state-porcelain`))![1]! },
        { label: "tracking branch", pattern: "origin/main" },
        { label: "ahead/behind", pattern: '# branch\\.ab \\+0 -0|^(?!.*"(?:ahead|behind)":)[\\s\\S]+$' },
        { label: "clean checkout", pattern: '^# branch\\.ab \\+0 -0\\n?$|^(?!.*"(?:changes|staged|unstaged|untracked|conflicts)":)[\\s\\S]+$' },
      ];
      nativeOutput = recorded(`${specimen.name}-state-porcelain`);
      commands = ["git status --porcelain=v2 --branch"];
      command = ["status", "--agent"];
    } else {
      expected = [
        { label: "run ID", pattern: String(specimen.run) },
        { label: "conclusion", pattern: "failure" },
        { label: "workflow", pattern: run.workflowName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") },
        { label: "failed-step output", pattern: specimen.name === "zod" ? "'pipe' implicitly has return type 'any'" : "See the 'Check fixture errors' step" },
      ];
      nativeOutput = recorded(`${specimen.name}-run-exact`) + recorded(`${specimen.name}-run-failed-log`);
      commands = [
        `gh run view ${specimen.run} -R ${specimen.repo} --json databaseId,displayTitle,workflowName,status,conclusion,headBranch,event,createdAt,url,jobs`,
        `gh run view ${specimen.run} -R ${specimen.repo} --log-failed`,
      ];
      command = ["run", String(specimen.run), "-R", specimen.repo, "--agent"];
    }
    const out = await replayCli(command, kind === "status" ? statusResponses(specimen) : ciResponses(specimen));
    const output = out.stdout;
    const native = metrics(nativeOutput, expected, commands.length);
    const ggh = { ...metrics(output, expected, 1), ...(kind === "status" ? { byteRatio: Buffer.byteLength(output) / native.bytes, maxByteRatio: 1.5 } : {}), subprocessCalls: out.calls.length, exitCode: out.exitCode, unexpected: out.unexpected, stderr: out.stderr };
    results.push({ case: `${specimen.name}-${kind}`, question: kind === "ci" ? "Why did CI fail at this PR head?" : kind === "status" ? "Which branch and tracking branch, what drift, and is it clean?" : "Which run/jobs failed and what did the failed steps print?", expectedEvidence: expected, nativeCommands: commands, gghCommand: `ggh ${command.join(" ")}`, native, ggh });
  }
}
const dirtyResults = [];
for (const count of [5, 25]) {
  const row = await dirtyStatusCase(count);
  dirtyResults.push({ case: `dirty-status-${count}`, question: "Which paths need index, worktree, rename, untracked or conflict actions?", expectedEvidence: row.expected,
    nativeCommands: ["git status --porcelain=v2 --branch"], nativeV1Commands: ["git status --porcelain=v1 -b"], gghCommand: "ggh status --agent",
    native: metrics(row.nativeOutput, row.expected, 1), nativeV1: metrics(row.nativeV1Output, row.expected, 1),
    previousRawFormat: { bytes: Buffer.byteLength(row.previousOutput), measurement: "Previous raw-record shape reconstructed from the same porcelain response and envelope, not an older binary." },
    ggh: { ...metrics(row.out.stdout, row.expected, 1), subprocessCalls: row.out.calls.length, exitCode: row.out.exitCode, unexpected: row.out.unexpected, stderr: row.out.stderr },
  });
}
const artifact = { schemaVersion: 1, fixtureRevision: "agent-pain-2026-10-22", tokenMetric: "bytes/4 estimate; no offline tokenizer dev dependency installed", results, dirtyResults };
writeFileSync(join(import.meta.dir, "results.json"), JSON.stringify(artifact, null, 2) + "\n");
console.table(results.map(row => ({ case: row.case, "native bytes": row.native.bytes, "ggh bytes": row.ggh.bytes, "native ~tokens": row.native.tokens, "ggh ~tokens": row.ggh.tokens, "native recall": `${row.native.recall * 100}%`, "ggh recall": `${row.ggh.recall * 100}%`, "native calls": row.native.toolCalls, "ggh calls": row.ggh.toolCalls })));
console.table(dirtyResults.map(row => ({ case: row.case, "native v2 bytes": row.native.bytes, "native v1 bytes": row.nativeV1.bytes, "previous raw bytes": row.previousRawFormat.bytes, "ggh bytes": row.ggh.bytes, "v2 / v1 / ggh recall": `${row.native.recall * 100}% / ${row.nativeV1.recall * 100}% / ${row.ggh.recall * 100}%` })));
console.log(artifact.tokenMetric);
if (dirtyResults.some(row => [row.native, row.nativeV1, row.ggh].some(result => result.recall < 1) || row.ggh.exitCode !== 0 || row.ggh.unexpected.length || row.ggh.stderr) || results.some(row => row.ggh.recall < 1 || row.native.recall < 1 || row.ggh.recall < row.native.recall || row.ggh.exitCode !== 0 || row.ggh.unexpected.length || row.ggh.stderr || (row.ggh.byteRatio !== undefined && row.ggh.byteRatio > 1.5))) {
  console.error("Agent evidence gate failed. See bench/agent/results.json.");
  process.exitCode = 1;
}
