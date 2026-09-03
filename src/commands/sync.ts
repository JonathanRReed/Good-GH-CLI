import { Command } from "commander";
import {
  deleteLocalBranch,
  fetchPrune,
  getAheadBehind,
  getCurrentBranch,
  getGoneBranches,
  getRemotes,
  isDetachedHead,
  isGitRepo,
} from "../services/git.ts";
import {
  confirmPrompt,
  fail,
  header,
  p,
  pc,
} from "../utils/ui.ts";
import { isDryRun } from "../utils/flags.ts";

export function registerSyncCommand(program: Command): void {
  program
    .command("sync")
    .alias("prune")
    .description("Fetch & prune remote refs, show ahead/behind drift, and delete stale merged branches")
    .option("-y, --yes", "Automatically delete stale local branches without confirmation")
    .action(async (options?: { yes?: boolean }) => {
      header("Git Sync & Stale Branch Pruning");

      if (!(await isGitRepo())) {
        fail("Not a git repository.");
        return;
      }

      const remotes = await getRemotes();
      if (remotes.length === 0) {
        p.log.warn(pc.yellow("No git remotes configured for this repository."));
        p.log.info("Add a remote with `git remote add origin <url>` to sync with remote.");
        return;
      }

      const s = p.spinner();
      s.start("Fetching latest remote refs and pruning deleted tracking branches...");

      try {
        await fetchPrune();
        s.stop(pc.green("Remote refs updated and pruned!"));
      } catch {
        s.stop(pc.yellow("Fetch/prune completed with warnings."));
      }

      const detached = await isDetachedHead();
      const currentBranch = await getCurrentBranch();

      if (detached) {
        p.log.warn(pc.yellow("Currently in detached HEAD state. Switch to a named branch to track remote changes."));
      } else {
        const drift = await getAheadBehind();
        if (drift.hasUpstream) {
          if (drift.ahead === 0 && drift.behind === 0) {
            p.log.success(pc.green(`Branch ${pc.bold(currentBranch)} is completely in sync with remote.`));
          } else {
            const parts: string[] = [];
            if (drift.ahead > 0) parts.push(pc.yellow(`ahead ${drift.ahead} commit(s)`));
            if (drift.behind > 0) parts.push(pc.cyan(`behind ${drift.behind} commit(s)`));
            p.log.step(`Branch ${pc.bold(currentBranch)} drift: ${parts.join(", ")}`);
          }
        } else {
          p.log.info(pc.dim(`Branch ${currentBranch} has no upstream remote tracking branch.`));
        }
      }

      // Check for stale (gone) branches
      const goneBranches = await getGoneBranches();

      if (goneBranches.length === 0) {
        p.log.success(pc.green("No stale local branches found. Local repository is clean!"));
        p.outro(pc.green("Sync complete."));
        return;
      }

      p.log.warn(
        pc.yellow(
          `Found ${pc.bold(String(goneBranches.length))} local branch(es) whose remote tracking branch was merged or deleted:`,
        ),
      );

      for (const branch of goneBranches) {
        p.log.message(`  ${pc.red("✖")} ${pc.bold(branch)} ${pc.dim("(remote: gone)")}`);
      }

      if (isDryRun()) {
        for (const branch of goneBranches) {
          if (branch === currentBranch) continue;
          p.log.warn(`${pc.yellow("dry run")} ${pc.dim("·")} would delete ${pc.bold(branch)}`);
        }
        return;
      }

      if (!options?.yes) {
        const confirmDelete = await confirmPrompt({
          message: `Delete ${goneBranches.length} stale local branch(es)?`,
          initialValue: true,
          assumeYes: options?.yes,
        });
        if (!confirmDelete) {
          p.cancel("Skipped branch cleanup.");
          return;
        }
      }

      const delSpinner = p.spinner();
      delSpinner.start("Deleting stale local branches...");
      let deletedCount = 0;

      for (const branch of goneBranches) {
        // Never delete current branch
        if (branch === currentBranch) continue;
        try {
          await deleteLocalBranch(branch, true);
          deletedCount++;
        } catch {
          // Ignore
        }
      }

      delSpinner.stop(pc.green(`Safely deleted ${deletedCount} stale branch(es)!`));
      p.outro(pc.green("Sync and cleanup complete."));
    });
}
