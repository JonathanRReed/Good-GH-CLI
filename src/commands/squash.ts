import { Command } from "commander";
import { getFlags } from "../services/runtime.ts";
import {
  commit,
  getCommitCount,
  getSquashPreview,
  type SquashPreview,
  getStatus,
  hasCommits,
  requireGitRepo,
  squashCommits,
} from "../services/git.ts";
import {
  generateCommitWithFallback,
  type AIAttempt,
  type AIAttemptFailure,
} from "../services/ai/index.ts";
import { run } from "../utils/exec.ts";
import { sanitizeDiffForAI, type ChangedFile } from "../utils/diff.ts";
import {
  emitJson,
  fail,
  formatAIFallback,
  header,
  p,
  pc,
  promptInput,
  reportAIFailure,
  selectMenu,
} from "../utils/ui.ts";
import { dryRun } from "../utils/flags.ts";

export function registerSquashCommand(program: Command): void {
  program
    .command("squash [count]")
    .description("Squash the last N commits into one")
    .option("-m, --message <message>", "Consolidated commit message")
    .action(async (countArg?: string, options?: { message?: string }) => {
      header("Commit Squash Assistant");

      if (!(await requireGitRepo())) return;

      if (!(await hasCommits())) {
        p.log.warn("Repository has no commits to squash.");
        return;
      }

      const status = await getStatus();
      if (status.hasChanges) {
        fail("Working tree has uncommitted changes.");
        p.log.info("Please commit, stash, or discard your changes before squashing commits.");
        p.cancel("Squash aborted to protect uncommitted changes.");
        return;
      }

      const totalCommits = await getCommitCount();
      if (totalCommits < 2) {
        p.log.warn(`Repository only has ${totalCommits} commit(s). At least 2 commits are required to squash.`);
        return;
      }

      let count = countArg === undefined ? 0 : Number(countArg);
      if (countArg !== undefined && (!/^[0-9]+$/.test(countArg) || !Number.isSafeInteger(count) || count < 2)) {
        fail("Squash count must be a whole number of at least 2.");
        return;
      }
      if (countArg === undefined) {
        const input = await promptInput({
          message: `How many commits would you like to squash into one? (2 - ${totalCommits})`,
          defaultValue: "2",
          validate: (val) => {
            const n = Number(val);
            if (!/^[0-9]+$/.test(val) || !Number.isSafeInteger(n) || n < 2) return "Must be at least 2 commits";
            if (n > totalCommits) return `Cannot exceed total repository commits (${totalCommits})`;
            return undefined;
          },
        });

        if (!input) {
          p.cancel("Squash cancelled.");
          return;
        }

        count = Number(input);
      }

      if (count > totalCommits) {
        fail(`Cannot squash ${count} commits: repository only has ${totalCommits} commit(s).`);
        return;
      }

      if (dryRun(`squash the last ${count} commits into one`)) return;

      let preview: SquashPreview;
      try {
        preview = await getSquashPreview(count);
      } catch (err) {
        fail(String(err));
        return;
      }
      const previousMessages = preview.previousMessages;

      p.log.step("Commits being squashed:");
      for (const msg of previousMessages) {
        p.log.message(`  ${pc.dim("•")} ${msg}`);
      }

      let commitSubject = options?.message;
      if (commitSubject !== undefined && !commitSubject.trim()) {
        fail("Commit message cannot be empty.");
        return;
      }
      let commitBody = "";

      if (!commitSubject) {
        const aiChoice = await selectMenu({
          message: "How would you like to formulate the new consolidated commit message?",
          options: [
            { value: "ai", label: "Generate with AI", hint: "synthesizes squashed changes into a clean message" },
            { value: "manual", label: "Enter manually", hint: "write custom commit message" },
            { value: "first", label: "Use oldest commit message", hint: previousMessages[previousMessages.length - 1] || "first message" },
          ],
        });

        if (aiChoice === null) {
          p.cancel("Squash cancelled. History and staged content were not changed.");
          return;
        }

        if (aiChoice === "first") {
          commitSubject = previousMessages[previousMessages.length - 1] || "squashed commit";
        } else if (aiChoice === "manual") {
          const manualSub = await promptInput({
            message: "Enter squashed commit subject:",
            validate: (v) => (!v || !v.trim() ? "Subject required" : undefined),
          });
          if (!manualSub) return;
          commitSubject = manualSub;
        } else {
          // AI generation
          const aiSpinner = p.spinner();
          aiSpinner.start("Generating squashed commit message with AI...");
          try {
            const base = preview.base ?? (await run("git", ["hash-object", "-t", "tree", "--stdin"], { input: "" })).stdout.trim();
            const rawDiff = (await run("git", ["diff", "--no-relative", base, preview.head])).stdout;
            const paths = (await run("git", ["diff", "--no-relative", "--name-status", "--no-renames", "-z", base, preview.head])).stdout.split("\0");
            const files: ChangedFile[] = [];
            for (let i = 0; i + 1 < paths.length; i += 2) {
              files.push({ path: paths[i + 1]!, staged: true, status: paths[i] === "D" ? "deleted" : paths[i] === "A" ? "added" : "modified" });
            }
            const { result: aiResult, providerName, model } = await generateCommitWithFallback(
              {
                branch: status.branch,
                stagedFiles: files,
                // Never send raw diffs (lockfiles, .env, secrets) to the AI provider
                stagedDiff: sanitizeDiffForAI(rawDiff).diff,
                customGuidance: `Consolidate these ${count} commits: ${previousMessages.join(", ")}`,
              },
              undefined,
              (failure: AIAttemptFailure, next?: AIAttempt) => {
                aiSpinner.message(formatAIFallback(failure, next));
              },
            );
            aiSpinner.stop(`Commit message generated by ${pc.bold(providerName)} [${pc.cyan(model)}].`);
            commitSubject = aiResult.subject;
            commitBody = aiResult.body;
          } catch (err) {
            aiSpinner.stop(pc.yellow("AI generation failed."));
            reportAIFailure(err, "Every configured AI provider and model failed:");
            const fallbackSub = await promptInput({
              message: "Enter squashed commit subject:",
              defaultValue: previousMessages[0] || "squashed commit",
            });
            if (!fallbackSub) return;
            commitSubject = fallbackSub;
          }
        }
      }

      if (!commitSubject || commitSubject.trim().length === 0) return;

      // Prompts and AI finish before the first history mutation. Recheck the
      // original branch, HEAD and clean worktree immediately before resetting.
      let recoveryRef: string;
      try {
        ({ recoveryRef } = await squashCommits(count, process.cwd(), preview));
      } catch (err) {
        fail(String(err));
        return;
      }
      const recovery = `Original history is retained at ${recoveryRef}. Inspect git status before recovering; no automatic reset was performed.`;

      if (getFlags().json) {
        try {
          await commit(commitSubject, commitBody);
          emitJson({ squashed: count, subject: commitSubject, body: commitBody });
        } catch (err) {
          emitJson({ squashed: 0, error: String(err), recoveryRef });
          fail(`${String(err)}\n${recovery}`);
        }
        return;
      }

      const cSpinner = p.spinner();
      cSpinner.start("Finalizing squashed commit...");
      try {
        await commit(commitSubject, commitBody);
        cSpinner.stop(pc.green(`Successfully squashed ${count} commits into 1!`));
        p.outro(pc.bold(pc.cyan(`Commit: ${commitSubject}`)));
      } catch (err) {
        cSpinner.stop(pc.red("Commit failed."));
        fail(`${String(err)}\n${recovery}`);
      }
    });
}
