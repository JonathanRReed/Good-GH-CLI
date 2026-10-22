import { Command } from "commander";
import { getFlags, recordCommandIssue } from "../services/runtime.ts";
import {
  countUniqueCommits,
  detectDefaultBranch,
  fetchPrune,
  getAheadBehind,
  getCurrentBranch,
  getGoneBranches,
  getRemotes,
  isDetachedHead,
  requireGitRepo,
} from "../services/git.ts";
import { emitJson, header, p, pc, jsonOut, confirmOrAbort, fail } from "../utils/ui.ts";
import { dryRun, isDryRun } from "../utils/flags.ts";
import { classifyBranchDeletion, deleteGoneBranch, type BranchDeletionProof } from "../services/git/branch-safety.ts";
import { readProjectIndex } from "../services/projects/index-store.ts";
import { syncProjects, type ProjectSyncResult } from "../services/projects/sync.ts";
import { selectProject } from "./projects.ts";

interface SyncOptions { yes?: boolean; force?: boolean; all?: boolean; includeHostWorktrees?: boolean; forkUpstream?: boolean; concurrency?: string; timeout?: string }

function renderSync(result: ProjectSyncResult): void {
  const rows = [["Project / checkout", "Result", "Detail"]];
  for (const clone of result.clones) {
    rows.push([clone.name, clone.outcome, "reason" in clone ? clone.reason : ""]);
    for (const row of clone.checkouts) rows.push([`  ${row.path} [${row.branch ?? "HEAD"}]`, row.outcome, row.outcome === "skipped" ? row.reason : row.outcome === "updated" ? `${row.old.slice(0, 12)}..${row.new.slice(0, 12)}` : ""]);
    if (clone.forkUpstream.outcome !== "skipped") rows.push([`  fork ${clone.forkUpstream.target}`, clone.forkUpstream.outcome, ""]);
    else if (clone.forkUpstream.reason !== "not-requested") rows.push(["  fork", "skipped", clone.forkUpstream.reason]);
  }
  const widths = [0, 1, 2].map(column => Math.max(...rows.map(row => row[column]?.length ?? 0)));
  for (const row of rows) p.log.message(row.map((value, column) => value.padEnd(widths[column] ?? 0)).join("  ").trimEnd());
  for (const clone of result.clones) {
    if ("message" in clone) p.log.error(`${clone.commonDir}: ${clone.message}`);
    for (const fetch of clone.fetches) if (fetch.outcome !== "updated") p.log.error(`${fetch.remote}: ${fetch.message}`);
    for (const row of clone.checkouts) if ("message" in row) p.log.error(`${row.path}: ${row.message}`);
  }
  if (result.cancelled) p.log.warn("Cancelled. Earlier effects remain applied.");
}

async function syncSelected(queries: string[], options: SyncOptions): Promise<void> {
  if (options.all && queries.length || options.force) { fail("Use either --all or project names. --force applies only to single-repo pruning.", { code: "invalid_arguments" }); return; }
  const concurrency = Number(options.concurrency ?? "4"); const timeoutMs = Number(options.timeout ?? "120000");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) { fail("Concurrency must be 1..64 and timeout must be 1..2147483647 milliseconds.", { code: "invalid_arguments" }); return; }
  const index = readProjectIndex();
  const selected = options.all ? index.clones : [];
  for (const query of queries) { const clone = await selectProject(index.clones, query); if (!clone) return; selected.push(clone); }
  if (options.forkUpstream && !isDryRun()) {
    const targets = [...new Set(selected.flatMap(clone => clone.primary ? [`${clone.primary.host}/${clone.primary.owner}/${clone.primary.name}`] : []))];
    if (!(await confirmOrAbort(`Sync remote fork default branches from upstream: ${targets.join(", ") || "no recognized targets"}?`, { assumeYes: options.yes, initialValue: false }))) return;
  }
  const result = await syncProjects(selected, { concurrency, timeoutMs, includeHostWorktrees: options.includeHostWorktrees, forkUpstream: options.forkUpstream, dryRun: isDryRun() });
  if (["failed", "partially_completed", "cancelled"].includes(result.status)) {
    recordCommandIssue({ status: result.cancelled ? "cancelled" : "failed", code: result.cancelled ? "cancelled" : result.status === "partially_completed" ? "partial_completion" : "operation_failed", message: "Some projects did not complete sync. Inspect per-clone outcomes." });
    process.exitCode = result.cancelled ? 130 : 1;
  }
  if (!jsonOut(result)) renderSync(result);
}

export function registerSyncCommand(program: Command): void {
  program
    .command("sync [project...]")
    .alias("prune")
    .description("Sync indexed projects, or fetch and prune the current repository")
    .option("-y, --yes", "Automatically delete safe stale local branches without confirmation")
    .option("-f, --force", "Allow unmerged gone branches; unpublished and checked-out branches stay protected")
    .option("--all", "Sync every indexed clone without deleting local branches")
    .option("--include-host-worktrees", "Also update checkouts under agent-host worktree directories")
    .option("--fork-upstream", "Sync selected remote forks' default branches from upstream, with confirmation")
    .option("--concurrency <count>", "Maximum concurrent clones, default 4")
    .option("--timeout <ms>", "Per-clone deadline in milliseconds, default 120000")
    .action(async (projects: string[], options: SyncOptions) => {
      if (options.all || projects.length) { await syncSelected(projects, options); return; }
      if (options.includeHostWorktrees || options.forkUpstream || options.concurrency || options.timeout) { fail("Select indexed projects or --all for bulk sync options.", { code: "invalid_arguments" }); return; }
      header("Git Sync & Stale Branch Pruning");

      if (!(await requireGitRepo())) return;

      const remotes = await getRemotes();
      if (remotes.length === 0) {
        if (jsonOut({ status: "no_op", reason: "no_remotes" })) return;
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
      const protectedBranches: { name: string; reason: string }[] = [];
      const proofs = new Map<string, Extract<BranchDeletionProof, { tip: string }>>();

      for (const branch of goneBranches) {
        if (branch === currentBranch) continue;
        const [proof, unique] = await Promise.all([
          classifyBranchDeletion(branch, defaultBranch),
          countUniqueCommits(branch, defaultBranch),
        ]);
        if (proof.outcome === "delete") {
          safeBranches.push(branch);
          proofs.set(branch, proof);
        } else if (proof.reason === "unmerged") {
          unsafeBranches.push({ name: branch, count: unique });
          proofs.set(branch, proof);
        } else protectedBranches.push({ name: branch, reason: proof.reason });
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
      const skipped = (options?.force
        ? []
        : unsafeBranches.map((b) => `${b.name} (has ${b.count} unmerged commit(s); pass --force to delete)`))
        .concat(protectedBranches.map(branch => `${branch.name} (${branch.reason})`));
      for (const branch of protectedBranches) p.log.warn(`${branch.name}: kept (${branch.reason})`);

      const emitSyncJson = (overrides?: Record<string, unknown>): void => {
        emitJson({
          currentBranch: detached ? "HEAD" : currentBranch,
          detached,
          drift,
          goneBranches,
          safeToDelete: safeBranches,
          unsafe: unsafeBranches,
          protected: protectedBranches,
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
          await deleteGoneBranch(branch, defaultBranch, Boolean(options?.force), process.cwd(), proofs.get(branch));
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
