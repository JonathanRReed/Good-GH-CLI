import { Command } from "commander";
import { getFlags } from "../services/runtime.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getRepoRoot, hasCommits, requireGitRepo } from "../services/git.ts";
import { getCommitsSinceTag, listReleases } from "../services/github.ts";
import { generateReleaseNotesWithFallback } from "../services/ai/index.ts";
import { dryRun } from "../utils/flags.ts";
import { data, emitJson, fail, header, p, pc, reportAIFailure, confirmOrAbort } from "../utils/ui.ts";

const HEADER = `# Changelog

All notable changes to this project are documented here.
This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
`;

/**
 * Release notes were being generated for `ggh release` and then discarded. This
 * keeps them, so the project accumulates a changelog instead of a publish log.
 */
export function registerChangelogCommand(program: Command): void {
  program
    .command("changelog [version]")
    .description("Write a changelog entry into CHANGELOG.md")
    .option("--since <tag>", "Summarise commits since this tag (defaults to the latest release)")
    .option("--stdout", "Print the entry instead of writing the file")
    .option("-y, --yes", "Write without confirming")
    .action(async (version?: string, options?: { since?: string; stdout?: boolean; yes?: boolean }) => {
      header("Changelog");

      if (!(await requireGitRepo())) return;
      if (!(await hasCommits())) {
        fail("Repository has no commits.");
        return;
      }

      const repoRoot = await getRepoRoot();
      const previousTag = options?.since || (await listReleases(1))[0]?.tagName;
      const commits = await getCommitsSinceTag(previousTag);

      if (commits.length === 0) {
        p.log.info(pc.dim(`No commits since ${previousTag ?? "the start of history"}.`));
        return;
      }

      p.log.step(`${commits.length} commit(s) since ${previousTag ? pc.cyan(previousTag) : "the first commit"}.`);

      const tag = version || "Unreleased";
      const s = p.spinner();
      s.start("Summarising...");
      let body: string;
      try {
        const { result, providerName, model } = await generateReleaseNotesWithFallback({
          tag,
          previousTag,
          commits,
        });
        s.stop(`Written by ${pc.bold(providerName)} [${pc.cyan(model)}].`);
        body = result;
      } catch (err) {
        s.stop(pc.yellow("Falling back to the raw commit list."));
        reportAIFailure(err, "AI changelog generation failed:");
        body = commits.map((c) => `- ${c}`).join("\n");
      }

      const date = new Date().toISOString().slice(0, 10);
      const entry = `## ${tag} — ${date}\n\n${body.trim()}\n`;

      if (options?.stdout || getFlags().json) {
        if (getFlags().json) {
          emitJson({ version: tag, date, body: body.trim(), commits });
        } else {
          data(entry);
        }
        return;
      }

      p.note(entry.trim(), "New entry");

      const changelogPath = join(repoRoot, "CHANGELOG.md");
      const exists = existsSync(changelogPath);

      if (dryRun(`${exists ? "prepend to" : "create"} ${changelogPath}`)) return;

      if (!(await confirmOrAbort(`${exists ? "Prepend this entry to" : "Create"} CHANGELOG.md?`, { assumeYes: options?.yes, cancelText: "Nothing written." }))) return;

      try {
        if (exists) {
          const current = readFileSync(changelogPath, "utf-8");
          // Keep the file's own preamble, insert the new entry above the newest one.
          const firstEntry = current.indexOf("\n## ");
          const updated =
            firstEntry === -1
              ? `${current.trimEnd()}\n\n${entry}`
              : `${current.slice(0, firstEntry + 1)}${entry}\n${current.slice(firstEntry + 1)}`;
          writeFileSync(changelogPath, updated, "utf-8");
        } else {
          writeFileSync(changelogPath, `${HEADER}\n${entry}`, "utf-8");
        }
        p.log.success(pc.green(`${exists ? "Updated" : "Created"} ${pc.bold("CHANGELOG.md")}.`));
        p.outro("Done.");
      } catch (err) {
        fail(String(err));
      }
    });
}
