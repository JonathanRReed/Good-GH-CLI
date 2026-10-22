import type { Command } from "commander";
import { getReviewThreads, reviewThreadsSince, type ReviewThreadsResult } from "../services/github/review-threads.ts";
import { getFlags } from "../services/runtime.ts";
import { parsePositiveSafeInteger } from "../utils/numeric-target.ts";
import { data } from "../utils/output.ts";
import { fail, failFromGitHub, jsonOut } from "../utils/ui.ts";

export function formatReviewThreads(result: ReviewThreadsResult): string {
  const files = new Map<string, ReviewThreadsResult["threads"]>();
  for (const thread of result.threads) {
    const group = files.get(thread.path) ?? [];
    group.push(thread);
    files.set(thread.path, group);
  }
  const lines = [`PR #${result.number} ${result.headSha} (base ${result.baseSha})`];
  for (const [path, threads] of files) {
    lines.push(`\n${path}`);
    for (const thread of threads) {
      const line = thread.line ?? thread.originalLine;
      const location = line === null ? "file" : thread.startLine === null ? `${line}` : `${thread.startLine}-${line}`;
      lines.push(`  ${location} [${thread.isResolved ? "resolved" : "unresolved"}]${thread.isOutdated ? " [outdated]" : ""} ${thread.id}`);
      for (const comment of thread.comments) {
        lines.push(`  @${comment.author?.login ?? "deleted"}${comment.outdated ? " [outdated]" : ""}${comment.bodyTruncated ? " [body truncated]" : ""}`, comment.body);
      }
    }
  }
  if (!result.threads.length) lines.push("No matching review threads.");
  if (!result.pagination.complete) lines.push("Pagination incomplete. Do not advance --since until a complete read.");
  return lines.join("\n");
}

export function registerPrThreadsCommand(pr: Command): void {
  pr.command("threads [number]")
    .description("Read pull request review threads with full comment bodies")
    .option("--unresolved", "Only unresolved threads (default with --agent)")
    .option("--all", "Include resolved and unresolved threads")
    .option("--since <timestamp>", "Threads with comments created or edited after an ISO timestamp or returned cursor")
    .option("--max-body <n>", "Truncate bodies to n characters and flag affected comments")
    .action(async (number: string | undefined, options: { unresolved?: boolean; all?: boolean; since?: string; maxBody?: string }) => {
      const num = number === undefined ? undefined : parsePositiveSafeInteger(number);
      if (num === null) { fail(`Invalid PR number: ${number}`, { code: "invalid_arguments" }); return; }
      if (options.all && options.unresolved) { fail("Use either --all or --unresolved.", { code: "invalid_arguments" }); return; }
      const maxBody = options.maxBody === undefined ? undefined : /^\d+$/.test(options.maxBody) ? Number(options.maxBody) : NaN;
      if (maxBody !== undefined && (!Number.isSafeInteger(maxBody) || maxBody < 0)) {
        fail("Invalid --max-body. Use a non-negative integer.", { code: "invalid_arguments" }); return;
      }
      try { if (options.since !== undefined) reviewThreadsSince(options.since); }
      catch (error) { fail(error instanceof Error ? error.message : String(error), { code: "invalid_arguments" }); return; }
      try {
        const result = await getReviewThreads(num, {
          unresolved: options.unresolved || (getFlags().agent && !options.all), since: options.since, maxBody,
        });
        if (jsonOut(result)) return;
        data(formatReviewThreads(result));
      } catch (error) { failFromGitHub(error); }
    });
}
