import { Command } from "commander";
import { getFlags } from "../services/runtime.ts";
import {
  getStatus,
  requireGitRepo,
  stashDiff,
  stashDrop,
  stashList,
  stashPop,
  stashPush,
} from "../services/git.ts";
import { dryRun } from "../utils/flags.ts";
import {
  jsonOut, emitJson,
  fail,
  header,
  p,
  pc,
  promptInput,
  renderDiff,
  searchablePicker,
  selectMenu,
} from "../utils/ui.ts";

export function registerStashCommand(program: Command): void {
  const stash = program
    .command("stash [action]")
    .alias("sh")
    .description("Push, browse, pop, and drop stashes")
    .option("-m, --message <message>", "Stash message")
    .action(async (action?: string, options?: { message?: string }) => {
      header("Git Stash Assistant");

      if (!(await requireGitRepo())) return;

      if (action === "push" || action === "save") {
        const status = await getStatus();
        const files = [...status.staged, ...status.unstaged, ...status.untracked].map((f) => f.path);
        if (dryRun(`stash ${files.length} file(s)${options?.message ? ` with message "${options.message}"` : ""}`)) return;

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
        if (dryRun("pop the latest stash")) return;

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
        if (jsonOut(list)) return;
        if (list.length === 0) {
          p.log.info(pc.dim("No stashes found."));
          return;
        }
        for (const s of list) {
          p.log.message(`${pc.bold(pc.cyan(s.ref))} ${pc.dim(`(${s.date})`)}: ${s.message}`);
        }
        return;
      }

      // JSON mode: emit stash list without entering interactive menu
      if (getFlags().json) {
        const list = await stashList();
        emitJson(list);
        return;
      }

      // Interactive Menu
      if (dryRun("show the stash menu")) return;

      const status = await getStatus();
      const list = await stashList();
      const latestStash = list.at(0);

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
          ...(latestStash
            ? [
                {
                  value: "pop",
                  label: "Pop latest stash",
                  hint: `${latestStash.ref}: ${latestStash.message}`,
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

        if (dryRun(`stash current changes${msg ? ` with message "${msg}"` : ""}`)) return;

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
        if (dryRun("pop the latest stash")) return;
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
          renderDiff(diff);
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
          if (dryRun(`pop stash ${pickStash}`)) return;
          try {
            await stashPop(pickStash as string);
            p.log.success(pc.green(`Popped ${pickStash}.`));
          } catch (err) {
            fail(`Failed to pop ${pickStash}: ${String(err)}`);
          }
        } else if (stashAction === "drop") {
          if (dryRun(`drop stash ${pickStash}`)) return;
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

        if (dryRun(`drop stash ${pickDrop}`)) return;

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
      if (!(await requireGitRepo())) return;
      if (dryRun(ref ? `pop stash ${ref}` : "pop the latest stash")) return;
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
      if (!(await requireGitRepo())) return;
      if (dryRun(`drop stash ${ref}`)) return;
      try {
        await stashDrop(ref);
        p.log.success(pc.green(`Dropped ${ref}.`));
      } catch (err) {
        fail(`Failed to drop stash: ${String(err)}`);
      }
    });

  stash
    .command("push")
    .alias("save")
    .description("Stash current changes")
    .option("-m, --message <message>", "Stash message")
    .action(async (options?: { message?: string }) => {
      header("Push Stash");
      if (!(await requireGitRepo())) return;
      const status = await getStatus();
      const files = [...status.staged, ...status.unstaged, ...status.untracked].map((f) => f.path);
      if (dryRun(`stash ${files.length} file(s)${options?.message ? ` with message "${options.message}"` : ""}`)) return;
      const s = p.spinner();
      s.start("Stashing changes...");
      try {
        await stashPush(options?.message);
        s.stop(pc.green("Changes stashed successfully!"));
      } catch (err) {
        s.stop(pc.red("Stash failed."));
        fail(String(err));
      }
    });

  stash
    .command("list")
    .description("List stashes")
    .action(async () => {
      header("Stash List");
      if (!(await requireGitRepo())) return;
      const list = await stashList();
      if (jsonOut(list)) return;
      if (list.length === 0) {
        p.log.info(pc.dim("No stashes found."));
        return;
      }
      for (const s of list) {
        p.log.message(`${pc.bold(pc.cyan(s.ref))} ${pc.dim(`(${s.date})`)}: ${s.message}`);
      }
    });
}
