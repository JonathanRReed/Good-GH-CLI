import { publicationSnapshot, assertPublicationApproval, PublicationApprovalError } from "../services/publication-approval.ts";
import { Command } from "commander";
import {
  clampLimit,
  forkRepository,
  getRepositoryReadme,
  gh,
  listUserRepositories,
  requireAuth,
  setDefaultRepository,
  viewRepository,
} from "../services/github.ts";
import { preparePublication, executePublication } from "../services/publication.ts";
import { getConfig } from "../services/config.ts";
import { isNonInteractive, recordCommandIssue } from "../services/runtime.ts";
import { invalidateCache } from "../services/cache.ts";
import { dryRun } from "../utils/flags.ts";
import { fail, failFromGitHub, header, p, pc, promptInput, jsonOut, confirmOrAbort } from "../utils/ui.ts";

export function registerRepoCommand(program: Command): void {
  const repo = program
    .command("repo [nameWithOwner]")
    .description("View, fork, create, and set the default repository")
    .option("--readme", "Include the README in the output")
    .action(async (nameWithOwner?: string, options?: { readme?: boolean }) => {
      header("Repository");
      if (!(await requireAuth())) return;

      const s = p.spinner();
      s.start(`Fetching ${nameWithOwner || "this repository"}...`);
      const detail = await viewRepository(nameWithOwner);
      s.stop(detail ? "Loaded." : pc.yellow("Not found."));

      if (!detail) {
        fail(nameWithOwner ? `Repository '${nameWithOwner}' not found.` : "Not inside a GitHub repository.");
        return;
      }

      if (jsonOut(detail)) return;

      p.log.step(pc.bold(detail.nameWithOwner) + (detail.isPrivate ? pc.dim(" (private)") : ""));
      if (detail.description) p.log.message(`  ${detail.description}`);
      p.log.message(
        `  ${pc.yellow("★")} ${detail.stargazerCount}  ${pc.cyan("⑂")} ${detail.forkCount}` +
          (detail.primaryLanguage ? `  ${pc.dim("·")} ${detail.primaryLanguage.name}` : "") +
          (detail.licenseInfo ? `  ${pc.dim("·")} ${detail.licenseInfo.name}` : ""),
      );
      p.log.message(`  Default branch: ${pc.cyan(detail.defaultBranchRef?.name ?? "unknown")}`);
      if (detail.repositoryTopics?.length) {
        p.log.message(`  Topics: ${detail.repositoryTopics.map((t) => pc.cyan(t.name)).join(", ")}`);
      }

      if (options?.readme) {
        const readme = await getRepositoryReadme(detail.nameWithOwner);
        if (readme) p.note(readme.slice(0, 3000), "README");
      }

      p.outro(pc.dim(detail.url));
    });

  repo.command("fork <nameWithOwner>")
    .description("Fork a repository to your account")
    .option("-c, --clone", "Clone the fork after creating it")
    .option("--remote", "Add the fork as a git remote")
    .option("-y, --yes", "Skip the confirmation prompt")
    .action(async (nameWithOwner: string, options?: { clone?: boolean; remote?: boolean; yes?: boolean }) => {
      header("Fork Repository");
      if (!(await requireAuth())) return;

      if (dryRun(`fork ${nameWithOwner}`)) return;

      if (!(await confirmOrAbort(`Fork ${pc.bold(nameWithOwner)} to your account?`, { assumeYes: options?.yes }))) return;

      const s = p.spinner();
      s.start("Forking...");
      try {
        const out = await forkRepository(nameWithOwner, { clone: options?.clone, remote: options?.remote });
        s.stop(pc.green("Forked."));
        if (jsonOut({ action: "fork", nameWithOwner, output: out || null })) return;
        if (out) p.log.message(pc.dim(out));
        p.outro("Done.");
      } catch (err) {
        s.stop(pc.red("Fork failed."));
        fail(String(err));
      }
    });

  repo.command("set-default <nameWithOwner>")
    .description("Set the repository that pr, issue, run, and release commands target")
    .action(async (nameWithOwner: string) => {
      header("Set Default Repository");
      if (!(await requireAuth())) return;

      if (dryRun(`set the default to ${nameWithOwner}`)) return;

      try {
        await setDefaultRepository(nameWithOwner);
        if (jsonOut({ action: "set-default", nameWithOwner })) return;
        p.log.success(pc.green(`Default repository set to ${pc.bold(nameWithOwner)}.`));
        p.outro("Ambiguous-remote errors in other commands should stop now.");
      } catch (err) {
        fail(String(err));
      }
    });

  repo.command("create [name]")
    .description("Create a repository on GitHub, optionally from this directory")
    .option("--public", "Create as public")
    .option("--private", "Create as private")
    .option("--internal", "Create as internal")
    .option("-d, --description <text>", "Repository description")
    .option("--source <path>", "Push an existing local repository from this path")
    .option("--push", "Push the current commits after creating")
    .option("--no-push", "Create without pushing commits")
    .option("--remote <name>", "Remote to add or reuse, default origin")
    .option("--approve-plan <sha256>", "Approve the exact dry-run snapshot")
    .option("--confirm", "Ask before creating and pushing")
    .option("--no-confirm", "Use inferred defaults without confirmation")
    .option("-y, --yes", "Skip the confirmation prompt")
    .action(async (name?: string, options?: {
      public?: boolean; private?: boolean; internal?: boolean;
      approvePlan?: string; description?: string; source?: string; push?: boolean; remote?: string; yes?: boolean; confirm?: boolean;
    }) => {
      header("Create Repository");
      if ([options?.public, options?.private, options?.internal].filter(Boolean).length > 1) {
        fail("Choose one visibility: --private, --public, or --internal.");
        return;
      }
      try {
        const request = {
          kind: "repo" as const, name, source: options?.source, remote: options?.remote,
          visibility: options?.public ? "public" as const : options?.internal ? "internal" as const : "private" as const,
          description: options?.description,
          ...(options?.push === undefined ? {} : { push: options.push }),
        };
        let prepared = await preparePublication(request);
        if (prepared.status === "needs_input" && prepared.required === "name" && !isNonInteractive()) {
          const typed = await promptInput({ message: "Repository name:", validate: value => value.trim() ? undefined : "Name required" });
          if (!typed) { p.cancel("Cancelled."); return; }
          prepared = await preparePublication({ ...request, name: typed });
        }
        if (prepared.status === "needs_input") {
          recordCommandIssue({ status: "needs_input", code: "missing_input", requiredInputs: [{ name: prepared.required, description: prepared.message }], message: prepared.message });
          jsonOut(prepared);
          fail(prepared.message);
          return;
        }
        const plan = prepared.plan;
        const snapshotId = await publicationSnapshot(plan);
        assertPublicationApproval(options?.approvePlan, snapshotId);
        p.note(`${plan.host}/${plan.target} (${plan.visibility})\n${plan.remote}: ${plan.remoteUrl}${plan.pushUrl !== plan.remoteUrl ? `\npush: ${plan.pushUrl}` : ""}\n${plan.steps.join(" → ")}\n${plan.root ?? "Remote repository only"}${plan.headTip ? `\n${plan.head} ${plan.headTip.slice(0, 12)}` : ""}`, "Publication plan");
        if (dryRun(`publish ${plan.target}: ${plan.steps.join(", ")}`)) { jsonOut({ status: "planned", snapshotId, plan }); return; }
        const confirmSetting = options?.confirm ?? getConfig().repo_create_confirm;
        if (!(await confirmOrAbort(`Create or publish ${plan.target}${plan.steps.includes("create_repository") ? ` as ${plan.visibility}` : " using its existing visibility"}?`, { assumeYes: Boolean(options?.approvePlan) || options?.yes || !confirmSetting }))) return;
        const result = await executePublication(plan, undefined, { approvedSnapshot: snapshotId });
        if (result.status !== "succeeded") fail(result.error ?? "Repository publication did not complete.");
        if (jsonOut({ ...result, name: plan.target.split("/").at(-1), ...(plan.steps.includes("create_repository") ? { visibility: plan.visibility } : {}) })) return;
        if (result.url) p.log.message(result.url);
        if (result.status === "succeeded") p.outro("Repository ready.");
        else p.log.info(`Completed: ${result.completed.join(", ") || "none"}. Remaining: ${result.remaining.join(", ") || "none"}. Inspect the target before retrying.`);
      } catch (error) {
        if (error instanceof PublicationApprovalError) recordCommandIssue(error.issue);
        failFromGitHub(error);
      }
    });

  repo
    .command("list")
    .description("List repositories for the authenticated user or organisation")
    .option("--limit <n>", "Maximum repositories to list", "30")
    .action(async (options?: { limit?: string }) => {
      header("Repositories");
      if (!(await requireAuth())) return;

      const s = p.spinner();
      s.start("Fetching repositories...");
      try {
        const repos = await listUserRepositories({
          limit: clampLimit(Number.parseInt(options?.limit ?? "30", 10)),
        });
        s.stop(`Loaded ${pc.green(String(repos.length))} repository(s).`);
        if (jsonOut(repos)) return;
        if (repos.length === 0) {
          p.log.info(pc.dim("No repositories found."));
          return;
        }
        for (const r of repos) {
          p.log.message(`  ${pc.bold(r.nameWithOwner)} ${pc.dim(r.isPrivate ? "private" : "public")}`);
        }
      } catch (err) {
        s.stop(pc.red("Failed to fetch repositories."));
        failFromGitHub(err);
      }
    });

  repo
    .command("delete <nameWithOwner>")
    .description("Delete a repository")
    .option("-y, --yes", "Skip the confirmation prompt")
    .action(async (nameWithOwner: string, options?: { yes?: boolean }) => {
      header("Delete Repository");
      if (!(await requireAuth())) return;

      if (dryRun(`delete ${nameWithOwner}`)) return;

      if (!(await confirmOrAbort(`Delete repository ${pc.bold(nameWithOwner)}? This cannot be undone.`, { assumeYes: options?.yes, initialValue: false }))) return;

      const s = p.spinner();
      s.start(`Deleting ${nameWithOwner}...`);
      try {
        await gh(["repo", "delete", nameWithOwner, "--yes"]);
        invalidateCache("repo-list:");
        s.stop(pc.green("Repository deleted."));
        if (jsonOut({ nameWithOwner, action: "delete" })) return;
        p.outro("Done.");
      } catch (err) {
        s.stop(pc.red("Delete failed."));
        failFromGitHub(err);
      }
    });

  repo
    .command("archive <nameWithOwner>")
    .description("Archive a repository")
    .option("-y, --yes", "Skip the confirmation prompt")
    .action(async (nameWithOwner: string, options?: { yes?: boolean }) => {
      header("Archive Repository");
      if (!(await requireAuth())) return;

      if (dryRun(`archive ${nameWithOwner}`)) return;

      if (!(await confirmOrAbort(`Archive repository ${pc.bold(nameWithOwner)}?`, { assumeYes: options?.yes }))) return;

      const s = p.spinner();
      s.start(`Archiving ${nameWithOwner}...`);
      try {
        await gh(["repo", "archive", nameWithOwner, "--yes"]);
        invalidateCache("repo-list:");
        s.stop(pc.green("Repository archived."));
        if (jsonOut({ nameWithOwner, action: "archive" })) return;
        p.outro("Done.");
      } catch (err) {
        s.stop(pc.red("Archive failed."));
        failFromGitHub(err);
      }
    });

  repo
    .command("unarchive <nameWithOwner>")
    .description("Unarchive a repository")
    .option("-y, --yes", "Skip the confirmation prompt")
    .action(async (nameWithOwner: string, options?: { yes?: boolean }) => {
      header("Unarchive Repository");
      if (!(await requireAuth())) return;

      if (dryRun(`unarchive ${nameWithOwner}`)) return;

      if (!(await confirmOrAbort(`Unarchive repository ${pc.bold(nameWithOwner)}?`, { assumeYes: options?.yes }))) return;

      const s = p.spinner();
      s.start(`Unarchiving ${nameWithOwner}...`);
      try {
        await gh(["repo", "unarchive", nameWithOwner, "--yes"]);
        invalidateCache("repo-list:");
        s.stop(pc.green("Repository unarchived."));
        if (jsonOut({ nameWithOwner, action: "unarchive" })) return;
        p.outro("Done.");
      } catch (err) {
        s.stop(pc.red("Unarchive failed."));
        failFromGitHub(err);
      }
    });

  repo
    .command("rename <nameWithOwner> <newName>")
    .description("Rename a repository")
    .option("-y, --yes", "Skip the confirmation prompt")
    .action(async (nameWithOwner: string, newName: string, options?: { yes?: boolean }) => {
      header("Rename Repository");
      if (!(await requireAuth())) return;

      if (dryRun(`rename ${nameWithOwner} to ${newName}`)) return;

      if (!(await confirmOrAbort(`Rename repository ${pc.bold(nameWithOwner)} to ${pc.bold(newName)}?`, { assumeYes: options?.yes }))) return;

      const s = p.spinner();
      s.start(`Renaming ${nameWithOwner}...`);
      try {
        await gh(["repo", "rename", nameWithOwner, newName, "--yes"]);
        invalidateCache("repo-list:");
        s.stop(pc.green("Repository renamed."));
        if (jsonOut({ nameWithOwner, newName, action: "rename" })) return;
        p.outro("Done.");
      } catch (err) {
        s.stop(pc.red("Rename failed."));
        failFromGitHub(err);
      }
    });

  repo
    .command("edit <nameWithOwner>")
    .description("Edit repository settings")
    .option("-d, --description <text>", "Repository description")
    .option("--enable-wiki", "Enable the wiki")
    .option("--disable-wiki", "Disable the wiki")
    .option("--enable-issues", "Enable issues")
    .option("--disable-issues", "Disable issues")
    .option("-y, --yes", "Skip the confirmation prompt")
    .action(async (
      nameWithOwner: string,
      options?: {
        description?: string;
        enableWiki?: boolean;
        disableWiki?: boolean;
        enableIssues?: boolean;
        disableIssues?: boolean;
        yes?: boolean;
      },
    ) => {
      header("Edit Repository");
      if (!(await requireAuth())) return;

      if (dryRun(`edit ${nameWithOwner}`)) return;

      if (!(await confirmOrAbort(`Edit repository ${pc.bold(nameWithOwner)}?`, { assumeYes: options?.yes }))) return;

      const args = ["repo", "edit", nameWithOwner];
      if (options?.description) args.push("--description", options.description);
      if (options?.enableWiki) args.push("--enable-wiki");
      if (options?.disableWiki) args.push("--disable-wiki");
      if (options?.enableIssues) args.push("--enable-issues");
      if (options?.disableIssues) args.push("--disable-issues");

      const s = p.spinner();
      s.start(`Editing ${nameWithOwner}...`);
      try {
        await gh(args);
        invalidateCache("repo-list:");
        s.stop(pc.green("Repository updated."));
        if (jsonOut({ nameWithOwner, action: "edit" })) return;
        p.outro("Done.");
      } catch (err) {
        s.stop(pc.red("Edit failed."));
        failFromGitHub(err);
      }
    });

  repo
    .command("sync <nameWithOwner>")
    .description("Sync a forked repository with its upstream parent")
    .option("-b, --branch <branch>", "Branch to sync (defaults to the default branch)")
    .option("-f, --force", "Force sync")
    .option("-y, --yes", "Skip the confirmation prompt")
    .action(async (nameWithOwner: string, options?: { branch?: string; force?: boolean; yes?: boolean }) => {
      header("Sync Repository");
      if (!(await requireAuth())) return;

      if (dryRun(`sync ${nameWithOwner}`)) return;

      if (!(await confirmOrAbort(`Sync ${pc.bold(nameWithOwner)} with upstream?`, { assumeYes: options?.yes }))) return;

      const args = ["repo", "sync", nameWithOwner];
      if (options?.branch) args.push("--branch", options.branch);
      if (options?.force) args.push("--force");

      const s = p.spinner();
      s.start(`Syncing ${nameWithOwner}...`);
      try {
        await gh(args);
        s.stop(pc.green("Repository synced."));
        if (jsonOut({ nameWithOwner, action: "sync" })) return;
        p.outro("Done.");
      } catch (err) {
        s.stop(pc.red("Sync failed."));
        failFromGitHub(err);
      }
    });

  repo
    .command("clone <nameWithOwner> [directory]")
    .description("Clone a repository from GitHub")
    .option("--bare", "Clone as a bare repository")
    .action(async (nameWithOwner: string, directory?: string, options?: { bare?: boolean }) => {
      header("Clone Repository");
      if (!(await requireAuth())) return;

      if (dryRun(`clone ${nameWithOwner}`)) return;

      const args = ["repo", "clone", nameWithOwner];
      if (directory) args.push(directory);
      if (options?.bare) args.push("--bare");

      const s = p.spinner();
      s.start(`Cloning ${nameWithOwner}...`);
      try {
        await gh(args, { stdio: "inherit" });
        s.stop(pc.green("Repository cloned."));
        if (jsonOut({ nameWithOwner, directory, action: "clone" })) return;
        p.outro("Done.");
      } catch (err) {
        s.stop(pc.red("Clone failed."));
        failFromGitHub(err);
      }
    });
}
