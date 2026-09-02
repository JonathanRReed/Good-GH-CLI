import { Command } from "commander";
import { join } from "node:path";
import {
  getCurrentBranch,
  getRepoRoot,
  isGitRepo,
  worktreeAdd,
  worktreeList,
  worktreeRemove,
} from "../services/git.ts";
import { resolveAIProvider } from "../services/ai/index.ts";
import { header, p, pc, promptInput } from "../utils/ui.ts";

export function registerWorktreeCommand(program: Command): void {
  const wt = program
    .command("worktree")
    .alias("wt")
    .description("Manage isolated parallel Git worktrees with AI branch generation");

  wt.command("list")
    .alias("ls")
    .description("List all active worktrees")
    .action(async () => {
      header("Git Worktrees");
      if (!(await isGitRepo())) {
        p.log.error("Not inside a git repository.");
        return;
      }

      const list = await worktreeList();
      if (list.length === 0) {
        p.log.info("No worktrees found.");
        return;
      }

      for (const item of list) {
        const isCurrent = process.cwd() === item.path;
        const prefix = isCurrent ? pc.green("● ") : "  ";
        p.log.message(
          `${prefix}${pc.bold(item.branch)} ${pc.dim(`(${item.head.slice(0, 7)})`)}\n    ${pc.dim(item.path)}`,
        );
      }
      p.outro("Done.");
    });

  wt.command("add [branchOrPrompt]")
    .description("Create a new worktree (accepts branch name or natural language task prompt)")
    .option("-b, --base <branch>", "Base branch to create worktree from")
    .action(async (arg?: string, options?: { base?: string }) => {
      header("Add Worktree");
      if (!(await isGitRepo())) {
        p.log.error("Not inside a git repository.");
        return;
      }

      let branchName = arg;

      if (!branchName) {
        const input = await promptInput({
          message: "Enter branch name or feature description:",
          placeholder: "e.g. fix/navbar-bug or 'add dark mode toggle'",
          validate: (v) => (!v || !v.trim() ? "Input required" : undefined),
        });

        if (!input) {
          p.cancel("Cancelled.");
          return;
        }
        branchName = input;
      }

      // If input looks like natural language (contains spaces or > 15 chars without slashes)
      if (branchName.includes(" ") || (!branchName.includes("/") && branchName.length > 15)) {
        const s = p.spinner();
        s.start("Generating semantic branch name with AI...");
        try {
          const { provider, model } = await resolveAIProvider();
          const generated = await provider.generateBranchName(branchName, model);
          s.stop("Branch name generated.");

          const confirmBranch = await promptInput({
            message: "Confirm or edit generated branch name:",
            defaultValue: generated,
            placeholder: generated,
          });

          if (!confirmBranch) {
            p.cancel("Cancelled.");
            return;
          }
          branchName = confirmBranch;
        } catch {
          s.stop(pc.yellow("AI naming unavailable; formatting from text..."));
          branchName = `feat/${branchName.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30)}`;
        }
      }

      const sanitizedDir = branchName
        .replace(/[^a-zA-Z0-9_-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "");
      const repoRoot = await getRepoRoot();
      const targetPath = join(repoRoot, ".worktrees", sanitizedDir);
      const baseBranch = options?.base || (await getCurrentBranch());

      const s = p.spinner();
      s.start(`Creating worktree for ${pc.cyan(branchName)} at ${pc.dim(targetPath)}...`);

      try {
        await worktreeAdd(branchName, targetPath, baseBranch);
        s.stop(pc.green("Worktree created successfully!"));
        p.log.message(
          `\nTo switch to your new worktree:\n  ${pc.bold(pc.cyan(`cd ${targetPath}`))}\n`,
        );
        p.outro(pc.green("Ready for isolated development!"));
      } catch (err) {
        s.stop(pc.red("Failed to create worktree."));
        p.log.error(String(err));
      }
    });

  wt.command("remove [target]")
    .alias("rm")
    .description("Remove an active worktree and clean up references")
    .option("-f, --force", "Force remove even with uncommitted changes")
    .action(async (target?: string, options?: { force?: boolean }) => {
      header("Remove Worktree");
      if (!(await isGitRepo())) {
        p.log.error("Not inside a git repository.");
        return;
      }

      const list = await worktreeList();
      const nonMainList = list.filter((w) => !w.isBare && w.path !== process.cwd());

      if (nonMainList.length === 0) {
        p.log.warn("No removable secondary worktrees found.");
        return;
      }

      let selectedPath = target;
      if (!selectedPath) {
        const pick = await p.select({
          message: "Select worktree to remove:",
          options: nonMainList.map((w) => ({
            value: w.path,
            label: `${w.branch} (${w.path})`,
          })),
          maxItems: 8,
        });

        if (p.isCancel(pick)) {
          p.cancel("Cancelled.");
          return;
        }
        selectedPath = pick as string;
      }

      const s = p.spinner();
      s.start(`Removing worktree ${pc.cyan(selectedPath)}...`);

      try {
        await worktreeRemove(selectedPath, options?.force);
        s.stop(pc.green("Worktree removed and references pruned."));
        p.outro("Done.");
      } catch (err: unknown) {
        s.stop(pc.yellow("Worktree removal blocked."));
        const errStr = String(err);
        if (errStr.includes("contains modified or untracked files") || errStr.includes("use --force")) {
          const confirmForce = await p.confirm({
            message: "Worktree contains untracked build files or local edits. Force remove?",
            initialValue: true,
          });

          if (confirmForce && !p.isCancel(confirmForce)) {
            const forceSpinner = p.spinner();
            forceSpinner.start("Force removing worktree...");
            try {
              await worktreeRemove(selectedPath, true);
              forceSpinner.stop(pc.green("Worktree force removed and metadata pruned!"));
              p.outro("Done.");
              return;
            } catch (forceErr) {
              forceSpinner.stop(pc.red("Failed to force remove worktree."));
              p.log.error(String(forceErr));
              return;
            }
          }
        }
        p.log.error(errStr);
      }
    });
}
