import { Command } from "commander";
import { execGitWithRetry, getInProgressOperation, getStatus, requireGitRepo, resolveConflict } from "../services/git.ts";
import { fail, header, p, pc, selectMenu, jsonOut, confirmOrAbort } from "../utils/ui.ts";
import { dryRun, isDryRun } from "../utils/flags.ts";

export function registerResolveCommand(program: Command): void {
  program
    .command("resolve")
    .description("Resolve merge conflicts, file by file")
    .option("-y, --yes", "Continue the in-progress rebase/merge/cherry-pick after all conflicts are resolved")
    .option("--dry-run", "List conflicts without resolving them")
    .action(async (options?: { yes?: boolean; dryRun?: boolean }) => {
      header("Merge Conflict Resolver");

      if (!(await requireGitRepo())) return;

      const status = await getStatus();
      if (status.conflicts.length === 0) {
        if (jsonOut({ conflicts: [], resolved: 0, remaining: 0 })) return;
        p.log.success(pc.green("No unresolved merge conflicts found!"));
        return;
      }

      if (jsonOut({
          conflicts: status.conflicts.map((c) => c.path),
          resolved: 0,
          remaining: status.conflicts.length,
          hint: "Resolve conflicts interactively, or use `git checkout --ours/--theirs` and `git add`.",
        })) return;

      p.log.step(`Found ${pc.bold(pc.yellow(String(status.conflicts.length)))} conflicted file(s).`);

      if (isDryRun()) {
        for (const conflict of status.conflicts) {
          p.log.message(`  ${pc.yellow("▲")} ${pc.bold(conflict.path)}`);
        }
        dryRun(`resolve ${status.conflicts.length} conflict(s) interactively`);
        p.outro(pc.dim("No files were changed."));
        return;
      }

      for (const conflict of status.conflicts) {
        const choice = await selectMenu({
          message: `Resolve conflict in: ${pc.bold(pc.cyan(conflict.path))}`,
          options: [
            {
              value: "ours",
              label: "Accept Ours (current branch)",
              hint: "keep local version and stage resolution",
            },
            {
              value: "theirs",
              label: "Accept Theirs (incoming branch)",
              hint: "keep incoming version and stage resolution",
            },
            {
              value: "mark",
              label: "Mark as resolved (git add)",
              hint: "if you already manually resolved conflict markers",
            },
            {
              value: "skip",
              label: "Skip this file for now",
            },
          ],
        });

        if (choice === null) {
          p.cancel("Conflict resolution paused.");
          return;
        }

        try {
          if (choice === "ours") {
            await resolveConflict(conflict.path, "ours");
            p.log.success(`Accepted ours for ${pc.cyan(conflict.path)}.`);
          } else if (choice === "theirs") {
            await resolveConflict(conflict.path, "theirs");
            p.log.success(`Accepted theirs for ${pc.cyan(conflict.path)}.`);
          } else if (choice === "mark") {
            await resolveConflict(conflict.path, "mark");
            p.log.success(`Marked ${pc.cyan(conflict.path)} as resolved.`);
          }
        } catch (err) {
          fail(`Failed to resolve ${pc.bold(conflict.path)}: ${String(err)}`);
        }
      }

      const updated = await getStatus();
      if (updated.conflicts.length === 0) {
        p.log.success(pc.green("All merge conflicts resolved!"));

        const operation = await getInProgressOperation();
        if (operation) {
          const commandMap = {
            rebase: "git rebase --continue",
            merge: "git commit --no-edit",
            "cherry-pick": "git cherry-pick --continue",
          };
          const proceed = await confirmOrAbort(`Run ${commandMap[operation]}?`, { assumeYes: options?.yes, cancelText: null });

          if (proceed) {
            const s = p.spinner();
            s.start(`Continuing ${operation}...`);
            try {
              if (operation === "rebase") {
                await execGitWithRetry(["rebase", "--continue"], { env: { ...process.env, GIT_EDITOR: "true" } });
              } else if (operation === "merge") {
                await execGitWithRetry(["commit", "--no-edit"]);
              } else if (operation === "cherry-pick") {
                await execGitWithRetry(["cherry-pick", "--continue"], { env: { ...process.env, GIT_EDITOR: "true" } });
              }
              s.stop(pc.green(`${operation} continued successfully!`));
            } catch (err) {
              s.stop(pc.red(`Failed to continue ${operation}.`));
              fail(String(err));
              return;
            }
          }
        }

        p.outro(pc.green("Done."));
      } else {
        p.log.warn(`${updated.conflicts.length} conflicted file(s) remaining.`);
      }
    });
}
