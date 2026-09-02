import { Command } from "commander";
import { resolve } from "node:path";
import {
  getRepoRoot,
  getStatus,
  isGitRepo,
  listBranches,
  switchBranch,
  worktreeList,
} from "../services/git.ts";
import { header, p, pc, promptInput, searchablePicker, type PickerItem } from "../utils/ui.ts";

function formatSwitchError(err: unknown): string {
  const str = String(err);
  if (str.includes("overwritten by checkout") || str.includes("local changes")) {
    return "Your local uncommitted changes would be overwritten by switching branches. Please commit or stash your changes first (`ggh stash` or `ggh commit`).";
  }
  return str;
}

export function registerSwitchCommand(program: Command): void {
  program
    .command("switch [target]")
    .alias("sw")
    .description("Quickly switch between git branches and active worktrees")
    .option("-c, --create", "Create and switch to a new branch")
    .action(async (target?: string, options?: { create?: boolean }) => {
      header("Switch Branch / Worktree");

      if (!(await isGitRepo())) {
        p.log.error("Not a git repository.");
        return;
      }

      const status = await getStatus();
      const currentBranch = status.isDetached ? "HEAD (detached)" : status.branch;

      // If user specified target directly on CLI:
      if (target) {
        if (options?.create) {
          const s = p.spinner();
          s.start(`Creating and switching to branch ${pc.cyan(target)}...`);
          try {
            await switchBranch(target, true);
            s.stop(pc.green(`Switched to new branch ${pc.bold(pc.cyan(target))}`));
          } catch (err) {
            s.stop(pc.red("Failed to create branch."));
            p.log.error(formatSwitchError(err));
          }
          return;
        }

        const s = p.spinner();
        s.start(`Switching to branch ${pc.cyan(target)}...`);
        try {
          await switchBranch(target, false);
          s.stop(pc.green(`Switched to branch ${pc.bold(pc.cyan(target))}`));
        } catch (err) {
          s.stop(pc.red("Failed to switch branch."));
          p.log.error(formatSwitchError(err));
        }
        return;
      }

      // Interactive mode
      if (status.hasChanges) {
        p.log.warn(pc.yellow(`You have ${status.staged.length + status.unstaged.length + status.untracked.length} uncommitted change(s).`));
      }

      const branches = await listBranches();
      const worktrees = await worktreeList();
      const repoRoot = await getRepoRoot();

      const choices: PickerItem[] = [
        {
          value: "__create__",
          label: "+ Create new branch...",
          hint: "branch off current HEAD",
        },
      ];

      // Add local branches
      for (const b of branches) {
        const isCurrent = b.name === currentBranch;
        choices.push({
          value: `branch:${b.name}`,
          label: isCurrent ? `* ${b.name}` : b.name,
          hint: isCurrent ? "current branch" : b.commit.slice(0, 45),
        });
      }

      // Add worktrees if more than the main root
      const secondaryTrees = worktrees.filter((w) => resolve(w.path) !== resolve(repoRoot));
      if (secondaryTrees.length > 0) {
        for (const wt of secondaryTrees) {
          choices.push({
            value: `worktree:${wt.path}`,
            label: `🌲 ${wt.branch}`,
            hint: wt.path,
          });
        }
      }

      const selected = await searchablePicker({
        title: `Currently on ${currentBranch}. Switch to:`,
        items: choices,
        pageSize: 8,
      });

      if (!selected) {
        p.cancel("Switch cancelled.");
        return;
      }

      const val = selected;

      if (val === "__create__") {
        const branchName = await promptInput({
          message: "Enter new branch name:",
          validate: (v) => (!v || !v.trim() ? "Branch name required" : undefined),
        });

        if (!branchName) {
          p.cancel("Cancelled.");
          return;
        }

        const cleanName = branchName.trim().replace(/\s+/g, "-");
        const s = p.spinner();
        s.start(`Creating and switching to ${pc.cyan(cleanName)}...`);
        try {
          await switchBranch(cleanName, true);
          s.stop(pc.green(`Switched to new branch ${pc.bold(pc.cyan(cleanName))}`));
        } catch (err) {
          s.stop(pc.red("Failed to create branch."));
          p.log.error(formatSwitchError(err));
        }
      } else if (val.startsWith("branch:")) {
        const targetBranch = val.replace("branch:", "");
        if (targetBranch === currentBranch) {
          p.log.info(pc.dim(`Already on branch ${targetBranch}.`));
          return;
        }

        const s = p.spinner();
        s.start(`Switching to ${pc.cyan(targetBranch)}...`);
        try {
          await switchBranch(targetBranch, false);
          s.stop(pc.green(`Switched to branch ${pc.bold(pc.cyan(targetBranch))}`));
        } catch (err) {
          s.stop(pc.red("Failed to switch branch."));
          p.log.error(formatSwitchError(err));
        }
      } else if (val.startsWith("worktree:")) {
        const wtPath = val.replace("worktree:", "");
        p.log.success(pc.green("Selected worktree:"));
        p.log.message(`To switch to this worktree in your shell:\n  ${pc.bold(pc.cyan(`cd ${wtPath}`))}\n`);
      }
    });
}
