import { Command } from "commander";
import { getFlags } from "../services/runtime.ts";
import { getCurrentBranch, hasCommits, isDetachedHead, requireGitRepo, undoCommit } from "../services/git.ts";
import {
  confirmOrAbort,
  emitJson,
  fail,
  header,
  p,
  pc,
} from "../utils/ui.ts";
import { dryRun } from "../utils/flags.ts";

export function registerUndoCommand(program: Command): void {
  program
    .command("undo")
    .description("Undo the last commit, keeping the changes staged")
    .option("-y, --yes", "Skip confirmation prompt")
    .action(async (options: { yes?: boolean }) => {
      header("Undo Last Commit");

      if (!(await requireGitRepo())) return;

      if (!(await hasCommits())) {
        p.log.warn("Repository has no commits to undo.");
        return;
      }

      const isDetached = await isDetachedHead();
      const rawBranch = await getCurrentBranch();
      const targetDesc = isDetached ? pc.yellow("HEAD (detached)") : `branch ${pc.cyan(rawBranch)}`;

      if (dryRun(`soft-reset the last commit on ${targetDesc}`)) return;

      if (!options.yes) {
        if (!(await confirmOrAbort(`Undo the latest commit on ${targetDesc}? (Changes will remain staged)`, { cancelText: "Undo cancelled." }))) return;
      }

      if (getFlags().json) {
        try {
          await undoCommit();
          emitJson({ undone: true, branch: isDetached ? "HEAD" : rawBranch, detached: isDetached });
        } catch (err) {
          emitJson({ undone: false, error: String(err) });
          fail(String(err));
        }
        return;
      }

      const s = p.spinner();
      s.start("Undoing last commit (soft reset)...");
      try {
        await undoCommit();
        s.stop(pc.green("Last commit undone successfully!"));
        p.log.message(`\nYour changes are safely preserved in the staging area.\nRun ${pc.cyan("ggh status")} to review.\n`);
        p.outro(pc.green("Done."));
      } catch (err) {
        s.stop(pc.red("Undo failed."));
        fail(String(err));
      }
    });
}
