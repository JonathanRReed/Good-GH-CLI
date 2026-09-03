import type { Command } from "commander";
import {
  getActivePullRequest,
  getPullRequestDiff,
  submitPullRequestReview,
  viewPullRequest,
  type ReviewComment,
} from "../services/github.ts";
import {
  generateReviewWithFallback,
  type AIAttempt,
  type AIAttemptFailure,
  type ReviewFinding,
} from "../services/ai/index.ts";
import { sanitizeDiffForAI } from "../utils/diff.ts";
import { getFlags } from "../services/runtime.ts";
import { isDryRun } from "../utils/flags.ts";
import {
  confirmPrompt,
  emitJson,
  fail,
  formatAIFallback,
  header,
  multiSelectMenu,
  p,
  pc,
  reportAIFailure,
  selectMenu,
} from "../utils/ui.ts";

/** Lines the diff actually adds, so a finding can never be anchored somewhere GitHub will reject. */
function addedLinesByFile(diff: string): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  let file = "";
  let newLine = 0;

  for (const line of diff.split("\n")) {
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch) {
      file = fileMatch[1];
      if (!map.has(file)) map.set(file, new Set());
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number.parseInt(hunk[1], 10);
      continue;
    }
    if (!file) continue;
    if (line.startsWith("+")) {
      map.get(file)?.add(newLine);
      newLine++;
    } else if (!line.startsWith("-") && !line.startsWith("\\")) {
      newLine++;
    }
  }
  return map;
}

const SEVERITY_ORDER = { blocker: 0, concern: 1, nit: 2 } as const;

function severityTag(severity: ReviewFinding["severity"]): string {
  if (severity === "blocker") return pc.red("blocker");
  if (severity === "concern") return pc.yellow("concern");
  return pc.dim("nit");
}

