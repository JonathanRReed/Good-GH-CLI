import type { Command } from "commander";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import skill from "../../skills/ggh/SKILL.md" with { type: "text" };
import packedReference from "../generated/skill-reference.ts";
import { gunzipSync } from "node:zlib";
import { dryRun } from "../utils/flags.ts";
import { recordCompletedEffect } from "../services/runtime.ts";
import { confirmOrAbort, data, fail, jsonOut } from "../utils/ui.ts";

const providerGuidance = "T3 Code uses the selected provider's skills directory. Use --install claude or --install codex, or --install /absolute/path/to/skills/ggh for another provider.";

function stat(path: string) {
  try { return lstatSync(path); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export function registerAgentSkillCommand(agent: Command): void {
  agent.command("skill")
    .description("Print the ggh skill or install it for an agent host")
    .option("--install <host-or-path>", "Install for claude, codex, or an explicit skill directory; t3 explains provider paths")
    .option("--force", "Allow replacing differing skill files")
    .option("-y, --yes", "Approve installation without prompting")
    .option("--dry-run", "Show installation paths without writing files")
    .action(async (options: { install?: string; force?: boolean; yes?: boolean }) => {
      if (!options.install) {
        if (!jsonOut({ schemaVersion: 1, skill })) data(skill);
        return;
      }
      if (options.install === "t3") {
        if (!jsonOut({ schemaVersion: 1, guidance: providerGuidance })) data(providerGuidance);
        return;
      }
      // Personal skill conventions, verified 2026-10-22:
      // https://code.claude.com/docs/en/skills#choose-where-skills-load
      // https://developers.openai.com/codex/skills/ (redirects to https://learn.chatgpt.com/docs/build-skills)
      // Claude: ~/.claude/skills; Codex: ~/.agents/skills. Explicit paths support legacy ~/.codex/skills.
      const target = options.install === "claude" ? join(homedir(), ".claude", "skills", "ggh")
        : options.install === "codex" ? join(homedir(), ".agents", "skills", "ggh")
          : resolve(options.install === "~" ? homedir() : options.install.startsWith("~/") ? join(homedir(), options.install.slice(2)) : options.install);
      const files = { "SKILL.md": skill, "reference.md": gunzipSync(Buffer.from(packedReference, "base64")).toString("utf8") };
      const paths = Object.keys(files).map(name => join(target, name));
      const payload = { schemaVersion: 1, target, files: paths };
      try {
        const directory = stat(target);
        if (directory && (!directory.isDirectory() || directory.isSymbolicLink())) throw new Error(`Skill destination must be a directory, not a file or symlink: ${target}`);
        const writes: Array<{ path: string; text: string }> = [];
        for (const [name, text] of Object.entries(files)) {
          const path = join(target, name);
          const existing = stat(path);
          if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error(`Refusing to replace a non-regular skill file: ${path}`);
          if (existing && readFileSync(path, "utf8") === text) continue;
          if (existing && !options.force) {
            fail(`Skill file differs: ${path}. Inspect it and pass --force to replace it.`, { code: "confirmation_required", requiredInputs: [{ name: "--force", description: "Allow replacing the differing skill files after inspection" }] });
            jsonOut(payload);
            return;
          }
          writes.push({ path, text });
        }
        if (dryRun(`install ggh skill in ${target}: ${writes.map(file => file.path).join(", ") || "already current"}`)) {
          jsonOut({ ...payload, writes: writes.map(file => file.path) });
          return;
        }
        if (!writes.length) {
          if (!jsonOut({ ...payload, unchanged: true })) data(`Skill already current: ${target}`);
          return;
        }
        if (!(await confirmOrAbort(`Install ggh skill in ${target}${options.force ? " and replace differing files" : ""}?`, { assumeYes: options.yes }))) {
          jsonOut(payload);
          return;
        }
        mkdirSync(target, { recursive: true });
        if (!directory) recordCompletedEffect(`skill_directory_created:${target}`);
        for (const file of writes) {
          writeFileSync(file.path, file.text, { flag: options.force ? "w" : "wx" });
          recordCompletedEffect(`skill_file_written:${file.path}`);
        }
        if (!jsonOut(payload)) data(`Installed ggh skill: ${target}`);
      } catch (error) {
        fail(error instanceof Error ? error.message : "Skill installation failed.");
        jsonOut(payload);
      }
    });
}
