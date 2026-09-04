import { Command } from "commander";
import { getFlags } from "../services/runtime.ts";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { checkLargeFiles, getGitPath, getStagedDiff, getStatus, requireGitRepo } from "../services/git.ts";
import { scanCodeHygiene } from "../utils/diff.ts";
import { emitJson, fail, header, p, pc, selectMenu, jsonOut, unknownAction, confirmOrAbort } from "../utils/ui.ts";
import { dryRun } from "../utils/flags.ts";

/** Hooks are executable files, never paths supplied by a caller. */
function safeHookName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(name);
}

/** Atomic replacement avoids following a symlink or leaving a partial script. */
function writeHook(hooksDir: string, name: string, script: string): void {
  mkdirSync(hooksDir, { recursive: true });
  const target = join(hooksDir, name);
  if (existsSync(target) && !lstatSync(target).isFile()) {
    throw new Error(`Refusing to replace non-regular hook: ${name}`);
  }
  const temporary = mkdtempSync(join(hooksDir, ".ggh-write-"));
  try {
    const file = join(temporary, "hook");
    writeFileSync(file, script, { mode: 0o755, flag: "wx" });
    chmodSync(file, 0o755);
    renameSync(file, target);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

const KNOWN_HOOKS = [
  "pre-commit",
  "commit-msg",
  "pre-push",
  "post-commit",
  "post-merge",
  "pre-rebase",
  "post-checkout",
  "prepare-commit-msg",
] as const;

function buildHookScript(command: string): string {
  const normalized = command.trim().replace(/^ggh\s+/, "");
  if (!normalized || /[\r\n\0]/.test(normalized)) {
    throw new Error("Hook command must be a nonempty single line.");
  }
  return `#!/bin/sh
# Installed by ggh hook install. Custom commands run with your privileges.
exec ggh ${normalized} "$@"
`;
}

const DEFAULT_COMMAND = "hook check";

export function registerHookCommand(program: Command): void {
  const hook = program
    .command("hook [action] [name]")
    .description("Install, list, edit, and remove git hooks")
    .option("-c, --command <cmd>", "Custom command for the hook (default: ggh hook check)")
    .option("-y, --yes", "Skip confirmation prompts")
    .addHelpText("after", `
Examples:
  ggh hook list
  ggh hook install pre-commit
  ggh hook edit pre-commit --command "ggh hook check"
  ggh hook remove pre-commit -y`)
    .action(async (
      action?: string,
      name?: string,
      options?: { command?: string; yes?: boolean },
    ) => {
      header("Git Hooks");

      if (!(await requireGitRepo())) return;

      const hooksDir = await getGitPath("hooks");

      const subcommand = action?.toLowerCase();

      if (subcommand === "list" || (!action && !name)) {
        await listHooks(hooksDir);
        return;
      }

      if (subcommand === "install") {
        await installHook(hooksDir, name, options);
        return;
      }

      if (subcommand === "remove" || subcommand === "delete") {
        await removeHook(hooksDir, name, options);
        return;
      }

      if (subcommand === "edit" && name) {
        await editHook(hooksDir, name, options);
        return;
      }

      unknownAction("hook", action, ["list", "install", "remove", "edit"]);
    });

  hook.command("check")
    .description("Check staged content only; never commit, stage, prompt, or invoke AI")
    .action(async () => {
      if (!(await requireGitRepo())) return;
      const status = await getStatus();
      const issues = scanCodeHygiene(await getStagedDiff());
      const large = await checkLargeFiles(status.staged);
      const ok = status.conflicts.length === 0 && issues.length === 0 && large.blocked.length === 0;
      if (!ok) process.exitCode = 1;
      if (jsonOut({ ok, conflicts: status.conflicts, issues, ...large })) return;
      for (const issue of issues) p.log.error(issue.message);
      for (const file of large.blocked) p.log.error(`Staged file is too large: ${file.path} (${file.sizeMB} MiB)`);
      if (status.conflicts.length) p.log.error("Resolve staged conflicts before committing.");
      if (!ok) p.log.error("Staged checks failed. Fix the staged content, or deliberately bypass the hook with git commit --no-verify.");
    });

  async function useHooksDir(): Promise<string | null> {
    header("Git Hooks");
    if (!(await requireGitRepo())) return null;
    return getGitPath("hooks");
  }

  hook
    .command("list")
    .description("Show installed git hooks")
    .action(async () => {
      const hooksDir = await useHooksDir();
      if (!hooksDir) return;
      await listHooks(hooksDir);
    });

  hook
    .command("install [name]")
    .description("Install a git hook (prompts when name omitted)")
    .option("-c, --command <cmd>", "Custom command for the hook (default: ggh hook check)")
    .option("-y, --yes", "Skip confirmation prompts")
    .action(async (name?: string, options?: { command?: string; yes?: boolean }) => {
      const hooksDir = await useHooksDir();
      if (!hooksDir) return;
      await installHook(hooksDir, name, options);
    });

  hook
    .command("remove <name>")
    .alias("delete")
    .description("Remove an installed git hook")
    .option("-y, --yes", "Skip confirmation prompts")
    .action(async (name: string, options?: { yes?: boolean }) => {
      const hooksDir = await useHooksDir();
      if (!hooksDir) return;
      await removeHook(hooksDir, name, options);
    });

  hook
    .command("edit <name>")
    .description("Show or update a git hook (--command to update)")
    .option("-c, --command <cmd>", "Replace the hook body with a custom command")
    .option("-y, --yes", "Skip confirmation prompts")
    .action(async (name: string, options?: { command?: string; yes?: boolean }) => {
      const hooksDir = await useHooksDir();
      if (!hooksDir) return;
      await editHook(hooksDir, name, options);
    });

  async function listHooks(hooksDir: string): Promise<void> {
    if (!existsSync(hooksDir)) {
      if (jsonOut([])) return;
      p.log.info(pc.dim("No hooks directory."));
      return;
    }

    const files = readdirSync(hooksDir).filter((f) => safeHookName(f) && !f.endsWith(".sample") && lstatSync(join(hooksDir, f)).isFile());
    if (files.length === 0) {
      if (jsonOut([])) return;
      p.log.info(pc.dim("No git hooks installed."));
      return;
    }

    if (getFlags().json) {
      const hooks = files.map((f) => {
        const content = readFileSync(join(hooksDir, f), "utf-8");
        const isGgh = content.includes("ggh");
        return { name: f, installedByGgh: isGgh };
      });
      emitJson(hooks);
      return;
    }

    p.log.step(`${files.length} hook(s) installed:`);
    for (const f of files) {
      const content = readFileSync(join(hooksDir, f), "utf-8");
      const tag = content.includes("ggh") ? pc.green(" [ggh]") : "";
      p.log.message(`  ${pc.bold(f)}${tag}`);
    }
    p.outro(pc.dim("Install with `ggh hook install <name>`, remove with `ggh hook remove <name>`."));
  }

  async function installHook(
    hooksDir: string,
    name?: string,
    options?: { command?: string; yes?: boolean },
  ): Promise<void> {
    let hookName = name;
    if (!hookName) {
      const picked = await selectMenu<string>({
        message: "Which hook to install?",
        options: KNOWN_HOOKS.map((h) => ({ value: h, label: h })),
      });
      if (!picked) {
        p.cancel("Cancelled.");
        return;
      }
      hookName = picked;
    }

    if (!KNOWN_HOOKS.includes(hookName as typeof KNOWN_HOOKS[number])) {
      // Still allow it, just warn
      p.log.warn(pc.yellow(`"${hookName}" is not a standard git hook, but installing anyway.`));
    }

    if (!safeHookName(hookName)) {
      fail(`"${hookName}" is not a valid hook name.`);
      return;
    }

    const script = options?.command
      ? buildHookScript(options.command)
      : buildHookScript(DEFAULT_COMMAND);

    const hookPath = join(hooksDir, hookName);

    // --dry-run previews without prompting or writing.
    if (dryRun(`install hook "${hookName}"${existsSync(hookPath) ? " (overwrite)" : ""}`)) {
      jsonOut({ action: "install", name: hookName, command: options?.command || DEFAULT_COMMAND, dryRun: true });
      return;
    }

    if (existsSync(hookPath)) {
      if (!(await confirmOrAbort(`Hook "${hookName}" already exists. Overwrite?`, { assumeYes: options?.yes, initialValue: false }))) return;
    }

    writeHook(hooksDir, hookName, script);
    if (jsonOut({ action: "install", name: hookName, command: options?.command || DEFAULT_COMMAND })) return;
    p.log.success(pc.green(`Hook "${hookName}" installed.`));
    p.log.info(pc.dim(`Runs: ggh ${options?.command || DEFAULT_COMMAND}`));
    p.outro("Done.");
  }

  async function removeHook(
    hooksDir: string,
    name?: string,
    options?: { yes?: boolean },
  ): Promise<void> {
    if (!name) {
      fail("Provide a hook name to remove.");
      return;
    }

    if (!safeHookName(name)) {
      fail(`"${name}" is not a valid hook name.`);
      return;
    }

    if (!safeHookName(name)) {
      fail(`"${name}" is not a valid hook name.`);
      return;
    }
    const hookPath = join(hooksDir, name);
    if (!existsSync(hookPath)) {
      fail(`Hook "${name}" is not installed.`);
      return;
    }

    if (dryRun(`remove hook "${name}"`)) return;

    if (!(await confirmOrAbort(`Remove hook "${name}"?`, { assumeYes: options?.yes }))) return;

    unlinkSync(hookPath);
    if (jsonOut({ action: "remove", name })) return;
    p.log.success(pc.green(`Hook "${name}" removed.`));
    p.outro("Done.");
  }

  async function editHook(
    hooksDir: string,
    name: string,
    options?: { command?: string; yes?: boolean },
  ): Promise<void> {
    if (!safeHookName(name)) {
      fail(`"${name}" is not a valid hook name.`);
      return;
    }
    const hookPath = join(hooksDir, name);
    if (!existsSync(hookPath)) {
      fail(`Hook "${name}" is not installed. Use \`ggh hook install ${name}\` first.`);
      return;
    }

    if (options?.command) {
      if (dryRun(`update hook "${name}" to run: ${options.command}`)) {
        if (getFlags().json) {
          emitJson({ action: "edit", name, command: options.command, dryRun: true });
        }
        return;
      }
      const script = buildHookScript(options.command);
      writeHook(hooksDir, name, script);
      if (jsonOut({ action: "edit", name, command: options.command })) return;
      p.log.success(pc.green(`Hook "${name}" updated to run: ${options.command}`));
      p.outro("Done.");
      return;
    }

    // Do not read arbitrary files through a hook symlink.
    if (!lstatSync(hookPath).isFile()) {
      fail("Refusing to read a non-regular hook.");
      return;
    }
    const content = readFileSync(hookPath, "utf-8");
    if (jsonOut({ name, content })) return;
    p.note(content, `Hook: ${name}`);
    p.log.info(pc.dim(`Edit with: ggh hook edit ${name} --command "your command here"`));
  }
}
