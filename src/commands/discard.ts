import { Command } from "commander";
import { discardFiles, getStatus, requireGitRepo } from "../services/git.ts";
import {
  confirmOrAbort, jsonOut,
  fail,
  header,
  multiSelectMenu,
  p,
  pc,
} from "../utils/ui.ts";
import { dryRun, isDryRun } from "../utils/flags.ts";

export function registerDiscardCommand(program: Command): void {
  program
    .command("discard [files...]")
    .alias("restore")
    .description("Discard uncommitted changes to selected files")
    .option(
      "-a, --all",
      "Discard changes to all tracked files; pass --include-untracked to also delete untracked files",
    )
    .option("-y, --yes", "Skip the confirmation prompt")
    .option("--include-untracked", "When using --all, also delete untracked files")
    .action(async (fileArgs?: string[], options?: { all?: boolean; yes?: boolean; includeUntracked?: boolean }) => {
      header("Discard Changes (Revert)");

      if (!(await requireGitRepo())) return;

      const status = await getStatus();
      const allDirty = [
        ...status.staged.map((f) => ({ path: f.path, staged: true, untracked: false, status: f.status })),
        ...status.unstaged.map((f) => ({ path: f.path, staged: false, untracked: false, status: f.status })),
        ...status.untracked.map((f) => ({ path: f.path, staged: false, untracked: true, status: "untracked" })),
      ];

      if (allDirty.length === 0) {
        if (jsonOut({ discarded: [], count: 0 })) return;
        p.log.success(pc.green("Working tree is completely clean. No changes to discard!"));
        return;
      }

      let toDiscard: typeof allDirty;

      if (options?.all) {
        const untracked = allDirty.filter((f) => f.untracked);
        if (untracked.length > 0 && !options?.includeUntracked) {
          p.log.warn(`The following ${untracked.length} untracked file(s) would NOT be deleted without --include-untracked:`);
          for (const f of untracked) {
            p.log.message(`  ${pc.yellow("▲")} ${pc.bold(f.path)}`);
          }
          p.log.info(pc.dim("Pass --include-untracked to delete them with --all."));
        }
        toDiscard = options?.includeUntracked ? allDirty : allDirty.filter((f) => !f.untracked);
      } else if (fileArgs && fileArgs.length > 0) {
        toDiscard = allDirty.filter((f) => fileArgs.includes(f.path));
        if (toDiscard.length === 0) {
          p.log.warn("None of the specified files have changes to discard.");
          return;
        }
        // Explicit args can still name untracked files; require the same flag
        // so a stray `ggh discard path/to/new-file` never silently deletes
        // a file git has never tracked.
        const untrackedArgs = toDiscard.filter((f) => f.untracked);
        if (untrackedArgs.length > 0 && !options?.includeUntracked) {
          p.log.warn(
            `${untrackedArgs.length} of the specified file(s) are untracked and would be deleted. Pass --include-untracked to delete them.`,
          );
          for (const f of untrackedArgs) {
            p.log.message(`  ${pc.yellow("▲")} ${pc.bold(f.path)}`);
          }
          toDiscard = toDiscard.filter((f) => !f.untracked);
          if (toDiscard.length === 0) {
            return;
          }
        }
      } else {
        if (dryRun("discard changes")) return;
        const selected = await multiSelectMenu({
          message: "Select file(s) to permanently discard changes from:",
          options: allDirty.map((f) => ({
            value: f.path,
            label: `${f.path} ${pc.dim(`(${f.status}${f.staged ? ", staged" : ""})`)}`,
          })),
          required: true,
          pageSize: 8,
        });

        if (selected === null) {
          p.cancel("Discard cancelled.");
          return;
        }

        toDiscard = allDirty.filter((f) => selected.includes(f.path));
      }

      const untrackedToDelete = toDiscard.filter((f) => f.untracked);
      if (untrackedToDelete.length > 0) {
        p.log.warn(`The following ${untrackedToDelete.length} untracked file(s) will be deleted:`);
        for (const f of untrackedToDelete) {
          p.log.message(`  ${pc.yellow("▲")} ${pc.bold(f.path)}`);
        }
      }

      if (isDryRun()) {
        if (jsonOut({ discarded: toDiscard.map((f) => f.path), count: toDiscard.length, dryRun: true })) return;
        for (const f of toDiscard) {
          dryRun(`discard ${f.path}`);
        }
        return;
      }

      if (!(await confirmOrAbort(`Permanently discard changes to ${pc.bold(pc.red(String(toDiscard.length)))} file(s)? This cannot be undone!`, { assumeYes: options?.yes, initialValue: false, cancelText: "Discard cancelled." }))) return;

      const s = p.spinner();
      s.start("Discarding file changes...");
      try {
        await discardFiles(toDiscard);
        s.stop(pc.green(`Discarded changes in ${toDiscard.length} file(s)!`));
        p.outro(pc.green("Working tree restored."));
      } catch (err) {
        s.stop(pc.red("Failed to discard some changes."));
        fail(String(err));
      }
    });
}
