import type { Command } from "commander";
import {
  filterReviewComments,
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
import { dryRun } from "../utils/flags.ts";
import { applyPatch } from "../services/git.ts";
import {
  confirmOrAbort, jsonOut,
  fail,
  failFromGitHub,
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
      const matchedFile = fileMatch.at(1);
      if (matchedFile === undefined) continue;
      file = matchedFile;
      if (!map.has(file)) map.set(file, new Set());
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      const hunkStart = hunk.at(1);
      if (hunkStart === undefined) continue;
      newLine = Number.parseInt(hunkStart, 10);
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
    .option("--fix", "Generate and offer to apply AI-suggested fixes for each finding")
    .option("-y, --yes", "Post every finding without picking through them")
    .action(async (prNumber?: string, options?: {
      guidance?: string; approve?: boolean; requestChanges?: boolean;
      comment?: boolean; local?: boolean; fix?: boolean; yes?: boolean;
    }) => {
      header("AI Pull Request Review");

      let num: number | undefined = prNumber ? Number.parseInt(prNumber, 10) : undefined;
      if (num !== undefined && Number.isNaN(num)) {
        fail(`Invalid PR number: ${prNumber}`);
        return;
      }
      if (num === undefined) {
        const active = await getActivePullRequest();
        if (!active) {
          fail("No PR found for the current branch. Pass a number.");
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

      if (jsonOut({ number: num, summary: review.summary, findings: anchored, unanchored })) return;

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

      // --fix: show AI-suggested patches and let the user apply selected ones.
      if (options?.fix) {
        const fixable = anchored.filter((f) => f.suggestedFix);
        if (fixable.length === 0) {
          p.log.info(pc.dim("No AI-suggested fixes were generated for these findings."));
        } else {
          p.log.step(`${fixable.length} finding(s) have suggested fixes:`);
          for (const [i, f] of fixable.entries()) {
            p.log.message(`  ${pc.dim(String(i + 1).padStart(2))} ${severityTag(f.severity)} ${pc.cyan(`${f.path}:${f.line}`)}`);
            p.log.message(`     ${f.body}`);
            if (f.suggestedFix) {
              p.note(f.suggestedFix, `Suggested fix ${i + 1}`);
            }
          }

          if (dryRun(`offer to apply ${fixable.length} fix(es)`)) {
            // dry run announced; skip the apply menu
          } else {
            const applyPicks = await multiSelectMenu<number>({
              message: "Apply which suggested fixes?",
              options: fixable.map((f, i) => ({
                value: i,
                label: `${f.path}:${f.line}`,
                hint: `${f.severity} · ${f.body.slice(0, 60)}`,
              })),
              initialValues: fixable.map((_, i) => i),
              pageSize: 10,
            });
            if (applyPicks === null) {
              p.log.info(pc.dim("No fixes applied."));
            } else if (applyPicks.length > 0) {
              const combinedPatch = applyPicks.map((i) => fixable.at(i)?.suggestedFix ?? "").join("\n");
              const applySpinner = p.spinner();
              applySpinner.start(`Applying ${applyPicks.length} fix(es)...`);
              try {
                await applyPatch(combinedPatch);
                applySpinner.stop(pc.green(`Applied ${applyPicks.length} fix(es) to the working tree.`));
                p.log.info(pc.dim("Review the changes with `git diff`, then `ggh c -a` to commit."));
              } catch (err) {
                applySpinner.stop(pc.red("Failed to apply one or more patches."));
                fail(String(err));
              }
            }
          }
        }
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
        selected = picked.flatMap((i) => {
          const finding = anchored.at(i);
          return finding ? [finding] : [];
        });
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

      if (dryRun(`post ${selected.length} comment(s) on #${num} as ${event}`)) return;

      if (!(await confirmOrAbort(`Post ${selected.length} comment(s) on #${num} as ${event.replace("_", " ").toLowerCase()}?`, { assumeYes: options?.yes, cancelText: "Nothing posted." }))) return;

      const comments: ReviewComment[] = selected.map((f) => ({
        path: f.path,
        line: f.line,
        body: `**${f.severity}** — ${f.body}\n\n<sub>via \`ggh pr review\`</sub>`,
      }));

      const { comments: filteredComments, dropped } = filterReviewComments(comments, rawDiff);
      if (dropped.length > 0) {
        p.log.warn(`${pc.yellow(String(dropped.length))} review comment(s) were dropped:`);
        for (const d of dropped) {
          p.log.message(
            `  ${pc.red("✖")} ${pc.cyan(`${d.comment.path}:${d.comment.line}`)} — ${d.reasons.join(", ")}`,
          );
        }
      }

      if (filteredComments.length === 0) {
        p.outro("No review comments passed the safety filter.");
        return;
      }

      const postSpinner = p.spinner();
      postSpinner.start("Posting review...");
      try {
        await submitPullRequestReview(num, { event, body: review.summary, comments: filteredComments });
        postSpinner.stop(pc.green(`Review posted with ${filteredComments.length} comment(s).`));
        p.outro("Done.");
      } catch (err) {
        postSpinner.stop(pc.red("Failed to post the review."));
        failFromGitHub(err);
      }
    });
}
