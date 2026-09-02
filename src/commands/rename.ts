import { Command } from "commander";
import { execa } from "execa";
import {
  getAheadBehind,
  getCurrentBranch,
  isGitRepo,
  renameBranch,
} from "../services/git.ts";
import { header, p, pc } from "../utils/ui.ts";

export function registerRenameCommand(program: Command): void {
  program
    .command("rename [newName]")
    .description("Safely rename the current branch locally and update remote tracking (Graphite-style)")
    .action(async (newNameArg?: string) => {
      header("Branch Rename Assistant");

      if (!(await isGitRepo())) {
        p.log.error("Not a git repository.");
        return;
      }

      const current = await getCurrentBranch();
      if (["main", "master"].includes(current.toLowerCase())) {
        const confirmDefault = await p.confirm({
          message: `Current branch is default branch ${pc.bold(pc.yellow(current))}. Are you sure you want to rename it?`,
          initialValue: false,
        });
        if (!confirmDefault || p.isCancel(confirmDefault)) {
          p.cancel("Rename cancelled.");
          return;
        }
      }

      let newName = newNameArg;
      if (!newName) {
        const inputName = await p.text({
          message: `Enter new name for branch ${pc.bold(pc.cyan(current))}:`,
          placeholder: "e.g. feat/new-auth-flow",
          validate: (v) => (!v || !v.trim() ? "New branch name required" : undefined),
        });

        if (p.isCancel(inputName)) {
          p.cancel("Rename cancelled.");
          return;
        }

        newName = (inputName as string).trim();
      }

      const s = p.spinner();
      s.start(`Renaming branch from ${pc.cyan(current)} to ${pc.green(newName)}...`);

      const drift = await getAheadBehind();
      const hadRemote = drift.hasUpstream;

      try {
        await renameBranch(current, newName);
        s.stop(pc.green(`Branch renamed to ${pc.bold(pc.green(newName))}!`));
      } catch (err) {
        s.stop(pc.red("Failed to rename local branch."));
        p.log.error(String(err));
        return;
      }

      if (hadRemote) {
        const updateRemote = await p.confirm({
          message: `Branch had remote tracking. Push ${pc.bold(pc.green(newName))} to remote and delete old remote branch 'origin/${current}'?`,
          initialValue: true,
        });

        if (updateRemote && !p.isCancel(updateRemote)) {
          const remoteSpinner = p.spinner();
          remoteSpinner.start("Updating remote tracking branch...");
          try {
            await execa("git", ["push", "-u", "origin", newName]);
            await execa("git", ["push", "origin", "--delete", current]);
            remoteSpinner.stop(pc.green("Remote branch updated successfully!"));
          } catch (remoteErr) {
            remoteSpinner.stop(pc.yellow("Remote branch update could not be fully completed."));
            p.log.warn(String(remoteErr));
          }
        }
      }

      p.outro(pc.green(`Current branch is now ${pc.bold(pc.cyan(newName))}.`));
    });
}
