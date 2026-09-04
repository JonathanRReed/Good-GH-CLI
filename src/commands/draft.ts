import { Command } from "commander";
import { getFlags } from "../services/runtime.ts";
import {
  getStatus,
  requireGitRepo,
  stashDrop,
  stashList,
  stashPop,
  stashPush,
} from "../services/git.ts";
import {
  type AIAttempt,
  type AIAttemptFailure,
  generateCommitWithFallback,
} from "../services/ai/index.ts";
import type { AIProvider as ConfigAIProvider } from "../services/config.ts";
import { sanitizeDiffForAI } from "../utils/diff.ts";
import { dryRun, isDryRun } from "../utils/flags.ts";
import {
  confirmOrAbort, unknownAction, jsonOut,
  fail,
  formatAIFallback,
  header,
  p,
  pc,
  reportAIFailure,
  searchablePicker,
} from "../utils/ui.ts";

const DRAFT_PREFIX = "ggh-draft:";
const draftLabel = (msg: string) => msg.replace(DRAFT_PREFIX, "").trim();

export function registerDraftCommand(program: Command): void {
  const draft = program
    .command("draft [action]")
    .description("Stash uncommitted work with an AI-generated description, then restore it later")
    .option("--provider <provider>", "Override AI provider (codex, grok, claude, or ollama)")
    .option("-y, --yes", "Skip confirmation prompts")
    .addHelpText("after", `
Examples:
  ggh draft                   # save current changes (default action)
  ggh draft list --json
  ggh draft resume -y
  ggh draft drop --dry-run`)
    .action(async (action?: string, options?: { provider?: string; yes?: boolean }) => {
      header("Draft");

      if (!(await requireGitRepo())) return;

      const subcommand = action?.toLowerCase();

      if (subcommand === "list" || (!action && getFlags().json)) {
        await listDrafts();
        return;
      }

      if (subcommand === "resume" || subcommand === "pop") {
        await resumeDraft(options);
        return;
      }

      if (subcommand === "drop" || subcommand === "delete") {
        await dropDraft(options);
        return;
      }

      if (subcommand === "create" || !action) {
        // Default: create a new draft
        await createDraft(options);
        return;
      }

      unknownAction("draft", action, ["create", "list", "resume", "drop"]);
    });

  draft
    .command("create")
    .description("Save current changes as a draft with an AI-generated description")
    .option("--provider <provider>", "Override AI provider (codex, grok, claude, or ollama)")
    .option("-y, --yes", "Skip confirmation prompts")
    .action(async (options?: { provider?: string; yes?: boolean }) => {
      header("Draft");
      if (!(await requireGitRepo())) return;
      await createDraft(options);
    });

  draft
    .command("list")
    .description("Show saved drafts")
    .action(async () => {
      header("Draft");
      if (!(await requireGitRepo())) return;
      await listDrafts();
    });

  draft
    .command("resume")
    .alias("pop")
    .description("Restore a saved draft")
    .option("-y, --yes", "Skip confirmation prompts")
    .action(async (options?: { yes?: boolean }) => {
      header("Draft");
      if (!(await requireGitRepo())) return;
      await resumeDraft(options);
    });

  draft
    .command("drop")
    .alias("delete")
    .description("Delete a saved draft")
    .option("-y, --yes", "Skip confirmation prompts")
    .action(async (options?: { yes?: boolean }) => {
      header("Draft");
      if (!(await requireGitRepo())) return;
      await dropDraft(options);
    });

  async function createDraft(options?: { provider?: string; yes?: boolean }): Promise<void> {
    const status = await getStatus();
    const hasChanges = status.staged.length > 0 || status.unstaged.length > 0 || status.untracked.length > 0;
    if (!hasChanges) {
      p.log.info(pc.dim("No uncommitted changes to draft."));
      return;
    }

    if (dryRun("stash changes with an AI-generated description")) return;

    // Generate a description with AI from the current diff
    const { getStagedDiff } = await import("../services/git.ts");
    const rawDiff = await getStagedDiff();
    const { diff: sanitizedDiff, redactedCount } = sanitizeDiffForAI(rawDiff);
    if (redactedCount > 0) {
      p.log.warn(pc.yellow(`Redacted ${redactedCount} potential secret(s) from diff sent to AI.`));
    }

    let description = `draft on ${status.branch}`;
    const s = p.spinner();
    s.start("Generating draft description with AI...");
    try {
      const { result: aiResult } = await generateCommitWithFallback(
        {
          branch: status.branch,
          stagedFiles: status.staged,
          stagedDiff: sanitizedDiff,
          style: "concise",
        },
        options?.provider as ConfigAIProvider | undefined,
        (failure: AIAttemptFailure, next?: AIAttempt) => s.message(formatAIFallback(failure, next)),
      );
      s.stop("Draft description generated.");
      description = `${DRAFT_PREFIX} ${aiResult.subject}`;
    } catch (err) {
      s.stop(pc.yellow("AI description failed; using branch name instead."));
      reportAIFailure(err, "Could not generate a description:");
    }

    p.log.step(`Draft: ${pc.cyan(description)}`);

    if (!(await confirmOrAbort(`Stash changes as "${description}"?`, { assumeYes: options?.yes }))) return;

    const stashSpinner = p.spinner();
    stashSpinner.start("Stashing...");
    try {
      await stashPush(description);
      stashSpinner.stop(pc.green("Draft saved."));
      if (jsonOut({ action: "create", description })) return;
      p.log.info(pc.dim(`Restore with \`ggh draft resume\`.`));
      p.outro("Done.");
    } catch (err) {
      stashSpinner.stop(pc.red("Stash failed."));
      fail(String(err));
    }
  }

  async function listDrafts(): Promise<void> {
    const stashes = await stashList();
    const drafts = stashes.filter((s) => s.message.includes(DRAFT_PREFIX));

    if (jsonOut(drafts)) return;

    if (drafts.length === 0) {
      p.log.info(pc.dim("No drafts saved."));
      return;
    }

    p.log.step(`${drafts.length} draft(s):`);
    for (const d of drafts) {
      const desc = draftLabel(d.message);
      p.log.message(`  ${pc.bold(d.ref)} ${pc.cyan(desc)} ${pc.dim(d.date)}`);
    }
    p.outro(pc.dim("Restore with `ggh draft resume`, drop with `ggh draft drop`."));
  }

  async function resumeDraft(options?: { yes?: boolean }): Promise<void> {
    const stashes = await stashList();
    const drafts = stashes.filter((s) => s.message.includes(DRAFT_PREFIX));

    if (drafts.length === 0) {
      if (jsonOut([])) return;
      p.log.info(pc.dim("No drafts to resume."));
      return;
    }

    // --dry-run must not prompt: describe without picking.
    if (isDryRun()) {
      if (jsonOut({ action: "resume", dryRun: true, candidates: drafts.map((d) => d.ref) })) return;
      if (dryRun(`pop ${drafts.length === 1 ? (drafts.at(0)?.ref ?? "a draft (use ggh draft resume with a single draft for an exact preview)") : "a draft (use ggh draft resume with a single draft for an exact preview)"}`)) return;
    }

    let ref: string;
    if (drafts.length === 1) {
      const single = drafts.at(0);
      if (!single) {
        p.log.info(pc.dim("No drafts to resume."));
        return;
      }
      ref = single.ref;
    } else {
      const picked = await searchablePicker<string>({
        title: "Select a draft to resume:",
        items: drafts.map((d) => ({
          value: d.ref,
          label: draftLabel(d.message),
          hint: d.date,
        })),
        pageSize: 8,
      });
      if (!picked) {
        p.cancel("Cancelled.");
        return;
      }
      ref = picked;
    }

    if (dryRun(`pop ${ref}`)) return;

    if (!(await confirmOrAbort(`Resume draft ${pc.bold(ref)}?`, { assumeYes: options?.yes }))) return;

    const s = p.spinner();
    s.start("Restoring draft...");
    try {
      await stashPop(ref);
      s.stop(pc.green("Draft restored."));
      if (jsonOut({ action: "resume", ref })) return;
      p.outro("Done.");
    } catch (err) {
      s.stop(pc.red("Failed to restore draft."));
      fail(String(err));
    }
  }

  async function dropDraft(options?: { yes?: boolean }): Promise<void> {
    const stashes = await stashList();
    const drafts = stashes.filter((s) => s.message.includes(DRAFT_PREFIX));

    if (drafts.length === 0) {
      if (jsonOut([])) return;
      p.log.info(pc.dim("No drafts to drop."));
      return;
    }

    // --dry-run must not prompt: describe without picking.
    if (isDryRun()) {
      if (jsonOut({ action: "drop", dryRun: true, candidates: drafts.map((d) => d.ref) })) return;
      if (dryRun(`drop ${drafts.length === 1 ? (drafts.at(0)?.ref ?? "a draft (use ggh draft drop with a single draft for an exact preview)") : "a draft (use ggh draft drop with a single draft for an exact preview)"}`)) return;
    }

    let ref: string;
    if (drafts.length === 1) {
      const single = drafts.at(0);
      if (!single) {
        p.log.info(pc.dim("No drafts to drop."));
        return;
      }
      ref = single.ref;
    } else {
      const picked = await searchablePicker<string>({
        title: "Select a draft to drop:",
        items: drafts.map((d) => ({
          value: d.ref,
          label: draftLabel(d.message),
          hint: d.date,
        })),
        pageSize: 8,
      });
      if (!picked) {
        p.cancel("Cancelled.");
        return;
      }
      ref = picked;
    }

    if (dryRun(`drop ${ref}`)) return;

    if (!(await confirmOrAbort(`Drop draft ${pc.bold(ref)}?`, { assumeYes: options?.yes }))) return;

    const s = p.spinner();
    s.start("Dropping draft...");
    try {
      await stashDrop(ref);
      s.stop(pc.green("Draft dropped."));
      if (jsonOut({ action: "drop", ref })) return;
      p.outro("Done.");
    } catch (err) {
      s.stop(pc.red("Failed to drop draft."));
      fail(String(err));
    }
  }
}
