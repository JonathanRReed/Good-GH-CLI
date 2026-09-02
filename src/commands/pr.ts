import { Command } from "commander";
import {
  checkoutPullRequest,
  getGitHubAuthStatus,
  getPullRequestDiff,
  listPullRequests,
  viewPullRequestInBrowser,
} from "../services/github.ts";
import { fetchPullRequestBranch, isGitRepo, worktreeAdd } from "../services/git.ts";
import { resolveAIProvider } from "../services/ai/index.ts";
import { header, p, pc } from "../utils/ui.ts";

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
  program
    .command("pr [prNumber]")
    .alias("prs")
    .description("Browse, checkout, and AI-review GitHub Pull Requests")
    .option("--checkout", "Directly checkout the specified PR number")
    .option("-w, --worktree", "Checkout PR into an isolated worktree (.worktrees/pr-N)")
    .option("--web", "Open the specified PR number in browser")
    .action(async (prNumber?: string, options?: { checkout?: boolean; worktree?: boolean; web?: boolean }) => {
      header("GitHub Pull Requests");

      if (!(await isGitRepo())) {
        p.log.error("Not a git repository.");
        return;
      }

      const ghAuth = await getGitHubAuthStatus();
      if (!ghAuth.authenticated) {
        p.log.warn("GitHub CLI is not authenticated. Run `gh auth login` to view Pull Requests.");
        return;
      }

      if (prNumber) {
        const num = parseInt(prNumber, 10);
        if (isNaN(num)) {
          p.log.error(`Invalid PR number: ${prNumber}`);
          return;
        }

        if (options?.web) {
          await viewPullRequestInBrowser(num);
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
            p.log.error(String(err));
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
          p.log.error(String(err));
        }
        return;
      }

      // Interactive List
      const s = p.spinner();
      s.start("Fetching open Pull Requests from GitHub...");
      const prs = await listPullRequests(20);
      s.stop(`Loaded ${pc.green(String(prs.length))} open Pull Request(s).`);

      if (prs.length === 0) {
        p.log.info(pc.dim("No open Pull Requests found for this repository."));
        return;
      }

      const selectedPrNum = await p.select({
        message: "Select a Pull Request to inspect:",
        options: prs.map((pr) => ({
          value: pr.number,
          label: `#${pr.number} ${pr.title}`,
          hint: `by @${pr.author.login} (${pr.headRefName})`,
        })),
      });

      if (p.isCancel(selectedPrNum)) {
        p.cancel("Cancelled.");
        return;
      }

      const selectedPr = prs.find((pr) => pr.number === selectedPrNum);
      if (!selectedPr) return;

      const action = await p.select({
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

      if (p.isCancel(action) || action === "cancel") return;

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
          p.log.error(String(err));
        }
      } else if (action === "checkout") {
        const checkoutSpinner = p.spinner();
        checkoutSpinner.start(`Checking out PR #${selectedPr.number}...`);
        try {
          await checkoutPullRequest(selectedPr.number);
          checkoutSpinner.stop(pc.green(`Checked out PR #${selectedPr.number}!`));
        } catch (err) {
          checkoutSpinner.stop(pc.red("Checkout failed."));
          p.log.error(String(err));
        }
      } else if (action === "web") {
        await viewPullRequestInBrowser(selectedPr.number);
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
          const diff = await getPullRequestDiff(selectedPr.number);
          const { provider, model } = await resolveAIProvider();

          const prSummary = await provider.generatePr(
            {
              branch: selectedPr.headRefName,
              baseBranch: "main",
              diff,
              commitSummary: selectedPr.title,
            },
            model,
          );

          reviewSpinner.stop("AI Summary Generated:");
          p.note(prSummary.body, `AI Summary for PR #${selectedPr.number}`);
        } catch {
          reviewSpinner.stop(pc.yellow("AI review unavailable."));
        }
      }
    });
}
