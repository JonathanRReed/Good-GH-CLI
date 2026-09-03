import { Command } from "commander";
import {
  createRepository,
  forkRepository,
  getGitHubAuthStatus,
  getRepositoryReadme,
  ghApi,
  setDefaultRepository,
  viewRepository,
} from "../services/github.ts";
import { getFlags } from "../services/runtime.ts";
import { isDryRun } from "../utils/flags.ts";
import { confirmPrompt, emitJson, fail, header, p, pc, promptInput, selectMenu } from "../utils/ui.ts";

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

export function registerRepoCommand(program: Command): void {
  const repo = program
    .command("repo [nameWithOwner]")
    .description("View, fork, create, and set the default GitHub repository")
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

      if (getFlags().json) {
        emitJson(detail);
        return;
      }

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

      if (isDryRun()) {
        p.log.warn(`${pc.yellow("dry run")} ${pc.dim("·")} would fork ${nameWithOwner}`);
        return;
      }

      const confirmed = await confirmPrompt({
        message: `Fork ${pc.bold(nameWithOwner)} to your account?`,
        initialValue: true,
        assumeYes: options?.yes,
      });
      if (!confirmed) {
        p.cancel("Cancelled.");
        return;
      }

      const s = p.spinner();
      s.start("Forking...");
      try {
        const out = await forkRepository(nameWithOwner, { clone: options?.clone, remote: options?.remote });
        s.stop(pc.green("Forked."));
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

      if (isDryRun()) {
        p.log.warn(`${pc.yellow("dry run")} ${pc.dim("·")} would set the default to ${nameWithOwner}`);
        return;
      }

      try {
        await setDefaultRepository(nameWithOwner);
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
    .option("-y, --yes", "Skip the confirmation prompt")
    .action(async (name?: string, options?: {
      public?: boolean; private?: boolean; internal?: boolean;
      description?: string; source?: string; push?: boolean; yes?: boolean;
    }) => {
      header("Create Repository");
      if (!(await requireAuth())) return;

      let repoName = name;
      if (!repoName) {
        const typed = await promptInput({
          message: "Repository name:",
          validate: (v) => (!v || !v.trim() ? "Name required" : undefined),
        });
        if (!typed) {
          p.cancel("Cancelled.");
          return;
        }
        repoName = typed;
      }

      let visibility: "public" | "private" | "internal" | null = options?.public
        ? "public"
        : options?.private
          ? "private"
          : options?.internal
            ? "internal"
            : null;

      if (!visibility) {
        visibility = await selectMenu<"public" | "private" | "internal">({
          message: "Visibility:",
          options: [
            { value: "private", label: "Private", hint: "only you and collaborators" },
            { value: "public", label: "Public", hint: "visible to everyone" },
            { value: "internal", label: "Internal", hint: "organisation members only" },
          ],
          initialValue: "private",
        });
        if (!visibility) {
          p.cancel("Cancelled.");
          return;
        }
      }

      if (isDryRun()) {
        p.log.warn(`${pc.yellow("dry run")} ${pc.dim("·")} would create ${visibility} repository ${repoName}`);
        return;
      }

      const confirmed = await confirmPrompt({
        message: `Create ${pc.bold(visibility)} repository ${pc.bold(pc.cyan(repoName))}?`,
        initialValue: true,
        assumeYes: options?.yes,
      });
      if (!confirmed) {
        p.cancel("Cancelled.");
        return;
      }

      const s = p.spinner();
      s.start("Creating repository...");
      try {
        const out = await createRepository({
          name: repoName,
          visibility,
          description: options?.description,
          source: options?.source,
          push: options?.push,
        });
        s.stop(pc.green("Repository created."));
        if (out) p.log.message(pc.bold(pc.cyan(out)));
        p.outro("Done.");
      } catch (err) {
        s.stop(pc.red("Creation failed."));
        fail(String(err));
      }
    });
}

/**
 * The escape hatch. Anything not wrapped by a ggh command stays reachable,
 * so a missing feature never becomes a hard wall.
 */
export function registerApiCommand(program: Command): void {
  program
    .command("api <endpoint...>")
    .description("Make an authenticated GitHub API request (passthrough to `gh api`)")
    .allowUnknownOption(true)
    .helpOption(false)
    .action(async (endpoint: string[]) => {
      const code = await ghApi(endpoint);
      process.exitCode = code;
    });
}
