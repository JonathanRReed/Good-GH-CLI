import type { Command } from "commander";
import {
  commentOnPullRequest,
  editPullRequest,
  getActivePullRequest,
  mergePullRequest,
  setPullRequestState,
  viewPullRequest,
  type MergeOptions,
} from "../services/github.ts";
import { getFlags } from "../services/runtime.ts";
import { isDryRun } from "../utils/flags.ts";
import {
  confirmPrompt,
  emitJson,
  fail,
  header,
  p,
  pc,
  promptInput,
  selectMenu,
} from "../utils/ui.ts";

async function resolvePrNumber(arg?: string): Promise<number | null> {
  if (arg) {
    const parsed = Number.parseInt(arg, 10);
    if (Number.isNaN(parsed)) {
      fail(`Invalid Pull Request number: ${arg}`);
      return null;
    }
    return parsed;
  }
  const active = await getActivePullRequest();
  if (!active) {
    fail("No Pull Request found for the current branch. Pass a number, or run `ggh pr create`.");
    return null;
  }
  return active.number;
}

function stateColor(state: string): string {
  const upper = state.toUpperCase();
  if (upper === "OPEN") return pc.green(state);
  if (upper === "MERGED") return pc.magenta(state);
  return pc.dim(state);
}

export function registerPrLifecycleCommands(pr: Command): void {
  pr.command("view [prNumber]")
    .description("Show a Pull Request: state, review decision, size, and body")
    .action(async (prNumber?: string) => {
      const num = prNumber ? Number.parseInt(prNumber, 10) : undefined;
      const detail = await viewPullRequest(Number.isNaN(num as number) ? undefined : num);
      if (!detail) {
        fail("No Pull Request found. Pass a number, or run `ggh pr create`.");
        return;
      }

      if (getFlags().json) {
        emitJson(detail);
        return;
      }

      header(`Pull Request #${detail.number}`);
      p.log.step(pc.bold(detail.title));
      p.log.message(`  State:    ${stateColor(detail.state)}${detail.isDraft ? pc.dim(" (draft)") : ""}`);
      p.log.message(`  Author:   ${pc.cyan(detail.author?.login ?? "unknown")}`);
      p.log.message(`  Branches: ${pc.cyan(detail.headRefName)} → ${pc.cyan(detail.baseRefName)}`);
      p.log.message(
        `  Size:     ${pc.green("+" + detail.additions)} ${pc.red("-" + detail.deletions)} across ${detail.changedFiles} file(s)`,
      );
      p.log.message(`  Review:   ${detail.reviewDecision ? pc.bold(detail.reviewDecision) : pc.dim("none yet")}`);
      p.log.message(`  Mergeable:${detail.mergeable === "MERGEABLE" ? pc.green(" yes") : pc.yellow(" " + detail.mergeable.toLowerCase())}`);
      if (detail.labels?.length) {
        p.log.message(`  Labels:   ${detail.labels.map((l) => pc.cyan(l.name)).join(", ")}`);
      }
      if (detail.body?.trim()) {
        p.note(detail.body.trim().slice(0, 2000), "Description");
      }
      p.outro(pc.dim(detail.url));
    });

  pr.command("merge [prNumber]")
    .description("Merge a Pull Request and clean up the branch")
    .option("-s, --squash", "Squash and merge")
    .option("-r, --rebase", "Rebase and merge")
    .option("-m, --merge", "Create a merge commit")
    .option("--auto", "Merge automatically once required checks pass")
    .option("--delete-branch", "Delete the head branch after merging", true)
    .option("--no-delete-branch", "Keep the head branch after merging")
    .option("-y, --yes", "Skip the confirmation prompt")
    .action(async (prNumber?: string, options?: {
      squash?: boolean; rebase?: boolean; merge?: boolean; auto?: boolean;
      deleteBranch?: boolean; yes?: boolean;
    }) => {
      header("Merge Pull Request");
      const num = await resolvePrNumber(prNumber);
      if (num === null) return;

      const detail = await viewPullRequest(num);
      if (detail) {
        p.log.step(`#${detail.number} ${pc.bold(detail.title)}`);
        p.log.message(`  ${pc.cyan(detail.headRefName)} → ${pc.cyan(detail.baseRefName)} · ${stateColor(detail.state)}`);
        if (detail.state.toUpperCase() !== "OPEN") {
          fail(`Pull Request #${num} is ${detail.state.toLowerCase()}, not open.`);
          return;
        }
      }

      let method: MergeOptions["method"] | null = options?.squash
        ? "squash"
        : options?.rebase
          ? "rebase"
          : options?.merge
            ? "merge"
            : null;

      if (!method) {
        method = (await selectMenu<MergeOptions["method"]>({
          message: "How should this Pull Request be merged?",
          options: [
            { value: "squash", label: "Squash and merge", hint: "one commit on the base branch" },
            { value: "merge", label: "Create a merge commit", hint: "keeps every commit" },
            { value: "rebase", label: "Rebase and merge", hint: "replays commits, no merge commit" },
          ],
          initialValue: "squash",
        })) as MergeOptions["method"] | null;
        if (!method) {
          p.cancel("Merge cancelled.");
          return;
        }
      }

      if (isDryRun()) {
        p.log.warn(
          `${pc.yellow("dry run")} ${pc.dim("·")} would ${method}-merge #${num}` +
            (options?.deleteBranch === false ? "" : " and delete the head branch"),
        );
        return;
      }

      const confirmed = await confirmPrompt({
        message: `${method === "squash" ? "Squash" : method === "rebase" ? "Rebase" : "Merge"} Pull Request #${num}?`,
        initialValue: true,
        assumeYes: options?.yes,
      });
      if (!confirmed) {
        p.cancel("Merge cancelled.");
        return;
      }

      const s = p.spinner();
      s.start(`Merging #${num}...`);
      try {
        const out = await mergePullRequest(num, {
          method,
          deleteBranch: options?.deleteBranch !== false,
          auto: options?.auto,
        });
        s.stop(pc.green(options?.auto ? `Auto-merge armed for #${num}.` : `Pull Request #${num} merged.`));
        if (out) p.log.message(pc.dim(out));
        p.outro("Done.");
      } catch (err) {
        s.stop(pc.red("Merge failed."));
        fail(String(err));
      }
    });

  for (const [name, description, verb] of [
    ["ready", "Mark a draft Pull Request as ready for review", "mark as ready"],
    ["close", "Close a Pull Request without merging", "close"],
    ["reopen", "Reopen a closed Pull Request", "reopen"],
  ] as const) {
    pr.command(`${name} [prNumber]`)
      .description(description)
      .option("-y, --yes", "Skip the confirmation prompt")
      .action(async (prNumber?: string, options?: { yes?: boolean }) => {
        header(`${name[0].toUpperCase()}${name.slice(1)} Pull Request`);
        const num = await resolvePrNumber(prNumber);
        if (num === null) return;

        if (isDryRun()) {
          p.log.warn(`${pc.yellow("dry run")} ${pc.dim("·")} would ${verb} #${num}`);
          return;
        }

        const confirmed = await confirmPrompt({
          message: `${verb[0].toUpperCase()}${verb.slice(1)} Pull Request #${num}?`,
          initialValue: true,
          assumeYes: options?.yes,
        });
        if (!confirmed) {
          p.cancel("Cancelled.");
          return;
        }

        try {
          await setPullRequestState(name, num);
          p.log.success(pc.green(`Pull Request #${num} ${name === "ready" ? "is ready for review" : name + "d"}.`));
          p.outro("Done.");
        } catch (err) {
          fail(String(err));
        }
      });
  }

  pr.command("comment [prNumber]")
    .description("Add a comment to a Pull Request")
    .option("-b, --body <body>", "Comment body")
    .action(async (prNumber?: string, options?: { body?: string }) => {
      header("Comment on Pull Request");
      const num = await resolvePrNumber(prNumber);
      if (num === null) return;

      let body = options?.body;
      if (!body) {
        const typed = await promptInput({
          message: "Comment:",
          validate: (v) => (!v || !v.trim() ? "Comment cannot be empty" : undefined),
        });
        if (!typed) {
          p.cancel("Cancelled.");
          return;
        }
        body = typed;
      }

      if (isDryRun()) {
        p.log.warn(`${pc.yellow("dry run")} ${pc.dim("·")} would comment on #${num}`);
        return;
      }

      try {
        const url = await commentOnPullRequest(num, body);
        p.log.success(pc.green("Comment posted."));
        if (url) p.log.message(pc.dim(url));
        p.outro("Done.");
      } catch (err) {
        fail(String(err));
      }
    });

  pr.command("edit [prNumber]")
    .description("Edit a Pull Request title, body, or base branch")
    .option("-t, --title <title>", "New title")
    .option("-b, --body <body>", "New body")
    .option("--base <branch>", "Retarget onto a different base branch")
    .option("--add-label <label...>", "Add labels")
    .action(async (prNumber?: string, options?: {
      title?: string; body?: string; base?: string; addLabel?: string[];
    }) => {
      header("Edit Pull Request");
      const num = await resolvePrNumber(prNumber);
      if (num === null) return;

      if (!options?.title && !options?.body && !options?.base && !options?.addLabel?.length) {
        fail("Nothing to change. Pass --title, --body, --base, or --add-label.");
        return;
      }

      if (isDryRun()) {
        p.log.warn(`${pc.yellow("dry run")} ${pc.dim("·")} would edit #${num}`);
        return;
      }

      try {
        await editPullRequest(num, options);
        p.log.success(pc.green(`Pull Request #${num} updated.`));
        p.outro("Done.");
      } catch (err) {
        fail(String(err));
      }
    });
}
