import { Command } from "commander";
import {
  DEFAULT_CONFIG,
  findProjectConfigPath,
  getConfig,
  getConfigPath,
  getConfigWithSources,
  getProjectConfig,
  isConfigKey,
  saveConfig,
  validateConfigValue,
  type AIProvider,
  type GoodGhConfig,
} from "../services/config.ts";
import { dryRun } from "../utils/flags.ts";
import { clearCache, getCacheDir } from "../services/cache.ts";
import { fail, header, p, pc, selectMenu, data, jsonOut } from "../utils/ui.ts";

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
      if (jsonOut({
          userFile: getConfigPath(),
          projectFile: findProjectConfigPath(),
          values: Object.fromEntries(sources.map((s) => [s.key, { value: s.value, source: s.source }])),
        })) return;

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
      const project = getProjectConfig();
      for (const issue of project?.problems ?? []) {
        p.log.warn(`${pc.dim(project!.path)}: ${pc.cyan(issue.key)} ${issue.message} (ignored)`);
      }
      p.log.info(pc.dim("Precedence: environment > project .ggh.json > user file > defaults."));
      p.outro("Done.");
    });

  configCmd
    .command("cache-clear")
    .description("Delete cached GitHub responses")
    .action(() => {
      header("Clear Cache");
      if (dryRun("clear owned GitHub cache entries")) { jsonOut({ action: "cache-clear", dryRun: true }); return; }
      const removed = clearCache();
      if (jsonOut({ removed, directory: getCacheDir() })) return;
      p.log.success(pc.green(`Removed ${removed} cached response(s).`));
      p.log.message(pc.dim(getCacheDir()));
      p.outro("Done.");
    });

  configCmd
    .command("get <key>")
    .description("Get a specific configuration value")
    .action((key: string) => {
      const config = getConfig();
      const val = isConfigKey(key) ? config[key] : undefined;
      if (val === undefined) {
        fail(`Configuration key '${key}' not found.`);
      } else {
        // Data on stdout: `MODEL=$(ggh config get codex_model)` must work.
        if (jsonOut(val)) return;
        data(String(val));
      }
    });

  const settableKeys = (Object.keys(DEFAULT_CONFIG) as Array<keyof GoodGhConfig>).filter(
    (k) => k !== "first_run_completed",
  );

  configCmd
    .command("set <key> <value>")
    .description("Set a configuration value (e.g. ai_provider grok, ai_fallback false)")
    .action((key: string, value: string) => {
      if (!isConfigKey(key) || key === "first_run_completed") {
        fail(`Invalid configuration key. Valid keys are: ${settableKeys.join(", ")}`);
        return;
      }
      const { value: coerced, problem } = validateConfigValue(key, value);
      if (problem) {
        fail(`${key} ${problem}.`);
        return;
      }
      if (dryRun(`set ${key}`)) { jsonOut({ key, value: coerced, dryRun: true }); return; }
      saveConfig({ [key]: coerced });
      if (jsonOut({ key, value: coerced })) return;
      p.log.success(`${pc.cyan(key)} set to ${pc.green(String(coerced))}`);
      if (key === "ai_provider" && coerced === "ollama" && getConfig().ai_fallback !== false) {
        p.log.info(
          pc.dim("Tip: `ggh config set ai_fallback false` prevents fallback to a different provider if Ollama is unavailable."),
        );
      }
    });

  configCmd
    .command("unset <key>")
    .description("Remove a value from your user config so the default (or project/env) applies")
    .action((key: string) => {
      if (!isConfigKey(key)) {
        fail(`Invalid configuration key. Valid keys are: ${settableKeys.join(", ")}`);
        return;
      }
      if (dryRun(`unset ${key}`)) { jsonOut({ key, dryRun: true }); return; }
      saveConfig({ [key]: undefined });
      if (jsonOut({ key, value: getConfig()[key] })) return;
      p.log.success(`${pc.cyan(key)} reset.`);
    });

  configCmd
    .command("doctor")
    .description("Check your configuration, the project .ggh.json, and every AI provider")
    .option("--fix", "Fix file permissions and invalid project keys without changing providers")
    .action(async (options?: { fix?: boolean }) => {
      header("Configuration Doctor");
      if (options?.fix && dryRun("repair config permissions and invalid project keys")) { jsonOut({ action: "doctor", dryRun: true }); return; }
      const { getAvailableProviders, getProviderById, PROVIDER_ORDER, getConfiguredModel } = await import(
        "../services/ai/index.ts"
      );
      const config = getConfig();
      const project = getProjectConfig();
      const problems: string[] = [];
      const fixed: string[] = [];

      if (project) {
        p.log.message(`Project file: ${pc.dim(project.path)}`);
        for (const issue of project.problems) problems.push(`${project.path}: ${issue.key} ${issue.message}`);
        const overrides = Object.keys(project.config);
        if (overrides.length) p.log.info(`Project overrides: ${overrides.map((k) => pc.cyan(k)).join(", ")}`);

        // --fix: remove invalid keys from .ggh.json
        if (options?.fix && project.problems.length > 0) {
          try {
            const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
            if (existsSync(project.path)) {
              const raw = JSON.parse(readFileSync(project.path, "utf-8")) as Record<string, unknown>;
              let changed = false;
              for (const issue of project.problems) {
                if (issue.key in raw) {
                  delete raw[issue.key];
                  changed = true;
                  fixed.push(`Removed invalid key '${issue.key}' from ${project.path}`);
                }
              }
              if (changed) {
                writeFileSync(project.path, JSON.stringify(raw, null, 2) + "\n", { encoding: "utf-8" });
              }
            }
          } catch {
            // best-effort
          }
        }
      }

      const available = new Set((await getAvailableProviders()).map((x) => x.id));
      for (const id of PROVIDER_ORDER) {
        const provider = getProviderById(id);
        const model = getConfiguredModel(provider);
        const mark = available.has(id) ? pc.green("✓") : pc.dim("○");
        p.log.message(`  ${mark} ${provider.displayName.padEnd(18)} ${pc.dim(model)}`);
      }
      if (!available.has(config.ai_provider ?? "codex")) {
        problems.push(
          `Configured provider '${config.ai_provider}' is not installed${
            config.ai_fallback === false ? " and fallback is off, so every AI feature will fail" : ""
          }.`,
        );


      }
      if (config.ai_fallback === false) {
        p.log.info(`Fallback: ${pc.yellow("off")} — only ${pc.bold(config.ai_provider ?? "codex")} is ever contacted.`);
      }

      // --fix: tighten config file permissions
      if (options?.fix) {
        try {
          const { chmodSync, existsSync } = await import("node:fs");
          const { getConfigPath } = await import("../services/config.ts");
          const configPath = getConfigPath();
          if (existsSync(configPath)) {
            chmodSync(configPath, 0o600);
            fixed.push(`Set config file permissions to 0600`);
          }
        } catch {
          // best-effort, may fail on Windows
        }
      }

      if (jsonOut({ config, projectFile: project?.path ?? null, problems, providers: [...available], fixed })) return;

      if (fixed.length > 0) {
        for (const f of fixed) p.log.success(pc.green(f));
      }

      if (problems.length === 0) {
        p.outro(pc.green("No problems found."));
        return;
      }
      for (const problem of problems) p.log.warn(problem);
      if (options?.fix && fixed.length > 0) {
        p.outro(pc.green(`${fixed.length} issue(s) fixed, ${problems.length} remain.`));
      } else {
        fail(`${problems.length} problem(s) found${options?.fix ? " (some could not be auto-fixed)" : ""}.`);
      }
    });

  // Default interactive config if no subcommand is given
  configCmd.action(async () => {
    header("Interactive Configuration");
    const current = getConfig();
    if (jsonOut(current)) return;
    if (dryRun("configure user preferences interactively")) return;

    const provider = await selectMenu({
      message: "Select default AI Provider:",
      options: [
        { value: "codex" as const, label: "Codex (ChatGPT)", hint: "hosted; sends sanitized repository content" },
        { value: "grok" as const, label: "xAI Grok", hint: "hosted; sends sanitized repository content" },
        { value: "claude" as const, label: "Claude Code", hint: "hosted; sends sanitized repository content" },
        { value: "ollama" as const, label: "Ollama (local)", hint: "uses your Ollama server; check its model and cloud settings" },
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

    const fallback = await selectMenu({
      message: "If that provider fails, try the others?",
      options: [
        { value: "yes", label: "Yes, fall back", hint: "Codex → Grok → Claude → Ollama, first result wins" },
        { value: "no", label: "No, this provider only", hint: "nothing is ever sent anywhere else" },
      ],
      initialValue: current.ai_fallback === false ? "no" : "yes",
    });

    if (fallback === null) {
      p.cancel("Configuration unchanged.");
      return;
    }

    saveConfig({
      ai_provider: provider as AIProvider,
      ai_fallback: fallback === "yes",
      commit_style: commitStyle as GoodGhConfig["commit_style"],
      first_run_completed: true,
    });

    p.outro(pc.green("Configuration updated successfully!"));
  });
}
