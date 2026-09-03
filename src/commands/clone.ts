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
import { header, p, pc, promptInput, searchablePicker, selectMenu, type PickerItem } from "../utils/ui.ts";

function expandPath(pathStr: string): string {
  if (pathStr.startsWith("~/") || pathStr === "~") {
    return join(homedir(), pathStr.slice(1));
  }
  return resolve(pathStr);
}

function extractRepoName(urlOrShorthand: string): string {
  const clean = urlOrShorthand.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const parts = clean.split(/[/:]/);
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
    .action(async (repoArg?: string, options?: { fast?: boolean; blobless?: boolean; shallow?: boolean; dir?: string }) => {
      header("Clone & Add Project");

      let selectedRepo = repoArg;
      const isFast = Boolean(options?.fast || options?.blobless);
      let cloneMode: CloneMode = isFast ? "blobless" : options?.shallow ? "shallow" : "standard";

      // If a single-word keyword or shorthand was provided as argument, search user's repos and GitHub
      if (selectedRepo && !selectedRepo.includes("/") && !selectedRepo.includes(":") && !selectedRepo.startsWith("http")) {
        const query = selectedRepo.toLowerCase();
        const s = p.spinner();
        s.start(`Finding repository matching "${selectedRepo}"...`);
        const [userRepos, globalResults] = await Promise.all([
          listUserRepositories(100),
          searchRepositories(selectedRepo, 10),
        ]);
        s.stop();

        const exactUserMatch = userRepos.find(
          (r) => r.nameWithOwner.toLowerCase().split("/")[1] === query,
        );

        if (exactUserMatch) {
          selectedRepo = exactUserMatch.nameWithOwner;
        } else {
          const matchedUserRepos = userRepos.filter(
            (r) =>
              r.nameWithOwner.toLowerCase().includes(query) ||
              (r.description && r.description.toLowerCase().includes(query)),
          );

          const seen = new Set<string>();
          const candidateList: RepositoryItem[] = [];
          for (const r of [...matchedUserRepos, ...globalResults]) {
            const key = r.nameWithOwner.toLowerCase();
            if (!seen.has(key)) {
              seen.add(key);
              candidateList.push(r);
            }
          }

          if (candidateList.length === 1 && candidateList[0]) {
            selectedRepo = candidateList[0].nameWithOwner;
          } else if (candidateList.length > 1) {
            const pick = await searchablePicker({
              title: `Repositories matching "${selectedRepo}":`,
              items: candidateList.map((r) => ({
                value: r.nameWithOwner,
                label: r.nameWithOwner,
                hint: r.isPrivate ? "🔒 private" : r.description?.slice(0, 45) || "",
              })),
              pageSize: 8,
            });

            if (!pick) {
              p.cancel("Clone cancelled.");
              return;
            }
            selectedRepo = pick;
          }
        }
      }

      // Interactive discovery if no repo argument given or not resolved
      let ghAuth: Awaited<ReturnType<typeof getGitHubAuthStatus>> | null = null;
      if (!selectedRepo) {
        ghAuth = await getGitHubAuthStatus();
        if (!ghAuth.authenticated) {
          p.log.warn(
            pc.yellow("GitHub CLI is not authenticated. You can still paste any repository URL."),
          );
        }

        const s = p.spinner();
        s.start("Loading your GitHub repositories...");
        const [userRepos, starredRepos] = await Promise.all([
          listUserRepositories(100),
          listStarredRepositories(30),
        ]);
        s.stop("Repositories loaded.");

        const items: PickerItem[] = [];
        const seenRepos = new Set<string>();

        for (const r of userRepos) {
          if (seenRepos.has(r.nameWithOwner)) continue;
          seenRepos.add(r.nameWithOwner);
          items.push({
            value: r.nameWithOwner,
            label: r.nameWithOwner,
            hint: r.isPrivate ? "🔒 private" : r.description?.slice(0, 45) || "",
          });
        }

        for (const r of starredRepos) {
          if (seenRepos.has(r.nameWithOwner)) continue;
          seenRepos.add(r.nameWithOwner);
          items.push({
            value: r.nameWithOwner,
            label: `★ ${r.nameWithOwner}`,
            hint: r.description?.slice(0, 45) || "Starred",
          });
        }

        const pick = await searchablePicker({
          title: "Select or search repository to clone:",
          items,
          pageSize: 8,
          onSearchGitHub: async (q: string) => {
            const results = await searchRepositories(q, 15);
            return results.map((r) => ({
              value: r.nameWithOwner,
              label: `🌐 ${r.nameWithOwner}`,
              hint: r.isPrivate ? "🔒 private" : r.description?.slice(0, 45) || "",
            }));
          },
        });

        if (!pick) {
          p.cancel("Clone cancelled.");
          return;
        }

        selectedRepo = pick;
      }

      const finalAuth = ghAuth ?? (await getGitHubAuthStatus());
      const repoUrl = normalizeCloneUrl(selectedRepo, finalAuth.protocol || "https");
      const defaultRepoName = extractRepoName(selectedRepo);

      // Destination directory resolution
      let targetDir = options?.dir;

      if (!targetDir) {
        const config = getConfig();
        const baseCloneDir = config.default_clone_dir && config.default_clone_dir !== "."
          ? expandPath(config.default_clone_dir)
          : process.cwd();

        const defaultPath = join(baseCloneDir, defaultRepoName);

        const dirChoice = await selectMenu({
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

        if (dirChoice === null) {
          p.cancel("Clone cancelled.");
          return;
        }

        if (dirChoice === "__custom_dir__") {
          const customPath = await promptInput({
            message: "Enter target directory path:",
            defaultValue: defaultPath,
            placeholder: defaultPath,
          });
          if (!customPath) {
            p.cancel("Clone cancelled.");
            return;
          }
          targetDir = expandPath(customPath);
        } else {
          targetDir = dirChoice as string;
        }
      } else {
        targetDir = expandPath(targetDir);
      }

      if (existsSync(targetDir)) {
        p.log.error(`Target directory '${targetDir}' already exists!`);
        process.exitCode = 1;
        return;
      }

      // Clone mode selection if not specified via flags
      if (!options?.fast && !options?.shallow) {
        const modePick = await selectMenu({
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
        });

        if (modePick === null) {
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
        process.exitCode = 1;
      }
    });
}
