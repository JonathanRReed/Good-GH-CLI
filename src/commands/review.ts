import { safeHumanText } from "../utils/output.ts";
import { Command } from "commander";
import { requireGitRepo } from "../services/git.ts";
import { requireAuth } from "../services/github/client.ts";
import { prepareReview, resolveReview } from "../services/review.ts";
import { detectReviewEditor, openReviewEditor } from "../services/review/editors.ts";
import { detectReviewPager, showReviewPager } from "../services/review/pager.ts";
import { isReviewSha } from "../services/review/ledger.ts";
import { getFlags } from "../services/runtime.ts";
import { dryRun } from "../utils/flags.ts";
import { parsePositiveSafeInteger } from "../utils/numeric-target.ts";
import { data, fail, failFromGitHub, jsonOut, p } from "../utils/ui.ts";

export function registerReviewCommand(program: Command): void {
  program.command("review <pr>")
    .description("Inspect a PR in a safe checkout. Local marks are never GitHub approvals.")
    .option("--editor", "Open a GUI editor, detected by default when available")
    .option("--pager", "Review in tuicr, delta, or the terminal")
    .option("--since <revision>", "Show changes since last local mark or a full commit SHA")
    .option("--mark", "Record the current head as locally inspected, never a GitHub approval")
    .addHelpText("after", "\nEditor order: GGH_REVIEW_EDITOR, GUI VISUAL/EDITOR, code, cursor, zed, idea.\nJSON and agent output never launch editors or pagers. Opening an editor never marks a review.")
    .action(async (target: string, options: { editor?: boolean; pager?: boolean; since?: string; mark?: boolean }) => {
      const number = parsePositiveSafeInteger(target);
      if (number === null || (options.editor && options.pager) || (options.since !== undefined && options.since !== "last" && !isReviewSha(options.since))) {
        fail("Use a positive PR number, one of --editor/--pager, and --since last or a full commit SHA.", { code: "invalid_arguments" });
        return;
      }
      if (dryRun(`prepare review checkout for PR #${number}${options.mark ? " and record a local inspection mark" : ""}`)) return;
      if (!(await requireGitRepo()) || !(await requireAuth())) return;
      try {
        const dataOnly = getFlags().json || getFlags().agent;
        const editor = !dataOnly && !options.pager ? detectReviewEditor() : undefined;
        if (!dataOnly && options.editor && !editor) throw new Error("No supported GUI editor found. Set GGH_REVIEW_EDITOR or use --pager.");
        const snapshot = await resolveReview(number);
        const { result, from, files } = await prepareReview({ snapshot, since: options.since, mark: options.mark });
        if (jsonOut(result)) return;
        data(`PR #${number} at ${result.headSha}\n${result.checkoutPath}`);
        if (result.since) {
          data(`Changes since ${result.since.fromHead}${result.since.rewritten ? " [history rewritten]" : " [previous head is an ancestor]"}`);
          for (const commit of result.since.commits) data(`${commit.sha.slice(0, 12)} ${safeHumanText(commit.subject)}`);
          data(`Changed files: ${files.length}`);
          for (const file of files) data(safeHumanText(file));
          if (result.since.ambiguity) p.log.warn(result.since.ambiguity);
          if (result.since.rangeDiff) data(safeHumanText(result.since.rangeDiff));
          for (const thread of result.since.threadsChanged.threads) {
            data(`Thread ${thread.id} ${safeHumanText(thread.path)}:${thread.line ?? thread.originalLine ?? ""}`);
            for (const comment of thread.comments) data(`${safeHumanText(comment.author?.login ?? "unknown")}: ${safeHumanText(comment.body)}`);
          }
        }
        if (result.marked) data("Marked locally as inspected. No GitHub approval was submitted.");
        if (editor) {
          const hint = await openReviewEditor({ editor, cwd: result.checkoutPath, from, head: result.headSha, files, incremental: options.since !== undefined });
          if (hint) p.log.info(hint);
        } else {
          const pager = detectReviewPager(options.since !== undefined);
          await showReviewPager({ pager, pr: number, cwd: result.checkoutPath, from, head: result.headSha, repo: `${result.pr.host}/${result.pr.owner}/${result.pr.repo}`, host: result.pr.host });
        }
      } catch (error) { failFromGitHub(error); }
    });
}
