import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ciResponses, recordedRun, specimens, statusResponses } from "./cases.ts";
import { recorded, replayCli } from "./replay.ts";
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
        { label: "tracking branch", pattern: "origin/main" },
        { label: "ahead/behind", pattern: '# branch\\.ab \\+0 -0|"ahead":0,"behind":0' },
        { label: "clean checkout", pattern: '^# branch\\.ab \\+0 -0\\n?$|"staged":0,"unstaged":0,"untracked":0,"conflicts":0' },
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
    // Normalize the checkout path only; every other output byte comes from the current CLI.
    const envelope = JSON.parse(out.stdout);
    if (kind === "status" && envelope.result?.repository) envelope.result.repository.root = `/recorded/${specimen.name}`;
    const output = kind === "status" ? JSON.stringify(envelope) + "\n" : out.stdout;
    const native = metrics(nativeOutput, expected, commands.length);
    const ggh = { ...metrics(output, expected, 1), subprocessCalls: out.calls.length, exitCode: out.exitCode, unexpected: out.unexpected, stderr: out.stderr };
    results.push({ case: `${specimen.name}-${kind}`, question: kind === "ci" ? "Why did CI fail at this PR head?" : kind === "status" ? "Which branch and tracking branch, what drift, and is it clean?" : "Which run/jobs failed and what did the failed steps print?", expectedEvidence: expected, nativeCommands: commands, gghCommand: `ggh ${command.join(" ")}`, native, ggh });
  }
}
const artifact = { schemaVersion: 1, fixtureRevision: "agent-pain-2026-10-22", tokenMetric: "bytes/4 estimate; no offline tokenizer dev dependency installed", results };
writeFileSync(join(import.meta.dir, "results.json"), JSON.stringify(artifact, null, 2) + "\n");
console.table(results.map(row => ({ case: row.case, "native bytes": row.native.bytes, "ggh bytes": row.ggh.bytes, "native ~tokens": row.native.tokens, "ggh ~tokens": row.ggh.tokens, "native recall": `${row.native.recall * 100}%`, "ggh recall": `${row.ggh.recall * 100}%`, "native calls": row.native.toolCalls, "ggh calls": row.ggh.toolCalls })));
console.log(artifact.tokenMetric);
if (results.some(row => row.ggh.recall < 1 || row.native.recall < 1 || row.ggh.recall < row.native.recall || row.ggh.exitCode !== 0 || row.ggh.unexpected.length || row.ggh.stderr)) {
  console.error("Agent evidence gate failed. See bench/agent/results.json.");
  process.exitCode = 1;
}
