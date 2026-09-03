import { Command } from "commander";
import {
  checkoutPullRequest,
  getGitHubAuthStatus,
  getPullRequestDiff,
  listPullRequests,
  viewPullRequestInBrowser,
} from "../services/github.ts";
import { fetchPullRequestBranch, detectDefaultBranch, isGitRepo, worktreeAdd } from "../services/git.ts";
import { registerPrCreateCommand } from "./pr-create.ts";
import { registerPrLifecycleCommands } from "./pr-lifecycle.ts";
import { registerPrReviewCommand } from "./pr-review.ts";
import { getFlags } from "../services/runtime.ts";
import { generatePrWithFallback, type AIAttempt, type AIAttemptFailure } from "../services/ai/index.ts";
import { sanitizeDiffForAI } from "../utils/diff.ts";
import {
  emitJson,
  fail,
  formatAIFallback,
  header,
  p,
  pc,
  reportAIFailure,
  searchablePicker,
  selectMenu,
} from "../utils/ui.ts";

function displayColoredDiff(rawDiff: string): void {
  const lines = rawDiff.split("\n");
  const output: string[] = [];
  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      output.push(pc.green(line));
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      output.push(pc.red(line));
    } else if (line.startsWith("@@")) {
      output.push(pc.cyan(line));
    } else if (line.startsWith("diff --git") || line.startsWith("index ")) {
      output.push(pc.bold(pc.dim(line)));
    } else {
      output.push(line);
    }
  }
  console.log("\n" + output.join("\n") + "\n");
}

