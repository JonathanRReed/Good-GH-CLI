import { Command } from "commander";
import {
  checkLargeFiles,
  checkSubmodules,
  commit,
  findPrTemplate,
  getRecentCommits,
  getStagedDiff,
  getStagedDiffStat,
  getStatus,
  isGitRepo,
  pullRebase,
  push,
  stageAll,
  stageFiles,
  switchBranch,
} from "../services/git.ts";
import {
  ensureFirstRunSetup,
  generateCommitWithFallback,
  resolveAIProvider,
} from "../services/ai/index.ts";
import { createPullRequest, getActivePullRequest, getGitHubAuthStatus } from "../services/github.ts";
import { getConfig, type AIProvider as ConfigAIProvider } from "../services/config.ts";
import { redactSecrets, scanCodeHygiene, stripLockfilesFromDiff } from "../utils/diff.ts";
import { detectCommitConvention, type CommitStyle } from "../utils/conventions.ts";
import { header, p, pc, promptFirstRunProvider } from "../utils/ui.ts";

function displayColoredDiff(rawDiff: string): void {
  const lines = rawDiff.split("\n");
  const output: string[] = [];
  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      output.push(pc.green(line));
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      output.push(pc.red(line));
    } else if (line.startsWith("@@")) {
      output.push(pc.cyan(line));
    } else if (line.startsWith("diff --git") || line.startsWith("index ")) {
      output.push(pc.bold(pc.dim(line)));
    } else {
      output.push(line);
    }
  }
  console.log("\n" + output.join("\n") + "\n");
}

