import { fixtureDirectory, recorded, type ReplayResponse } from "./replay.ts";
import { join } from "node:path";

export const specimens = [
  { name: "zod", repo: "colinhacks/zod", pr: 5914, run: 32274929243 },
  { name: "vscode", repo: "microsoft/vscode", pr: 343557, run: 39818915094 },
];
export type Specimen = typeof specimens[number];

export function recordedRun(specimen: Specimen) {
  return { ...JSON.parse(recorded(`${specimen.name}-run-exact`)), ...JSON.parse(recorded(`${specimen.name}-run-json`)) };
}

export function ciResponses(specimen: Specimen): ReplayResponse[] {
  const run = recordedRun(specimen);
  const pr = JSON.parse(recorded(`${specimen.name}-pr-json`));
  const responses: ReplayResponse[] = [
    { command: "git", prefix: ["rev-parse", "--is-inside-work-tree"], stdout: "true\n" },
    { command: "gh", prefix: ["auth", "status"], stdout: JSON.stringify({ hosts: { "github.com": [{ active: true, state: "success", login: "offline", host: "github.com" }] } }) },
    { command: "gh", prefix: ["pr", "view"], stdout: JSON.stringify(pr) },
    { command: "gh", prefix: ["api", `repos/{owner}/{repo}/actions/runs?head_sha=${pr.headRefOid}&per_page=100&page=1`], stdout: JSON.stringify({ workflow_runs: [{ id: run.databaseId, workflow_id: 1 }] }) },
    { command: "gh", prefix: ["run", "view", String(specimen.run), "--json"], stdout: JSON.stringify(run) },
    { command: "gh", prefix: ["run", "view", String(specimen.run), "--log-failed"], fixture: `${specimen.name}-run-failed-log` },
  ];
  for (const job of run.jobs) {
    if (job.conclusion !== "failure") continue;
    const prefix = ["run", "view", String(specimen.run), "--job", String(job.databaseId)];
    responses.push({ command: "gh", prefix: [...prefix, "--log-failed"], stdout: recorded(`${specimen.name}-run-failed-log`).split("\n").filter(line => line.startsWith(`${job.name}\t`)).join("\n") + "\n" });
    responses.push({ command: "gh", prefix: ["api", `repos/{owner}/{repo}/actions/jobs/${job.databaseId}`], stderr: "Annotations were not captured by the research replay.", exitCode: 1 });
    responses.push(specimen.name === "vscode" && job.databaseId === 119964605506
      ? { command: "gh", prefix: [...prefix, "--log"], fixture: "vscode-full-failed-job" }
      : { command: "gh", prefix: [...prefix, "--log"], stderr: "Full job log was not captured by the research replay.", exitCode: 1 });
  }
  return responses;
}

export function statusResponses(specimen: Specimen): ReplayResponse[] {
  const fields = recorded(`${specimen.name}-state-porcelain`).trim().split("\n");
  return [
    { command: "git", prefix: ["rev-parse", "--is-inside-work-tree"], stdout: "true\n" },
    { command: "git", prefix: ["symbolic-ref", "-q", "HEAD"], stdout: "refs/heads/main\n" },
    { command: "git", prefix: ["branch", "--show-current"], stdout: "main\n" },
    { command: "git", prefix: ["-c", "core.quotepath=false", "status", "--porcelain=v1", "-z", "-uall"], stdout: "" },
    { command: "git", prefix: ["rev-parse", "--show-toplevel"], stdout: fixtureDirectory + "\n" },
    { command: "git", prefix: ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=no"], stdout: fields.join("\0") + "\0" },
    { command: "git", prefix: ["rev-parse", "--absolute-git-dir"], stdout: join(fixtureDirectory, ".recorded-git") + "\n" },
  ];
}
