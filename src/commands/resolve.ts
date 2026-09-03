import { Command } from "commander";
import { getStatus, isGitRepo, resolveConflict } from "../services/git.ts";
import {
  fail,
  header,
  p,
  pc,
  selectMenu,
} from "../utils/ui.ts";

export function registerResolveCommand(program: Command): void {
  program
    .command("resolve")
    .description("Interactively resolve merge conflicts file by file")
    .action(async () => {
      header("Merge Conflict Resolver");

      if (!(await isGitRepo())) {
        fail("Not a git repository.");
        return;
      }

      const status = await getStatus();
      if (status.conflicts.length === 0) {
        p.log.success(pc.green("No unresolved merge conflicts found!"));
        return;
      }

      p.log.step(`Found ${pc.bold(pc.yellow(String(status.conflicts.length)))} conflicted file(s).`);

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
        p.outro(pc.green("All merge conflicts resolved! You can now commit with `ggh commit`."));
      } else {
        p.log.warn(`${updated.conflicts.length} conflicted file(s) remaining.`);
      }
    });
}