async function promptConventionalCommitWizard(): Promise<{ subject: string; body: string }> {
  p.log.step("Conventional Commit Wizard");
  const type = await p.select({
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
  if (p.isCancel(type)) throw new Error("cancelled");

  const scope = await p.text({
    message: "Enter scope (optional, press Enter to skip):",
    placeholder: "e.g. auth, api, ui",
  });
  if (p.isCancel(scope)) throw new Error("cancelled");

  const desc = await p.text({
    message: "Enter short description (imperative, <= 72 chars):",
    validate: (v) => (!v || !v.trim() ? "Description required" : undefined),
  });
  if (p.isCancel(desc)) throw new Error("cancelled");

  const body = await p.text({
    message: "Enter commit body / bullet points (optional, press Enter to skip):",
  });
  if (p.isCancel(body)) throw new Error("cancelled");

  const scopeStr = scope && (scope as string).trim() ? `(${scope.trim()})` : "";
  const subject = `${type}${scopeStr}: ${desc.trim()}`;
  return { subject, body: (body as string).trim() };
}

export function registerCommitCommand(program: Command): void {
  program
    .command("commit")
    .alias("c")
    .description("Streamlined git commit with interactive staging, AI messages, and stacked actions")
    .option("-m, --message <message>", "Commit message (skips AI generation)")
    .option("-a, --all", "Stage all modified and untracked files before committing")
    .option("--amend", "Amend previous commit")
    .option("-n, --no-verify", "Bypass pre-commit and commit-msg hooks")
    .option("-S, --gpg-sign", "GPG-sign commits")
    .option("-s, --signoff", "Add Signed-off-by line at the end of the commit message")
    .option("-i, --issue <issue>", "Link commit and PR to a GitHub issue number (e.g. 42)")
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
      review?: boolean;
      push?: boolean;
      pr?: boolean;
      ai?: boolean;
      provider?: string;
      style?: string;
    }) => {
      header(options.amend ? "Amend Last Commit" : "Commit & Stacked Actions");

      if (!(await isGitRepo())) {
        p.log.error("Not a git repository. Run `git init` or navigate to a repository.");
        return;
      }

      let status = await getStatus();

      // Guard against unresolved merge conflicts
      if (status.conflicts.length > 0) {
        p.log.error(`Unresolved merge conflicts detected in ${status.conflicts.length} file(s):`);
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

        const stageChoice = await p.select({
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

        if (p.isCancel(stageChoice)) {
          p.cancel("Commit cancelled.");
          return;
        }

        if (stageChoice === "all") {
          await stageAll();
        } else {
          const selectedFiles = await p.multiselect({
            message: "Select files to stage (space to toggle, enter to confirm):",
            options: unstagedAndUntracked.map((f) => ({
              value: f.path,
              label: `${f.path} ${pc.dim(`(${f.status})`)}`,
            })),
            required: true,
          });

          if (p.isCancel(selectedFiles)) {
            p.cancel("Commit cancelled.");
            return;
          }

          await stageFiles(selectedFiles as string[]);
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

      // Code Hygiene Scanner (--review)
      const rawDiff = await getStagedDiff();
      if (options.review) {
        const hygieneIssues = scanCodeHygiene(rawDiff);
        if (hygieneIssues.length > 0) {
          p.log.warn(pc.yellow(`Pre-commit review found ${hygieneIssues.length} hygiene issue(s):`));
          for (const issue of hygieneIssues.slice(0, 5)) {
            p.log.message(`  ${pc.yellow("▲")} ${issue.message}: ${pc.dim(issue.line.slice(0, 60))}`);
          }
          const proceed = await p.confirm({
            message: "Proceed with commit anyway?",
            initialValue: true,
          });
          if (!proceed || p.isCancel(proceed)) {
            p.cancel("Commit cancelled to address code hygiene.");
            return;
          }
        } else {
          p.log.success(pc.green("Code hygiene check passed! No debug artifacts detected."));
        }
      }

      // Large File Pre-Commit Guard (GitHub 100MB hard limit)
      const { blocked, warnings } = await checkLargeFiles(status.staged);
      if (blocked.length > 0) {
        p.log.error(
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
      const submodules = await checkSubmodules();
      const dirtySubmodules = submodules.filter((s) => s.status !== "uninitialized");
      if (dirtySubmodules.length > 0) {
        p.log.warn(pc.yellow(`Detected ${dirtySubmodules.length} dirty/modified submodule(s):`));
        for (const s of dirtySubmodules) {
          p.log.message(`  ${pc.yellow("▲")} ${s.name} (${s.status}, commit: ${s.commit.slice(0, 7)})`);
        }
        const proceedSubmod = await p.confirm({
          message: "Proceed with commit anyway?",
          initialValue: true,
        });
        if (!proceedSubmod || p.isCancel(proceedSubmod)) {
          p.cancel("Commit cancelled to address submodules.");
          return;
        }
      }

      // Auto-Feature Branching (T3 Code pattern)
      const isDefaultBranch = ["main", "master"].includes(status.branch.toLowerCase());
      if (isDefaultBranch && !options.amend && !options.message) {
        const branchChoice = await p.select({
          message: `You are on default branch ${pc.bold(pc.yellow(status.branch))}. Where would you like to commit?`,
          options: [
            {
              value: "feature",
              label: "Create a feature branch (Recommended by T3 Code)",
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

        if (p.isCancel(branchChoice) || branchChoice === "cancel") {
          p.cancel("Commit cancelled.");
          return;
        }

        if (branchChoice === "feature") {
          const featureNameInput = await p.text({
            message: "Enter feature branch name:",
            placeholder: "e.g. feat/dashboard-layout",
            validate: (v) => (!v || !v.trim() ? "Branch name required" : undefined),
          });

          if (p.isCancel(featureNameInput)) {
            p.cancel("Commit cancelled.");
            return;
          }

          const newBranch = (featureNameInput as string).trim();
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

        // Secret scanning & sanitization
        const { redactedCount } = redactSecrets(rawDiff);
        if (redactedCount > 0) {
          p.log.warn(pc.yellow(`Redacted ${redactedCount} potential secret(s) from diff sent to AI.`));
        }

        const sanitizedDiff = stripLockfilesFromDiff(rawDiff);

        // Detect Style
        let activeStyle: CommitStyle = "conventional";
        if (options.style && ["conventional", "gitmoji", "concise"].includes(options.style)) {
          activeStyle = options.style as CommitStyle;
        } else if (config.commit_style && config.commit_style !== "auto") {
          activeStyle = config.commit_style as CommitStyle;
        } else {
          const recent = await getRecentCommits(10);
          activeStyle = detectCommitConvention(recent);
        }

        let customGuidance: string | undefined;
        let generationLoop = true;

        while (generationLoop) {
          const s = p.spinner();
          s.start("Generating commit message with AI...");

          try {
            const { result: aiResult, providerName, model: activeModel } =
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
                (primary, fallback) => {
                  s.message(`Primary provider ${pc.yellow(primary)} failed. Falling back to ${pc.cyan(fallback)}...`);
                },
              );
            s.stop(`Commit message generated by ${pc.bold(providerName)} [${pc.cyan(activeModel)}].`);

            commitSubject = aiResult.subject;
            commitBody = aiResult.body;
          } catch {
            s.stop(pc.yellow("AI generation unavailable. Launching Conventional Commit wizard..."));
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

          const action = await p.select({
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

          if (p.isCancel(action) || action === "cancel") {
            p.cancel("Commit cancelled.");
            return;
          }

          if (action === "diff") {
            displayColoredDiff(rawDiff);
            continue;
          } else if (action === "edit") {
            const editSub = await p.text({
              message: "Edit commit subject:",
              defaultValue: commitSubject,
            });
            if (p.isCancel(editSub)) return;
            commitSubject = editSub as string;

            const editBody = await p.text({
              message: "Edit commit body (optional):",
              defaultValue: commitBody,
            });
            if (p.isCancel(editBody)) return;
            commitBody = editBody as string;
            generationLoop = false;
          } else if (action === "regenerate") {
            const guidance = await p.text({
              message: "Enter guidance or hints for regeneration (optional):",
              placeholder: "e.g. emphasize breaking change or make it shorter",
            });
            if (p.isCancel(guidance)) return;
            customGuidance = guidance as string;
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

      if (!commitSubject) {
        p.cancel("Commit cancelled.");
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
        });
        commitSpinner.stop(pc.green(options.amend ? "Commit amended successfully!" : "Commit created successfully!"));
      } catch (err: unknown) {
        commitSpinner.stop(pc.red("Git commit failed."));
        const execaErr = err as { stderr?: string; stdout?: string };
        const output = execaErr.stderr || execaErr.stdout || String(err);
        p.log.error(output);
        return;
      }

      // Protected Branch Direct Push Guard
      if (options.push && !options.pr) {
        const isProtected = ["main", "master", "release", "prod", "production"].includes(
          status.branch.toLowerCase(),
        );
        if (isProtected) {
          const confirmProtected = await p.confirm({
            message: `You are on protected branch ${pc.bold(pc.yellow(status.branch))}. Push directly without a PR?`,
            initialValue: false,
          });
          if (!confirmProtected || p.isCancel(confirmProtected)) {
            p.log.info("Push cancelled. Consider running `ggh c --pr` to open a Pull Request.");
            options.push = false;
          }
        }
      }

      // Handle Push
      if (options.push || options.pr) {
        const pushSpinner = p.spinner();
        pushSpinner.start(`Pushing to remote branch ${pc.cyan(status.branch)}...`);
        try {
          await push({ branch: status.branch, noVerify: options.noVerify });
          pushSpinner.stop(pc.green("Pushed to remote successfully!"));
        } catch (err) {
          pushSpinner.stop(pc.yellow("Push failed or was rejected."));
          const retryRebase = await p.confirm({
            message: "Remote branch may have new changes. Run `git pull --rebase` and retry?",
            initialValue: true,
          });

          if (retryRebase && !p.isCancel(retryRebase)) {
            const rebaseSpinner = p.spinner();
            rebaseSpinner.start("Pulling remote changes with rebase...");
            try {
              await pullRebase();
              rebaseSpinner.stop(pc.green("Rebase completed. Retrying push..."));
              await push({ branch: status.branch, noVerify: options.noVerify });
              p.log.success(pc.green("Pushed to remote successfully!"));
            } catch (rebaseErr) {
              rebaseSpinner.stop(pc.red("Rebase or push failed. Please resolve conflicts manually."));
              p.log.error(String(rebaseErr));
              return;
            }
          } else {
            p.log.error(String(err));
            return;
          }
        }
      }

      // Handle PR Creation (Auto PR)
      if (options.pr) {
        const ghAuth = await getGitHubAuthStatus();
        if (!ghAuth.authenticated) {
          p.log.warn("GitHub CLI is not authenticated. Cannot create PR automatically.");
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

        const diffStat = await getStagedDiffStat();
        const prTemplate = await findPrTemplate();

        if (prTemplate) {
          p.log.info(pc.dim("Detected repository PR template in .github/"));
        }

        const { provider, model } = await resolveAIProvider(
          options.provider as ConfigAIProvider | undefined,
        );

        let prTitle = commitSubject;
        let prBody = commitBody;

        try {
          const prAi = await provider.generatePr(
            {
              branch: status.branch,
              baseBranch: "main",
              diff: rawDiff,
              diffStat,
              commitSummary: commitSubject,
              template: prTemplate || undefined,
              issue: options.issue,
            },
            model,
          );
          prTitle = prAi.title;
          prBody = prAi.body;
          prSpinner.stop("PR content generated.");
        } catch {
          prSpinner.stop(pc.yellow("Using commit message for PR content."));
        }

        p.note(`${pc.bold(prTitle)}\n\n${pc.dim(prBody)}`, "Proposed Pull Request");

        const confirmPr = await p.confirm({
          message: "Create this Pull Request now on GitHub?",
          initialValue: true,
        });

        if (confirmPr && !p.isCancel(confirmPr)) {
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
            p.log.error(String(err));
          }
        }
      }

      p.outro(pc.green("All operations completed successfully!"));
    });
}
