import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createRelease,
  getCommitsSinceTag,
  getGitHubAuthStatus,
  listReleases,
} from "../services/github.ts";
import { getRepoRoot, isGitRepo } from "../services/git.ts";
import { resolveAIProvider } from "../services/ai/index.ts";
import { header, p, pc, promptInput } from "../utils/ui.ts";

function detectPackageVersion(repoRoot: string): string | null {
  try {
    const pkgPath = join(repoRoot, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (pkg.version) {
        return `v${pkg.version}`;
      }
    }
  } catch {
    // Ignore
  }
  return null;
}

export function registerReleaseCommand(program: Command): void {
  program
    .command("release [action] [tag]")
    .alias("rel")
    .description("Browse GitHub releases or create new releases with AI changelogs")
    .option("-t, --title <title>", "Release title")
    .option("-n, --notes <notes>", "Release notes (skips AI generation)")
    .option("--draft", "Create as draft release")
    .option("--prerelease", "Create as pre-release")
    .action(async (action?: string, tagArg?: string, options?: {
      title?: string;
      notes?: string;
      draft?: boolean;
      prerelease?: boolean;
    }) => {
      header("GitHub Release Assistant");

      if (!(await isGitRepo())) {
        p.log.error("Not a git repository.");
        return;
      }

      const ghAuth = await getGitHubAuthStatus();
      if (!ghAuth.authenticated) {
        p.log.warn("GitHub CLI is not authenticated. Run `gh auth login`.");
        return;
      }

      if (action === "create") {
        const repoRoot = await getRepoRoot();
        const detectedTag = detectPackageVersion(repoRoot);

        let tag = tagArg;
        if (!tag) {
          const inputTag = await promptInput({
            message: "Enter release tag name:",
            defaultValue: detectedTag || "v1.0.0",
            validate: (v) => (!v || !v.trim() ? "Tag name required" : undefined),
          });
          if (!inputTag) {
            p.cancel("Cancelled.");
            return;
          }
          tag = inputTag.trim();
        }

        const title = options?.title || tag;
        let notes = options?.notes;

        if (!notes) {
          const s = p.spinner();
          s.start("Aggregating recent commits for release changelog...");

          const releases = await listReleases(1);
          const previousTag = releases[0]?.tagName;
          const commits = await getCommitsSinceTag(previousTag);

          s.stop(`Found ${pc.bold(pc.green(String(commits.length)))} commit(s) since ${previousTag ? pc.cyan(previousTag) : "initial commit"}.`);

          if (commits.length === 0) {
            notes = `Release ${tag}`;
          } else {
            const aiSpinner = p.spinner();
            aiSpinner.start("Generating AI Release Changelog...");

            try {
              const { provider, model } = await resolveAIProvider();
              const promptInput = [
                `Generate clean, formatted GitHub Release Notes for version ${tag}.`,
                "Summarize these commits into logical sections (Features, Fixes, Maintenance):",
                ...commits.map((c) => `- ${c}`),
              ].join("\n");

              const aiRes = await provider.generatePr(
                {
                  branch: tag,
                  baseBranch: "main",
                  diff: promptInput,
                  commitSummary: `Release ${tag}`,
                },
                model,
              );
              aiSpinner.stop("Release notes generated!");
              notes = aiRes.body || `Release notes for ${tag}\n\n${commits.map((c) => `- ${c}`).join("\n")}`;
            } catch {
              aiSpinner.stop(pc.yellow("Using commit list as release notes."));
              notes = commits.map((c) => `- ${c}`).join("\n");
            }
          }
        }

        p.note(notes, `Proposed Release Notes: ${tag}`);

        const confirm = await p.confirm({
          message: `Publish release ${pc.bold(pc.cyan(tag))} to GitHub?`,
          initialValue: true,
        });

        if (!confirm || p.isCancel(confirm)) {
          p.cancel("Release cancelled.");
          return;
        }

        const pubSpinner = p.spinner();
        pubSpinner.start("Publishing release on GitHub...");
        try {
          const url = await createRelease({
            tag,
            title,
            notes,
            draft: options?.draft,
            prerelease: options?.prerelease,
          });
          pubSpinner.stop(pc.green(`Release ${tag} created successfully!`));
          if (url) p.log.success(`Release URL: ${pc.bold(pc.cyan(url))}`);
        } catch (err) {
          pubSpinner.stop(pc.red("Failed to publish release."));
          p.log.error(String(err));
        }
        return;
      }

      // Default: list recent releases
      const s = p.spinner();
      s.start("Fetching recent releases from GitHub...");
      const releases = await listReleases(10);
      s.stop(`Found ${pc.green(String(releases.length))} release(s).`);

      if (releases.length === 0) {
        p.log.info("No releases found on GitHub. Create one with `ggh release create`.");
        return;
      }

      for (const relItem of releases) {
        const flags: string[] = [];
        if (relItem.isDraft) flags.push(pc.yellow("[draft]"));
        if (relItem.isPrerelease) flags.push(pc.cyan("[pre-release]"));
        const dateStr = relItem.publishedAt ? pc.dim(`(${new Date(relItem.publishedAt).toLocaleDateString()})`) : "";
        p.log.message(`  ${pc.bold(pc.green(relItem.tagName))} - ${relItem.name} ${flags.join(" ")} ${dateStr}`);
      }

      p.log.info(`Run ${pc.bold(pc.cyan("ggh release create"))} to draft and publish a new release.`);
    });
}
