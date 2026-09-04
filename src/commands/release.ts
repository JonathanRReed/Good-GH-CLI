import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createRelease,
  deleteRelease,
  downloadRelease,
  getCommitsSinceTag,
  listReleases,
  requireAuth,
  uploadRelease,
  viewRelease,
} from "../services/github.ts";
import { getRepoRoot, hasCommits, requireGitRepo } from "../services/git.ts";
import { generateReleaseNotesWithFallback, type AIAttempt, type AIAttemptFailure } from "../services/ai/index.ts";
import { dryRun } from "../utils/flags.ts";
import { fail, failFromGitHub, formatAIFallback, header, p, pc, promptInput, reportAIFailure, jsonOut, unknownAction, confirmOrAbort } from "../utils/ui.ts";

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
  const release = program
    .command("release [action] [tag] [files...]")
    .alias("rel")
    .description("Browse releases, or publish one with AI-written notes")
    .option("-t, --title <title>", "Release title")
    .option("-n, --notes <notes>", "Release notes (skips AI generation)")
    .option("--draft", "Create as draft release")
    .option("--prerelease", "Create as pre-release")
    .option("-y, --yes", "Skip the publish confirmation prompt")
    .option("--limit <n>", "Maximum releases to list", "30")
    .option("-p, --pattern <pattern>", "Download only assets matching the pattern")
    .option("-D, --dir <dir>", "Directory to download release assets into")
    .action(async (action?: string, tagArg?: string, files?: string[], options?: {
      title?: string; notes?: string; draft?: boolean; prerelease?: boolean; yes?: boolean;
      limit?: string; pattern?: string; dir?: string;
    }) => {
      const uploadFiles = files;
      header("GitHub Release Assistant");

      const [isRepo, authed] = await Promise.all([requireGitRepo(), requireAuth()]);
      if (!isRepo || !authed) return;

      const subcommand = action?.toLowerCase();
      if (subcommand === "list" || (!action && !tagArg)) {
        await listReleasesAction(options?.limit);
        return;
      }

      if (subcommand === "view" && tagArg) {
        await viewReleaseAction(tagArg);
        return;
      }

      if (subcommand === "download" && tagArg) {
        await downloadReleaseAction(tagArg, options);
        return;
      }

      if (subcommand === "upload" && tagArg) {
        await uploadReleaseAction(tagArg, uploadFiles);
        return;
      }

      if (subcommand === "delete" && tagArg) {
        await deleteReleaseAction(tagArg, options);
        return;
      }

      let isCreate = action === "create";
      let tag = tagArg;

      if (action && action !== "create" && action !== "list") {
        if (/^v?\d+(\.\d+)*/i.test(action)) {
          isCreate = true;
          tag = action;
        }
      }

      if (isCreate) {
        await createReleaseAction(tag, options);
        return;
      }

      unknownAction("release", action, ["list", "view", "download", "upload", "delete", "create"]);
    });

  release
    .command("list")
    .description("List releases")
    .option("--limit <n>", "Maximum releases to list", "30")
    .action(async (options?: { limit?: string }) => {
      header("GitHub Release Assistant");
      if (!(await requireGitRepo())) return;
      if (!(await requireAuth())) return;
      await listReleasesAction(options?.limit);
    });

  release
    .command("view <tag>")
    .description("View a release")
    .action(async (tag: string) => {
      header("GitHub Release Assistant");
      if (!(await requireGitRepo())) return;
      if (!(await requireAuth())) return;
      await viewReleaseAction(tag);
    });

  release
    .command("download <tag>")
    .description("Download release assets")
    .option("-p, --pattern <pattern>", "Download only assets matching the pattern")
    .option("-D, --dir <dir>", "Directory to download release assets into")
    .action(async (tag: string, options?: { pattern?: string; dir?: string }) => {
      header("GitHub Release Assistant");
      if (!(await requireGitRepo())) return;
      if (!(await requireAuth())) return;
      await downloadReleaseAction(tag, options);
    });

  release
    .command("upload <tag> [files...]")
    .description("Upload assets to a release")
    .action(async (tag: string, files?: string[]) => {
      header("GitHub Release Assistant");
      if (!(await requireGitRepo())) return;
      if (!(await requireAuth())) return;
      await uploadReleaseAction(tag, files);
    });

  release
    .command("delete <tag>")
    .description("Delete a release")
    .option("-y, --yes", "Skip confirmation prompt")
    .action(async (tag: string, options?: { yes?: boolean }) => {
      header("GitHub Release Assistant");
      if (!(await requireGitRepo())) return;
      if (!(await requireAuth())) return;
      await deleteReleaseAction(tag, options);
    });

  release
    .command("create [tag]")
    .description("Create a release")
    .option("-t, --title <title>", "Release title")
    .option("-n, --notes <notes>", "Release notes (skips AI generation)")
    .option("--draft", "Create as draft release")
    .option("--prerelease", "Create as pre-release")
    .option("-y, --yes", "Skip the publish confirmation prompt")
    .action(async (tag?: string, options?: {
      title?: string; notes?: string; draft?: boolean; prerelease?: boolean; yes?: boolean;
    }) => {
      header("GitHub Release Assistant");
      if (!(await requireGitRepo())) return;
      if (!(await requireAuth())) return;
      await createReleaseAction(tag, options);
    });

  async function listReleasesAction(limit?: string): Promise<void> {
    // Read-only: --dry-run does not block listing.
    const s = p.spinner();
    s.start("Fetching recent releases from GitHub...");
    let releases: Awaited<ReturnType<typeof listReleases>>;
    try {
      releases = await listReleases(Number.parseInt(limit ?? "30", 10) || 30);
      s.stop(`Found ${pc.green(String(releases.length))} release(s).`);
    } catch (err) {
      s.stop(pc.red("Failed to fetch releases."));
      failFromGitHub(err);
      return;
    }

    if (jsonOut(releases)) return;

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
  }

  async function viewReleaseAction(tag: string): Promise<void> {
    // Read-only: --dry-run does not block viewing.
    const s = p.spinner();
    s.start(`Fetching release ${tag}...`);
    let rel;
    try {
      rel = await viewRelease(tag);
    } catch (err) {
      s.stop(pc.red("Failed to fetch release."));
      failFromGitHub(err);
      return;
    }
    s.stop(rel ? "Release loaded." : "Release not found.");
    if (!rel) {
      fail(`Release ${tag} not found.`);
      return;
    }
    if (jsonOut(rel)) return;
    p.log.step(pc.bold(String((rel as { tagName?: string }).tagName ?? tag)));
    p.log.message(`  ${(rel as { name?: string }).name ?? ""}`);
    p.log.message(`  ${pc.dim(String((rel as { url?: string }).url ?? ""))}`);
  }

  async function downloadReleaseAction(tag: string, options?: { pattern?: string; dir?: string }): Promise<void> {
    if (dryRun(`download release ${tag}`)) return;
    const s = p.spinner();
    s.start(`Downloading release ${tag}...`);
    try {
      await downloadRelease(tag, { pattern: options?.pattern, dir: options?.dir });
      s.stop(pc.green("Release downloaded."));
    } catch (err) {
      s.stop(pc.red("Download failed."));
      failFromGitHub(err);
    }
  }

  async function uploadReleaseAction(tag: string, files?: string[]): Promise<void> {
    const fileList = files ?? [];
    if (fileList.length === 0) {
      fail("Upload requires at least one file path.");
      return;
    }
    if (dryRun(`upload ${fileList.length} asset(s) to release ${tag}`)) return;
    const s = p.spinner();
    s.start(`Uploading assets to release ${tag}...`);
    try {
      await uploadRelease(tag, fileList);
      s.stop(pc.green("Assets uploaded."));
    } catch (err) {
      s.stop(pc.red("Upload failed."));
      failFromGitHub(err);
    }
  }

  async function deleteReleaseAction(tag: string, options?: { yes?: boolean }): Promise<void> {
    if (dryRun(`delete release ${tag}`)) return;
    if (!(await confirmOrAbort(`Delete release ${pc.bold(tag)}?`, { assumeYes: options?.yes }))) return;
    const s = p.spinner();
    s.start(`Deleting release ${tag}...`);
    try {
      await deleteRelease(tag);
      s.stop(pc.green("Release deleted."));
    } catch (err) {
      s.stop(pc.red("Delete failed."));
      failFromGitHub(err);
    }
  }

  async function createReleaseAction(
    tag: string | undefined,
    options?: { title?: string; notes?: string; draft?: boolean; prerelease?: boolean; yes?: boolean },
  ): Promise<void> {
    if (!(await hasCommits())) {
      fail("Cannot create a release: repository has no commits.");
      return;
    }

    const repoRoot = await getRepoRoot();
    const detectedTag = detectPackageVersion(repoRoot);

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

      let releases: Awaited<ReturnType<typeof listReleases>> = [];
      try {
        releases = await listReleases(1);
      } catch {
        s.stop(pc.yellow("Could not fetch previous release."));
      }
      const previousTag = releases[0]?.tagName;
      const commits = await getCommitsSinceTag(previousTag);

      s.stop(`Found ${pc.bold(pc.green(String(commits.length)))} commit(s) since ${previousTag ? pc.cyan(previousTag) : "initial commit"}.`);

      if (commits.length === 0) {
        notes = `Release ${tag}`;
      } else {
        if (dryRun(`create release ${tag}`)) return;
        const aiSpinner = p.spinner();
        aiSpinner.start("Generating AI Release Changelog...");

        try {
          const { result: aiNotes, providerName, model } = await generateReleaseNotesWithFallback(
            { tag, previousTag, commits },
            undefined,
            (failure: AIAttemptFailure, next?: AIAttempt) => {
              aiSpinner.message(formatAIFallback(failure, next));
            },
          );
          aiSpinner.stop(`Release notes generated by ${pc.bold(providerName)} [${pc.cyan(model)}].`);
          notes = aiNotes || commits.map((c) => `- ${c}`).join("\n");
        } catch (err) {
          aiSpinner.stop(pc.yellow("Using commit list as release notes."));
          reportAIFailure(err, "AI release notes generation failed:");
          notes = commits.map((c) => `- ${c}`).join("\n");
        }
      }
    }

    if (dryRun(`create release ${pc.cyan(tag)} with ${pc.cyan(title)}`)) return;

    p.note(notes, `Proposed Release Notes: ${tag}`);

    if (!(await confirmOrAbort(`Publish release ${pc.bold(pc.cyan(tag))} to GitHub?`, { assumeYes: options?.yes, cancelText: "Release cancelled." }))) return;

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
      if (jsonOut({ tag, url })) return;
      if (url) p.log.success(`Release URL: ${pc.bold(pc.cyan(url))}`);
    } catch (err) {
      pubSpinner.stop(pc.red("Failed to publish release."));
      failFromGitHub(err);
    }
  }
}
