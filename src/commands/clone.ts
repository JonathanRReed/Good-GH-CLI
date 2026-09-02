import { Command } from "commander";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { clone } from "../services/git.ts";
import {
  getGitHubAuthStatus,
  listStarredRepositories,
  listUserRepositories,
  normalizeCloneUrl,
  searchRepositories,
  type RepositoryItem,
} from "../services/github.ts";
import { getConfig, type CloneMode } from "../services/config.ts";
import { header, p, pc } from "../utils/ui.ts";

function expandPath(pathStr: string): string {
  if (pathStr.startsWith("~/") || pathStr === "~") {
    return join(homedir(), pathStr.slice(1));
  }
  return resolve(pathStr);
}

function extractRepoName(urlOrShorthand: string): string {
  const parts = urlOrShorthand.replace(/\.git$/, "").split(/[/:]/);
  return parts[parts.length - 1] || "project";
}

export function registerCloneCommand(program: Command): void {
  program
    .command("clone [repo]")
    .alias("add")
    .description("Quickly search, add, or clone a repository with fast git internals")
    .option("--fast, --blobless", "Use fast blobless clone (--filter=blob:none)")
    .option("--shallow", "Use shallow clone with depth 1 (--depth 1)")
    .option("-d, --dir <directory>", "Target directory for the cloned repository")
    .action(async (repoArg?: string, options?: { fast?: boolean; shallow?: boolean; dir?: string }) => {
      header("Clone & Add Project");

      let selectedRepo = repoArg;
      let cloneMode: CloneMode = options?.fast ? "blobless" : options?.shallow ? "shallow" : "standard";

      // Interactive discovery if no repo argument given
      if (!selectedRepo) {
        const ghAuth = await getGitHubAuthStatus();
        if (!ghAuth.authenticated) {
          p.log.warn(
            pc.yellow("GitHub CLI is not authenticated. You can still paste any repository URL."),
          );
        }

        const s = p.spinner();
        s.start("Loading your GitHub repositories...");
        const [userRepos, starredRepos] = await Promise.all([
          listUserRepositories(25),
          listStarredRepositories(10),
        ]);
        s.stop("Repositories loaded.");

        const choices: { value: string; label: string; hint?: string }[] = [];

        choices.push({
          value: "__search__",
          label: "🔍 Search all GitHub...",
          hint: "Type a query to search any public or private repo",
        });

        choices.push({
          value: "__custom__",
          label: "🔗 Enter custom URL or owner/repo",
          hint: "e.g. facebook/react or https://github.com/...",
        });

        if (userRepos.length > 0) {
          for (const r of userRepos) {
            choices.push({
              value: r.nameWithOwner,
              label: r.nameWithOwner,
              hint: r.isPrivate ? "🔒 private" : r.description?.slice(0, 40) || "",
            });
          }
        }

        if (starredRepos.length > 0) {
          for (const r of starredRepos) {
            if (!choices.some((c) => c.value === r.nameWithOwner)) {
              choices.push({
                value: r.nameWithOwner,
                label: `★ ${r.nameWithOwner}`,
                hint: r.description?.slice(0, 40) || "Starred",
              });
            }
          }
        }

        const pick = await p.select({
          message: "Select a repository to clone:",
          options: choices,
        });

        if (p.isCancel(pick)) {
          p.cancel("Clone cancelled.");
          return;
        }

        if (pick === "__search__") {
          const query = await p.text({
            message: "Enter search term:",
            placeholder: "e.g. next.js or good-gh",
            validate: (v) => (!v || !v.trim() ? "Search query cannot be empty" : undefined),
          });

          if (p.isCancel(query)) {
            p.cancel("Search cancelled.");
            return;
          }

          const searchSpinner = p.spinner();
          searchSpinner.start(`Searching GitHub for '${query}'...`);
          const searchResults = await searchRepositories(query, 15);
          searchSpinner.stop(`Found ${searchResults.length} repositories.`);

          if (searchResults.length === 0) {
            p.log.error("No repositories found for that query.");
            return;
          }

          const searchPick = await p.select({
            message: "Select repository from search results:",
            options: searchResults.map((r: RepositoryItem) => ({
              value: r.nameWithOwner,
              label: r.nameWithOwner,
              hint: r.description?.slice(0, 50) || "",
            })),
          });

          if (p.isCancel(searchPick)) {
            p.cancel("Clone cancelled.");
            return;
          }
          selectedRepo = searchPick as string;
        } else if (pick === "__custom__") {
          const customUrl = await p.text({
            message: "Enter GitHub URL or owner/repo:",
            placeholder: "owner/repo or https://github.com/...",
            validate: (v) => (!v || !v.trim() ? "URL cannot be empty" : undefined),
          });
          if (p.isCancel(customUrl)) {
            p.cancel("Clone cancelled.");
            return;
          }
          selectedRepo = customUrl as string;
        } else {
          selectedRepo = pick as string;
        }
      }

      if (!selectedRepo) {
        p.cancel("No repository specified.");
        return;
      }

      const ghAuth = await getGitHubAuthStatus();
      const repoUrl = normalizeCloneUrl(selectedRepo, ghAuth.protocol || "https");
      const defaultRepoName = extractRepoName(selectedRepo);

      // Destination directory resolution
      let targetDir = options?.dir;
      if (!targetDir) {
        const config = getConfig();
        const baseCloneDir = config.default_clone_dir && config.default_clone_dir !== "."
          ? expandPath(config.default_clone_dir)
          : process.cwd();

        const defaultPath = join(baseCloneDir, defaultRepoName);

        const dirChoice = await p.select({
          message: "Where would you like to clone this project?",
          options: [
            {
              value: defaultPath,
              label: `./${defaultRepoName}`,
              hint: defaultPath,
            },
            {
              value: "__custom_dir__",
              label: "Choose custom path...",
              hint: "Enter a specific directory path",
            },
          ],
        });

        if (p.isCancel(dirChoice)) {
          p.cancel("Clone cancelled.");
          return;
        }

        if (dirChoice === "__custom_dir__") {
          const customPath = await p.text({
            message: "Enter target directory path:",
            defaultValue: defaultPath,
            placeholder: defaultPath,
          });
          if (p.isCancel(customPath)) {
            p.cancel("Clone cancelled.");
            return;
          }
          targetDir = expandPath(customPath as string);
        } else {
          targetDir = dirChoice as string;
        }
      } else {
        targetDir = expandPath(targetDir);
      }

      if (existsSync(targetDir)) {
        p.log.error(`Target directory '${targetDir}' already exists!`);
        return;
      }

      // Clone mode selection if not specified via flags
      if (!options?.fast && !options?.shallow) {
        const modePick = await p.select({
          message: "Select clone mode:",
          options: [
            {
              value: "standard" as const,
              label: "Standard Clone",
              hint: "Full repository history and blobs",
            },
            {
              value: "blobless" as const,
              label: "Fast Blobless (--filter=blob:none)",
              hint: "Much faster download; blobs fetched lazily as needed",
            },
            {
              value: "shallow" as const,
              label: "Ultra-Fast Shallow (--depth 1)",
              hint: "Latest commit only; minimal footprint",
            },
          ],
          initialValue: "standard",
        });

        if (p.isCancel(modePick)) {
          p.cancel("Clone cancelled.");
          return;
        }
        cloneMode = modePick as CloneMode;
      }

      const cloneSpinner = p.spinner();
      cloneSpinner.start(`Cloning ${pc.cyan(selectedRepo)} [${cloneMode} mode] into ${pc.dim(targetDir)}...`);

      try {
        await clone(repoUrl, targetDir, cloneMode);
        cloneSpinner.stop(pc.green("Repository cloned successfully!"));
        p.log.message(`\nTo get started, navigate to your project:\n  ${pc.bold(pc.cyan(`cd ${targetDir}`))}\n`);
        p.outro(pc.green("Ready to code!"));
      } catch (err) {
        cloneSpinner.stop(pc.red("Clone failed."));
        p.log.error(String(err));
      }
    });
}
