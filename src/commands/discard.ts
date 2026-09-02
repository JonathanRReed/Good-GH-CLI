import { Command } from "commander";
import { discardFiles, getStatus, isGitRepo } from "../services/git.ts";
import { header, p, pc } from "../utils/ui.ts";

export function registerDiscardCommand(program: Command): void {
  program
    .command("discard [files...]")
    .alias("restore")
    .description("Interactively discard and revert changes to working tree files (Lazygit-style)")
    .option("-a, --all", "Discard changes to all modified and untracked files")
    .action(async (fileArgs?: string[], options?: { all?: boolean }) => {
      header("Discard Changes (Revert)");

      if (!(await isGitRepo())) {
        p.log.error("Not a git repository.");
        return;
      }

      const status = await getStatus();
      const allDirty = [
        ...status.staged.map((f) => ({ path: f.path, staged: true, untracked: false, status: f.status })),
        ...status.unstaged.map((f) => ({ path: f.path, staged: false, untracked: false, status: f.status })),
        ...status.untracked.map((f) => ({ path: f.path, staged: false, untracked: true, status: "untracked" })),
      ];

      if (allDirty.length === 0) {
        p.log.success(pc.green("Working tree is completely clean. No changes to discard!"));
        return;
      }

      let toDiscard: typeof allDirty = [];

      if (options?.all) {
        toDiscard = allDirty;
      } else if (fileArgs && fileArgs.length > 0) {
        toDiscard = allDirty.filter((f) => fileArgs.includes(f.path));
        if (toDiscard.length === 0) {
          p.log.warn("None of the specified files have changes to discard.");
          return;
        }
      } else {
        const selected = await p.multiselect({
          message: "Select file(s) to permanently discard changes from:",
          options: allDirty.map((f) => ({
            value: f.path,
            label: `${f.path} ${pc.dim(`(${f.status}${f.staged ? ", staged" : ""})`)}`,
          })),
          required: true,
          maxItems: 8,
        });

        if (p.isCancel(selected)) {
          p.cancel("Discard cancelled.");
          return;
        }

        toDiscard = allDirty.filter((f) => (selected as string[]).includes(f.path));
      }

      const confirm = await p.confirm({
        message: `Permanently discard changes to ${pc.bold(pc.red(String(toDiscard.length)))} file(s)? This cannot be undone!`,
        initialValue: false,
      });

      if (!confirm || p.isCancel(confirm)) {
        p.cancel("Discard cancelled.");
        return;
      }

      const s = p.spinner();
      s.start("Discarding file changes...");
      try {
        await discardFiles(toDiscard);
        s.stop(pc.green(`Discarded changes in ${toDiscard.length} file(s)!`));
        p.outro(pc.green("Working tree restored."));
      } catch (err) {
        s.stop(pc.red("Failed to discard some changes."));
        p.log.error(String(err));
      }
    });
}
