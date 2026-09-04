import { Command } from "commander";
import { getFlags } from "../services/runtime.ts";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../services/config.ts";
import { emitJson, fail, header, p, pc, jsonOut, unknownAction, confirmOrAbort } from "../utils/ui.ts";
import { dryRun } from "../utils/flags.ts";

/**
 * `ggh plugin` — community extensions.
 *
 * Plugins are TypeScript or JavaScript files that register additional
 * commands. They're stored in `~/.config/ggh/plugins/` and loaded at startup.
 *
 * A plugin file must export a `register(program: Command): void` function.
 *
 * Security: plugins are loaded with `await import()`, so they run with full
 * process privileges. Users should only install plugins from trusted sources.
 */

interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  source?: string;
  installedAt: string;
}

function getPluginsDir(): string {
  return join(getConfigDir(), "plugins");
}

function getManifestPath(): string {
  return join(getPluginsDir(), "manifest.json");
}

function readManifest(): PluginManifest[] {
  const path = getManifestPath();
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return Array.isArray(raw) ? (raw as PluginManifest[]) : [];
  } catch {
    return [];
  }
}

function writeManifest(plugins: PluginManifest[]): void {
  const dir = getPluginsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getManifestPath(), JSON.stringify(plugins, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
}

function getPluginPath(name: string): string {
  return join(getPluginsDir(), `${name}.ts`);
}

function resolvePluginPath(name: string): string | null {
  for (const ext of [".ts", ".js", ".mjs"]) {
    const candidate = join(getPluginsDir(), `${name}${ext}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function registerPluginCommand(program: Command): void {
  const plugin = program
    .command("plugin [action] [name]")
    .description("Install, list, and remove community plugins (run with full process privileges — install only from sources you trust)")
    .option("--from <path>", "Install from a local plugin file")
    .option("-y, --yes", "Skip confirmation prompts")
    .addHelpText("after", `
Examples:
  ggh plugin list
  ggh plugin install my-cmd --from ./my-cmd.ts
  ggh plugin remove my-cmd -y`)
    .action(async (
      action?: string,
      name?: string,
    ) => {
      header("Plugins");

      const subcommand = action?.toLowerCase();
      const options = plugin.opts<{ from?: string; yes?: boolean }>();

      if (subcommand === "list" || (!action && !name)) {
        await listPlugins();
        return;
      }

      if (subcommand === "install" && name) {
        await installPlugin(name, options?.from, options?.yes);
        return;
      }

      if (subcommand === "remove" || subcommand === "delete" || subcommand === "uninstall") {
        await removePlugin(name, options?.yes);
        return;
      }

      unknownAction("plugin", action, ["list", "install", "remove"]);
    });

  plugin
    .command("list")
    .description("Show installed plugins")
    .action(async () => {
      header("Plugins");
      await listPlugins();
    });

  plugin
    .command("install <name>")
    .description("Install a plugin from a local file")
    .option("--from <path>", "Local path to the plugin file (required)")
    .option("-y, --yes", "Overwrite without confirming when already installed")
    .action(async (name: string, options?: { from?: string; yes?: boolean }) => {
      header("Plugins");
      await installPlugin(name, options?.from, options?.yes);
    });

  plugin
    .command("remove <name>")
    .alias("uninstall")
    .alias("delete")
    .description("Remove an installed plugin")
    .option("-y, --yes", "Skip confirmation prompts")
    .action(async (name: string, options?: { yes?: boolean }) => {
      header("Plugins");
      await removePlugin(name, options?.yes);
    });

  async function listPlugins(): Promise<void> {
    const plugins = readManifest();
    if (jsonOut(plugins)) return;
    if (plugins.length === 0) {
      p.log.info(pc.dim("No plugins installed. Install with `ggh plugin install <name> --from <path>`."));
      return;
    }
    p.log.step(`${plugins.length} plugin(s) installed:`);
    for (const plugin of plugins) {
      p.log.message(`  ${pc.bold(pc.cyan(plugin.name))} ${pc.dim(plugin.version || "")} ${plugin.description || ""}`);
      p.log.message(`    ${pc.dim(`installed ${plugin.installedAt.slice(0, 10)}`)}${plugin.source ? ` from ${pc.dim(plugin.source)}` : ""}`);
    }
    p.outro(pc.dim("Remove with `ggh plugin remove <name>`."));
  }

  async function installPlugin(name: string, from?: string, assumeYes?: boolean): Promise<void> {
    if (!from) {
      fail("Provide a source with --from <path>. URL installs are not yet supported.");
      return;
    }

    // Validate the name
    if (!/^[a-z0-9-_]+$/i.test(name)) {
      fail(`Invalid plugin name: "${name}". Use letters, digits, hyphens, and underscores only.`);
      return;
    }

    if (dryRun(`install plugin "${name}" from ${from}`)) {
      jsonOut({ action: "install", name, source: from, dryRun: true });
      return;
    }

    let content: string;
    if (from.startsWith("http://") || from.startsWith("https://")) {
      fail("URL plugin installs are not yet supported. Download the file and use a local path.");
      return;
    } else {
      // Local file
      if (!existsSync(from)) {
        fail(`File not found: ${from}`);
        return;
      }
      content = readFileSync(from, "utf-8");
    }

    // Basic validation: must export a register function. This is a smoke
    // check, not a sandbox — plugins run with full process privileges.
    const hasRegisterExport =
      /export\s+(async\s+)?function\s+register\b/.test(content) ||
      /export\s*\{[^}]*\bregister\b[^}]*\}/.test(content) ||
      /module\.exports\s*.\s*register\b/.test(content);
    if (!hasRegisterExport) {
      fail("Plugin file must export a `register(program: Command): void` function.");
      return;
    }

    const plugins = readManifest();
    const existing = plugins.find((p) => p.name === name);
    const prompt = existing
      ? `Overwrite plugin "${name}"? It will run with your full user privileges.`
      : `Install plugin "${name}"? It will run with your full user privileges.`;
    if (!(await confirmOrAbort(prompt, { assumeYes }))) return;

    const dir = getPluginsDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const pluginPath = getPluginPath(name);
    writeFileSync(pluginPath, content, { encoding: "utf-8", mode: 0o600 });

    const manifest: PluginManifest = {
      name,
      version: existing?.version,
      description: existing?.description,
      source: from,
      installedAt: new Date().toISOString(),
    };

    if (existing) {
      const idx = plugins.indexOf(existing);
      plugins[idx] = manifest;
    } else {
      plugins.push(manifest);
    }
    writeManifest(plugins);

    if (jsonOut({ action: "install", ...manifest })) return;

    p.log.success(pc.green(`Plugin "${name}" installed from ${from}.`));
    p.log.info(pc.dim("Restart ggh to load the new plugin."));
    p.outro("Done.");
  }

  async function removePlugin(name?: string, assumeYes?: boolean): Promise<void> {
    if (!name) {
      fail("Provide a plugin name to remove.");
      return;
    }

    const plugins = readManifest();
    const existing = plugins.find((p) => p.name === name);
    if (!existing) {
      fail(`Plugin "${name}" is not installed.`);
      return;
    }

    if (dryRun(`remove plugin "${name}"`)) {
      if (getFlags().json) {
        emitJson({ action: "remove", name, dryRun: true });
      }
      return;
    }

    if (!(await confirmOrAbort(`Remove plugin "${name}"?`, { assumeYes }))) return;

    const pluginPath = getPluginPath(name);
    if (existsSync(pluginPath)) {
      rmSync(pluginPath);
    }
    // Also clean up compiled variants from earlier installs.
    for (const ext of [".js", ".mjs"]) {
      const alt = join(getPluginsDir(), `${name}${ext}`);
      if (existsSync(alt)) rmSync(alt);
    }

    const filtered = plugins.filter((p) => p.name !== name);
    writeManifest(filtered);

    if (jsonOut({ action: "remove", name })) return;

    p.log.success(pc.green(`Plugin "${name}" removed.`));
    p.outro("Done.");
  }
}

/**
 * Loads all installed plugins and registers their commands.
 * Called from index.ts at startup.
 */
export async function loadPlugins(program: Command): Promise<void> {
  const plugins = readManifest();
  for (const plugin of plugins) {
    const pluginPath = resolvePluginPath(plugin.name) ?? getPluginPath(plugin.name);
    if (!existsSync(pluginPath)) continue;
    try {
      const mod = await import(`file://${pluginPath}`);
      if (typeof mod.register === "function") {
        mod.register(program);
      }
    } catch (err) {
      // Don't let a broken plugin crash ggh
      process.stderr.write(`ggh: plugin "${plugin.name}" failed to load: ${String(err)}\n`);
    }
  }
}
