import { Command } from "commander";
import { getFlags } from "../services/runtime.ts";
import { existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getRepoRoot, requireGitRepo } from "../services/git.ts";
import { emitJson, fail, header, p, pc, selectMenu, jsonOut, unknownAction, confirmOrAbort } from "../utils/ui.ts";
import { dryRun } from "../utils/flags.ts";

const IS_WINDOWS = process.platform === "win32";

/** Reject hook names that could traverse out of .git/hooks. */
function safeHookName(name: string): boolean {
  return !(/[\\/]/.test(name) || name.includes("..")) && name.length > 0 && !name.includes(" ");
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
  if (IS_WINDOWS) {
    // Windows: use a batch wrapper. Git for Windows executes hooks via sh,
    // but a .sh shebang is more portable across Git installations.
    return `#!/bin/sh
# Installed by \`ggh hook install\` on Windows.
# Git for Windows bundles a shell that can run this.
exec ggh ${command}
`;
  }
  return `#!/bin/sh
# Installed by \`ggh hook install\` — runs \`${command}\` before each commit.
# Edit with \`ggh hook edit <name>\` or remove with \`ggh hook remove <name>\`.
exec ggh ${command}
`;
}

const DEFAULT_COMMAND = "commit --review --no-ai";

export function registerHookCommand(program: Command): void {
  const hook = program
    .command("hook [action] [name]")
    .description("Install, list, edit, and remove git hooks")
    .option("-c, --command <cmd>", "Custom command for the hook (default: ggh commit --review --no-ai)")
    .option("-y, --yes", "Skip confirmation prompts")
    .addHelpText("after", `
Examples:
  ggh hook list
  ggh hook install pre-commit
  ggh hook edit pre-commit --command "ggh commit --review"
  ggh hook remove pre-commit -y`)
    .action(async (
      action?: string,
      name?: string,
      options?: { command?: string; yes?: boolean },
    ) => {
      header("Git Hooks");

      if (!(await requireGitRepo())) return;

      const root = await getRepoRoot();
      const hooksDir = join(root, ".git", "hooks");

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

  async function useHooksDir(): Promise<string | null> {
    header("Git Hooks");
    if (!(await requireGitRepo())) return null;
    return join(await getRepoRoot(), ".git", "hooks");
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
    .option("-c, --command <cmd>", "Custom command for the hook (default: ggh commit --review --no-ai)")
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

    const files = readdirSync(hooksDir).filter((f) => !f.endsWith(".sample"));
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

    writeFileSync(hookPath, script, { mode: 0o755 });
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
      writeFileSync(hookPath, script, { mode: 0o755 });
      if (jsonOut({ action: "edit", name, command: options.command })) return;
      p.log.success(pc.green(`Hook "${name}" updated to run: ${options.command}`));
      p.outro("Done.");
      return;
    }

    // Show current content
    const content = readFileSync(hookPath, "utf-8");
    if (jsonOut({ name, content })) return;
    p.note(content, `Hook: ${name}`);
    p.log.info(pc.dim(`Edit with: ggh hook edit ${name} --command "your command here"`));
  }
}
