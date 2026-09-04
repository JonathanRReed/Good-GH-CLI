import { Command } from "commander";
import { getFlags } from "../services/runtime.ts";
import { existsSync, appendFileSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getRepoRoot, requireGitRepo } from "../services/git.ts";
import { emitJson, fail, failFromGitHub, header, p, pc, jsonOut } from "../utils/ui.ts";
import { dryRun } from "../utils/flags.ts";

export function registerIgnoreCommand(program: Command): void {
  const ignore = program
    .command("ignore [patterns...]")
    .alias("gitignore")
    .description("Manage .gitignore patterns")
    .option("--local", "Write to .git/info/exclude instead of .gitignore")
    .option("--list", "Show current ignore patterns")
    .option("--remove <pattern>", "Remove a pattern from .gitignore")
    .addHelpText("after", `
Examples:
  ggh ignore "*.log" ".env"
  ggh ignore --list
  ggh ignore --list --json
  ggh ignore --remove "*.log"
  ggh ignore "*.key" --local`)
    .action(async (
      patterns?: string[],
      options?: { local?: boolean; list?: boolean; remove?: string },
    ) => {
      const target = await useIgnoreFile(options?.local);
      if (!target) return;

      if (options?.list) {
        await listIgnores(target.path, target.label);
        return;
      }

      if (options?.remove) {
        await removeIgnore(target.path, target.label, options.remove);
        return;
      }

      if (!patterns || patterns.length === 0) {
        fail("Provide patterns to add, or use --list / --remove <pattern>.");
        return;
      }
      await addIgnores(target.path, target.label, patterns);
    });

  ignore
    .command("list")
    .description("Show current ignore patterns")
    .option("--local", "Read from .git/info/exclude instead of .gitignore")
    .action(async (options?: { local?: boolean }) => {
      const target = await useIgnoreFile(options?.local);
      if (!target) return;
      await listIgnores(target.path, target.label);
    });

  ignore
    .command("add [patterns...]")
    .description("Append patterns (skips duplicates)")
    .option("--local", "Write to .git/info/exclude instead of .gitignore")
    .action(async (patterns?: string[], options?: { local?: boolean }) => {
      const target = await useIgnoreFile(options?.local);
      if (!target) return;
      if (!patterns || patterns.length === 0) {
        fail("Provide patterns to add. Example: `ggh ignore add \"*.log\"`.");
        return;
      }
      await addIgnores(target.path, target.label, patterns);
    });

  ignore
    .command("remove <pattern>")
    .alias("delete")
    .description("Remove a pattern")
    .option("--local", "Edit .git/info/exclude instead of .gitignore")
    .action(async (pattern: string, options?: { local?: boolean }) => {
      const target = await useIgnoreFile(options?.local);
      if (!target) return;
      await removeIgnore(target.path, target.label, pattern);
    });

  async function useIgnoreFile(local?: boolean): Promise<{ path: string; label: string } | null> {
    header("Ignore");
    if (!(await requireGitRepo())) return null;
    const root = await getRepoRoot();
    return {
      path: local ? join(root, ".git", "info", "exclude") : join(root, ".gitignore"),
      label: local ? ".git/info/exclude" : ".gitignore",
    };
  }

  async function listIgnores(targetPath: string, label: string): Promise<void> {
    if (!existsSync(targetPath)) {
      if (jsonOut({ file: targetPath, patterns: [] })) return;
      p.log.info(pc.dim(`No ${label} found.`));
      return;
    }
    const content = readFileSync(targetPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
    if (jsonOut({ file: targetPath, patterns: lines })) return;
    if (lines.length === 0) {
      p.log.info(pc.dim(`No patterns in ${label}.`));
      return;
    }
    p.log.step(`${lines.length} pattern(s) in ${pc.cyan(label)}:`);
    for (const line of lines) {
      p.log.message(`  ${pc.dim("•")} ${line}`);
    }
  }

  async function removeIgnore(targetPath: string, label: string, pattern: string): Promise<void> {
    if (!existsSync(targetPath)) {
      fail(`No ${label} to edit.`);
      return;
    }
    const content = readFileSync(targetPath, "utf-8");
    const lines = content.split("\n");
    const filtered = lines.filter((l) => l.trim() !== pattern.trim());
    if (filtered.length === lines.length) {
      if (jsonOut({ action: "noop", pattern, file: targetPath })) return;
      p.log.info(pc.dim(`Pattern "${pattern}" not present.`));
      return;
    }
    if (dryRun(`remove "${pattern}" from ${label}`)) {
      jsonOut({ action: "remove", pattern, file: targetPath, dryRun: true });
      return;
    }
    try {
      writeFileSync(targetPath, filtered.join("\n"));
    } catch (err) {
      failFromGitHub(err);
      return;
    }
    if (jsonOut({ action: "remove", pattern, file: targetPath })) return;
    p.log.success(pc.green(`Removed "${pattern}" from ${label}.`));
  }

  async function addIgnores(targetPath: string, label: string, patterns: string[]): Promise<void> {
    // Ensure the directory exists (for .git/info/exclude)
    const dir = dirname(targetPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Read existing content to avoid duplicates
    const existing = existsSync(targetPath) ? readFileSync(targetPath, "utf-8") : "";
    const existingLines = new Set(existing.split("\n").map((l) => l.trim()));

    const toAdd = patterns.filter((pat) => !existingLines.has(pat.trim()));
    if (toAdd.length === 0) {
      if (jsonOut({ action: "noop", patterns: [], file: targetPath })) return;
      p.log.info(pc.dim("All patterns already present."));
      return;
    }

    if (dryRun(`add ${toAdd.length} pattern(s) to ${label}`)) {
      if (getFlags().json) {
        emitJson({ action: "add", patterns: toAdd, file: targetPath, dryRun: true });
      }
      return;
    }

    const addition = (existing && !existing.endsWith("\n") ? "\n" : "") + toAdd.join("\n") + "\n";
    try {
      appendFileSync(targetPath, addition);
    } catch (err) {
      failFromGitHub(err);
      return;
    }

    if (jsonOut({ action: "add", patterns: toAdd, file: targetPath })) return;

    p.log.success(pc.green(`Added ${toAdd.length} pattern(s) to ${label}.`));
    for (const pat of toAdd) {
      p.log.message(`  ${pc.dim("•")} ${pc.cyan(pat)}`);
    }
    p.outro("Done.");
  }
}
