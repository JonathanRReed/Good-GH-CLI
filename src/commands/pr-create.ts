import type { Command } from "commander";
import {
  detectDefaultBranch,
  findPrTemplate,
  getBranchDiff,
  getBranchDiffStat,
  getCommitsSinceBase,
  getCurrentBranch,
  getRemoteTrackingBranch,
  isGitRepo,
  push,
} from "../services/git.ts";
import { createPullRequest, getActivePullRequest, getGitHubAuthStatus } from "../services/github.ts";
import { generatePrWithFallback, type AIAttempt, type AIAttemptFailure } from "../services/ai/index.ts";
import { sanitizeDiffForAI } from "../utils/diff.ts";
import { isDryRun } from "../utils/flags.ts";
import { getFlags } from "../services/runtime.ts";
import {
  confirmPrompt,
  emitJson,
  fail,
  formatAIFallback,
  header,
  p,
  pc,
  promptInput,
  reportAIFailure,
} from "../utils/ui.ts";

/**
 * `ggh pr create` — the missing half of the pull request story. Everything before
 * this could browse and check out PRs but never open one unless it happened as a
 * side effect of `ggh commit --pr`.
 */
export function registerPrCreateCommand(pr: Command): void {
  pr.command("create")
    .description("Open a Pull Request for the current branch, with an AI-written title and body")
    .option("-t, --title <title>", "Pull Request title (skips AI generation)")
    .option("-b, --body <body>", "Pull Request body (skips AI generation)")
    .option("--base <branch>", "Base branch to merge into")
    .option("-d, --draft", "Create as a draft Pull Request")
    .option("-w, --web", "Open the create page in a browser instead")
    .option("-i, --issue <issue>", "Link the Pull Request to an issue number")
    .option("-y, --yes", "Skip the confirmation prompt")
    .option("--no-ai", "Use the commit history for the title and body instead of AI")
    .action(async (options: {
      title?: string; body?: string; base?: string; draft?: boolean;
      web?: boolean; issue?: string; yes?: boolean; ai?: boolean;
    }) => {
      header("Create Pull Request");

      if (!(await isGitRepo())) {
        fail("Not a git repository.");
        return;
      }

      const auth = await getGitHubAuthStatus();
      if (!auth.authenticated) {
        fail(
          auth.notInstalled
            ? "GitHub CLI (`gh`) is not installed. Install it from https://cli.github.com."
            : "GitHub CLI is not authenticated. Run `gh auth login`.",
        );
        return;
      }

      const branch = await getCurrentBranch();
      if (!branch || branch === "HEAD") {
        fail("Cannot open a Pull Request from a detached HEAD. Check out a branch first.");
        return;
      }

      const existing = await getActivePullRequest();
      if (existing) {
        p.log.info(`Branch ${pc.cyan(branch)} already has Pull Request #${existing.number}.`);
        if (getFlags().json) {
          emitJson(existing);
          return;
        }
        p.log.message(`  ${pc.bold(pc.cyan(existing.url))}`);
        p.outro("Nothing to do.");
        return;
      }

      const base = options.base || (await detectDefaultBranch());
      if (base === branch) {
        fail(`Base and head are both ${pc.bold(branch)}. Pass --base to pick a different target.`);
        return;
      }

      const [commits, diff, diffStat, template] = await Promise.all([
        getCommitsSinceBase(base),
        getBranchDiff(base),
        getBranchDiffStat(base),
        findPrTemplate(),
      ]);

      if (commits.length === 0) {
        fail(`Branch ${pc.bold(branch)} has no commits that ${pc.bold(base)} does not already have.`);
        return;
      }

      p.log.step(`${commits.length} commit(s) on ${pc.cyan(branch)} against ${pc.cyan(base)}`);

      // A branch that was never pushed cannot be the head of a Pull Request.
      if (!(await getRemoteTrackingBranch(process.cwd(), branch))) {
        if (isDryRun()) {
          p.log.warn(`${pc.yellow("dry run")} ${pc.dim("·")} would push ${branch} to origin`);
        } else {
          const pushSpinner = p.spinner();
          pushSpinner.start(`Pushing ${pc.cyan(branch)} to origin...`);
          try {
            await push({ branch, setUpstream: true });
            pushSpinner.stop(pc.green("Branch pushed."));
          } catch (err) {
            pushSpinner.stop(pc.red("Push failed."));
            fail(String(err));
            return;
          }
        }
      }

      let title = options.title;
      let body = options.body;

      if ((!title || !body) && options.ai !== false) {
        const aiSpinner = p.spinner();
        aiSpinner.start("Writing the Pull Request with AI...");
        try {
          const { result, providerName, model } = await generatePrWithFallback(
            {
              branch,
              baseBranch: base,
              diff: sanitizeDiffForAI(diff).diff,
              diffStat,
              commitSummary: commits.join("\n"),
              template: template || undefined,
              issue: options.issue,
            },
            undefined,
            (failure: AIAttemptFailure, next?: AIAttempt) => aiSpinner.message(formatAIFallback(failure, next)),
          );
          aiSpinner.stop(`Draft written by ${pc.bold(providerName)} [${pc.cyan(model)}].`);
          title = title || result.title;
          body = body || result.body;
        } catch (err) {
          aiSpinner.stop(pc.yellow("AI generation failed; falling back to the commit history."));
          reportAIFailure(err, "Could not write the Pull Request with AI:");
        }
      }

      title = title || commits[commits.length - 1] || `Changes from ${branch}`;
      body = body || commits.map((c) => `- ${c}`).join("\n");

      if (!options.title && !getFlags().json) {
        const edited = await promptInput({ message: "Pull Request title:", defaultValue: title });
        if (edited === null) {
          p.cancel("Cancelled.");
          return;
        }
        title = edited;
      }

      p.note(`${pc.bold(title)}\n\n${pc.dim(body)}`, options.draft ? "Draft Pull Request" : "Pull Request");

      if (isDryRun()) {
        p.log.warn(`${pc.yellow("dry run")} ${pc.dim("·")} would open a Pull Request ${pc.cyan(base)} ← ${pc.cyan(branch)}`);
        p.outro("Nothing was created.");
        return;
      }

      const confirmed = await confirmPrompt({
        message: `Open this Pull Request against ${pc.bold(base)}?`,
        initialValue: true,
        assumeYes: options.yes,
      });
      if (!confirmed) {
        p.cancel("Cancelled.");
        return;
      }

      const createSpinner = p.spinner();
      createSpinner.start("Opening Pull Request...");
      try {
        const url = await createPullRequest({
          title,
          body,
          draft: options.draft,
          web: options.web,
          base,
        });
        createSpinner.stop(pc.green("Pull Request opened."));
        if (getFlags().json) {
          emitJson({ url, title, body, base, head: branch, draft: Boolean(options.draft) });
          return;
        }
        p.log.success(`${pc.bold(pc.cyan(url))}`);
        p.outro("Done.");
      } catch (err) {
        createSpinner.stop(pc.red("Failed to open the Pull Request."));
        fail(String(err));
      }
    });
}