export function registerPrReviewCommand(pr: Command): void {
  pr.command("review [prNumber]")
    .description("Review a Pull Request with AI and post the findings as real review comments")
    .option("-g, --guidance <text>", "Steer the review, e.g. 'focus on error handling'")
    .option("--approve", "Submit as an approval")
    .option("--request-changes", "Submit as a change request")
    .option("--comment", "Submit as comments only (default)")
    .option("--local", "Print the review without posting anything")
    .option("-y, --yes", "Post every finding without picking through them")
    .action(async (prNumber?: string, options?: {
      guidance?: string; approve?: boolean; requestChanges?: boolean;
      comment?: boolean; local?: boolean; yes?: boolean;
    }) => {
      header("AI Pull Request Review");

      let num: number | undefined = prNumber ? Number.parseInt(prNumber, 10) : undefined;
      if (num !== undefined && Number.isNaN(num)) {
        fail(`Invalid Pull Request number: ${prNumber}`);
        return;
      }
      if (num === undefined) {
        const active = await getActivePullRequest();
        if (!active) {
          fail("No Pull Request found for this branch. Pass a number.");
          return;
        }
        num = active.number;
      }

      const [detail, rawDiff] = await Promise.all([viewPullRequest(num), getPullRequestDiff(num)]);
      if (!rawDiff.trim()) {
        fail(`Pull Request #${num} has no diff to review.`);
        return;
      }

      const title = detail?.title ?? `Pull Request #${num}`;
      p.log.step(`#${num} ${pc.bold(title)}`);

      const s = p.spinner();
      s.start("Reading the diff...");
      let review;
      try {
        const run = await generateReviewWithFallback(
          { title, diff: sanitizeDiffForAI(rawDiff).diff, guidance: options?.guidance },
          undefined,
          (failure: AIAttemptFailure, next?: AIAttempt) => s.message(formatAIFallback(failure, next)),
        );
        review = run.result;
        s.stop(`Reviewed by ${pc.bold(run.providerName)} [${pc.cyan(run.model)}].`);
      } catch (err) {
        s.stop(pc.red("Review failed."));
        reportAIFailure(err, "Could not generate a review:");
        return;
      }

      // Only keep findings anchored to a line the diff actually adds.
      const valid = addedLinesByFile(rawDiff);
      const anchored: ReviewFinding[] = [];
      const unanchored: ReviewFinding[] = [];
      for (const finding of review.findings) {
        if (valid.get(finding.path)?.has(finding.line)) anchored.push(finding);
        else unanchored.push(finding);
      }
      anchored.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

      if (getFlags().json) {
        emitJson({ number: num, summary: review.summary, findings: anchored, unanchored });
        return;
      }

      if (review.summary) p.note(review.summary, "Summary");

      if (anchored.length === 0 && unanchored.length === 0) {
        p.log.success(pc.green("No issues found."));
        p.outro("Nothing to post.");
        return;
      }

      p.log.step(`${anchored.length} finding(s) anchored to changed lines:`);
      for (const [i, f] of anchored.entries()) {
        p.log.message(`  ${pc.dim(String(i + 1).padStart(2))} ${severityTag(f.severity)} ${pc.cyan(`${f.path}:${f.line}`)}`);
        p.log.message(`     ${f.body}`);
      }
      if (unanchored.length > 0) {
        p.log.warn(
          `${unanchored.length} finding(s) pointed at lines this diff does not add and were dropped rather than mis-anchored.`,
        );
      }

      if (options?.local) {
        p.outro(pc.dim("--local: nothing was posted."));
        return;
      }
      if (anchored.length === 0) {
        p.outro("Nothing anchored well enough to post.");
        return;
      }

      let selected = anchored;
      if (!options?.yes) {
        const picked = await multiSelectMenu<number>({
          message: "Which findings should be posted?",
          options: anchored.map((f, i) => ({
            value: i,
            label: `${f.path}:${f.line}`,
            hint: `${f.severity} · ${f.body.slice(0, 60)}`,
          })),
          initialValues: anchored.map((_, i) => i),
          pageSize: 10,
        });
        if (picked === null) {
          p.cancel("Review cancelled; nothing posted.");
          return;
        }
        selected = picked.map((i) => anchored[i]);
      }

      if (selected.length === 0) {
        p.outro("No findings selected.");
        return;
      }

      let event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES" = "COMMENT";
      if (options?.approve) event = "APPROVE";
      else if (options?.requestChanges) event = "REQUEST_CHANGES";
      else if (!options?.comment && !options?.yes) {
        const chosen = await selectMenu<"COMMENT" | "APPROVE" | "REQUEST_CHANGES">({
          message: "How should this review be submitted?",
          options: [
            { value: "COMMENT", label: "Comment", hint: "leave the findings without a verdict" },
            { value: "REQUEST_CHANGES", label: "Request changes", hint: "blocks merge until addressed" },
            { value: "APPROVE", label: "Approve", hint: "approve with the findings attached" },
          ],
          initialValue: selected.some((f) => f.severity === "blocker") ? "REQUEST_CHANGES" : "COMMENT",
        });
        if (!chosen) {
          p.cancel("Review cancelled; nothing posted.");
          return;
        }
        event = chosen;
      }

      if (isDryRun()) {
        p.log.warn(
          `${pc.yellow("dry run")} ${pc.dim("·")} would post ${selected.length} comment(s) on #${num} as ${event}`,
        );
        return;
      }

      const confirmed = await confirmPrompt({
        message: `Post ${selected.length} comment(s) on #${num} as ${event.replace("_", " ").toLowerCase()}?`,
        initialValue: true,
        assumeYes: options?.yes,
      });
      if (!confirmed) {
        p.cancel("Nothing posted.");
        return;
      }

      const comments: ReviewComment[] = selected.map((f) => ({
        path: f.path,
        line: f.line,
        body: `**${f.severity}** — ${f.body}\n\n<sub>via \`ggh pr review\`</sub>`,
      }));

      const postSpinner = p.spinner();
      postSpinner.start("Posting review...");
      try {
        await submitPullRequestReview(num, { event, body: review.summary, comments });
        postSpinner.stop(pc.green(`Review posted with ${comments.length} comment(s).`));
        p.outro("Done.");
      } catch (err) {
        postSpinner.stop(pc.red("Failed to post the review."));
        fail(String(err));
      }
    });
}
