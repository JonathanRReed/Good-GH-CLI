import { Command } from "commander";
import {
  getActivePullRequest,
  getGitHubAuthStatus,
  getPullRequestChecks,
} from "../services/github.ts";
import { getCurrentBranch, isGitRepo } from "../services/git.ts";
import { header, p, pc } from "../utils/ui.ts";

export function registerChecksCommand(program: Command): void {
  program
    .command("checks")
    .description("View GitHub Actions CI status checks for the active branch or Pull Request")
    .option("-w, --watch", "Continuously watch checks until completion")
    .action(async (options?: { watch?: boolean }) => {
      header("CI Status Checks");

      if (!(await isGitRepo())) {
        p.log.error("Not a git repository.");
        return;
      }

      const ghAuth = await getGitHubAuthStatus();
      if (!ghAuth.authenticated) {
        p.log.warn("GitHub CLI is not authenticated. Run `gh auth login`.");
        return;
      }

      const currentBranch = await getCurrentBranch();
      const s = p.spinner();
      s.start(`Fetching active Pull Request for ${pc.cyan(currentBranch)}...`);

      const activePr = await getActivePullRequest();
      if (!activePr) {
        s.stop(pc.yellow(`No active Pull Request found for branch ${pc.cyan(currentBranch)}.`));
        p.log.info("Create a Pull Request first with `ggh commit --pr` or `gh pr create`.");
        return;
      }

      s.stop(`Found PR #${pc.bold(pc.green(String(activePr.number)))}: ${activePr.title}`);

      async function displayChecks(): Promise<{ allDone: boolean; allPassed: boolean }> {
        const checks = await getPullRequestChecks();
        if (checks.length === 0) {
          p.log.info("No CI status checks reported for this Pull Request.");
          return { allDone: true, allPassed: true };
        }

        let pendingCount = 0;
        let failCount = 0;

        for (const check of checks) {
          const stateUpper = check.state.toUpperCase();
          if (stateUpper === "SUCCESS" || stateUpper === "PASS") {
            p.log.message(`  ${pc.green("✓")} ${pc.bold(check.name)} ${pc.dim(`(${check.description || "pass"})`)}`);
          } else if (stateUpper === "FAILURE" || stateUpper === "FAIL" || stateUpper === "ERROR") {
            p.log.message(`  ${pc.red("✖")} ${pc.bold(check.name)} ${pc.red(`(${check.description || "failed"})`)}`);
            failCount++;
          } else {
            p.log.message(`  ${pc.yellow("◷")} ${pc.bold(check.name)} ${pc.yellow(`(${check.description || "pending / in-progress"})`)}`);
            pendingCount++;
          }
        }

        const allDone = pendingCount === 0;
        const allPassed = allDone && failCount === 0;
        return { allDone, allPassed };
      }

      const initial = await displayChecks();

      if (!options?.watch || initial.allDone) {
        if (initial.allPassed) {
          p.outro(pc.green("All CI checks passed!"));
        } else if (initial.allDone) {
          p.outro(pc.red("Some CI checks failed."));
        } else {
          p.outro(pc.yellow("CI checks are still in progress. Run `ggh checks --watch` to monitor."));
        }
        return;
      }

      // Watch Mode
      p.log.step("Watching CI checks (polling every 8 seconds, press Ctrl+C to exit)...");
      let watching = true;

      while (watching) {
        await new Promise((res) => setTimeout(res, 8000));
        console.clear();
        header(`Watching CI Checks (PR #${activePr.number})`);
        const status = await displayChecks();
        if (status.allDone) {
          watching = false;
          if (status.allPassed) {
            p.outro(pc.green("All CI checks passed successfully!"));
          } else {
            p.outro(pc.red("One or more CI checks failed."));
          }
        }
      }
    });
}
