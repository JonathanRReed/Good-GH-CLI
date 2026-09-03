import { Command } from "commander";
import {
  commentOnIssue,
  createIssue,
  getGitHubAuthStatus,
  listIssues,
  setIssueState,
  viewIssue,
} from "../services/github.ts";
import { isGitRepo, switchBranch } from "../services/git.ts";
import { generateBranchNameWithFallback } from "../services/ai/index.ts";
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
  searchablePicker,
  selectMenu,
} from "../utils/ui.ts";

async function requireAuth(): Promise<boolean> {
  const auth = await getGitHubAuthStatus();
  if (auth.authenticated) return true;
  fail(
    auth.notInstalled
      ? "GitHub CLI (`gh`) is not installed. Install it from https://cli.github.com."
      : "GitHub CLI is not authenticated. Run `gh auth login`.",
  );
  return false;
}

function stateTag(state: string): string {
  return state.toUpperCase() === "OPEN" ? pc.green("open") : pc.magenta("closed");
}

export function registerIssueCommand(program: Command): void {
  const issue = program
    .command("issue [issueNumber]")
    .alias("issues")
    .description("Browse, read, open, and close issues")
    .option("-s, --state <state>", "Filter by state: open, closed, all", "open")
    .option("-a, --assignee <user>", "Filter by assignee (use @me for your own)")
    .option("-l, --label <label>", "Filter by label")
    .option("--limit <n>", "Maximum issues to list", "30")
    .action(async (issueNumber?: string, options?: {
      state?: string; assignee?: string; label?: string; limit?: string;
    }) => {
      header("GitHub Issues");
      if (!(await requireAuth())) return;

      if (issueNumber) {
        const num = Number.parseInt(issueNumber, 10);
        if (Number.isNaN(num)) {
          fail(`Invalid issue number: ${issueNumber}`);
          return;
        }
        await showIssue(num);
        return;
      }

      const s = p.spinner();
      s.start("Fetching issues...");
      const issues = await listIssues({
        limit: Number.parseInt(options?.limit ?? "30", 10) || 30,
        state: options?.state,
        assignee: options?.assignee,
        label: options?.label,
      });
      s.stop(`Loaded ${pc.green(String(issues.length))} issue(s).`);

      if (getFlags().json) {
        emitJson(issues);
        return;
      }

      if (issues.length === 0) {
        p.log.info(pc.dim("No issues matched."));
        return;
      }

      const picked = await searchablePicker<number>({
        title: "Select an issue:",
        items: issues.map((i) => ({
          value: i.number,
          label: `#${i.number} ${i.title}`,
          hint: `${i.state.toLowerCase()} · @${i.author?.login ?? "unknown"}${
            i.labels?.length ? " · " + i.labels.map((l) => l.name).join(", ") : ""
          }`,
        })),
        pageSize: 10,
      });
      if (!picked) {
        p.cancel("Cancelled.");
        return;
      }
      await showIssue(picked);
    });

  async function showIssue(num: number): Promise<void> {
    const detail = await viewIssue(num);
    if (!detail) {
      fail(`Issue #${num} not found.`);
      return;
    }

    if (getFlags().json) {
      emitJson(detail);
      return;
    }

    p.log.step(`#${detail.number} ${pc.bold(detail.title)}`);
    p.log.message(`  State:  ${stateTag(detail.state)}`);
    p.log.message(`  Author: ${pc.cyan(detail.author?.login ?? "unknown")}`);
    if (detail.labels?.length) {
      p.log.message(`  Labels: ${detail.labels.map((l) => pc.cyan(l.name)).join(", ")}`);
    }
    if (detail.body?.trim()) {
      p.note(detail.body.trim().slice(0, 2000), "Description");
    }
    if (detail.comments?.length) {
      p.log.step(`${detail.comments.length} comment(s):`);
      for (const c of detail.comments.slice(-3)) {
        p.log.message(`  ${pc.cyan("@" + c.author.login)} ${pc.dim(c.createdAt.slice(0, 10))}`);
        p.log.message(`    ${c.body.trim().split("\n").slice(0, 4).join("\n    ")}`);
      }
    }
    p.outro(pc.dim(detail.url));
  }

  issue.command("create")
    .description("Open a new issue")
    .option("-t, --title <title>", "Issue title")
    .option("-b, --body <body>", "Issue body")
    .option("-l, --label <label...>", "Labels to apply")
    .option("-a, --assignee <user>", "Assign to a user")
    .action(async (options: { title?: string; body?: string; label?: string[]; assignee?: string }) => {
      header("Create Issue");
      if (!(await requireAuth())) return;

      let title = options.title;
      if (!title) {
        const typed = await promptInput({
          message: "Issue title:",
          validate: (v) => (!v || !v.trim() ? "Title required" : undefined),
        });
        if (!typed) {
          p.cancel("Cancelled.");
          return;
        }
        title = typed;
      }

      let body = options.body;
      if (body === undefined) {
        const typed = await promptInput({ message: "Issue body (optional):" });
        if (typed === null) {
          p.cancel("Cancelled.");
          return;
        }
        body = typed;
      }

      if (isDryRun()) {
        p.log.warn(`${pc.yellow("dry run")} ${pc.dim("·")} would open an issue titled "${title}"`);
        return;
      }

      const s = p.spinner();
      s.start("Opening issue...");
      try {
        const url = await createIssue({ title, body, labels: options.label, assignee: options.assignee });
        s.stop(pc.green("Issue opened."));
        if (getFlags().json) {
          emitJson({ url, title, body });
          return;
        }
        p.log.success(pc.bold(pc.cyan(url)));
        p.outro("Done.");
      } catch (err) {
        s.stop(pc.red("Failed to open the issue."));
        fail(String(err));
      }
    });

  for (const action of ["close", "reopen"] as const) {
    issue.command(`${action} <issueNumber>`)
      .description(`${action === "close" ? "Close" : "Reopen"} an issue`)
      .option("-y, --yes", "Skip the confirmation prompt")
      .action(async (issueNumber: string, options?: { yes?: boolean }) => {
        header(`${action === "close" ? "Close" : "Reopen"} Issue`);
        if (!(await requireAuth())) return;

        const num = Number.parseInt(issueNumber, 10);
        if (Number.isNaN(num)) {
          fail(`Invalid issue number: ${issueNumber}`);
          return;
        }

        if (isDryRun()) {
          p.log.warn(`${pc.yellow("dry run")} ${pc.dim("·")} would ${action} issue #${num}`);
          return;
        }

        const confirmed = await confirmPrompt({
          message: `${action === "close" ? "Close" : "Reopen"} issue #${num}?`,
          initialValue: true,
          assumeYes: options?.yes,
        });
        if (!confirmed) {
          p.cancel("Cancelled.");
          return;
        }

        try {
          await setIssueState(action, num);
          p.log.success(pc.green(`Issue #${num} ${action}d.`));
          p.outro("Done.");
        } catch (err) {
          fail(String(err));
        }
      });
  }

  issue.command("comment <issueNumber>")
    .description("Add a comment to an issue")
    .option("-b, --body <body>", "Comment body")
    .action(async (issueNumber: string, options?: { body?: string }) => {
      header("Comment on Issue");
      if (!(await requireAuth())) return;

      const num = Number.parseInt(issueNumber, 10);
      if (Number.isNaN(num)) {
        fail(`Invalid issue number: ${issueNumber}`);
        return;
      }

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
        p.log.warn(`${pc.yellow("dry run")} ${pc.dim("·")} would comment on issue #${num}`);
        return;
      }

      try {
        const url = await commentOnIssue(num, body);
        p.log.success(pc.green("Comment posted."));
        if (url) p.log.message(pc.dim(url));
        p.outro("Done.");
      } catch (err) {
        fail(String(err));
      }
    });

  issue.command("develop <issueNumber>")
    .description("Create and switch to a branch for an issue, named from its title")
    .option("--base <branch>", "Base branch to branch from")
    .action(async (issueNumber: string, options?: { base?: string }) => {
      header("Start Work on Issue");
      if (!(await isGitRepo())) {
        fail("Not a git repository.");
        return;
      }
      if (!(await requireAuth())) return;

      const num = Number.parseInt(issueNumber, 10);
      if (Number.isNaN(num)) {
        fail(`Invalid issue number: ${issueNumber}`);
        return;
      }

      const detail = await viewIssue(num);
      if (!detail) {
        fail(`Issue #${num} not found.`);
        return;
      }

      p.log.step(`#${detail.number} ${pc.bold(detail.title)}`);

      // Ask AI for a semantic name, but always fall back to a deterministic slug.
      let branch = `${num}-${detail.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)}`;
      const s = p.spinner();
      s.start("Naming the branch...");
      try {
        const { result } = await generateBranchNameWithFallback(`${detail.title}\n\n${detail.body ?? ""}`.slice(0, 2000));
        s.stop("Branch name suggested.");
        branch = result;
      } catch {
        s.stop(pc.dim(`Using a slug from the issue title.`));
      }

      const chosen = await selectMenu<string>({
        message: "Branch name:",
        options: [
          { value: branch, label: branch, hint: "suggested" },
          { value: `issue-${num}`, label: `issue-${num}`, hint: "plain" },
        ],
        initialValue: branch,
      });
      if (!chosen) {
        p.cancel("Cancelled.");
        return;
      }

      if (isDryRun()) {
        p.log.warn(`${pc.yellow("dry run")} ${pc.dim("·")} would create branch ${chosen} for issue #${num}`);
        return;
      }

      try {
        await switchBranch(chosen, true, process.cwd(), options?.base);
        p.log.success(pc.green(`Switched to ${pc.bold(pc.cyan(chosen))}.`));
        p.log.info(pc.dim(`Commit with \`ggh c -i ${num}\` to link the work back to the issue.`));
        p.outro("Done.");
      } catch (err) {
        fail(String(err));
      }
    });
}
