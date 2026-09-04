import { Command } from "commander";
import { getFlags } from "../services/runtime.ts";
import {
  countUniqueCommits,
  deleteLocalBranch,
  detectDefaultBranch,
  fetchPrune,
  getAheadBehind,
  getCurrentBranch,
  getGoneBranches,
  getRemotes,
  isBranchMergedInto,
  isDetachedHead,
  requireGitRepo,
} from "../services/git.ts";
import { emitJson, header, p, pc, jsonOut, confirmOrAbort } from "../utils/ui.ts";
import { dryRun, isDryRun } from "../utils/flags.ts";

export function registerSyncCommand(program: Command): void {
  program
    .command("sync")
    .alias("prune")
    .description("Fetch, prune, and delete branches whose remote is gone")
    .option("-y, --yes", "Automatically delete safe stale local branches without confirmation")
    .option("-f, --force", "Delete gone branches even if they have unpushed/unmerged commits")
    .action(async (options?: { yes?: boolean; force?: boolean }) => {
      header("Git Sync & Stale Branch Pruning");

      if (!(await requireGitRepo())) return;

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

      const [detached, currentBranch] = await Promise.all([isDetachedHead(), getCurrentBranch()]);
      let drift: { ahead: number; behind: number; hasUpstream: boolean } | null = null;

      if (detached) {
        p.log.warn(pc.yellow("Currently in detached HEAD state. Switch to a named branch to track remote changes."));
      } else {
        drift = await getAheadBehind();
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
        if (jsonOut({
            currentBranch: detached ? "HEAD" : currentBranch,
            detached,
            drift,
            goneBranches: [],
            safeToDelete: [],
            unsafe: [],
            skipped: [],
            deleted: [],
            deletedCount: 0,
            dryRun: isDryRun(),
          })) return;

        p.log.success(pc.green("No stale local branches found. Local repository is clean!"));
        p.outro(pc.green("Sync complete."));
        return;
      }

      const defaultBranch = await detectDefaultBranch();
      const safeBranches: string[] = [];
      const unsafeBranches: { name: string; count: number }[] = [];

      for (const branch of goneBranches) {
        if (branch === currentBranch) continue;
        const [merged, unique] = await Promise.all([
          isBranchMergedInto(branch, defaultBranch),
          countUniqueCommits(branch, defaultBranch),
        ]);
        if (merged || unique === 0) {
          safeBranches.push(branch);
        } else {
          unsafeBranches.push({ name: branch, count: unique });
        }
      }

      p.log.warn(
        pc.yellow(
          `Found ${pc.bold(String(goneBranches.length))} local branch(es) whose remote tracking branch was merged or deleted:`,
        ),
      );

      for (const branch of safeBranches) {
        p.log.message(`  ${pc.yellow("▲")} ${pc.bold(branch)} ${pc.dim("(remote: gone · safe to delete)")}`);
      }

      for (const { name, count } of unsafeBranches) {
        p.log.message(
          `  ${pc.red("✖")} ${pc.bold(name)} ${pc.dim(`(remote: gone · has ${count} unpushed/unmerged commit(s))`)}`,
        );
      }

      const toDelete = options?.force ? [...safeBranches, ...unsafeBranches.map((b) => b.name)] : safeBranches;
      const skipped = options?.force
        ? []
        : unsafeBranches.map((b) => `${b.name} (has ${b.count} unpushed/unmerged commit(s); pass --force to delete)`);

      const emitSyncJson = (overrides?: Record<string, unknown>): void => {
        emitJson({
          currentBranch: detached ? "HEAD" : currentBranch,
          detached,
          drift,
          goneBranches,
          safeToDelete: safeBranches,
          unsafe: unsafeBranches,
          skipped,
          toDelete,
          deleted: [],
          deletedCount: 0,
          dryRun: isDryRun(),
          ...overrides,
        });
      };

      if (toDelete.length === 0) {
        if (getFlags().json) {
          emitSyncJson();
          return;
        }
        for (const reason of skipped) {
          p.log.warn(`${pc.yellow("skipped")} ${pc.dim("·")} ${pc.bold(reason)}`);
        }
        p.outro(pc.green("No branches were deleted."));
        return;
      }

      if (dryRun(`delete ${toDelete.length} stale branch(es)`)) {
        if (getFlags().json) emitSyncJson();
        return;
      }

      if (!options?.yes) {
        if (!(await confirmOrAbort(`Delete ${toDelete.length} stale local branch(es)?`, { cancelText: "Skipped branch cleanup." }))) return;
      }

      const delSpinner = p.spinner();
      delSpinner.start("Deleting stale local branches...");
      const deleted: string[] = [];
      const failed: string[] = [];

      for (const branch of toDelete) {
        try {
          // Safe branches use `git branch -d` (rejects unmerged); --force opts into `-D`.
          await deleteLocalBranch(branch, Boolean(options?.force));
          deleted.push(branch);
        } catch {
          failed.push(branch);
        }
      }

      if (getFlags().json) {
        delSpinner.stop();
        emitSyncJson({ deleted, deletedCount: deleted.length, failed, dryRun: false });
        return;
      }

      delSpinner.stop(pc.green(`Deleted ${deleted.length} stale branch(es)!`));
      if (failed.length) {
        p.log.warn(pc.yellow(`${failed.length} branch(es) could not be deleted:`));
        for (const branch of failed) {
          p.log.message(`  ${pc.yellow("✖")} ${pc.bold(branch)} ${pc.dim("(use --force to delete unmerged branches)")}`);
        }
      }
      p.outro(pc.green("Sync and cleanup complete."));
    });
}
