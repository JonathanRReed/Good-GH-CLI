import { executeSnapshotCommit } from "../services/git/scoped-commit.ts";
import {
  captureStagedSnapshot,
  executeSplitCommits,
  validateSplitPlan,
} from "../services/git/split.ts";
import { getFlags, isNonInteractive } from "../services/runtime.ts";
import { Command } from "commander";
import {
  checkLargeFiles,
  checkSubmodules,
  detectPullRequestBase,
  getCommitSubject,
  getRecentCommits,
  getRemotes,
  getStagedDiff,
  getStagedDiffStat,
  getStatus,
  hasCommits,
  requireGitRepo,
  isValidCommit,
  push,
  stageAll,
  stageFiles,
  switchBranch,
} from "../services/git.ts";
import {
  type AIAttempt,
  type AIAttemptFailure,
  ensureFirstRunSetup,
  generateCommitWithFallback,
  generateSplitWithFallback,
} from "../services/ai/index.ts";
import { getActivePullRequest } from "../services/github.ts";
import {
  type AIProvider as ConfigAIProvider,
  getConfig,
} from "../services/config.ts";
import { sanitizeDiffForAI, scanCodeHygiene } from "../utils/diff.ts";
import {
  type CommitStyle,
  detectCommitConvention,
} from "../utils/conventions.ts";
import { validateBranchName } from "../utils/branch-name.ts";
import { parsePositiveSafeInteger } from "../utils/numeric-target.ts";
import {
  confirmOrAbort,
  jsonOut,
  confirmPrompt,
  fail,
  failFromPush,
  formatAIFallback,
  header,
  multiSelectMenu,
  p,
  pc,
  promptFirstRunProvider,
  promptInput,
  renderDiff,
  reportAIFailure,
  selectMenu,
} from "../utils/ui.ts";
import { openPullRequest } from "./pr-create.ts";
import { PushProtectionError } from "../services/git/push-protection.ts";
import { run } from "../utils/exec.ts";
import { dryRun, isDryRun } from "../utils/flags.ts";

const PROTECTED_PUSH_BRANCHES = new Set(["main", "master", "release", "prod", "production"]);

async function promptConventionalCommitWizard(): Promise<{
  subject: string;
  body: string;
}> {
  p.log.step("Conventional Commit Wizard");
  const type = await selectMenu({
    message: "Select commit type:",
    options: [
      { value: "feat", label: "feat", hint: "A new feature" },
      { value: "fix", label: "fix", hint: "A bug fix" },
      { value: "docs", label: "docs", hint: "Documentation changes" },
      {
        value: "refactor",
        label: "refactor",
        hint: "Code change that neither fixes a bug nor adds a feature",
      },
      {
        value: "perf",
        label: "perf",
        hint: "A code change that improves performance",
      },
      {
        value: "test",
        label: "test",
        hint: "Adding missing tests or correcting existing tests",
      },
      {
        value: "chore",
        label: "chore",
        hint: "Changes to build process or auxiliary tools",
      },
    ],
  });
  if (type === null) throw new Error("cancelled");

  const scope = await promptInput({
    message: "Enter scope (optional, press Enter to skip):",
    placeholder: "e.g. auth, api, ui",
  });
  if (scope === null) throw new Error("cancelled");

  const desc = await promptInput({
    message: "Enter short description (imperative, <= 72 chars):",
    validate: (v) => (!v || !v.trim() ? "Description required" : undefined),
  });
  if (desc === null) throw new Error("cancelled");

  const body = await promptInput({
    message: "Enter commit body / bullet points (optional, press Enter to skip):",
  });
  if (body === null) throw new Error("cancelled");

  const trimmedScope = scope.trim();
  const scopeStr = trimmedScope ? `(${trimmedScope})` : "";
  const subject = `${type}${scopeStr}: ${desc.trim()}`;
  return { subject, body: body.trim() };
}

