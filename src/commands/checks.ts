import { Command } from "commander";
import { getFlags } from "../services/runtime.ts";
import {
  getActivePullRequest,
  getPullRequestChecks,
  requireAuth,
} from "../services/github.ts";
import { getCurrentBranch, requireGitRepo } from "../services/git.ts";
import { emitJson, header, p, pc } from "../utils/ui.ts";
import { isDryRun } from "../utils/flags.ts";

export function registerChecksCommand(program: Command): void {
  program
    .command("checks")
    .description("CI status for this branch's pull request")
    .option("-w, --watch", "Continuously watch checks until completion")
    .option("--timeout <seconds>", "Give up watching after this long", "1800")
    .option("--dry-run", "Show what would be checked without watching")
    .action(async (options?: { watch?: boolean; timeout?: string; dryRun?: boolean }) => {
      header("CI Status Checks");

      if (!(await requireGitRepo())) return;

      if (!(await requireAuth())) return;

      const currentBranch = await getCurrentBranch();
      const s = p.spinner();
      s.start(`Fetching active Pull Request for ${pc.cyan(currentBranch)}...`);

      const activePr = await getActivePullRequest();
      if (getFlags().json) {
        const checks = await getPullRequestChecks();
        emitJson({ pullRequest: activePr, checks });
        if (checks.some((c) => ["FAILURE", "FAIL", "ERROR"].includes(c.state.toUpperCase()))) {
          process.exitCode = 1;
        }
        return;
      }
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

      // --dry-run forces a single fetch and never enters the watch loop.
      if (isDryRun()) {
        if (initial.allPassed) {
          p.outro(pc.green("All CI checks passed!"));
        } else if (initial.allDone) {
          process.exitCode = 1;
          p.outro(pc.red("Some CI checks failed."));
        } else {
          p.outro(pc.yellow("CI checks are still in progress (dry run: not watching)."));
        }
        return;
      }

      if (!options?.watch || initial.allDone) {
        if (initial.allPassed) {
          p.outro(pc.green("All CI checks passed!"));
        } else if (initial.allDone) {
          // Non-zero so `ggh checks` is usable as a gate in scripts and CI.
          process.exitCode = 1;
          p.outro(pc.red("Some CI checks failed."));
        } else {
          p.outro(pc.yellow("CI checks are still in progress. Run `ggh checks --watch` to monitor."));
        }
        return;
      }

      // Watch mode: back off from 5s toward 30s so a long queue does not hammer
      // the API, and stop at --timeout rather than looping forever.
      const timeoutSeconds = Number.parseInt(options?.timeout ?? "1800", 10) || 1800;
      const deadline = Date.now() + timeoutSeconds * 1000;
      let delayMs = 5_000;

      p.log.step(`Watching CI checks (up to ${timeoutSeconds}s, press Ctrl+C to stop)...`);

      for (;;) {
        if (Date.now() >= deadline) {
          process.exitCode = 1;
          p.outro(pc.yellow(`Gave up after ${timeoutSeconds}s; checks are still running.`));
          return;
        }

        await new Promise((res) => setTimeout(res, Math.min(delayMs, deadline - Date.now())));
        delayMs = Math.min(delayMs * 1.5, 30_000);

        console.clear();
        header(`Watching CI Checks (PR #${activePr.number})`);
        const status = await displayChecks();
        if (status.allDone) {
          if (status.allPassed) {
            p.outro(pc.green("All CI checks passed successfully!"));
          } else {
            process.exitCode = 1;
            p.outro(pc.red("One or more CI checks failed."));
          }
          return;
        }
      }
    });
}