export function registerPrCommand(program: Command): void {
  const pr = program
    .command("pr [prNumber]")
    .alias("prs")
    .description("Browse, checkout, and AI-review GitHub Pull Requests")
    .option("--checkout", "Directly checkout the specified PR number")
    .option("-w, --worktree", "Checkout PR into an isolated worktree (.worktrees/pr-N)")
    .option("--web", "Open the specified PR number in browser")
    .action(async (prNumber?: string, options?: { checkout?: boolean; worktree?: boolean; web?: boolean }) => {
      header("GitHub Pull Requests");

      if (!(await isGitRepo())) {
        fail("Not a git repository.");
        return;
      }

      const ghAuth = await getGitHubAuthStatus();
      if (!ghAuth.authenticated) {
        p.log.warn(
          ghAuth.notInstalled
            ? "GitHub CLI (`gh`) is not installed. Install it from https://cli.github.com to view Pull Requests."
            : "GitHub CLI is not authenticated. Run `gh auth login` to view Pull Requests.",
        );
        process.exitCode = 1;
        return;
      }

      if (prNumber) {
        const num = parseInt(prNumber, 10);
        if (isNaN(num)) {
          fail(`Invalid PR number: ${prNumber}`);
          return;
        }

        if (options?.web) {
          try {
            await viewPullRequestInBrowser(num);
          } catch (err) {
            fail(`Failed to open PR #${num} in browser: ${String(err)}`);
          }
          return;
        }

        if (options?.worktree) {
          const branchName = `pr-${num}`;
          const worktreePath = `.worktrees/pr-${num}`;
          const s = p.spinner();
          s.start(`Setting up isolated worktree for PR #${num}...`);
          try {
            await fetchPullRequestBranch(num, branchName);
            await worktreeAdd(branchName, worktreePath);
            s.stop(pc.green(`PR #${num} checked out to isolated worktree at ${pc.bold(pc.cyan(worktreePath))}!`));
            p.log.info(`Run ${pc.bold(pc.cyan(`cd ${worktreePath}`))} to start working.`);
          } catch (err) {
            s.stop(pc.red(`Failed to checkout PR #${num} into worktree.`));
            fail(String(err));
          }
          return;
        }

        const s = p.spinner();
        s.start(`Checking out PR #${num}...`);
        try {
          await checkoutPullRequest(num);
          s.stop(pc.green(`Checked out PR #${num} successfully!`));
        } catch (err) {
          s.stop(pc.red(`Failed to checkout PR #${num}.`));
          fail(String(err));
        }
        return;
      }

      // Interactive List
      const s = p.spinner();
      s.start("Fetching open Pull Requests from GitHub...");
      const prs = await listPullRequests(20);
      s.stop(`Loaded ${pc.green(String(prs.length))} open Pull Request(s).`);

      if (getFlags().json) {
        emitJson(prs);
        return;
      }

      if (prs.length === 0) {
        p.log.info(pc.dim("No open Pull Requests found for this repository."));
        return;
      }

      const selectedPrNum = await searchablePicker<number>({
        title: "Select a Pull Request to inspect:",
        items: prs.map((pr) => ({
          value: pr.number,
          label: `#${pr.number} ${pr.title}`,
          hint: `by @${pr.author.login} (${pr.headRefName})`,
        })),
        pageSize: 8,
      });

      if (!selectedPrNum) {
        p.cancel("Cancelled.");
        return;
      }

      const selectedPr = prs.find((pr) => pr.number === selectedPrNum);
      if (!selectedPr) return;

      const action = await selectMenu({
        message: `Action for PR #${selectedPr.number} (${selectedPr.title}):`,
        options: [
          { value: "checkout", label: "Checkout locally", hint: `switch to branch ${selectedPr.headRefName}` },
          { value: "worktree", label: "Checkout to isolated worktree", hint: `.worktrees/pr-${selectedPr.number}` },
          { value: "review", label: "Generate AI Summary / Review", hint: "analyze diff with AI" },
          { value: "diff", label: "View colored diff", hint: "inspect patch in terminal" },
          { value: "web", label: "Open in browser", hint: selectedPr.url },
          { value: "cancel", label: "Cancel" },
        ],
      });

      if (action === null || action === "cancel") return;

      if (action === "worktree") {
        const branchName = `pr-${selectedPr.number}`;
        const worktreePath = `.worktrees/pr-${selectedPr.number}`;
        const wtSpinner = p.spinner();
        wtSpinner.start(`Creating isolated worktree for PR #${selectedPr.number}...`);
        try {
          await fetchPullRequestBranch(selectedPr.number, branchName);
          await worktreeAdd(branchName, worktreePath);
          wtSpinner.stop(pc.green(`PR #${selectedPr.number} ready at ${pc.bold(pc.cyan(worktreePath))}!`));
          p.log.info(`Run ${pc.bold(pc.cyan(`cd ${worktreePath}`))} to review or build.`);
        } catch (err) {
          wtSpinner.stop(pc.red(`Failed to checkout PR into worktree.`));
          fail(String(err));
        }
      } else if (action === "checkout") {
        const checkoutSpinner = p.spinner();
        checkoutSpinner.start(`Checking out PR #${selectedPr.number}...`);
        try {
          await checkoutPullRequest(selectedPr.number);
          checkoutSpinner.stop(pc.green(`Checked out PR #${selectedPr.number}!`));
        } catch (err) {
          checkoutSpinner.stop(pc.red("Checkout failed."));
          fail(String(err));
        }
      } else if (action === "web") {
        try {
          await viewPullRequestInBrowser(selectedPr.number);
        } catch (err) {
          fail(`Failed to open PR #${selectedPr.number} in browser: ${String(err)}`);
        }
      } else if (action === "diff") {
        const diff = await getPullRequestDiff(selectedPr.number);
        if (diff) {
          displayColoredDiff(diff);
        } else {
          p.log.info("No diff available.");
        }
      } else if (action === "review") {
        const reviewSpinner = p.spinner();
        reviewSpinner.start("Fetching diff and generating AI review...");

        try {
          const [diff, defaultBranch] = await Promise.all([
            getPullRequestDiff(selectedPr.number),
            detectDefaultBranch(),
          ]);
          if (!diff.trim()) {
            reviewSpinner.stop(pc.yellow("No diff available for this Pull Request."));
            return;
          }

          const { result: prSummary, providerName, model } = await generatePrWithFallback(
            {
              branch: selectedPr.headRefName,
              baseBranch: defaultBranch,
              // Never send raw PR diffs (lockfiles, .env, secrets) to the AI provider
              diff: sanitizeDiffForAI(diff).diff,
              commitSummary: selectedPr.title,
            },
            undefined,
            (failure: AIAttemptFailure, next?: AIAttempt) => {
              reviewSpinner.message(formatAIFallback(failure, next));
            },
          );

          reviewSpinner.stop(`AI summary generated by ${pc.bold(providerName)} [${pc.cyan(model)}].`);
          p.note(prSummary.body, `AI Summary for PR #${selectedPr.number}`);
        } catch (err) {
          reviewSpinner.stop(pc.yellow("AI review failed."));
          reportAIFailure(err, "Could not generate an AI review:");
          process.exitCode = 1;
        }
      }
    });

  registerPrCreateCommand(pr);
  registerPrLifecycleCommands(pr);
  registerPrReviewCommand(pr);
}
