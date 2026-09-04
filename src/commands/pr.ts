import { Command } from "commander";
import {
  checkoutPullRequest,
  commentOnPullRequest,
  getPullRequestDiff,
  listPullRequests,
  mergePullRequest,
  requireAuth,
  requireGitHubRepo,
  setPullRequestState,
  viewPullRequest,
  viewPullRequestInBrowser,
} from "../services/github.ts";
import { detectDefaultBranch, fetchPullRequestBranch, requireGitRepo, worktreeAdd } from "../services/git.ts";
import { registerPrCreateCommand } from "./pr-create.ts";
import { registerPrLifecycleCommands } from "./pr-lifecycle.ts";
import { registerPrReviewCommand } from "./pr-review.ts";
import { type AIAttempt, type AIAttemptFailure, generatePrWithFallback } from "../services/ai/index.ts";
import { dryRun } from "../utils/flags.ts";
import { sanitizeDiffForAI } from "../utils/diff.ts";
import {
  confirmOrAbort, jsonOut,
  fail,
  failFromGitHub,
  formatAIFallback,
  header,
  p,
  pc,
  promptInput,
  renderDiff,
  reportAIFailure,
  searchablePicker,
  selectMenu,
} from "../utils/ui.ts";

export function registerPrCommand(program: Command): void {
  const pr = program
    .command("pr [prNumber]")
    .alias("prs")
    .description("Open, review, merge, and check out pull requests")
    .option("--checkout", "Directly checkout the specified PR number")
    .option("-w, --worktree", "Checkout PR into an isolated worktree (.worktrees/pr-N)")
    .option("--web", "Open the specified PR number in browser")
    .option("-a, --author <user>", "Filter PRs by author (use @me for your own)")
    .option("-l, --label <label>", "Filter PRs by label")
    .option("-s, --state <state>", "Filter by state: open, closed, merged, all", "open")
    .option("--search <query>", "Filter PRs with a search query")
    .option("--mine", "Show only PRs authored by you")
    .option("--limit <n>", "Maximum PRs to list", "30")
    .option("-y, --yes", "Skip confirmation prompts for merge/close actions")
    .action(async (prNumber?: string, options?: {
      checkout?: boolean; worktree?: boolean; web?: boolean;
      author?: string; label?: string; state?: string; search?: string; mine?: boolean; limit?: string;
      yes?: boolean;
    }) => {
      header("GitHub Pull Requests");

      const [isRepo, authed] = await Promise.all([requireGitHubRepo(), requireAuth()]);
      if (!isRepo || !authed) return;

      if ((options?.checkout || options?.worktree) && !(await requireGitRepo())) return;
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
            failFromGitHub(err);
          }
          return;
        }

        if (options?.worktree) {
          const branchName = `pr-${num}`;
          const worktreePath = `.worktrees/pr-${num}`;
          if (dryRun(`checkout PR #${num} into worktree ${worktreePath}`)) return;
          const s = p.spinner();
          s.start(`Setting up isolated worktree for PR #${num}...`);
          try {
            await fetchPullRequestBranch(num, branchName);
            await worktreeAdd(branchName, worktreePath);
            s.stop(pc.green(`PR #${num} checked out to isolated worktree at ${pc.bold(pc.cyan(worktreePath))}!`));
            p.log.info(`Run ${pc.bold(pc.cyan(`cd ${worktreePath}`))} to start working.`);
          } catch (err) {
            s.stop(pc.red(`Failed to checkout PR #${num} into worktree.`));
            failFromGitHub(err);
          }
          return;
        }

        if (options?.checkout) {
          if (dryRun(`checkout PR #${num}`)) return;
          const s = p.spinner();
          s.start(`Checking out PR #${num}...`);
          try {
            await checkoutPullRequest(num);
            s.stop(pc.green(`Checked out PR #${num} successfully!`));
          } catch (err) {
            s.stop(pc.red(`Failed to checkout PR #${num}.`));
            failFromGitHub(err);
          }
          return;
        }

        await inspectPullRequest(num, options?.yes);
        return;
      }

      await listPullRequestsInteractive(options);
    });

  pr.command("list")
    .description("List pull requests for this repository")
    .option("-a, --author <user>", "Filter by author")
    .option("-l, --label <label>", "Filter by label")
    .option("-s, --state <state>", "Filter by state", "open")
    .option("--search <query>", "Search query")
    .option("--mine", "Show only your PRs")
    .option("--limit <n>", "Maximum to list", "30")
    .action(async (options?: {
      author?: string; label?: string; state?: string; search?: string; mine?: boolean; limit?: string;
    }) => {
      header("GitHub Pull Requests");
      const [isRepo, authed] = await Promise.all([requireGitHubRepo(), requireAuth()]);
      if (!isRepo || !authed) return;
      await listPullRequestsInteractive(options);
    });

  pr.command("diff <prNumber>")
    .description("Show the diff for a pull request")
    .action(async (prNumber: string) => {
      header("Pull Request Diff");
      if (!(await requireGitHubRepo())) return;
      const num = parseInt(prNumber, 10);
      if (isNaN(num)) {
        fail(`Invalid PR number: ${prNumber}`);
        return;
      }
      const s = p.spinner();
      s.start(`Fetching diff for PR #${num}...`);
      try {
        const diff = await getPullRequestDiff(num);
        s.stop(diff ? "Diff loaded." : "No diff available.");
        if (jsonOut({ number: num, diff })) return;
        if (diff.trim()) {
          renderDiff(diff);
        } else {
          p.log.info("No diff available.");
        }
      } catch (err) {
        s.stop(pc.red("Failed to fetch diff."));
        failFromGitHub(err);
      }
    });

  pr.command("checkout <prNumber>")
    .description("Check out a pull request locally")
    .action(async (prNumber: string) => {
      header("Checkout Pull Request");
      if (!(await requireGitHubRepo())) return;
      const num = parseInt(prNumber, 10);
      if (isNaN(num)) {
        fail(`Invalid PR number: ${prNumber}`);
        return;
      }
      if (dryRun(`checkout PR #${num}`)) return;
      const s = p.spinner();
      s.start(`Checking out PR #${num}...`);
      try {
        await checkoutPullRequest(num);
        s.stop(pc.green(`Checked out PR #${num} successfully!`));
      } catch (err) {
        s.stop(pc.red("Checkout failed."));
        failFromGitHub(err);
      }
    });

  registerPrCreateCommand(pr);
  registerPrLifecycleCommands(pr);
  registerPrReviewCommand(pr);

  async function listPullRequestsInteractive(options?: {
    author?: string; label?: string; state?: string; search?: string; mine?: boolean; limit?: string;
  }): Promise<void> {
    // Read-only: --dry-run does not block listing.
    const s = p.spinner();
    s.start("Fetching open Pull Requests from GitHub...");
    let prs: Awaited<ReturnType<typeof listPullRequests>>;
    try {
      prs = await listPullRequests({
        limit: parseInt(options?.limit ?? "30", 10) || 30,
        state: options?.state,
        author: options?.author,
        label: options?.label,
        search: options?.search,
        mine: options?.mine,
      });
      s.stop(`Loaded ${pc.green(String(prs.length))} open Pull Request(s).`);
    } catch (err) {
      s.stop(pc.red("Failed to fetch Pull Requests."));
      failFromGitHub(err);
      return;
    }

    if (jsonOut(prs)) return;

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

    await inspectPullRequest(selectedPrNum);
  }

  async function inspectPullRequest(num: number, assumeYes?: boolean): Promise<void> {
    const s = p.spinner();
    s.start(`Fetching PR #${num}...`);
    let detail;
    try {
      detail = await viewPullRequest(num);
    } catch (err) {
      s.stop(pc.red("Failed to fetch PR."));
      failFromGitHub(err);
      return;
    }
    if (!detail) {
      s.stop(pc.yellow("PR not found."));
      fail(`PR #${num} not found.`);
      return;
    }
    s.stop("Pull Request loaded.");

    if (jsonOut(detail)) return;

    const action = await selectMenu<string>({
      message: `Action for PR #${detail.number} (${detail.title}):`,
      options: [
        { value: "checkout", label: "Checkout locally", hint: `switch to branch ${detail.headRefName}` },
        { value: "worktree", label: "Checkout to isolated worktree", hint: `.worktrees/pr-${detail.number}` },
        { value: "merge", label: "Merge", hint: "merge and optionally delete branch" },
        { value: "ready", label: "Mark as ready", hint: "ready for review" },
        { value: "close", label: "Close", hint: "close without merging" },
        { value: "reopen", label: "Reopen", hint: "reopen a closed PR" },
        { value: "comment", label: "Comment", hint: "add a comment" },
        { value: "review", label: "Generate AI Summary / Review", hint: "analyze diff with AI" },
        { value: "diff", label: "View colored diff", hint: "inspect patch in terminal" },
        { value: "web", label: "Open in browser", hint: detail.url },
        { value: "cancel", label: "Cancel" },
      ],
      initialValue: "checkout",
    });

    if (action === null || action === "cancel") return;

    if (action === "merge") {
      const method = await selectMenu<"squash" | "merge" | "rebase">({
        message: `How should PR #${num} be merged?`,
        options: [
          { value: "squash", label: "Squash and merge" },
          { value: "merge", label: "Merge commit" },
          { value: "rebase", label: "Rebase and merge" },
        ],
        initialValue: "squash",
      });
      if (!method) return;
      if (dryRun(`${method}-merge PR #${num}`)) return;
      if (!(await confirmOrAbort(`${method}-merge PR #${num}?`, { assumeYes, cancelText: null }))) return;
      const mergeSpinner = p.spinner();
      mergeSpinner.start(`Merging PR #${num}...`);
      try {
        await mergePullRequest(num, { method, deleteBranch: true });
        mergeSpinner.stop(pc.green(`PR #${num} merged.`));
      } catch (err) {
        mergeSpinner.stop(pc.red("Merge failed."));
        failFromGitHub(err);
      }
      return;
    }

    if (action === "ready" || action === "close" || action === "reopen") {
      const stateVerb = action === "ready" ? "mark as ready" : action;
      if (dryRun(`${stateVerb} PR #${num}`)) return;
      if (!(await confirmOrAbort(`${action === "ready" ? "Mark PR #" + num + " as ready" : action + " PR #" + num}?`, { assumeYes, cancelText: null }))) return;
      const stateSpinner = p.spinner();
      stateSpinner.start(`${action} PR #${num}...`);
      try {
        const url = await setPullRequestState(action, num);
        stateSpinner.stop(pc.green(`PR #${num} ${action === "ready" ? "is ready" : action + "d"}.`));
        if (url) p.log.message(pc.dim(url));
      } catch (err) {
        stateSpinner.stop(pc.red("Failed."));
        failFromGitHub(err);
      }
      return;
    }

    if (action === "comment") {
      const body = await promptInput({ message: "Comment:", validate: (v) => (!v?.trim() ? "Comment cannot be empty" : undefined) });
      if (!body) return;
      if (dryRun(`comment on PR #${num}`)) return;
      const commentSpinner = p.spinner();
      commentSpinner.start("Posting comment...");
      try {
        const url = await commentOnPullRequest(num, body);
        commentSpinner.stop(pc.green("Comment posted."));
        if (url) p.log.message(pc.dim(url));
      } catch (err) {
        commentSpinner.stop(pc.red("Failed to post comment."));
        failFromGitHub(err);
      }
      return;
    }

    if (action === "worktree") {
      const branchName = `pr-${num}`;
      const worktreePath = `.worktrees/pr-${num}`;
      const wtSpinner = p.spinner();
      wtSpinner.start(`Creating isolated worktree for PR #${num}...`);
      try {
        await fetchPullRequestBranch(num, branchName);
        await worktreeAdd(branchName, worktreePath);
        wtSpinner.stop(pc.green(`PR #${num} ready at ${pc.bold(pc.cyan(worktreePath))}!`));
        p.log.info(`Run ${pc.bold(pc.cyan(`cd ${worktreePath}`))} to review or build.`);
      } catch (err) {
        wtSpinner.stop(pc.red(`Failed to checkout PR into worktree.`));
        failFromGitHub(err);
      }
    } else if (action === "checkout") {
      const checkoutSpinner = p.spinner();
      checkoutSpinner.start(`Checking out PR #${num}...`);
      try {
        await checkoutPullRequest(num);
        checkoutSpinner.stop(pc.green(`Checked out PR #${num}!`));
      } catch (err) {
        checkoutSpinner.stop(pc.red("Checkout failed."));
        failFromGitHub(err);
      }
    } else if (action === "web") {
      try {
        await viewPullRequestInBrowser(num);
      } catch (err) {
        failFromGitHub(err);
      }
    } else if (action === "diff") {
      try {
        const diff = await getPullRequestDiff(num);
        if (diff) {
          renderDiff(diff);
        } else {
          p.log.info("No diff available.");
        }
      } catch (err) {
        failFromGitHub(err);
      }
    } else if (action === "review") {
      const reviewSpinner = p.spinner();
      reviewSpinner.start("Fetching diff and generating AI review...");

      try {
        const [diff, defaultBranch] = await Promise.all([getPullRequestDiff(num), detectDefaultBranch()]);
        if (!diff.trim()) {
          reviewSpinner.stop(pc.yellow("No diff available for this Pull Request."));
          return;
        }

        const { result: prSummary, providerName, model } = await generatePrWithFallback(
          {
            branch: detail.headRefName,
            baseBranch: defaultBranch,
            // Never send raw PR diffs (lockfiles, .env, secrets) to the AI provider
            diff: sanitizeDiffForAI(diff).diff,
            commitSummary: detail.title,
          },
          undefined,
          (failure: AIAttemptFailure, next?: AIAttempt) => {
            reviewSpinner.message(formatAIFallback(failure, next));
          },
        );

        reviewSpinner.stop(`AI summary generated by ${pc.bold(providerName)} [${pc.cyan(model)}].`);
        p.note(prSummary.body, `AI Summary for PR #${num}`);
      } catch (err) {
        reviewSpinner.stop(pc.yellow("AI review failed."));
        reportAIFailure(err, "Could not generate an AI review:");
        process.exitCode = 1;
      }
    }
  }
}
