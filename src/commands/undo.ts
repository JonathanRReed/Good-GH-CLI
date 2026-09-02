import { Command } from "commander";
import { getCurrentBranch, hasCommits, isDetachedHead, isGitRepo, undoCommit } from "../services/git.ts";
import { confirmPrompt, header, p, pc } from "../utils/ui.ts";

export function registerUndoCommand(program: Command): void {
  program
    .command("undo")
    .description("Undo the last commit on the current branch (preserves all changes staged)")
    .option("-y, --yes", "Skip confirmation prompt")
    .action(async (options: { yes?: boolean }) => {
      header("Undo Last Commit");

      if (!(await isGitRepo())) {
        p.log.error("Not a git repository.");
        return;
      }

      if (!(await hasCommits())) {
        p.log.warn("Repository has no commits to undo.");
        return;
      }

      const isDetached = await isDetachedHead();
      const rawBranch = await getCurrentBranch();
      const targetDesc = isDetached ? pc.yellow("HEAD (detached)") : `branch ${pc.cyan(rawBranch)}`;

      if (!options.yes) {
        const confirmUndo = await confirmPrompt({
          message: `Undo the latest commit on ${targetDesc}? (Changes will remain staged)`,
          initialValue: true,
        });

        if (!confirmUndo) {
          p.cancel("Undo cancelled.");
          return;
        }
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
        p.log.error(String(err));
      }
    });
}
