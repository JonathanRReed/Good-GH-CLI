import { Command } from "commander";
import {
  findProjectConfigPath,
  getConfig,
  getConfigPath,
  getConfigWithSources,
  saveConfig,
  type AIProvider,
  type GoodGhConfig,
} from "../services/config.ts";
import { clearCache, getCacheDir } from "../services/cache.ts";
import { getFlags } from "../services/runtime.ts";
import { emitJson, fail, header, p, pc, selectMenu } from "../utils/ui.ts";

export function registerConfigCommand(program: Command): void {
  const configCmd = program
    .command("config")
    .description("Configure providers, models, and defaults");

  configCmd
    .command("list")
    .alias("ls")
    .description("List all configuration settings")
    .action(() => {
      const sources = getConfigWithSources();
      if (getFlags().json) {
        emitJson({
          userFile: getConfigPath(),
          projectFile: findProjectConfigPath(),
          values: Object.fromEntries(sources.map((s) => [s.key, { value: s.value, source: s.source }])),
        });
        return;
      }

      header("Configuration Settings");
      p.log.message(`User file:    ${pc.dim(getConfigPath())}`);
      const projectFile = findProjectConfigPath();
      p.log.message(`Project file: ${projectFile ? pc.dim(projectFile) : pc.dim("none")}`);
      p.log.message("");
      // Naming the winning layer is the whole point of having layers.
      for (const entry of sources) {
        const tag =
          entry.source === "env"
            ? pc.magenta("env")
            : entry.source === "project"
              ? pc.cyan("project")
              : entry.source === "user"
                ? pc.green("user")
                : pc.dim("default");
        p.log.message(`  ${pc.cyan(entry.key.padEnd(20))} ${String(entry.value).padEnd(18)} ${tag}`);
      }
      p.log.message("");
      p.log.info(pc.dim("Precedence: environment > project .ggh.json > user file > defaults."));
      p.outro("Done.");
    });

  configCmd
    .command("cache-clear")
    .description("Delete cached GitHub responses")
    .action(() => {
      header("Clear Cache");
      const removed = clearCache();
      p.log.success(pc.green(`Removed ${removed} cached response(s).`));
      p.log.message(pc.dim(getCacheDir()));
      p.outro("Done.");
    });

  configCmd
    .command("get <key>")
    .description("Get a specific configuration value")
    .action((key: string) => {
      const config = getConfig();
      const val = (config as Record<string, unknown>)[key];
      if (val === undefined) {
        fail(`Configuration key '${key}' not found.`);
      } else {
        // Data on stdout: `MODEL=$(ggh config get codex_model)` must work.
        process.stdout.write(`${String(val)}\n`);
      }
    });

  configCmd
    .command("set <key> <value>")
    .description("Set a configuration value (e.g. ai_provider grok)")
    .action((key: string, value: string) => {
      const validKeys: (keyof GoodGhConfig)[] = [
        "ai_provider",
        "codex_model",
        "grok_model",
        "claude_model",
        "ollama_model",
        "ai_timeout_ms",
        "default_clone_dir",
        "default_clone_mode",
        "commit_style",
      ];

      if (!validKeys.includes(key as keyof GoodGhConfig)) {
        fail(`Invalid configuration key. Valid keys are: ${validKeys.join(", ")}`);
        return;
      }

      if (key === "ai_provider" && !["codex", "grok", "claude", "ollama"].includes(value)) {
        fail("ai_provider must be 'codex', 'grok', 'claude', or 'ollama'.");
        return;
      }

      if (key === "commit_style" && !["auto", "conventional", "gitmoji", "concise"].includes(value)) {
        fail("commit_style must be 'auto', 'conventional', 'gitmoji', or 'concise'.");
        return;
      }

      if (key === "default_clone_mode" && !["standard", "blobless", "shallow"].includes(value)) {
        fail("default_clone_mode must be 'standard', 'blobless', or 'shallow'.");
        return;
      }

      if (key === "ai_timeout_ms") {
        const ms = Number.parseInt(value, 10);
        if (Number.isNaN(ms) || ms < 5_000) {
          fail("ai_timeout_ms must be a number of milliseconds (>= 5000).");
          return;
        }
        saveConfig({ ai_timeout_ms: ms });
        p.log.success(`${pc.cyan(key)} set to ${pc.green(String(ms))}`);
        return;
      }

      saveConfig({ [key]: value });
      p.log.success(`${pc.cyan(key)} set to ${pc.green(value)}`);
    });

  // Default interactive config if no subcommand is given
  configCmd.action(async () => {
    header("Interactive Configuration");
    const current = getConfig();

    const provider = await selectMenu({
      message: "Select default AI Provider:",
      options: [
        { value: "codex" as const, label: "Codex (ChatGPT)", hint: "GPT-5.6 tiers, then the rest of the chain" },
        { value: "grok" as const, label: "xAI Grok", hint: "local grok CLI session" },
        { value: "claude" as const, label: "Claude Code", hint: "local claude CLI session" },
        { value: "ollama" as const, label: "Ollama (local)", hint: "runs offline, never rate limited" },
      ],
      initialValue: current.ai_provider || "codex",
    });

    if (provider === null) {
      p.cancel("Configuration unchanged.");
      return;
    }

    const commitStyle = await selectMenu({
      message: "Select default commit message style:",
      options: [
        { value: "auto", label: "Auto-detect", hint: "Matches existing repository conventions" },
        { value: "conventional", label: "Conventional Commits", hint: "feat: ..., fix: ..." },
        { value: "gitmoji", label: "Gitmoji", hint: ":sparkles: feat: ..." },
        { value: "concise", label: "Concise", hint: "Short imperative sentence" },
      ],
      initialValue: current.commit_style || "auto",
    });

    if (commitStyle === null) {
      p.cancel("Configuration unchanged.");
      return;
    }

    saveConfig({
      ai_provider: provider as AIProvider,
      commit_style: commitStyle as GoodGhConfig["commit_style"],
      first_run_completed: true,
    });

    p.outro(pc.green("Configuration updated successfully!"));
  });
}
