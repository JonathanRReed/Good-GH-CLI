import { Command } from "commander";
import { getFlags } from "../services/runtime.ts";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { getConfigDir } from "../services/config.ts";
import { emitJson, fail, header, p, pc, jsonOut } from "../utils/ui.ts";
import { dryRun } from "../utils/flags.ts";

function getAliasesPath(): string {
  const dir = getConfigDir();
  return `${dir}/aliases.json`;
}

function readAliases(): Record<string, string> {
  const path = getAliasesPath();
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, string>;
    p.log.warn(pc.yellow(`Aliases file is not an object — ignoring ${path}.`));
    return {};
  } catch {
    p.log.warn(pc.yellow(`Aliases file is corrupt — ignoring ${path}. Remove it to reset.`));
    return {};
  }
}

function writeAliases(aliases: Record<string, string>): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getAliasesPath(), JSON.stringify(aliases, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/** Reads aliases for expansion before command parsing. Exported for index.ts. */
export function getAliasMap(): Record<string, string> {
  return readAliases();
}

/**
 * Expands the first argument through the alias map (`ggh ci` → `ggh commit
 * --pr` when `ci` aliases `commit --pr`). Bounded so an alias pointing at
 * itself cannot hang the CLI. The `alias` command itself is never expanded.
 * Pure apart from reading the map, so it is unit-testable.
 */
export function expandAlias(
  args: string[],
  map: Record<string, string> = getAliasMap(),
  maxDepth = 5,
): string[] {
  if (args.length === 0 || args[0] === "alias") return args;
  let expanded = args;
  for (let i = 0; i < maxDepth; i++) {
    const first = expanded.at(0);
    if (first === undefined) break;
    const expansion = map[first];
    if (!expansion) break;
    const parts = expansion.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0 || parts[0] === first) break;
    expanded = [...parts, ...expanded.slice(1)];
  }
  return expanded;
}

export function registerAliasCommand(program: Command): void {
  const alias = program
    .command("alias [name] [command...]")
    .description("Create, list, and remove custom command shortcuts (expanded before parsing; an alias wins over a built-in or git command of the same name)")
    .option("--remove <name>", "Remove an alias")
    .addHelpText("after", `
Examples:
  ggh alias ci "commit --pr --yes"
  ggh ci                        # expands to: ggh commit --pr --yes
  ggh alias --json              # list all aliases as JSON
  ggh alias --remove ci`)
    .action(async (
      name?: string,
      commandParts?: string[],
      options?: { remove?: string },
    ) => {
      header("Aliases");

      // --remove <name>
      if (options?.remove) {
        await removeAlias(options.remove);
        return;
      }

      // `ggh alias` or `ggh alias list` — list all
      if (!name || (name === "list" && !commandParts?.length)) {
        await listAliases();
        return;
      }

      // `ggh alias <name> <command...>` — create
      await setAlias(name, commandParts);
    });

  alias
    .command("list")
    .description("List all aliases")
    .action(async () => {
      header("Aliases");
      await listAliases();
    });

  alias
    .command("set <name> <command...>")
    .description("Create a command shortcut (equivalent to `ggh alias <name> <command...>`)")
    .action(async (name: string, commandParts: string[]) => {
      header("Aliases");
      await setAlias(name, commandParts);
    });

  alias
    .command("remove <name>")
    .alias("delete")
    .description("Remove an alias")
    .action(async (name: string) => {
      header("Aliases");
      await removeAlias(name);
    });

  async function listAliases(): Promise<void> {
    const aliases = readAliases();
    const entries = Object.entries(aliases);
    if (jsonOut(aliases)) return;
    if (entries.length === 0) {
      p.log.info(pc.dim("No aliases defined. Create one with `ggh alias <name> <command...>`."));
      return;
    }
    p.log.step(`${entries.length} alias(es):`);
    for (const [aliasName, cmd] of entries) {
      p.log.message(`  ${pc.bold(pc.cyan(aliasName))} ${pc.dim("→")} ${cmd}`);
    }
  }

  async function removeAlias(name: string): Promise<void> {
    const aliases = readAliases();
    if (!(name in aliases)) {
      fail(`No alias named "${name}".`);
      return;
    }
    if (dryRun(`remove alias "${name}"`)) {
      if (getFlags().json) {
        emitJson({ action: "remove", name, dryRun: true });
      }
      return;
    }
    delete aliases[name];
    writeAliases(aliases);
    if (jsonOut({ action: "remove", name })) return;
    p.log.success(pc.green(`Removed alias "${name}".`));
  }

  async function setAlias(name: string, commandParts?: string[]): Promise<void> {
    if (!commandParts || commandParts.length === 0) {
      fail("Provide a command to alias. Example: `ggh alias ci commit --pr --yes`.");
      return;
    }

    const command = commandParts.join(" ");
    if (dryRun(`set alias "${name}" → "${command}"`)) {
      if (getFlags().json) {
        emitJson({ action: "set", name, command, dryRun: true });
      }
      return;
    }
    const aliases = readAliases();
    aliases[name] = command;
    writeAliases(aliases);

    if (jsonOut({ action: "set", name, command })) return;

    p.log.success(pc.green(`Alias "${name}" → "${command}" saved.`));
    p.log.info(pc.dim(`Use it with: ggh ${name}`));
    p.outro("Done.");
  }
}
