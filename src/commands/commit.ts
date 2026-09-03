import { Command } from "commander";
import {
  checkLargeFiles,
  checkSubmodules,
  commit,
  detectDefaultBranch,
  findPrTemplate,
  getBranchDiff,
  getBranchDiffStat,
  getCommitsSinceBase,
  getRecentCommits,
  getRemotes,
  getStagedDiff,
  getStagedDiffStat,
  getStatus,
  hasCommits,
  isGitRepo,
  pullRebase,
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
  generatePrWithFallback,
} from "../services/ai/index.ts";
import { createPullRequest, getActivePullRequest, getGitHubAuthStatus } from "../services/github.ts";
import { type AIProvider as ConfigAIProvider, getConfig } from "../services/config.ts";
import { sanitizeDiffForAI, scanCodeHygiene } from "../utils/diff.ts";
import { type CommitStyle, detectCommitConvention } from "../utils/conventions.ts";
import {
  confirmPrompt,
  fail,
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

async function promptConventionalCommitWizard(): Promise<{ subject: string; body: string }> {
  p.log.step("Conventional Commit Wizard");
  const type = await selectMenu({
    message: "Select commit type:",
    options: [
      { value: "feat", label: "feat", hint: "A new feature" },
      { value: "fix", label: "fix", hint: "A bug fix" },
      { value: "docs", label: "docs", hint: "Documentation changes" },
      { value: "refactor", label: "refactor", hint: "Code change that neither fixes a bug nor adds a feature" },
      { value: "perf", label: "perf", hint: "A code change that improves performance" },
      { value: "test", label: "test", hint: "Adding missing tests or correcting existing tests" },
      { value: "chore", label: "chore", hint: "Changes to build process or auxiliary tools" },
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

  const scopeStr = scope.trim() ? `(${scope.trim()})` : "";
  const subject = `${type}${scopeStr}: ${desc.trim()}`;
  return { subject, body: body.trim() };
}

export function registerCommitCommand(program: Command): void {
  program
    .command("commit")
    .alias("c")
    .description("Stage, write a message with AI, commit, push, and open a PR")
    .option("-m, --message <message>", "Commit message (skips AI generation)")
    .option("-a, --all", "Stage all modified and untracked files before committing")
    .option("--amend", "Amend previous commit")
    .option("-n, --no-verify", "Bypass pre-commit and commit-msg hooks")
    .option("-S, --gpg-sign", "GPG-sign commits")
    .option("-s, --signoff", "Add Signed-off-by line at the end of the commit message")
    .option("-i, --issue <issue>", "Link commit and PR to a GitHub issue number (e.g. 42)")
    .option("-y, --yes", "Answer every confirmation with yes (required for non-interactive use)")
    .option("--review", "Run pre-commit hygiene scan for console.log, debugger, and localhost URLs")
    .option("--push", "Automatically commit and push to remote tracking branch")
    .option("--pr", "Commit, push, and create a GitHub Pull Request with AI summary")
    .option("--no-ai", "Disable AI commit generation and launch Conventional Commit wizard")
    .option("--provider <provider>", "Override AI provider (codex or grok)")
    .option("--style <style>", "Override commit style (conventional, gitmoji, concise)")
    .action(async (options: {
      message?: string;
      all?: boolean;
      amend?: boolean;
      noVerify?: boolean;
      gpgSign?: boolean;
      signoff?: boolean;
      issue?: string;
      yes?: boolean;
      review?: boolean;
      push?: boolean;
      pr?: boolean;
      ai?: boolean;
      provider?: string;
      style?: string;
    }) => {
      header(options.amend ? "Amend Last Commit" : "Commit & Stacked Actions");

      if (!(await isGitRepo())) {
        fail("Not a git repository. Run `git init` or navigate to a repository.");
        return;
      }

      if (options.message !== undefined && options.message.trim().length === 0) {
        fail("Commit message cannot be empty.");
        return;
      }

      if (options.amend && !(await hasCommits())) {
        fail("Cannot amend: repository has no commits yet.");
        return;
      }

      let status = await getStatus();

      // Guard against unresolved merge conflicts
      if (status.conflicts.length > 0) {
        fail(`Unresolved merge conflicts detected in ${status.conflicts.length} file(s):`);
        for (const c of status.conflicts) {
          p.log.message(`  ${pc.red("✖")} ${pc.bold(c.path)}`);
        }
        p.log.info(`Run ${pc.bold(pc.cyan("ggh resolve"))} to resolve conflicts interactively.`);
        p.cancel("Please resolve all merge conflicts and stage the resolution before committing.");
        return;
      }

      // Handle Staging
      if (options.all) {
        await stageAll();
        status = await getStatus();
      } else if (status.staged.length === 0 && !options.amend) {
        const unstagedAndUntracked = [...status.unstaged, ...status.untracked];
        if (unstagedAndUntracked.length === 0) {
          p.log.info(pc.dim("Working tree is clean. Nothing to commit."));
          return;
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
        p.log.warn("No files staged for commit.");
        return;
      }

      p.log.step(
        `Staged ${pc.green(String(status.staged.length))} file(s) on branch ${pc.cyan(status.branch)}`,
      );

      // Code Hygiene Scanner (--review), Large File Guard, and Submodule Guard are independent — run in parallel.
      // The diff is only fetched when something needs it (hygiene scan, AI generation, or PR creation).
      const needsDiff = Boolean(options.review || options.pr || (!options.message && options.ai !== false));
      const [rawDiff, largeFileCheck, submoduleStatus] = await Promise.all([
        needsDiff ? getStagedDiff() : Promise.resolve(""),
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
          const proceed = await confirmPrompt({
            message: "Proceed with commit anyway?",
            initialValue: true,
            assumeYes: options.yes,
          });
          if (!proceed) {
            p.cancel("Commit cancelled to address code hygiene.");
            return;
          }
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
        const proceedSubmod = await confirmPrompt({
          message: "Proceed with commit anyway?",
          initialValue: true,
          assumeYes: options.yes,
        });
        if (!proceedSubmod) {
          p.cancel("Commit cancelled to address submodules.");
          return;
        }
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
            validate: (v) => (!v || !v.trim() ? "Branch name required" : undefined),
          });

          if (!featureNameInput) {
            p.cancel("Commit cancelled.");
            return;
          }

          const newBranch = featureNameInput.trim();
          await switchBranch(newBranch, true);
          status = await getStatus();
          p.log.success(`Created and switched to feature branch ${pc.bold(pc.cyan(newBranch))}!`);
        }
      }

      // Resolve Commit Message
      let commitSubject = options.message;
      let commitBody = "";

      if (!commitSubject && options.ai === false) {
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
        const diffStat = await getStagedDiffStat();

        // Strip lockfiles/binaries/.env blocks and redact secrets in a single pass;
        // this is the only diff text that ever leaves the machine.
        const { diff: sanitizedDiff, redactedCount } = sanitizeDiffForAI(rawDiff);
        if (redactedCount > 0) {
          p.log.warn(pc.yellow(`Redacted ${redactedCount} potential secret(s) from diff sent to AI.`));
        }

        // Style precedence: --style flag, then configured style, then whatever
        // the last ten commits in this repository already use.
        const activeStyle: CommitStyle =
          options.style && ["conventional", "gitmoji", "concise"].includes(options.style)
            ? (options.style as CommitStyle)
            : config.commit_style && config.commit_style !== "auto"
              ? (config.commit_style as CommitStyle)
              : detectCommitConvention(await getRecentCommits(10));

        let customGuidance: string | undefined;
        let generationLoop = true;

        while (generationLoop) {
          const s = p.spinner();
          s.start("Generating commit message with AI...");

          try {
            const { result: aiResult, providerName, model: activeModel, failures } =
              await generateCommitWithFallback(
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
          if (options.push || options.pr) {
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
              { value: "commit", label: "Commit", hint: "Create local commit" },
              { value: "push", label: "Commit & Push", hint: `Push to origin/${status.branch}` },
              { value: "pr", label: prLabel, hint: prHint },
              { value: "diff", label: "View diff", hint: "Inspect colored diff of staged changes" },
              { value: "edit", label: "Edit message", hint: "Modify subject or body" },
              { value: "regenerate", label: "Regenerate message", hint: "Try again or provide guidance" },
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

      // Execute Commit (or Amend)
      const commitSpinner = p.spinner();
      commitSpinner.start(options.amend ? "Amending commit..." : "Creating commit...");
      try {
        await commit(commitSubject, commitBody, {
          noVerify: options.noVerify,
          gpgSign: options.gpgSign,
          signoff: options.signoff,
          amend: options.amend,
        });
        commitSpinner.stop(pc.green(options.amend ? "Commit amended successfully!" : "Commit created successfully!"));
      } catch (err: unknown) {
        commitSpinner.stop(pc.red("Git commit failed."));
        const execErr = err as { stderr?: string; stdout?: string };
        const output = execErr.stderr || execErr.stdout || String(err);
        fail(output);
        return;
      }

      // Protected Branch Direct Push Guard
      if (options.push && !options.pr) {
        const isProtected = ["main", "master", "release", "prod", "production"].includes(
          status.branch.toLowerCase(),
        );
        if (isProtected) {
          const confirmProtected = await confirmPrompt({
            message: `You are on protected branch ${pc.bold(pc.yellow(status.branch))}. Push directly without a PR?`,
            initialValue: false,
            assumeYes: options.yes,
          });
          if (!confirmProtected) {
            p.log.info("Push cancelled. Consider running `ggh c --pr` to open a Pull Request.");
            options.push = false;
          }
        }
      }

      // Handle Push
      if (options.push || options.pr) {
        if (status.isDetached || status.branch === "HEAD") {
          fail("Cannot push or open a Pull Request from a detached HEAD state. Please create or switch to a branch first.");
          options.push = false;
          options.pr = false;
          process.exitCode = 1;
          return;
        }

        const remotes = await getRemotes();
        if (remotes.length === 0) {
          p.log.warn("No git remote configured. Commit was created locally, but cannot push to remote.");
          p.log.info(`Add a remote with \`git remote add origin <url>\` and push with \`git push -u origin ${status.branch}\`.`);
          options.push = false;
          options.pr = false;
          return;
        }

        const pushSpinner = p.spinner();
        pushSpinner.start(`Pushing to remote branch ${pc.cyan(status.branch)}...`);
        try {
          await push({ branch: status.branch, noVerify: options.noVerify });
          pushSpinner.stop(pc.green("Pushed to remote successfully!"));
        } catch (err) {
          pushSpinner.stop(pc.yellow("Push failed or was rejected."));
          const retryRebase = await confirmPrompt({
            message: "Remote branch may have new changes. Run `git pull --rebase` and retry?",
            initialValue: true,
            assumeYes: options.yes,
          });

          if (retryRebase) {
            const rebaseSpinner = p.spinner();
            rebaseSpinner.start("Pulling remote changes with rebase...");
            try {
              await pullRebase();
              rebaseSpinner.stop(pc.green("Rebase completed. Retrying push..."));
              await push({ branch: status.branch, noVerify: options.noVerify });
              p.log.success(pc.green("Pushed to remote successfully!"));
            } catch (rebaseErr) {
              rebaseSpinner.stop(pc.red("Rebase or push failed. Please resolve conflicts manually."));
              fail(String(rebaseErr));
              return;
            }
          } else {
            fail(String(err));
            return;
          }
        }
      }

      // Handle PR Creation (Auto PR)
      if (options.pr) {
        const ghAuth = await getGitHubAuthStatus();
        if (!ghAuth.authenticated) {
          p.log.warn(
            ghAuth.notInstalled
              ? "GitHub CLI (`gh`) is not installed. Install it from https://cli.github.com to create PRs automatically."
              : "GitHub CLI is not authenticated. Cannot create PR automatically.",
          );
          process.exitCode = 1;
          return;
        }

        const activePr = await getActivePullRequest();
        if (activePr) {
          p.log.success(pc.green(`Pushed updates to active Pull Request #${activePr.number}: ${pc.bold(pc.cyan(activePr.url))}`));
          p.outro(pc.green("All operations completed successfully!"));
          return;
        }

        const prSpinner = p.spinner();
        prSpinner.start("Generating AI Pull Request content...");

        const [prTemplate, defaultBranch] = await Promise.all([findPrTemplate(), detectDefaultBranch()]);

        // The staged diff is empty now that the commit exists; a PR is the whole
        // branch, so describe it from base...HEAD instead.
        const [branchDiff, branchDiffStat, branchCommits] = await Promise.all([
          getBranchDiff(defaultBranch),
          getBranchDiffStat(defaultBranch),
          getCommitsSinceBase(defaultBranch),
        ]);

        if (prTemplate) {
          p.log.info(pc.dim("Detected repository PR template in .github/"));
        }

        let prTitle = commitSubject;
        let prBody = commitBody;

        try {
          const { result: prAi } = await generatePrWithFallback(
            {
              branch: status.branch,
              baseBranch: defaultBranch,
              // Never send raw diffs (lockfiles, .env, secrets) to the AI provider
              diff: sanitizeDiffForAI(branchDiff || rawDiff).diff,
              diffStat: branchDiffStat,
              commitSummary: branchCommits.length > 0 ? branchCommits.join("\n") : commitSubject,
              template: prTemplate || undefined,
              issue: options.issue,
            },
            options.provider as ConfigAIProvider | undefined,
            (failure: AIAttemptFailure, next?: AIAttempt) => {
              prSpinner.message(formatAIFallback(failure, next));
            },
          );
          prTitle = prAi.title;
          prBody = prAi.body;
          prSpinner.stop("PR content generated.");
        } catch (err) {
          prSpinner.stop(pc.yellow("Using commit message for PR content."));
          reportAIFailure(err, "AI Pull Request generation failed:");
        }

        p.note(`${pc.bold(prTitle)}\n\n${pc.dim(prBody)}`, "Proposed Pull Request");

        const confirmPr = await confirmPrompt({
          message: "Create this Pull Request now on GitHub?",
          initialValue: true,
          assumeYes: options.yes,
        });

        if (confirmPr) {
          const createSpinner = p.spinner();
          createSpinner.start("Creating Pull Request on GitHub...");
          try {
            const prUrl = await createPullRequest({
              title: prTitle,
              body: prBody,
            });
            createSpinner.stop(pc.green("Pull Request created!"));
            p.log.success(`PR URL: ${pc.bold(pc.cyan(prUrl))}`);
          } catch (err) {
            createSpinner.stop(pc.red("Failed to create PR."));
            fail(String(err));
            return;
          }
        }
      }

      p.outro(pc.green("All operations completed successfully!"));
    });
}
