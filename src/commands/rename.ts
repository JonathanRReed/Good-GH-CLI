import { Command } from "commander";
import { run } from "../utils/exec.ts";
import {
  getAheadBehind,
  getCurrentBranch,
  getRemotes,
  hasBranch,
  isGitRepo,
  renameBranch,
} from "../services/git.ts";
import { confirmPrompt, header, p, pc, promptInput } from "../utils/ui.ts";

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
      if (!current || current === "HEAD") {
        p.log.error("Cannot rename detached HEAD. Please checkout a named branch first.");
        return;
      }

      if (current === "main" || current === "master") {
        const confirmDefault = await confirmPrompt({
          message: `Current branch is default branch ${pc.bold(pc.yellow(current))}. Are you sure you want to rename it?`,
          initialValue: false,
        });
        if (!confirmDefault) {
          p.cancel("Rename cancelled.");
          return;
        }
      }

      let newName = newNameArg?.trim();
      if (newNameArg !== undefined && (!newName || newName.length === 0)) {
        p.log.error("New branch name cannot be empty.");
        return;
      }

      if (!newName) {
        const inputName = await promptInput({
          message: `Enter new name for branch ${pc.bold(pc.cyan(current))}:`,
          placeholder: "e.g. feat/new-auth-flow",
          validate: (v) => (!v || !v.trim() ? "New branch name required" : undefined),
        });

        if (!inputName) {
          p.cancel("Rename cancelled.");
          return;
        }

        newName = inputName.trim();
      }

      if (newName === current) {
        p.log.warn(`Branch is already named '${current}'. Nothing to rename.`);
        return;
      }

      if (await hasBranch(newName)) {
        p.log.error(`A branch named '${newName}' already exists.`);
        return;
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
        const remotes = await getRemotes();
        const remoteName = remotes.includes("origin") ? "origin" : remotes[0];

        if (remoteName) {
          const updateRemote = await confirmPrompt({
            message: `Branch had remote tracking. Push ${pc.bold(pc.green(newName))} to remote and delete old remote branch '${remoteName}/${current}'?`,
            initialValue: true,
          });

          if (updateRemote) {
            const remoteSpinner = p.spinner();
            remoteSpinner.start("Updating remote tracking branch...");
            try {
              await run("git", ["push", "-u", remoteName, newName]);
              await run("git", ["push", remoteName, "--delete", current]);
              remoteSpinner.stop(pc.green("Remote branch updated successfully!"));
            } catch (remoteErr) {
              remoteSpinner.stop(pc.yellow("Remote branch update could not be fully completed."));
              p.log.warn(String(remoteErr));
            }
          }
        }
      }

      p.outro(pc.green(`Current branch is now ${pc.bold(pc.cyan(newName))}.`));
    });
}
