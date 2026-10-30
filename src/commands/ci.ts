import { Command } from "commander";
import { collectCiEvidence, type CiEvidence } from "../services/github/ci.ts";
import { requireAuth, requireGitHubRepo } from "../services/github/client.ts";
import { getFlags, setFlags } from "../services/runtime.ts";
import { formatJsonOutput } from "../utils/output.ts";
import { data, fail, failFromGitHub, jsonOut } from "../utils/ui.ts";

function budget(value: string, name: string, maximum: number): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) {
    throw new Error(`${name} must be an integer between 0 and ${maximum}.`);
  }
  return Number(value);
}

function humanEvidence(result: CiEvidence): string {
  const lines = [`${result.repository}${result.pr ? ` PR #${result.pr.number}` : ""} · ${result.headSha}`];
  for (const run of result.runs) lines.push(`${run.workflow}${run.event ? ` [${run.event}]` : ""}: ${run.conclusion || "pending"}${run.stale ? " [STALE]" : ""} ${run.url}`);
  for (const failure of result.failures) {
    lines.push(`\n${failure.job} / ${failure.step}\n${failure.url} [${failure.logSource}]`);
    if (failure.jobs) for (const job of failure.jobs) lines.push(`Affected: ${job.job} / ${job.step} ${job.url} [${job.logSource}]`);
    for (const annotation of failure.annotations) {
      lines.push(`${annotation.path}:${annotation.startLine}: ${annotation.title ? `${annotation.title}: ` : ""}${annotation.message}`);
      if (annotation.rawDetails) lines.push(annotation.rawDetails);
    }
    for (const line of failure.evidence) lines.push(`${line.line}: ${line.text}`);
    if (failure.truncated.bytesShown < failure.truncated.bytesTotal) lines.push(`truncated: ${JSON.stringify(failure.truncated)}`);
    if (failure.annotationsTruncated) lines.push(`annotationsTruncated: ${JSON.stringify(failure.annotationsTruncated)}`);
  }
  if (!result.failures.length && !result.unavailable.length && !result.outputTruncated) lines.push("No failing jobs.");
  for (const item of result.unavailable) lines.push(`Unavailable [${item.source}${item.job ? ` / ${item.job}` : ""}]: ${item.reason}`);
  if (result.outputTruncated) lines.push(`outputTruncated: ${JSON.stringify(result.outputTruncated)}`);
  return lines.join("\n") + "\n";
}

function capOutput(result: CiEvidence, maxBytes: number): void {
  const bytes = () => Buffer.byteLength(getFlags().json ? formatJsonOutput(result) : humanEvidence(result));
  const bytesTotal = bytes();
  if (bytesTotal <= maxBytes) return;
  const omitted = { bytesTotal, maxBytes, evidenceLines: 0, annotations: 0, jobs: 0, failures: 0, runs: 0, unavailable: 0 };
  result.outputTruncated = omitted;
  while (bytes() > maxBytes) {
    // Keep a sample error for each group before removing identities or coverage warnings.
    const withExtraLines = result.failures.findLast(failure => failure.evidence.length > 1);
    const withAnnotations = result.failures.findLast(failure => failure.annotations.length);
    const withEvidence = result.failures.findLast(failure => failure.evidence.length);
    const withJobs = result.failures.findLast(failure => failure.jobs && failure.jobs.length > 1);
    if (withExtraLines) {
      const failure = withExtraLines;
      const line = failure.evidence.pop();
      if (line) { failure.truncated.bytesShown -= Buffer.byteLength(line.text); omitted.evidenceLines++; }
    } else if (withAnnotations) {
      const annotation = withAnnotations.annotations.pop();
      if (annotation) {
        const size = Buffer.byteLength(JSON.stringify(annotation));
        const shown = withAnnotations.annotations.reduce((total, item) => total + Buffer.byteLength(JSON.stringify(item)), 0);
        withAnnotations.annotationsTruncated ??= { bytesTotal: shown + size, bytesShown: shown + size };
        withAnnotations.annotationsTruncated.bytesShown -= size;
        omitted.annotations++;
      }
    } else if (withJobs) {
      withJobs.jobs?.pop();
      omitted.jobs++;
    } else if (result.failures.length > 1) {
      const failure = result.failures.pop();
      omitted.failures++;
      omitted.jobs += failure?.jobs?.length ?? 1;
      omitted.evidenceLines += failure?.evidence.length ?? 0;
    } else if (withEvidence) {
      const line = withEvidence.evidence.pop();
      if (line) { withEvidence.truncated.bytesShown -= Buffer.byteLength(line.text); omitted.evidenceLines++; }
    } else if (result.failures.length) {
      result.failures.pop();
      omitted.failures++;
      omitted.jobs++;
    } else if (result.runs.length) {
      result.runs.pop();
      omitted.runs++;
    } else if (result.unavailable.length) {
      result.unavailable.pop();
      omitted.unavailable++;
    } else {
      throw new Error("Target identity exceeds --max-output-bytes. Increase the total output budget.");
    }
  }
}

export function registerCiCommand(program: Command): void {
  program.command("ci").description("Inspect revision-linked CI evidence")
    .command("why [target]")
    .description("Extract failure evidence for a PR or Actions run")
    .option("--run", "Interpret the target as a run ID")
    .option("--max-bytes <n>", "Evidence and annotation byte budget per failing job", "6144")
    .option("--max-output-bytes <n>", "Total stdout byte cap, including metadata (minimum 1024)", "16384")
    .option("--context <n>", "Context lines around each match", "2")
    .action(async (target: string | undefined, options: { run?: boolean; maxBytes: string; maxOutputBytes: string; context: string }) => {
      let maxBytes: number;
      let maxOutputBytes: number;
      let context: number;
      try {
        maxBytes = budget(options.maxBytes, "--max-bytes", 1_048_576);
        maxOutputBytes = budget(options.maxOutputBytes, "--max-output-bytes", 1_048_576);
        if (maxOutputBytes < 1024) throw new Error("--max-output-bytes must be at least 1024.");
        context = budget(options.context, "--context", 100);
        if (target === "pr") target = undefined;
        if (target?.startsWith("https://")) {
          const url = new URL(target);
          const match = /^\/([^/]+)\/([^/]+)\/(pull|actions\/runs)\/(\d+)\/?$/.exec(url.pathname);
          if (!match || url.username || url.password || url.search || url.hash) throw new Error("Use a PR or Actions run URL.");
          const [, owner, repo, kind, id] = match;
          const repoArg = `${url.host}/${owner}/${repo}`;
          if (getFlags().repo && getFlags().repo !== repoArg && getFlags().repo !== `${owner}/${repo}`) throw new Error("URL and --repo targets disagree.");
          setFlags({ repo: repoArg });
          target = id;
          options.run = kind === "actions/runs";
        }
        if (target && !/^[1-9]\d*$/.test(target)) throw new Error("Use a PR number, run ID, or URL.");
        if (options.run && !target) throw new Error("A run ID is required with --run.");
      } catch (err) { fail(err instanceof Error ? err.message : String(err), { code: "invalid_arguments" }); return; }
      if (!(await requireGitHubRepo()) || !(await requireAuth())) return;
      try {
        const result = await collectCiEvidence({ target, run: options.run, maxBytes, context });
        capOutput(result, maxOutputBytes);
        if (jsonOut(result)) return;
        data(humanEvidence(result).trimEnd());
      } catch (err) { failFromGitHub(err); }
    });
}
