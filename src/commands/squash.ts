import { Command } from "commander";
import {
  commit,
  getStagedDiff,
  getStatus,
  hasCommits,
  isGitRepo,
  squashCommits,
} from "../services/git.ts";
import { generateCommitWithFallback } from "../services/ai/index.ts";
import { header, p, pc } from "../utils/ui.ts";

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

      let count = countArg ? parseInt(countArg, 10) : 0;
      if (!count || isNaN(count)) {
        const input = await p.text({
          message: "How many commits would you like to squash into one?",
          defaultValue: "2",
          validate: (val) => {
            const n = parseInt(val, 10);
            if (isNaN(n) || n < 2) return "Must be at least 2 commits";
            return undefined;
          },
        });

        if (p.isCancel(input)) {
          p.cancel("Squash cancelled.");
          return;
        }

        count = parseInt(input as string, 10);
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
        const aiChoice = await p.select({
          message: "How would you like to formulate the new consolidated commit message?",
          options: [
            { value: "ai", label: "Generate with AI", hint: "synthesizes squashed changes into a clean message" },
            { value: "manual", label: "Enter manually", hint: "write custom commit message" },
            { value: "first", label: "Use oldest commit message", hint: previousMessages[previousMessages.length - 1] || "first message" },
          ],
        });

        if (p.isCancel(aiChoice)) {
          p.cancel("All changes remain staged. You can commit anytime with `ggh commit`.");
          return;
        }

        if (aiChoice === "first") {
          commitSubject = previousMessages[previousMessages.length - 1] || "squashed commit";
        } else if (aiChoice === "manual") {
          const manualSub = await p.text({
            message: "Enter squashed commit subject:",
            validate: (v) => (!v || !v.trim() ? "Subject required" : undefined),
          });
          if (p.isCancel(manualSub)) return;
          commitSubject = manualSub as string;
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
            const fallbackSub = await p.text({
              message: "Enter squashed commit subject:",
              defaultValue: previousMessages[0] || "squashed commit",
            });
            if (p.isCancel(fallbackSub)) return;
            commitSubject = fallbackSub as string;
          }
        }
      }

      if (!commitSubject) return;

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
