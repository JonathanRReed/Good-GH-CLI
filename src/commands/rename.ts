import { Command } from "commander";
import { getFlags } from "../services/runtime.ts";
import { run } from "../utils/exec.ts";
import {
  getAheadBehind,
  getAllMergeBases,
  getCurrentBranch,
  getRemotes,
  hasBranch,
  renameBranch,
  requireGitRepo,
} from "../services/git.ts";
import {
  confirmOrAbort,
  emitJson,
  fail,
  header,
  p,
  pc,
  promptInput,
} from "../utils/ui.ts";
import { dryRun } from "../utils/flags.ts";
import { validateBranchName } from "../utils/branch-name.ts";

export function registerRenameCommand(program: Command): void {
  program
    .command("rename [newName]")
    .description("Rename the current branch, locally and on the remote")
    .option("-y, --yes", "Skip confirmation prompts")
    .action(async (newNameArg?: string, options?: { yes?: boolean }) => {
      header("Branch Rename Assistant");

      if (!(await requireGitRepo())) return;

      const current = await getCurrentBranch();
      if (!current || current === "HEAD") {
        fail("Cannot rename detached HEAD. Please checkout a named branch first.");
        return;
      }

      if (current === "main" || current === "master") {
        if (!(await confirmOrAbort(`Current branch is default branch ${pc.bold(pc.yellow(current))}. Are you sure you want to rename it?`, { assumeYes: options?.yes, initialValue: false, cancelText: "Rename cancelled." }))) return;
      }

      let newName = newNameArg?.trim();
      if (newNameArg !== undefined && (!newName || newName.length === 0)) {
        fail("New branch name cannot be empty.");
        return;
      }

      if (!newName) {
        const inputName = await promptInput({
          message: `Enter new name for branch ${pc.bold(pc.cyan(current))}:`,
          placeholder: "e.g. feat/new-auth-flow",
          validate: (v) => {
            if (!v || !v.trim()) return "New branch name required";
            return validateBranchName(v.trim()) || undefined;
          },
        });

        if (!inputName) {
          p.cancel("Rename cancelled.");
          return;
        }

        newName = inputName.trim();
      } else {
        const validationError = validateBranchName(newName);
        if (validationError) {
          fail(validationError);
          return;
        }
      }

      if (newName === current) {
        p.log.warn(`Branch is already named '${current}'. Nothing to rename.`);
        return;
      }

      if (await hasBranch(newName)) {
        fail(`A branch named '${newName}' already exists.`);
        return;
      }

      if (dryRun(`rename ${current} to ${newName}`)) return;

      if (getFlags().json) {
        try {
          await renameBranch(current, newName);
          const mergeBases = await getAllMergeBases();
          for (const [childBranch, parentBranch] of mergeBases.entries()) {
            if (parentBranch === current) {
              await run("git", ["config", `branch.${childBranch}.gh-merge-base`, newName], { reject: false });
            }
          }
          emitJson({ renamed: true, from: current, to: newName, remoteUpdated: false });
        } catch (err) {
          emitJson({ renamed: false, from: current, to: newName, error: String(err) });
          fail(String(err));
        }
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
        fail(String(err));
        return;
      }

      // Rewrite every child's parent pointer that pointed at the old name. Only
      // the name changes: the recorded parent tip is still where the child forked.
      const mergeBases = await getAllMergeBases();
      for (const [childBranch, parentBranch] of mergeBases.entries()) {
        if (parentBranch === current) {
          await run("git", ["config", `branch.${childBranch}.gh-merge-base`, newName], { reject: false });
        }
      }

      if (hadRemote) {
        const remotes = await getRemotes();
        const remoteName = remotes.includes("origin") ? "origin" : remotes[0];

        if (remoteName) {
          const updateRemote = await confirmOrAbort(`Branch had remote tracking. Push ${pc.bold(pc.green(newName))} to remote and delete old remote branch '${remoteName}/${current}'?`, { assumeYes: options?.yes, cancelText: null });

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
