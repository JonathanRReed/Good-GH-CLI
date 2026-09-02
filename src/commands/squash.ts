import { Command } from "commander";
import {
  commit,
  getCommitCount,
  getStagedDiff,
  getStatus,
  hasCommits,
  isGitRepo,
  squashCommits,
} from "../services/git.ts";
import { generateCommitWithFallback } from "../services/ai/index.ts";
import { header, p, pc, promptInput, selectMenu } from "../utils/ui.ts";

export function registerSquashCommand(program: Command): void {
  program
    .command("squash [count]")
    .description("Interactive commit squash assistant (soft-resets N commits into a single commit)")
    .option("-m, --message <message>", "Consolidated commit message")
    .action(async (countArg?: string, options?: { message?: string }) => {
      header("Commit Squash Assistant");

      if (!(await isGitRepo())) {
        p.log.error("Not a git repository.");
        return;
      }

      if (!(await hasCommits())) {
        p.log.warn("Repository has no commits to squash.");
        return;
      }

      const status = await getStatus();
      if (status.hasChanges) {
        p.log.error("Working tree has uncommitted changes.");
        p.log.info("Please commit, stash, or discard your changes before squashing commits.");
        p.cancel("Squash aborted to protect uncommitted changes.");
        return;
      }

      const totalCommits = await getCommitCount();
      if (totalCommits < 2) {
        p.log.warn(`Repository only has ${totalCommits} commit(s). At least 2 commits are required to squash.`);
        return;
      }

      let count = countArg ? parseInt(countArg, 10) : 0;
      if (!count || isNaN(count)) {
        const input = await promptInput({
          message: `How many commits would you like to squash into one? (2 - ${totalCommits})`,
          defaultValue: "2",
          validate: (val) => {
            const n = parseInt(val, 10);
            if (isNaN(n) || n < 2) return "Must be at least 2 commits";
            if (n > totalCommits) return `Cannot exceed total repository commits (${totalCommits})`;
            return undefined;
          },
        });

        if (!input) {
          p.cancel("Squash cancelled.");
          return;
        }

        count = parseInt(input, 10);
      }

      if (count > totalCommits) {
        p.log.error(`Cannot squash ${count} commits: repository only has ${totalCommits} commit(s).`);
        return;
      }

      const s = p.spinner();
      s.start(`Soft-resetting last ${count} commits...`);

      let previousMessages: string[] = [];
      try {
        const result = await squashCommits(count);
        previousMessages = result.previousMessages;
        s.stop(pc.green(`Soft-reset ${count} commits. All changes staged!`));
      } catch (err) {
        s.stop(pc.red("Failed to squash commits."));
        p.log.error(String(err));
        return;
      }

      p.log.step("Commits being squashed:");
      for (const msg of previousMessages) {
        p.log.message(`  ${pc.dim("•")} ${msg}`);
      }

      let commitSubject = options?.message;
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
          p.cancel("All changes remain staged. You can commit anytime with `ggh commit`.");
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
            const status = await getStatus();
            const rawDiff = await getStagedDiff();
            const { result: aiResult } = await generateCommitWithFallback({
              branch: status.branch,
              stagedFiles: status.staged,
              stagedDiff: rawDiff,
              customGuidance: `Consolidate these ${count} commits: ${previousMessages.join(", ")}`,
            });
            aiSpinner.stop("Commit message generated!");
            commitSubject = aiResult.subject;
            commitBody = aiResult.body;
          } catch {
            aiSpinner.stop(pc.yellow("AI unavailable. Please enter subject manually."));
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

      const cSpinner = p.spinner();
      cSpinner.start("Finalizing squashed commit...");
      try {
        await commit(commitSubject, commitBody);
        cSpinner.stop(pc.green(`Successfully squashed ${count} commits into 1!`));
        p.outro(pc.bold(pc.cyan(`Commit: ${commitSubject}`)));
      } catch (err) {
        cSpinner.stop(pc.red("Commit failed."));
        p.log.error(String(err));
      }
    });
}