export function registerCommitCommand(program: Command): void {
  program
    .command("commit")
    .alias("c")
    .description("Stage, commit, push, and open a pull request")
    .option("-m, --message <message>", "Commit message (skips AI generation)")
    .option(
      "-a, --all",
      "Stage all modified and untracked files before committing",
    )
    .option("--amend", "Amend previous commit")
    .option("-n, --no-verify", "Bypass pre-commit and commit-msg hooks")
    .option("-S, --gpg-sign", "GPG-sign commits")
    .option(
      "-s, --signoff",
      "Add Signed-off-by line at the end of the commit message",
    )
    .option(
      "-i, --issue <issue>",
      "Link commit and PR to a GitHub issue number (e.g. 42)",
    )
    .option(
      "--closes <issue>",
      "Add 'Closes #N' to the commit body and PR description",
    )
    .option(
      "-y, --yes",
      "Answer every confirmation with yes (required for non-interactive use)",
    )
    .option(
      "--review",
      "Run pre-commit hygiene scan for console.log, debugger, and localhost URLs",
    )
    .option("--push", "Automatically commit and push to remote tracking branch")
    .option(
      "--force-with-lease",
      "Push with --force-with-lease when the remote has diverged",
    )
    .option("--pr", "Commit and publish a GitHub pull request")
    .option(
      "--branch <branch>",
      "Create or switch to a branch before committing",
    )
    .option("--base <branch>", "Existing base branch for --pr")
    .option("--repo-name <name>", "Repository name when --pr needs a remote")
    .option(
      "--no-ai",
      "Disable AI commit generation and launch Conventional Commit wizard",
    )
    .option(
      "--provider <provider>",
      "Override AI provider (codex, grok, claude, or ollama)",
    )
    .option(
      "--style <style>",
      "Override commit style (conventional, gitmoji, concise)",
    )
    .option(
      "--fixup <sha>",
      "Create a fixup commit targeting <sha> (use with ggh squash or git rebase --autosquash)",
    )
    .option(
      "--split",
      "AI proposes splitting staged changes into focused commits",
    )
    .action(async (options: {
      message?: string;
      all?: boolean;
      amend?: boolean;
      verify?: boolean;
      gpgSign?: boolean;
      signoff?: boolean;
      issue?: string;
      closes?: string;
      yes?: boolean;
      review?: boolean;
      push?: boolean;
      forceWithLease?: boolean;
      pr?: boolean;
      branch?: string;
      base?: string;
      repoName?: string;
      ai?: boolean;
      provider?: string;
      style?: string;
      fixup?: string;
      split?: boolean;
    }) => {
      header(options.amend ? "Amend Last Commit" : "Commit & Stacked Actions");

      if (!(await requireGitRepo())) return;

      for (const [flag, value] of [["--issue", options.issue], ["--closes", options.closes]] as const) {
        if (value !== undefined && parsePositiveSafeInteger(value.replace(/^#/, "")) === null) {
          fail(`${flag} requires a positive whole issue number.`);
          return;
        }
      }

      if (
        options.split &&
        (options.ai === false ||
          options.message !== undefined ||
          options.amend ||
          options.fixup)
      ) {
        fail("--split cannot be combined with --no-ai, --message, --amend, or --fixup.");
        return;
      }

      if (
        options.message !== undefined &&
        options.message.trim().length === 0
      ) {
        fail("Commit message cannot be empty.");
        return;
      }

      if (options.amend && !(await hasCommits())) {
        fail("Cannot amend: repository has no commits yet.");
        return;
      }

      let status = await getStatus();

      if (options.branch) {
        const invalidBranch = validateBranchName(options.branch);
        if (invalidBranch) {
          fail(`Invalid branch name: ${invalidBranch}`); return;
        }
      }
      if (options.base) {
        const invalidBase = validateBranchName(options.base);
        if (invalidBase) {
          fail(`Invalid base branch: ${invalidBase}`); return;
        }
      }
      if (
        options.base &&
        options.base === (options.branch ?? status.branch)
      ) {
        fail(
          `Base branch "${options.base}" must differ from the commit branch.`,
        ); return;
      }

      // Guard against unresolved merge conflicts
      if (status.conflicts.length > 0) {
        fail(`Unresolved merge conflicts detected in ${status.conflicts.length} file(s):`, { code: "precondition_failed" });
        for (const c of status.conflicts) {
          p.log.message(`  ${pc.red("✖")} ${pc.bold(c.path)}`);
        }
        p.log.info(`Run ${pc.bold(pc.cyan("ggh resolve"))} to resolve conflicts interactively.`);
        p.cancel("Please resolve all merge conflicts and stage the resolution before committing.");
        return;
      }

      // Without a terminal nothing may be staged on the caller's behalf: agents stage reviewed paths themselves.
      if (isNonInteractive() && !options.all && !options.amend && !options.split && status.staged.length === 0 && status.unstaged.length + status.untracked.length > 0) {
        fail("Nothing staged. Stage the reviewed changes with git add <paths>, then commit.", { code: "precondition_failed" });
        return;
      }

      if (isDryRun()) {
        const filesToStage = options.all
          ? [...status.staged, ...status.unstaged, ...status.untracked]
          : status.staged;
        if (filesToStage.length === 0 && !options.amend) {
          p.log.info(pc.dim("Dry run: working tree is clean. Nothing to commit."));
          jsonOut({
            status: "planned",
            action: "commit",
            noOp: true,
            branch: status.branch,
            steps: [],
          }); return;
        }

        const targetFiles = filesToStage.map((f) => f.path);
        const proposedMessage =
          options.message ||
          (options.amend
            ? "amend previous commit"
            : "<generated by AI or conventional wizard>");
        const actions: string[] = [];
        if (options.all) actions.push("stage all changes");
        if (options.amend) actions.push("amend previous commit");
        else actions.push("create a commit");
        if (options.push) actions.push("push to remote");
        if (options.pr) actions.push("open a Pull Request");

        dryRun(`${actions.join(", ")} with message ${pc.bold(proposedMessage)}`);
        p.log.message(`  files: ${targetFiles.join(", ")}`); return;
      }

      if (options.pr && isNonInteractive() && !options.yes) {
        const message = "Publishing needs explicit authorization. Pass --yes with --pr before staging or committing.";
        fail(message, { code: "confirmation_required", requiredInputs: [{ name: "--yes", description: message }] }); return;
      }

      const hasWorkingChanges =
        status.staged.length +
          status.unstaged.length +
          status.untracked.length >
        0;
      if (
        hasWorkingChanges &&
        getFlags().aiDisabled &&
        isNonInteractive() &&
        !options.message &&
        !options.split &&
        !options.fixup
      ) {
        const message = "A commit message is required without interactive input. Pass -m <message>, or explicitly enable AI with --ai.";
        fail(message, { code: "missing_input", requiredInputs: [{ name: "-m", alternatives: ["--message", "--ai"], description: message }] }); return;
      }

      if ((hasWorkingChanges || options.amend) && options.push && !options.pr && isNonInteractive() && !options.yes && PROTECTED_PUSH_BRANCHES.has((options.branch ?? status.branch).toLowerCase())) {
        const message = "Pushing from a protected branch requires --yes before staging or committing. Pass --yes, or omit --push to commit locally.";
        fail(message, { code: "confirmation_required", requiredInputs: [{ name: "--yes", description: message }] });
        return;
      }

      if (options.branch && options.branch !== status.branch) {
        const existingBranch = await run(
          "git",
          ["show-ref", "--verify", "--quiet", `refs/heads/${options.branch}`],
          { reject: false },
        );
        await switchBranch(options.branch, existingBranch.exitCode !== 0);
        status = await getStatus();
        p.log.success(
          `Switched to branch ${pc.bold(pc.cyan(options.branch))}.`,
        );
      }

      if (options.pr) {
        let base = options.base;
        if (!base) {
          try {
            base = await detectPullRequestBase();
          } catch (error) {
            fail(error instanceof Error ? error.message : String(error)); return;
          }
        }
        if (base === status.branch) {
          fail(
            `Base branch "${base}" must differ from the commit branch. Pass --branch to choose a feature branch.`,
          ); return;
        }
      }

      if (!hasWorkingChanges && !options.amend) {
        if (options.pr) {
          await openPullRequest({
            title: options.message,
            base: options.base,
            repoName: options.repoName,
            yes: options.yes,
            ai: options.ai,
          }); return;
        }
        jsonOut({
          status: "no_op",
          action: "commit",
          noOp: true,
          branch: status.branch,
          completed: [],
        });
          p.log.info(pc.dim("Working tree is clean. Nothing to commit.")); return;
      }

      // Handle Staging
      if (options.all) {
        await stageAll();
        status = await getStatus();
      } else if (status.staged.length === 0 && !options.amend) {
        const unstagedAndUntracked = [
          ...status.unstaged,
          ...status.untracked,
        ];
        if (unstagedAndUntracked.length === 0) {
          if (options.pr) {
            await openPullRequest({
              title: options.message,
              base: options.base,
              repoName: options.repoName,
              yes: options.yes,
              ai: options.ai,
            }); return;
          }
          jsonOut({
            status: "no_op",
            action: "commit",
            noOp: true,
            branch: status.branch,
            completed: [],
          });
          p.log.info(pc.dim("Working tree is clean. Nothing to commit.")); return;
        }

        const stageChoice = await selectMenu({
          message: "No files are staged. How would you like to stage changes?",
          options: [
            {
              value: "all",
              label: "Stage all files",
              hint: `${unstagedAndUntracked.length} files (${status.unstaged.length} modified, ${status.untracked.length} untracked)`,
            },
            {
              value: "select",
              label: "Select files interactively...",
              hint: "Pick specific files to stage",
            },
          ],
        });

        if (stageChoice === null) {
          p.cancel("Commit cancelled.");
          return;
        }

        if (stageChoice === "all") {
          await stageAll();
        } else {
          const selectedFiles = await multiSelectMenu({
            message: "Select files to stage (space to toggle, enter to confirm):",
            options: unstagedAndUntracked.map((f) => ({
              value: f.path,
              label: `${f.path} ${pc.dim(`(${f.status})`)}`,
            })),
            required: true,
            pageSize: 8,
          });

          if (selectedFiles === null) {
            p.cancel("Commit cancelled.");
            return;
          }

          await stageFiles(selectedFiles);
        }
        status = await getStatus();
      }

      if (status.staged.length === 0 && !options.amend) {
        if (options.pr) {
          await openPullRequest({
            title: options.message,
            base: options.base,
            repoName: options.repoName,
            yes: options.yes,
            ai: options.ai,
          }); return;
        }
        jsonOut({
          status: "no_op",
          action: "commit",
          noOp: true,
          branch: status.branch,
          completed: [],
        });
        p.log.warn("No files staged for commit."); return;
      }

      let snapshot = await captureStagedSnapshot(process.cwd(), { allowEmpty: options.amend });

      p.log.step(
        `Staged ${pc.green(String(status.staged.length))} file(s) on branch ${pc.cyan(status.branch)}`,
      );

      // Code Hygiene Scanner (--review), Large File Guard, and Submodule Guard are independent — run in parallel.
      // The diff is only fetched when something needs it (hygiene scan, AI generation, or PR creation).
      const needsDiff = Boolean(
        options.review ||
        options.pr ||
        (!options.message && options.ai !== false),
      );
      const [
        rawDiff,
        diffStat,
        recentCommits,
        largeFileCheck,
        submoduleStatus,
      ] = await Promise.all([
        needsDiff ? getStagedDiff() : Promise.resolve(""),
        needsDiff ? getStagedDiffStat() : Promise.resolve(""),
        getRecentCommits(10),
        checkLargeFiles(status.staged),
        checkSubmodules(),
      ]);

      if (options.review) {
        const hygieneIssues = scanCodeHygiene(rawDiff);
        if (hygieneIssues.length > 0) {
          p.log.warn(pc.yellow(`Pre-commit review found ${hygieneIssues.length} hygiene issue(s):`));
          for (const issue of hygieneIssues.slice(0, 5)) {
            p.log.message(`  ${pc.yellow("▲")} ${issue.message}: ${pc.dim(issue.line.slice(0, 60))}`);
          }
          if (
            !(await confirmOrAbort("Proceed with commit anyway?", {
              assumeYes: options.yes,
              cancelText: "Commit cancelled to address code hygiene.",
            }))
          ) return;
        } else {
          p.log.success(pc.green("Code hygiene check passed! No debug artifacts detected."));
        }
      }

      // Large File Pre-Commit Guard (GitHub 100MB hard limit)
      const { blocked, warnings } = largeFileCheck;
      if (blocked.length > 0) {
        fail(
          pc.red(
            `Commit blocked: ${blocked.length} staged file(s) exceed GitHub's 100MB limit (which permanently breaks git push):`,
          ),
        );
        for (const b of blocked) {
          p.log.message(`  ${pc.red("✖")} ${pc.bold(b.path)} (${b.sizeMB} MB)`);
        }
        p.cancel("Please unstage these files or track them with Git LFS before committing.");
        return;
      }

      if (warnings.length > 0) {
        p.log.warn(pc.yellow(`Warning: ${warnings.length} staged file(s) exceed 50MB:`));
        for (const w of warnings) {
          p.log.message(`  ${pc.yellow("▲")} ${pc.bold(w.path)} (${w.sizeMB} MB)`);
        }
      }

      // Submodule Integrity Guard
      const dirtySubmodules = submoduleStatus.filter((s) => s.status !== "uninitialized");
      if (dirtySubmodules.length > 0) {
        p.log.warn(pc.yellow(`Detected ${dirtySubmodules.length} dirty/modified submodule(s):`));
        for (const s of dirtySubmodules) {
          p.log.message(`  ${pc.yellow("▲")} ${s.name} (${s.status}, commit: ${s.commit.slice(0, 7)})`);
        }
        if (
          !(await confirmOrAbort("Proceed with commit anyway?", {
            assumeYes: options.yes,
            cancelText: "Commit cancelled to address submodules.",
          }))
        ) return;
      }

      // Committing straight to the default branch is rarely what you meant.
      const isDefaultBranch = ["main", "master"].includes(status.branch.toLowerCase());
      if (isDefaultBranch && !options.amend && !options.message) {
        const branchChoice = await selectMenu({
          message: `You are on default branch ${pc.bold(pc.yellow(status.branch))}. Where would you like to commit?`,
          options: [
            {
              value: "feature",
              label: "Create a feature branch",
              hint: "keep default branch clean and ready for PR",
            },
            {
              value: "direct",
              label: "Commit directly to default branch",
              hint: "commit directly to main",
            },
            {
              value: "cancel",
              label: "Cancel",
            },
          ],
        });

        if (branchChoice === null || branchChoice === "cancel") {
          p.cancel("Commit cancelled.");
          return;
        }

        if (branchChoice === "feature") {
          const featureNameInput = await promptInput({
            message: "Enter feature branch name:",
            placeholder: "e.g. feat/dashboard-layout",
            validate: (v) => {
              if (!v || !v.trim()) return "Branch name required";
              return validateBranchName(v.trim());
            },
          });

          if (!featureNameInput) {
            p.cancel("Commit cancelled.");
            return;
          }

          const newBranch = featureNameInput.trim();
          await switchBranch(newBranch, true);
          status = await getStatus();
          snapshot = await captureStagedSnapshot();
          p.log.success(`Created and switched to feature branch ${pc.bold(pc.cyan(newBranch))}!`);
        }
      }

      // --fixup <sha>: skip AI, let git generate "fixup! <original subject>".
      // The user then runs `ggh squash` or `git rebase --autosquash` to apply it.
      if (options.fixup) {
        if (!(await isValidCommit(options.fixup))) {
          fail(`Invalid commit: ${options.fixup}`);
          return;
        }
        const targetSubject = await getCommitSubject(options.fixup);
        p.log.info(`Creating fixup commit for: ${pc.dim(targetSubject)}`);

        if (dryRun(`create a fixup commit targeting ${options.fixup.slice(0, 7)}`)) return;

        const fixupSpinner = p.spinner();
        fixupSpinner.start("Creating fixup commit...");
        try {
          await executeSnapshotCommit(snapshot, "fixup", "", {
            noVerify: options.verify === false,
            gpgSign: options.gpgSign,
            signoff: options.signoff,
            fixup: options.fixup,
          });
          fixupSpinner.stop(pc.green("Fixup commit created!"));
          p.log.info(pc.dim(`Squash it with \`ggh squash\` or \`git rebase --autosquash ${options.fixup}\`.`));
          jsonOut({
            status: "succeeded",
            action: "fixup",
            target: options.fixup,
            revision: (await run("git", ["rev-parse", "HEAD"])).stdout.trim(),
          });
          p.outro("Done.");
        } catch (err) {
          fixupSpinner.stop(pc.red("Fixup commit failed."));
          fail(String(err));
        } return;
      }

      let commitSubject = options.message;
      let commitBody = "";

      // --split: AI partitions the immutable staged snapshot, never the working tree.
      if (options.split) {
        if (status.staged.length === 0) {
          fail("Nothing staged to split. Use `ggh c -a --split` to stage everything first.");
          return;
        }

        // --dry-run must not bill AI: preview without calling providers.
        if (isDryRun()) {
          if (dryRun(`split ${status.staged.length} staged file(s) into multiple commits`)) return;
        }

        if (!options.provider) await ensureFirstRunSetup(promptFirstRunProvider);

        const splitDiffStat = diffStat;
        const { diff: splitSanitizedDiff, redactedCount: splitRedacted } = sanitizeDiffForAI(rawDiff);
        if (splitRedacted > 0) {
          p.log.warn(pc.yellow(`Redacted ${splitRedacted} potential secret(s) from diff sent to AI.`));
        }

        const activeStyle: CommitStyle =
          (options.style as CommitStyle) ||
          (getConfig().commit_style as CommitStyle) ||
          detectCommitConvention(recentCommits);

        const splitSpinner = p.spinner();
        splitSpinner.start("Analyzing staged changes for commit boundaries...");
        let splitResult;
        try {
          const { result, providerName, model } = await generateSplitWithFallback(
            {
              branch: status.branch,
              stagedFiles: snapshot.files,
              stagedDiff: splitSanitizedDiff,
              diffStat: splitDiffStat,
              style: activeStyle,
            },
            options.provider as ConfigAIProvider | undefined,
            (failure: AIAttemptFailure, next?: AIAttempt) => splitSpinner.message(formatAIFallback(failure, next)),
          );
          splitSpinner.stop(`Split proposed by ${pc.bold(providerName)} [${pc.cyan(model)}].`);
          splitResult = result;
        } catch (err) {
          splitSpinner.stop(pc.red("AI split failed."));
          reportAIFailure(err, "Could not propose a split:");
          process.exitCode = 1;
          return;
        }

        let plan;
        try { plan = validateSplitPlan(splitResult, snapshot); }
        catch (err) { fail(String(err)); return; }
        if (options.closes) {
          const last = plan.at(-1)!;
          last.body =
            `${last.body.trim()}\n\nCloses #${options.closes.replace(/^#/, "")}`.trim();
        }
        p.log.step(`Proposed ${plan.length} snapshot-preserving commits:`);
        for (const group of plan) {
          p.log.message(`  ${pc.cyan(group.subject)} ${pc.dim(group.files.join(", "))}`);
        }
        if (!(await confirmOrAbort(`Create ${plan.length} commits from the staged snapshot?`, { assumeYes: options.yes }))) return;
        try {
          const completed = await executeSplitCommits(snapshot, plan, {
            noVerify: options.verify === false,
            gpgSign: options.gpgSign,
            signoff: options.signoff,
          });
          p.log.success(`Created ${completed.length} commits. Unstaged content was not added.`);
        } catch (err) {
          fail(String(err)); return;
        }
        commitSubject = plan[0]!.subject;
        commitBody = plan.map((group) => `- ${group.subject}`).join("\n");
      } else {
        // Resolve Commit Message
        if (!commitSubject && getFlags().aiDisabled) {
        try {
          const wizardResult = await promptConventionalCommitWizard();
          commitSubject = wizardResult.subject;
          commitBody = wizardResult.body;
        } catch {
          p.cancel("Commit cancelled.");
          return;
        }
      } else if (!commitSubject) {
        // Ensure first run setup
        await ensureFirstRunSetup(promptFirstRunProvider);

        const config = getConfig();

        // Strip lockfiles/binaries/.env blocks and redact secrets in a single pass;
        // this is the only diff text that ever leaves the machine.
        const { diff: sanitizedDiff, redactedCount } = sanitizeDiffForAI(rawDiff);
        if (redactedCount > 0) {
          p.log.warn(pc.yellow(`Redacted ${redactedCount} potential secret(s) from diff sent to AI.`));
        }

          // Style precedence: --style flag, then configured style, then whatever
          // the last ten commits in this repository already use.
          const activeStyle: CommitStyle =
            options.style &&
            ["conventional", "gitmoji", "concise"].includes(options.style)
              ? (options.style as CommitStyle)
              : config.commit_style && config.commit_style !== "auto"
                ? (config.commit_style as CommitStyle)
                : detectCommitConvention(recentCommits);

        let customGuidance: string | undefined;
        let generationLoop = true;

          while (generationLoop) {
          const s = p.spinner();
          s.start("Generating commit message with AI...");

            try {
              const {
                result: aiResult,
                providerName,
                model: activeModel,
                failures,
              } = await generateCommitWithFallback(
                {
                  branch: status.branch,
                  stagedFiles: status.staged,
                  stagedDiff: sanitizedDiff,
                  diffStat,
                  issue: options.issue,
                  style: activeStyle,
                  customGuidance,
                },
                options.provider as ConfigAIProvider | undefined,
                (failure: AIAttemptFailure, next?: AIAttempt) => {
                  s.message(formatAIFallback(failure, next));
                },
              );
            s.stop(`Commit message generated by ${pc.bold(providerName)} [${pc.cyan(activeModel)}].`);

            for (const failure of failures) {
              p.log.info(
                pc.dim(`Skipped ${failure.providerName} [${failure.model}]: ${failure.reason}`),
              );
            }

            commitSubject = aiResult.subject;
            commitBody = aiResult.body;
            } catch (err) {
            s.stop(pc.yellow("AI commit generation failed."));
            reportAIFailure(err, "Every configured AI provider and model failed:");
            p.log.info("Falling back to the Conventional Commit wizard.");
        try {
          const wizardResult = await promptConventionalCommitWizard();
          commitSubject = wizardResult.subject;
          commitBody = wizardResult.body;
        } catch {
          p.cancel("Commit cancelled.");
          return;
        }
            break;
            }

          // If automated flags were provided on CLI, break immediately
          if (options.yes || options.push || options.pr) {
            break;
          }

          // Show generated message & action menu
          p.note(
            `${pc.bold(commitSubject)}\n${commitBody ? pc.dim(`\n${commitBody}`) : ""}`,
            "Proposed Commit Message",
          );

          const activePr = await getActivePullRequest();
          const prLabel = activePr
            ? `Commit & Push to PR #${activePr.number}`
            : "Commit, Push & Open PR";
          const prHint = activePr
            ? `Push updates to active PR #${activePr.number}`
            : "Push and generate AI Pull Request";

            const action = await selectMenu({
              message: "What would you like to do?",
              options: [
                {
                  value: "commit",
                  label: "Commit",
                  hint: "Create local commit",
                },
                {
                  value: "push",
                  label: "Commit & Push",
                  hint: `Push to origin/${status.branch}`,
                },
                { value: "pr", label: prLabel, hint: prHint },
                {
                  value: "diff",
                  label: "View diff",
                  hint: "Inspect colored diff of staged changes",
                },
                {
                  value: "edit",
                  label: "Edit message",
                  hint: "Modify subject or body",
                },
                {
                  value: "regenerate",
                  label: "Regenerate message",
                  hint: "Try again or provide guidance",
                },
                { value: "cancel", label: "Cancel", hint: "Abort commit" },
              ],
            });

          if (action === null || action === "cancel") {
            p.cancel("Commit cancelled.");
            return;
          }

          if (action === "diff") {
            renderDiff(rawDiff);
            continue;
          } else if (action === "edit") {
            const editSub = await promptInput({
              message: "Edit commit subject:",
              defaultValue: commitSubject,
            });
            if (!editSub) return;
            commitSubject = editSub;

            const editBody = await promptInput({
              message: "Edit commit body (optional):",
              defaultValue: commitBody,
            });
            if (editBody === null) return;
            commitBody = editBody;
            generationLoop = false;
          } else if (action === "regenerate") {
            const guidance = await promptInput({
              message: "Enter guidance or hints for regeneration (optional):",
              placeholder: "e.g. emphasize breaking change or make it shorter",
            });
            if (guidance === null) return;
            customGuidance = guidance;
          } else if (action === "push") {
            options.push = true;
            generationLoop = false;
          } else if (action === "pr") {
            options.pr = true;
            generationLoop = false;
          } else {
            // action === "commit"
            generationLoop = false;
          }
          }
        }

      if (!commitSubject || commitSubject.trim().length === 0) {
        p.cancel("Commit cancelled (empty commit message).");
        return;
      }

        // Append "Closes #N" footer if --closes was specified.
        if (options.closes) {
        const closesFooter = `Closes #${options.closes.replace(/^#/, "")}`;
          if (!commitBody.includes(closesFooter)) {
            commitBody = commitBody.trim()
              ? `${commitBody.trim()}\n\n${closesFooter}`
              : closesFooter;
          }
        }

      // Execute Commit (or Amend)
      const commitSpinner = p.spinner();
      commitSpinner.start(options.amend ? "Amending commit..." : "Creating commit...");
        try {
        await executeSnapshotCommit(snapshot, commitSubject, commitBody, {
          noVerify: options.verify === false,
          gpgSign: options.gpgSign,
          signoff: options.signoff,
          amend: options.amend,
        });
          commitSpinner.stop(
            pc.green(
              options.amend
                ? "Commit amended successfully!"
                : "Commit created successfully!",
            ),
          );
        } catch (err: unknown) {
        commitSpinner.stop(pc.red("Git commit failed."));
        const execErr = err as { stderr?: string; stdout?: string };
        const output = execErr.stderr || execErr.stdout || String(err);
        fail(output); return;
        }
      }

      // Protected Branch Direct Push Guard
      if (options.push && !options.pr) {
        const isProtected = PROTECTED_PUSH_BRANCHES.has(status.branch.toLowerCase());
        if (isProtected) {
          const confirmProtected = await confirmPrompt({
            message: `You are on protected branch ${pc.bold(pc.yellow(status.branch))}. Push directly without a PR?`,
            initialValue: false,
            assumeYes: options.yes,
          });
          if (!confirmProtected) {
            p.log.info("Push cancelled. Consider running `ggh c --pr` to open a Pull Request.");
            options.push = false;
            jsonOut({ status: "partially_completed", completed: ["commit"], remaining: ["push"], branch: status.branch, revision: (await run("git", ["rev-parse", "HEAD"])).stdout.trim(), reason: "push_not_authorized" });
            p.outro("Commit created locally. Push was not authorized.");
            return;
          }
        }
      }

      // Handle Push
      if (options.push && !options.pr) {
        if (status.isDetached || status.branch === "HEAD") {
          fail("Cannot push or open a Pull Request from a detached HEAD state. Please create or switch to a branch first.");
          options.push = false;
          options.pr = false;
          process.exitCode = 1;
          return;
        }

        const remotes = await getRemotes();
        if (remotes.length === 0) {
          fail("No git remote configured. Commit was created locally, but cannot push to remote.");
          p.log.info(`Add a remote with \`git remote add origin <url>\` and push with \`git push -u origin ${status.branch}\`.`);
          jsonOut({
            status: "partially_completed",
            completed: ["commit"],
            remaining: ["push"],
            branch: status.branch,
            revision: (await run("git", ["rev-parse", "HEAD"])).stdout.trim(),
          }); return;
        }

        const pushSpinner = p.spinner();
        pushSpinner.start(`Pushing to remote branch ${pc.cyan(status.branch)}...`);
        try {
          await push({
            branch: status.branch,
            noVerify: options.verify === false,
            forceWithLease: options.forceWithLease,
          });
          pushSpinner.stop(pc.green("Pushed to remote successfully!"));
        } catch (err) {
          const blocked = err instanceof PushProtectionError;
          pushSpinner.stop(pc.yellow(blocked ? "Push blocked by GitHub push protection. The local commit is preserved." : "Push failed or was rejected."));
          failFromPush(err, "Push did not complete. The local commit is preserved. Inspect the remote before retrying. ");
          jsonOut({
            status: "partially_completed",
            completed: ["commit"],
            remaining: ["push"],
            ...(blocked ? { failed: ["push"], pushProtection: err.details } : {}),
            branch: status.branch,
            revision: (await run("git", ["rev-parse", "HEAD"])).stdout.trim(),
          }); return;
        }
      }

      if (options.pr) {
        await openPullRequest({
          title: commitSubject,
          body: commitBody || undefined,
          base: options.base,
          repoName: options.repoName,
          yes: options.yes,
          priorCompleted: ["commit"],
        }); return;
      }
      jsonOut({
        status: "succeeded",
        action: options.amend ? "amend" : "commit",
        branch: status.branch,
        revision: (await run("git", ["rev-parse", "HEAD"])).stdout.trim(),
        completed: ["commit", ...(options.push ? ["push"] : [])],
      });
          p.outro(pc.green("All operations completed successfully!"));
    });
}
