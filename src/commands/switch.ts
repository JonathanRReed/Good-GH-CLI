import { Command } from "commander";
import { getFlags } from "../services/runtime.ts";
import { resolve } from "node:path";
import {
  getRepoRoot,
  getStatus,
  requireGitRepo,
  listBranches,
  switchBranch,
  worktreeList,
} from "../services/git.ts";
import {
  emitJson,
  fail,
  header,
  p,
  pc,
  type PickerItem,
  promptInput,
  searchablePicker,
} from "../utils/ui.ts";
import { dryRun } from "../utils/flags.ts";
import { validateBranchName } from "../utils/branch-name.ts";

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
    .alias("checkout")
    .description("Switch between branches and worktrees")
    .option("-c, --create", "Create and switch to a new branch")
    .action(async (target?: string, options?: { create?: boolean }) => {
      header("Switch Branch / Worktree");

      if (!(await requireGitRepo())) return;

      const status = await getStatus();
      const currentBranch = status.branch;
      const currentLabel = status.isDetached ? "HEAD (detached)" : status.branch;

      // If user specified target directly on CLI:
      if (target) {
        if (options?.create) {
          const validationError = validateBranchName(target);
          if (validationError) {
            fail(validationError);
            return;
          }
          if (dryRun(`create and switch to branch ${target}`)) return;

          if (getFlags().json) {
            try {
              await switchBranch(target, true);
              emitJson({ switched: true, branch: target, created: true });
            } catch (err) {
              emitJson({ switched: false, branch: target, created: true, error: formatSwitchError(err) });
              fail(formatSwitchError(err));
            }
            return;
          }

          const s = p.spinner();
          s.start(`Creating and switching to branch ${pc.cyan(target)}...`);
          try {
            await switchBranch(target, true);
            s.stop(pc.green(`Switched to new branch ${pc.bold(pc.cyan(target))}`));
          } catch (err) {
            s.stop(pc.red("Failed to create branch."));
            fail(formatSwitchError(err));
          }
          return;
        }

        if (getFlags().json) {
          try {
            await switchBranch(target, false);
            emitJson({ switched: true, branch: target, created: false });
          } catch (err) {
            emitJson({ switched: false, branch: target, created: false, error: formatSwitchError(err) });
            fail(formatSwitchError(err));
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
          fail(formatSwitchError(err));
        }
        return;
      }

      // JSON mode: emit branch list without entering interactive picker
      if (getFlags().json) {
        const branches = await listBranches();
        const worktrees = await worktreeList();
        const repoRoot = await getRepoRoot();
        const worktreeBranches = new Set(
          worktrees
            .filter((w) => resolve(w.path) !== resolve(repoRoot))
            .map((w) => w.branch),
        );
        emitJson(
          branches.map((b) => ({
            name: b.name,
            current: b.current,
            isWorktree: worktreeBranches.has(b.name),
          })),
        );
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
        const isCurrent = !status.isDetached && b.name === currentBranch;
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
        title: `Currently on ${currentLabel}. Switch to:`,
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
          validate: (v) => {
            if (!v || !v.trim()) return "Branch name required";
            return validateBranchName(v.trim()) || undefined;
          },
        });

        if (!branchName) {
          p.cancel("Cancelled.");
          return;
        }

        const cleanName = branchName.trim().replace(/\s+/g, "-");
        if (dryRun(`create and switch to branch ${cleanName}`)) return;

        const s = p.spinner();
        s.start(`Creating and switching to ${pc.cyan(cleanName)}...`);
        try {
          await switchBranch(cleanName, true);
          s.stop(pc.green(`Switched to new branch ${pc.bold(pc.cyan(cleanName))}`));
        } catch (err) {
          s.stop(pc.red("Failed to create branch."));
          fail(formatSwitchError(err));
        }
      } else if (val.startsWith("branch:")) {
        const targetBranch = val.replace("branch:", "");
        if (!status.isDetached && targetBranch === currentBranch) {
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
          fail(formatSwitchError(err));
        }
      } else if (val.startsWith("worktree:")) {
        const wtPath = val.replace("worktree:", "");
        p.log.success(pc.green("Selected worktree:"));
        p.log.message(`To switch to this worktree in your shell:\n  ${pc.bold(pc.cyan(`cd ${wtPath}`))}\n`);
      }
    });
}
