import type { Command } from "commander";
import { getFlags } from "../services/runtime.ts";
import {
  commentOnPullRequest,
  editPullRequest,
  getActivePullRequest,
  getCurrentRepositoryNameWithOwner,
  getPullRequestUrl,
  mergePullRequest,
  parseRepoFlag,
  setPullRequestState,
  viewPullRequest,
  type MergeOptions,
} from "../services/github.ts";
import { dryRun } from "../utils/flags.ts";
import {
  confirmOrAbort,  jsonOut,
  fail,
  failFromGitHub,
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
      fail(`Invalid PR number: ${arg}`);
      return null;
    }
    return parsed;
  }
  const active = await getActivePullRequest();
  if (!active) {
    fail("No PR found for the current branch. Pass a number, or run `ggh pr create`.");
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

async function repoForUrl(): Promise<string | null> {
  const parsed = parseRepoFlag();
  if (parsed) return parsed.nameWithOwner;
  try {
    return await getCurrentRepositoryNameWithOwner();
  } catch {
    return null;
  }
}

export function registerPrLifecycleCommands(pr: Command): void {
  pr.command("view [prNumber]")
    .description("Show a Pull Request: state, review decision, size, and body")
    .action(async (prNumber?: string) => {
      const num = prNumber ? Number.parseInt(prNumber, 10) : undefined;
      let detail;
      try {
        detail = await viewPullRequest(Number.isNaN(num as number) ? undefined : num);
      } catch (err) {
        failFromGitHub(err);
        return;
      }
      if (!detail) {
        fail("No PR found for the current branch. Pass a number, or run `ggh pr create`.");
        return;
      }

      if (jsonOut(detail)) return;

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
      const bodyTrimmed = detail.body?.trim();
      if (bodyTrimmed) {
        p.note(bodyTrimmed.slice(0, 2000), "Description");
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

      let detail;
      try {
        detail = await viewPullRequest(num);
      } catch (err) {
        failFromGitHub(err);
        return;
      }
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

      if (dryRun(
        `${method}-merge #${num}` +
          (options?.deleteBranch === false ? "" : " and delete the head branch"),
      )) return;

      if (!(await confirmOrAbort(`${method === "squash" ? "Squash" : method === "rebase" ? "Rebase" : "Merge"} Pull Request #${num}?`, { assumeYes: options?.yes, cancelText: "Merge cancelled." }))) return;

      const s = p.spinner();
      s.start(`Merging #${num}...`);
      try {
        const url = await mergePullRequest(num, {
          method,
          deleteBranch: options?.deleteBranch !== false,
          auto: options?.auto,
        });
        s.stop(pc.green(options?.auto ? `Auto-merge armed for #${num}.` : `Pull Request #${num} merged.`));
        if (url) p.log.message(pc.dim(url));
                  const repo = getFlags().json ? await repoForUrl() : null;
          if (jsonOut({ number: num, action: "merge", url: repo ? getPullRequestUrl(repo, num) : url })) return;
        p.outro("Done.");
      } catch (err) {
        s.stop(pc.red("Merge failed."));
        failFromGitHub(err);
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
        header(`${name.charAt(0).toUpperCase()}${name.slice(1)} Pull Request`);
        const num = await resolvePrNumber(prNumber);
        if (num === null) return;

        if (dryRun(`${verb} #${num}`)) return;

        if (!(await confirmOrAbort(`${verb.charAt(0).toUpperCase()}${verb.slice(1)} Pull Request #${num}?`, { assumeYes: options?.yes }))) return;

        const s = p.spinner();
        s.start(`${name} #${num}...`);
        try {
          const output = await setPullRequestState(name, num);
          s.stop(pc.green(`Pull Request #${num} ${name === "ready" ? "is ready for review" : name + "d"}.`));
          if (output) p.log.message(pc.dim(output));
                      const repo = getFlags().json ? await repoForUrl() : null;
            if (jsonOut({ number: num, action: name, url: repo ? getPullRequestUrl(repo, num) : output })) return;
          p.outro("Done.");
        } catch (err) {
          s.stop(pc.red("Failed."));
          failFromGitHub(err);
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

      if (dryRun(`comment on #${num}`)) return;

      try {
        const url = await commentOnPullRequest(num, body);
        p.log.success(pc.green("Comment posted."));
        if (url) p.log.message(pc.dim(url));
        if (jsonOut({ number: num, action: "comment", url })) return;
        p.outro("Done.");
      } catch (err) {
        failFromGitHub(err);
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

      if (dryRun(`edit #${num}`)) return;

      try {
        await editPullRequest(num, options);
        p.log.success(pc.green(`Pull Request #${num} updated.`));
                  const repo = getFlags().json ? await repoForUrl() : null;
          if (jsonOut({ number: num, action: "edit", url: repo ? getPullRequestUrl(repo, num) : undefined })) return;
        p.outro("Done.");
      } catch (err) {
        failFromGitHub(err);
      }
    });
}
