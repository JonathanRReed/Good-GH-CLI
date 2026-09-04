import { Command } from "commander";
import { getFlags } from "../services/runtime.ts";
import {
  commentOnIssue,
  createIssue,
  getCurrentRepositoryNameWithOwner,
  getIssueUrl,
  gh,
  listIssues,
  requireAuth,
  setIssueState,
  viewIssue,
} from "../services/github.ts";
import { requireGitRepo, switchBranch } from "../services/git.ts";
import { getStagedDiff, getStagedDiffStat, getStatus } from "../services/git.ts";
import {
  type AIAttempt,
  type AIAttemptFailure,
  generateBranchNameWithFallback,
  generateIssueBodyWithFallback,
  generateIssueFromDiffWithFallback,
} from "../services/ai/index.ts";
import type { AIProvider as ConfigAIProvider } from "../services/config.ts";
import { invalidateCache } from "../services/cache.ts";
import { dryRun, isDryRun } from "../utils/flags.ts";
import { sanitizeDiffForAI, sanitizeForAI } from "../utils/diff.ts";
import {
  confirmOrAbort, jsonOut,
  emitJson,
  fail,
  failFromGitHub,
  formatAIFallback,
  header,
  p,
  pc,
  promptInput,
  reportAIFailure,
  searchablePicker,
  selectMenu,
} from "../utils/ui.ts";

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
    .option("--author <user>", "Filter by author (use @me for your own)")
    .option("-l, --label <label>", "Filter by label")
    .option("--search <query>", "Filter with a search query")
    .option("--mine", "Show only issues authored by you")
    .option("--limit <n>", "Maximum issues to list", "30")
    .action(async (issueNumber?: string, options?: {
      state?: string; assignee?: string; author?: string; label?: string;
      search?: string; mine?: boolean; limit?: string;
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

      // Read-only: --dry-run does not block listing.
      const s = p.spinner();
      s.start("Fetching issues...");
      let issues: Awaited<ReturnType<typeof listIssues>>;
      try {
        issues = await listIssues({
          limit: Number.parseInt(options?.limit ?? "30", 10) || 30,
          state: options?.state,
          assignee: options?.assignee,
          author: options?.mine ? "@me" : options?.author,
          label: options?.label,
          search: options?.search,
        });
        s.stop(`Loaded ${pc.green(String(issues.length))} issue(s).`);
      } catch (err) {
        s.stop(pc.red("Failed to fetch issues."));
        failFromGitHub(err);
        return;
      }

      if (jsonOut(issues)) return;

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
    let detail;
    try {
      detail = await viewIssue(num);
    } catch (err) {
      failFromGitHub(err);
      return;
    }
    if (!detail) {
      fail(`Issue #${num} not found.`);
      return;
    }

    if (jsonOut(detail)) return;

    p.log.step(`#${detail.number} ${pc.bold(detail.title)}`);
    p.log.message(`  State:  ${stateTag(detail.state)}`);
    p.log.message(`  Author: ${pc.cyan(detail.author?.login ?? "unknown")}`);
    if (detail.labels?.length) {
      p.log.message(`  Labels: ${detail.labels.map((l) => pc.cyan(l.name)).join(", ")}`);
    }
    const bodyTrimmed = detail.body?.trim();
    if (bodyTrimmed) {
      p.note(bodyTrimmed.slice(0, 2000), "Description");
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
    .option("--ai", "Generate the issue body with AI from the title (and optional --notes)")
    .option("--from-diff", "Generate both title and body from the current uncommitted diff (implies --ai)")
    .option("-n, --notes <notes>", "Reporter notes to steer AI body generation")
    .option("--provider <provider>", "AI provider to use (codex, grok, claude, ollama)")
    .action(async (options: {
      title?: string;
      body?: string;
      label?: string[];
      assignee?: string;
      ai?: boolean;
      fromDiff?: boolean;
      notes?: string;
      provider?: string;
    }) => {
      header("Create Issue");
      if (!(await requireAuth())) return;

      let title = options.title;

      // --from-diff: generate both title and body from the current diff.
      if (options.fromDiff) {
        if (!(await requireGitRepo())) return;
        const diffStatus = await getStatus();
        const hasChanges = diffStatus.staged.length > 0 || diffStatus.unstaged.length > 0;
        if (!hasChanges) {
          fail("No uncommitted changes to generate an issue from.");
          return;
        }

        if (dryRun("generate and open an issue from diff with AI")) return;

        const [rawDiff, diffStat] = await Promise.all([getStagedDiff(), getStagedDiffStat()]);
        const { diff: sanitizedDiff, redactedCount } = sanitizeDiffForAI(rawDiff);
        if (redactedCount > 0) {
          p.log.warn(pc.yellow(`Redacted ${redactedCount} potential secret(s) from diff sent to AI.`));
        }

        const s = p.spinner();
        s.start("Generating issue from diff with AI...");
        try {
          const { result: aiResult, providerName, model: activeModel, failures } =
            await generateIssueFromDiffWithFallback(
              {
                diff: sanitizedDiff,
                diffStat,
                branch: diffStatus.branch,
                notes: options.notes ? sanitizeForAI(options.notes).text : undefined,
              },
              options.provider as ConfigAIProvider | undefined,
              (failure: AIAttemptFailure, next?: AIAttempt) => {
                s.message(formatAIFallback(failure, next));
              },
            );
          s.stop(`Issue generated by ${pc.bold(providerName)} [${pc.cyan(activeModel)}].`);
          for (const failure of failures) {
            p.log.info(pc.dim(`Skipped ${failure.providerName} [${failure.model}]: ${failure.reason}`));
          }

          title = aiResult.title;
          p.note(`${pc.bold(title)}\n${aiResult.body ? pc.dim(`\n${aiResult.body}`) : ""}`, "Proposed Issue");

          if (getFlags().json) {
            // In JSON mode, skip the interactive flow and open directly.
            const url = await createIssue({ title, body: aiResult.body, labels: options.label, assignee: options.assignee });
            emitJson({ number: 0, action: "create", url, title, body: aiResult.body });
            return;
          }

          const action = await selectMenu<string>({
            message: "Use this issue?",
            options: [
              { value: "use", label: "Open the issue", hint: "accept" },
              { value: "edit", label: "Edit title or body", hint: "refine" },
              { value: "cancel", label: "Cancel", hint: "abort" },
            ],
            initialValue: "use",
          });
          if (!action || action === "cancel") {
            p.cancel("Cancelled.");
            return;
          }
          if (action === "edit") {
            const editedTitle = await promptInput({ message: "Issue title:", initialValue: title });
            if (!editedTitle) {
              p.cancel("Cancelled.");
              return;
            }
            title = editedTitle;
            const editedBody = await promptInput({ message: "Issue body:", initialValue: aiResult.body });
            if (editedBody === null) {
              p.cancel("Cancelled.");
              return;
            }
            // Skip the rest of the AI flow and go straight to opening.
            if (dryRun(`open an issue titled "${title}"`)) return;
            const openSpinner = p.spinner();
            openSpinner.start("Opening issue...");
            try {
              const url = await createIssue({ title, body: editedBody, labels: options.label, assignee: options.assignee });
              openSpinner.stop(pc.green("Issue opened."));
              p.log.success(pc.bold(pc.cyan(url)));
              p.outro("Done.");
            } catch (err) {
              openSpinner.stop(pc.red("Failed to open the issue."));
              failFromGitHub(err);
            }
            return;
          }

          // "use" — open with the AI-generated title and body.
          if (dryRun(`open an issue titled "${title}"`)) return;
          const openSpinner = p.spinner();
          openSpinner.start("Opening issue...");
          try {
            const url = await createIssue({ title, body: aiResult.body, labels: options.label, assignee: options.assignee });
            openSpinner.stop(pc.green("Issue opened."));
            p.log.success(pc.bold(pc.cyan(url)));
            p.outro("Done.");
          } catch (err) {
            openSpinner.stop(pc.red("Failed to open the issue."));
            failFromGitHub(err);
          }
          return;
        } catch (err) {
          s.stop(pc.yellow("AI issue generation failed."));
          reportAIFailure(err, "Every configured AI provider and model failed:");
          p.log.info("Falling back to manual input.");
        }
      }
      if (!title) {
        if (isDryRun()) {
          title = options.title ?? "<untitled>";
        } else {
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
      }

      let body = options.body;
      if (body === undefined && !options.ai) {
        if (isDryRun()) {
          body = "";
        } else {
          const typed = await promptInput({ message: "Issue body (optional):" });
          if (typed === null) {
            p.cancel("Cancelled.");
            return;
          }
          body = typed;
        }
      }

      if (options.ai && body === undefined) {
        if (dryRun(`generate and open an issue titled "${title}" with AI`)) return;
        let notes = options.notes;
        if (notes === undefined) {
          const typed = await promptInput({
            message: "Notes for the AI (optional — what to emphasize, repro steps, etc.):",
          });
          if (typed === null) {
            p.cancel("Cancelled.");
            return;
          }
          notes = typed;
        }

        const sanitizedNotes = notes ? sanitizeForAI(notes) : undefined;
        if (sanitizedNotes?.redactedCount) {
          p.log.info(pc.dim(`${sanitizedNotes.redactedCount} secret-like value(s) redacted before sending to AI.`));
        }

        let repo: string | undefined;
        try {
          repo = (await getCurrentRepositoryNameWithOwner()) ?? undefined;
        } catch {
          repo = undefined;
        }

        const s = p.spinner();
        s.start("Generating issue body with AI...");
        try {
          const { result: aiBody, providerName, model: activeModel, failures } =
            await generateIssueBodyWithFallback(
              {
                title,
                notes: sanitizedNotes?.text,
                repo,
              },
              options.provider as ConfigAIProvider | undefined,
              (failure: AIAttemptFailure, next?: AIAttempt) => {
                s.message(formatAIFallback(failure, next));
              },
            );
          s.stop(`Issue body generated by ${pc.bold(providerName)} [${pc.cyan(activeModel)}].`);
          for (const failure of failures) {
            p.log.info(pc.dim(`Skipped ${failure.providerName} [${failure.model}]: ${failure.reason}`));
          }

          if (getFlags().json) {
            body = aiBody;
          } else {
            p.note(aiBody, "Proposed Issue Body");
            const action = await selectMenu<string>({
              message: "Use this body?",
              options: [
                { value: "use", label: "Open the issue with this body", hint: "accept" },
                { value: "edit", label: "Edit before opening", hint: "refine" },
                { value: "regenerate", label: "Regenerate with new notes", hint: "retry" },
                { value: "cancel", label: "Cancel", hint: "abort" },
              ],
              initialValue: "use",
            });
            if (!action || action === "cancel") {
              p.cancel("Cancelled.");
              return;
            }
            if (action === "edit") {
              const edited = await promptInput({
                message: "Issue body (edit — press Enter to keep the AI draft):",
                initialValue: aiBody,
              });
              if (edited === null) {
                p.cancel("Cancelled.");
                return;
              }
              body = edited;
            } else if (action === "regenerate") {
              const newNotes = await promptInput({
                message: "New notes for the AI:",
              });
              if (newNotes === null) {
                p.cancel("Cancelled.");
                return;
              }
              const reSanitized = newNotes ? sanitizeForAI(newNotes) : undefined;
              if (reSanitized?.redactedCount) {
                p.log.info(pc.dim(`${reSanitized.redactedCount} secret-like value(s) redacted before sending to AI.`));
              }
              s.start("Regenerating issue body with AI...");
              try {
                const { result: retryBody } = await generateIssueBodyWithFallback(
                  { title, notes: reSanitized?.text, repo },
                  options.provider as ConfigAIProvider | undefined,
                  (failure: AIAttemptFailure, next?: AIAttempt) => {
                    s.message(formatAIFallback(failure, next));
                  },
                );
                s.stop("Issue body regenerated.");
                p.note(retryBody, "Proposed Issue Body");
                const confirm = await selectMenu<string>({
                  message: "Use this body?",
                  options: [
                    { value: "use", label: "Open the issue with this body", hint: "accept" },
                    { value: "edit", label: "Edit before opening", hint: "refine" },
                    { value: "cancel", label: "Cancel", hint: "abort" },
                  ],
                  initialValue: "use",
                });
                if (!confirm || confirm === "cancel") {
                  p.cancel("Cancelled.");
                  return;
                }
                if (confirm === "edit") {
                  const edited2 = await promptInput({
                    message: "Issue body (edit — press Enter to keep the AI draft):",
                    initialValue: retryBody,
                  });
                  if (edited2 === null) {
                    p.cancel("Cancelled.");
                    return;
                  }
                  body = edited2;
                } else {
                  body = retryBody;
                }
              } catch (err) {
                s.stop(pc.yellow("AI issue body regeneration failed."));
                reportAIFailure(err, "Every configured AI provider and model failed:");
                p.log.info("Falling back to a manual body.");
                const typed = await promptInput({ message: "Issue body (optional):" });
                if (typed === null) {
                  p.cancel("Cancelled.");
                  return;
                }
                body = typed;
              }
            } else {
              body = aiBody;
            }
          }
        } catch (err) {
          s.stop(pc.yellow("AI issue body generation failed."));
          reportAIFailure(err, "Every configured AI provider and model failed:");
          p.log.info("Falling back to a manual body.");
          const typed = await promptInput({ message: "Issue body (optional):" });
          if (typed === null) {
            p.cancel("Cancelled.");
            return;
          }
          body = typed;
        }
      }

      if (dryRun(`open an issue titled "${title}"`)) return;

      const s = p.spinner();
      s.start("Opening issue...");
      try {
        const url = await createIssue({ title, body, labels: options.label, assignee: options.assignee });
        s.stop(pc.green("Issue opened."));
        if (jsonOut({ number: 0, action: "create", url, title, body })) return;
        p.log.success(pc.bold(pc.cyan(url)));
        p.outro("Done.");
      } catch (err) {
        s.stop(pc.red("Failed to open the issue."));
        failFromGitHub(err);
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

        if (dryRun(`${action} issue #${num}`)) return;

        if (!(await confirmOrAbort(`${action === "close" ? "Close" : "Reopen"} issue #${num}?`, { assumeYes: options?.yes }))) return;

        const s = p.spinner();
        s.start(`${action} issue #${num}...`);
        try {
          await setIssueState(action, num);
          s.stop(pc.green(`Issue #${num} ${action}d.`));
          if (getFlags().json) {
            const repo = await getCurrentRepositoryNameWithOwner();
            emitJson({ number: num, action, url: repo ? getIssueUrl(repo, num) : undefined });
            return;
          }
          p.outro("Done.");
        } catch (err) {
          s.stop(pc.red("Failed."));
          failFromGitHub(err);
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
        if (isDryRun()) {
          body = "";
        } else {
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
      }

    if (dryRun(`comment on issue #${num}`)) return;

      try {
        const url = await commentOnIssue(num, body);
        p.log.success(pc.green("Comment posted."));
        if (jsonOut({ number: num, action: "comment", url })) return;
        if (url) p.log.message(pc.dim(url));
        p.outro("Done.");
      } catch (err) {
        failFromGitHub(err);
      }
    });

  issue.command("develop <issueNumber>")
    .description("Create and switch to a branch for an issue, named from its title")
    .option("--base <branch>", "Base branch to branch from")
    .action(async (issueNumber: string, options?: { base?: string }) => {
      header("Start Work on Issue");
      const [isRepo, authed] = await Promise.all([requireGitRepo(), requireAuth()]);
      if (!isRepo || !authed) return;

      const num = Number.parseInt(issueNumber, 10);
      if (Number.isNaN(num)) {
        fail(`Invalid issue number: ${issueNumber}`);
        return;
      }

      let detail;
      try {
        detail = await viewIssue(num);
      } catch (err) {
        failFromGitHub(err);
        return;
      }
      if (!detail) {
        fail(`Issue #${num} not found.`);
        return;
      }

      p.log.step(`#${detail.number} ${pc.bold(detail.title)}`);

      const sanitized = sanitizeForAI(`${detail.title}\n\n${detail.body ?? ""}`.slice(0, 2000));
      if (sanitized.redactedCount > 0) {
        p.log.info(pc.dim(`${sanitized.redactedCount} secret-like value(s) redacted before sending to AI.`));
      }

      let branch = `${num}-${detail.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)}`;
      const s = p.spinner();
      s.start("Naming the branch...");
      try {
        const { result } = await generateBranchNameWithFallback(sanitized.text);
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

      if (dryRun(`create branch ${chosen} for issue #${num}`)) return;

      try {
        await switchBranch(chosen, true, process.cwd(), options?.base);
        p.log.success(pc.green(`Switched to ${pc.bold(pc.cyan(chosen))}.`));
        p.log.info(pc.dim(`Commit with \`ggh c -i ${num}\` to link the work back to the issue.`));
        p.outro("Done.");
      } catch (err) {
        failFromGitHub(err);
      }
    });

  issue.command("lock <issueNumber>")
    .description("Lock conversation on an issue")
    .option("-r, --reason <reason>", "Reason: off_topic, resolved, spam, too_heated")
    .option("-y, --yes", "Skip the confirmation prompt")
    .action(async (issueNumber: string, options?: { reason?: string; yes?: boolean }) => {
      await issueStateCommand("lock", issueNumber, options);
    });

  issue.command("unlock <issueNumber>")
    .description("Unlock conversation on an issue")
    .option("-y, --yes", "Skip the confirmation prompt")
    .action(async (issueNumber: string, options?: { yes?: boolean }) => {
      await issueStateCommand("unlock", issueNumber, options);
    });

  issue.command("pin <issueNumber>")
    .description("Pin an issue in a repository")
    .option("-y, --yes", "Skip the confirmation prompt")
    .action(async (issueNumber: string, options?: { yes?: boolean }) => {
      await issueStateCommand("pin", issueNumber, options);
    });

  issue.command("unpin <issueNumber>")
    .description("Unpin an issue in a repository")
    .option("-y, --yes", "Skip the confirmation prompt")
    .action(async (issueNumber: string, options?: { yes?: boolean }) => {
      await issueStateCommand("unpin", issueNumber, options);
    });

  issue.command("transfer <issueNumber> <destinationRepo>")
    .description("Transfer an issue to another repository")
    .option("-y, --yes", "Skip the confirmation prompt")
    .action(async (issueNumber: string, destinationRepo: string, options?: { yes?: boolean }) => {
      header("Transfer Issue");
      if (!(await requireAuth())) return;
      const num = Number.parseInt(issueNumber, 10);
      if (Number.isNaN(num)) {
        fail(`Invalid issue number: ${issueNumber}`);
        return;
      }

      if (dryRun(`transfer issue #${num} to ${destinationRepo}`)) return;

      if (!(await confirmOrAbort(`Transfer issue #${num} to ${pc.bold(destinationRepo)}?`, { assumeYes: options?.yes }))) return;

      const s = p.spinner();
      s.start(`Transferring issue #${num}...`);
      try {
        await gh(["issue", "transfer", String(num), destinationRepo]);
        invalidateCache("issue-list:");
        s.stop(pc.green("Issue transferred."));
      } catch (err) {
        s.stop(pc.red("Transfer failed."));
        failFromGitHub(err);
      }
    });

  issue.command("edit <issueNumber>")
    .description("Edit an issue title, body, or labels")
    .option("-t, --title <title>", "New title")
    .option("-b, --body <body>", "New body")
    .option("--add-label <label...>", "Add labels")
    .option("--remove-label <label...>", "Remove labels")
    .option("-a, --assignee <user>", "Set assignee")
    .action(async (issueNumber: string, options?: {
      title?: string; body?: string; addLabel?: string[]; removeLabel?: string[]; assignee?: string;
    }) => {
      header("Edit Issue");
      if (!(await requireAuth())) return;

      const num = Number.parseInt(issueNumber, 10);
      if (Number.isNaN(num)) {
        fail(`Invalid issue number: ${issueNumber}`);
        return;
      }

      if (!options?.title && !options?.body && !options?.addLabel?.length && !options?.removeLabel?.length && !options?.assignee) {
        fail("Nothing to change. Pass --title, --body, --add-label, --remove-label, or --assignee.");
        return;
      }

      if (dryRun(`edit issue #${num}`)) return;

      const args = ["issue", "edit", String(num)];
      let input: string | undefined;
      if (options?.title) args.push("--title", options.title);
      if (options?.body !== undefined) {
        args.push("--body-file", "-");
        input = options.body;
      }
      for (const label of options?.addLabel ?? []) args.push("--add-label", label);
      for (const label of options?.removeLabel ?? []) args.push("--remove-label", label);
      if (options?.assignee) args.push("--assignee", options.assignee);

      const s = p.spinner();
      s.start(`Editing issue #${num}...`);
      try {
        await gh(args, { input });
        invalidateCache("issue-list:");
        s.stop(pc.green("Issue updated."));
        if (getFlags().json) {
          const repo = await getCurrentRepositoryNameWithOwner();
          emitJson({ number: num, action: "edit", url: repo ? getIssueUrl(repo, num) : undefined });
          return;
        }
        p.outro("Done.");
      } catch (err) {
        s.stop(pc.red("Edit failed."));
        failFromGitHub(err);
      }
    });

  async function issueStateCommand(
    action: "lock" | "unlock" | "pin" | "unpin",
    issueNumber: string,
    options?: { reason?: string; yes?: boolean },
  ): Promise<void> {
    header(`${action.charAt(0).toUpperCase()}${action.slice(1)} Issue`);
    if (!(await requireAuth())) return;

    const num = Number.parseInt(issueNumber, 10);
    if (Number.isNaN(num)) {
      fail(`Invalid issue number: ${issueNumber}`);
      return;
    }

    if (dryRun(`${action} issue #${num}`)) return;

    if (!(await confirmOrAbort(`${action.charAt(0).toUpperCase()}${action.slice(1)} issue #${num}?`, { assumeYes: options?.yes }))) return;

    const args = ["issue", action, String(num)];
    if (action === "lock" && options?.reason) args.push("--reason", options.reason);

    const s = p.spinner();
    s.start(`${action} issue #${num}...`);
    try {
      await gh(args);
      invalidateCache("issue-list:");
      s.stop(pc.green(`Issue #${num} ${action}d.`));
    } catch (err) {
      s.stop(pc.red("Failed."));
      failFromGitHub(err);
    }
  }

}
