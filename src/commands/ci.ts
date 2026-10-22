import { Command } from "commander";
import { collectCiEvidence } from "../services/github/ci.ts";
import { requireAuth, requireGitHubRepo } from "../services/github/client.ts";
import { getFlags, setFlags } from "../services/runtime.ts";
import { data, fail, failFromGitHub, jsonOut } from "../utils/ui.ts";

function budget(value: string, name: string, maximum: number): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) {
    throw new Error(`${name} must be an integer between 0 and ${maximum}.`);
  }
  return Number(value);
}

export function registerCiCommand(program: Command): void {
  program.command("ci").description("Inspect revision-linked CI evidence")
    .command("why [target]")
    .description("Extract failure evidence for a PR or Actions run")
    .option("--run", "Interpret the target as a run ID")
    .option("--max-bytes <n>", "Evidence and annotation byte budget per failing job", "6144")
    .option("--context <n>", "Context lines around each match", "2")
    .action(async (target: string | undefined, options: { run?: boolean; maxBytes: string; context: string }) => {
      let maxBytes: number;
      let context: number;
      try {
        maxBytes = budget(options.maxBytes, "--max-bytes", 1_048_576);
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
        if (jsonOut(result)) return;
        data(`${result.pr ? `PR #${result.pr.number} · ` : ""}${result.headSha}`);
        for (const run of result.runs) data(`${run.workflow}: ${run.conclusion || "pending"}${run.stale ? " [STALE]" : ""} ${run.url}`);
        for (const failure of result.failures) {
          data(`\n${failure.job} / ${failure.step}\n${failure.url} [${failure.logSource}]`);
          for (const annotation of failure.annotations) {
            data(`${annotation.path}:${annotation.startLine}: ${annotation.title ? `${annotation.title}: ` : ""}${annotation.message}`);
            if (annotation.rawDetails) data(annotation.rawDetails);
          }
          for (const line of failure.evidence) data(`${line.line}: ${line.text}`);
          data(`truncated: ${JSON.stringify(failure.truncated)}`);
          data(`annotationsTruncated: ${JSON.stringify(failure.annotationsTruncated)}`);
        }
        if (!result.failures.length && !result.unavailable.length) data("No failing jobs.");
        for (const item of result.unavailable) data(`Unavailable [${item.source}${item.job ? ` / ${item.job}` : ""}]: ${item.reason}`);
      } catch (err) { failFromGitHub(err); }
    });
}
