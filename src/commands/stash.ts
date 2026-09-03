import { Command } from "commander";
import {
  getStatus,
  isGitRepo,
  stashDiff,
  stashDrop,
  stashList,
  stashPop,
  stashPush,
} from "../services/git.ts";
import { getFlags } from "../services/runtime.ts";
import {
  emitJson,
  fail,
  header,
  p,
  pc,
  promptInput,
  searchablePicker,
  selectMenu,
} from "../utils/ui.ts";

function displayColoredDiff(rawDiff: string): void {
  const lines = rawDiff.split("\n");
  const output: string[] = [];
  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      output.push(pc.green(line));
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      output.push(pc.red(line));
    } else if (line.startsWith("@@")) {
      output.push(pc.cyan(line));
    } else if (line.startsWith("diff --git") || line.startsWith("index ")) {
      output.push(pc.bold(pc.dim(line)));
    } else {
      output.push(line);
    }
  }
  console.log("\n" + output.join("\n") + "\n");
}

export function registerStashCommand(program: Command): void {
  const stash = program
    .command("stash [action]")
    .alias("sh")
    .description("Interactive modern Git stash assistant")
    .option("-m, --message <message>", "Stash message")
    .action(async (action?: string, options?: { message?: string }) => {
      header("Git Stash Assistant");

      if (!(await isGitRepo())) {
        fail("Not a git repository.");
        return;
      }

      if (action === "push" || action === "save") {
        const s = p.spinner();
        s.start("Stashing changes...");
        try {
          await stashPush(options?.message);
          s.stop(pc.green("Changes stashed successfully!"));
        } catch (err) {
          s.stop(pc.red("Stash failed."));
          fail(String(err));
        }
        return;
      }

      if (action === "pop") {
        const s = p.spinner();
        s.start("Popping latest stash...");
        try {
          await stashPop();
          s.stop(pc.green("Stash applied and popped!"));
        } catch (err) {
          s.stop(pc.red("Failed to pop stash."));
          fail(String(err));
        }
        return;
      }

      if (action === "list") {
        const list = await stashList();
        if (getFlags().json) {
          emitJson(list);
          return;
        }
        if (list.length === 0) {
          p.log.info(pc.dim("No stashes found."));
          return;
        }
        for (const s of list) {
          p.log.message(`${pc.bold(pc.cyan(s.ref))} ${pc.dim(`(${s.date})`)}: ${s.message}`);
        }
        return;
      }

      // Interactive Menu
      const status = await getStatus();
      const list = await stashList();

      if (!status.hasChanges && list.length === 0) {
        p.log.info(pc.dim("Working tree is clean and no stashes found."));
        return;
      }

      const choice = await selectMenu({
        message: "What would you like to do?",
        options: [
          ...(status.hasChanges
            ? [
                {
                  value: "stash",
                  label: "Stash current changes",
                  hint: `${status.staged.length} staged, ${status.unstaged.length} unstaged`,
                },
              ]
            : []),
          ...(list.length > 0
            ? [
                {
                  value: "pop",
                  label: "Pop latest stash",
                  hint: `${list[0].ref}: ${list[0].message}`,
                },
                {
                  value: "browse",
                  label: `Browse ${list.length} stash(es)...`,
                  hint: "Inspect colored diffs or apply",
                },
                {
                  value: "drop",
                  label: "Drop a stash",
                  hint: "Delete specific stash",
                },
              ]
            : []),
        ],
      });

      if (choice === null) {
        p.cancel("Cancelled.");
        return;
      }

      if (choice === "stash") {
        const msg = await promptInput({
          message: "Enter stash message (optional, press Enter to skip):",
          placeholder: "e.g. wip: work on login button",
        });

        if (msg === null) {
          p.cancel("Stash cancelled.");
          return;
        }

        const s = p.spinner();
        s.start("Stashing changes...");
        try {
          await stashPush(msg as string);
          s.stop(pc.green("Changes safely stashed!"));
        } catch (err) {
          s.stop(pc.red("Failed to stash changes."));
          fail(String(err));
        }
      } else if (choice === "pop") {
        const s = p.spinner();
        s.start("Popping latest stash...");
        try {
          await stashPop();
          s.stop(pc.green("Stash restored successfully!"));
        } catch (err) {
          s.stop(pc.red("Failed to pop stash."));
          fail(String(err));
        }
      } else if (choice === "browse") {
        const pickStash = await searchablePicker({
          title: "Select stash to inspect:",
          items: list.map((s) => ({
            value: s.ref,
            label: `${s.ref} (${s.date})`,
            hint: s.message,
          })),
          pageSize: 8,
        });

        if (!pickStash) return;

        const diff = await stashDiff(pickStash as string);
        if (diff) {
          displayColoredDiff(diff);
        } else {
          p.log.info("Empty stash diff.");
        }

        const stashAction = await selectMenu({
          message: `Action for ${pickStash}:`,
          options: [
            { value: "pop", label: "Apply & Pop this stash" },
            { value: "drop", label: "Drop (delete) this stash" },
            { value: "back", label: "Done / Back" },
          ],
        });

        if (stashAction === null || stashAction === "back") return;

        if (stashAction === "pop") {
          try {
            await stashPop(pickStash as string);
            p.log.success(pc.green(`Popped ${pickStash}.`));
          } catch (err) {
            fail(`Failed to pop ${pickStash}: ${String(err)}`);
          }
        } else if (stashAction === "drop") {
          try {
            await stashDrop(pickStash as string);
            p.log.success(pc.green(`Dropped ${pickStash}.`));
          } catch (err) {
            fail(`Failed to drop ${pickStash}: ${String(err)}`);
          }
        }
      } else if (choice === "drop") {
        const pickDrop = await searchablePicker({
          title: "Select stash to permanently delete:",
          items: list.map((s) => ({
            value: s.ref,
            label: `${s.ref} (${s.date})`,
            hint: s.message,
          })),
          pageSize: 8,
        });

        if (!pickDrop) return;

        try {
          await stashDrop(pickDrop as string);
          p.log.success(pc.green(`Dropped ${pickDrop}.`));
        } catch (err) {
          fail(`Failed to drop ${pickDrop}: ${String(err)}`);
        }
      }
    });

  stash
    .command("pop [ref]")
    .description("Pop a stash")
    .action(async (ref?: string) => {
      header("Pop Stash");
      if (!(await isGitRepo())) {
        fail("Not a git repository.");
        return;
      }
      try {
        await stashPop(ref);
        p.log.success(pc.green(ref ? `Stash ${ref} popped.` : "Latest stash popped."));
      } catch (err) {
        fail(`Failed to pop stash: ${String(err)}`);
      }
    });

  stash
    .command("drop <ref>")
    .description("Drop a stash")
    .action(async (ref: string) => {
      header("Drop Stash");
      if (!(await isGitRepo())) {
        fail("Not a git repository.");
        return;
      }
      try {
        await stashDrop(ref);
        p.log.success(pc.green(`Dropped ${ref}.`));
      } catch (err) {
        fail(`Failed to drop stash: ${String(err)}`);
      }
    });
}
