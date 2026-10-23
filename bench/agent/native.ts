import { stripVTControlCharacters } from "node:util";
import { recorded } from "./replay.ts";
import { recordedRun, type Specimen } from "./cases.ts";

export function filterNativeLog(log: string) {
  const lines = log.split(/\r?\n/).map(text => stripVTControlCharacters(text).replace(/\^\[\[[0-9;]*m/g, "").replace(/^[^\t]*\t[^\t]*\t/, "").replace(/^\uFEFF?\d{4}-\d\d-\d\dT\S+\s?/, ""));
  const wanted = new Set<number>();
  const unique = new Set<string>();
  lines.forEach((text, i) => {
    if (unique.has(text) || !/\w*Error\b|\bTS\d{4,}\b|\bFAIL\b|\berror:|\bException\b|##\[error\]|\.[cm]?[jt]sx?:\d+/i.test(text)) return;
    unique.add(text);
    for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 1); j++) wanted.add(j);
  });
  return [...wanted].sort((a, b) => a - b).map(i => ({ line: i + 1, text: lines[i] }));
}

/** Independent summary-first native reference: project metadata, then rg-like log filtering.
 * No ggh extractor, budget, or hand-written diagnostic answers are used here.
 */
export function nativeCi(specimen: Specimen): { output: string; commands: string[] } {
  const pr = JSON.parse(recorded(`${specimen.name}-pr-json`));
  const run = recordedRun(specimen);
  const commands = [
    `gh pr view ${specimen.pr} -R ${specimen.repo} --json number,url,headRefOid`,
    `gh run list -R ${specimen.repo} --commit ${pr.headRefOid} --json databaseId,workflowName,conclusion,headSha,url`,
    `gh run view ${specimen.run} -R ${specimen.repo} --json databaseId,headSha,url,workflowName,conclusion,jobs`,
    `gh run view ${specimen.run} -R ${specimen.repo} --log-failed`,
  ];
  const logs = [{ source: "failed-step", text: recorded(`${specimen.name}-run-failed-log`) }];
  if (specimen.name === "vscode") {
    commands.push(`gh run view ${specimen.run} -R ${specimen.repo} --job 119964605506 --log`);
    logs.push({ source: "full-job", text: recorded("vscode-full-failed-job") });
  }
  const evidence = logs.map(log => ({ source: log.source, lines: filterNativeLog(log.text) }));
  return { commands, output: JSON.stringify({ pr: pr.number, headSha: pr.headRefOid, run: run.databaseId,
    jobs: run.jobs.filter((j: { conclusion: string }) => j.conclusion === "failure").map((j: { name: string; steps: Array<{ name: string; conclusion: string }> }) => ({ name: j.name, steps: j.steps.filter(s => s.conclusion === "failure").map(s => s.name) })), evidence }) + "\n" };
}

if (import.meta.main) {
  const log = await Bun.stdin.text();
  const lines = filterNativeLog(log);
  console.log(JSON.stringify({ lines, bytesTotal: Buffer.byteLength(log), bytesShown: lines.reduce((sum, line) => sum + Buffer.byteLength(line.text ?? ""), 0) }));
}
