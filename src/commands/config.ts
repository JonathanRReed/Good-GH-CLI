import { Command } from "commander";
import packageJson from "../../package.json";
import { getInstallationGuidance } from "../services/install-guidance.ts";
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
import { commandExists, run, type RunOptions, type RunResult } from "../utils/exec.ts";
import type { AIProviderId } from "../services/ai/provider.ts";

const GH_ATTACHMENT_COMMANDS = [
  { id: "pr.create", args: ["pr", "create", "--help"] as const, label: "PR create" },
  { id: "pr.edit", args: ["pr", "edit", "--help"] as const, label: "PR edit" },
  { id: "pr.comment", args: ["pr", "comment", "--help"] as const, label: "PR comment" },
  { id: "issue.create", args: ["issue", "create", "--help"] as const, label: "Issue create" },
  { id: "issue.edit", args: ["issue", "edit", "--help"] as const, label: "Issue edit" },
  { id: "issue.comment", args: ["issue", "comment", "--help"] as const, label: "Issue comment" },
] as const;

interface LocalToolDiagnostics {
  git: { installed: boolean; version?: string };
  gh: {
    installed: boolean;
    version?: string;
    attachments: Record<(typeof GH_ATTACHMENT_COMMANDS)[number]["id"], boolean | null>;
  };
}

interface ProviderDiagnosticRow {
  id: AIProviderId;
  displayName: string;
  model: string;
  installed: boolean;
  version?: string;
  capabilities: string[];
}

export interface ConfigDoctorProbeDependencies {
  commandExists?: (command: string) => boolean;
  run?: (command: string, args: string[], options?: RunOptions) => Promise<RunResult>;
  providers?: readonly ProviderDiagnosticRow[];
}

async function probeLocalOutput(
  command: string,
  args: readonly string[],
  execute: NonNullable<ConfigDoctorProbeDependencies["run"]>,
): Promise<string | undefined> {
  try {
    const result = await execute(command, [...args], {
      reject: false,
      timeoutMs: 5_000,
      maxOutputBytes: 64 * 1024,
    });
    if (result.exitCode !== 0) return undefined;
    return `${result.stdout}\n${result.stderr}`;
  } catch {
    return undefined;
  }
}

function firstLine(output: string | undefined): string | undefined {
  return output?.split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 120);
}

function supportsAttachFlag(help: string | undefined): boolean | null {
  if (help === undefined) return null;
  return /(?:^|\s)--attach(?:[\s=]|$)/m.test(help);
}

async function inspectLocalTools(dependencies: ConfigDoctorProbeDependencies = {}): Promise<LocalToolDiagnostics> {
  const hasCommand = dependencies.commandExists ?? commandExists;
  const execute = dependencies.run ?? run;
  const gitInstalled = hasCommand("git");
  const ghInstalled = hasCommand("gh");
  const probePromises = Promise.all([
    gitInstalled ? probeLocalOutput("git", ["--version"], execute) : Promise.resolve(undefined),
    ghInstalled ? probeLocalOutput("gh", ["--version"], execute) : Promise.resolve(undefined),
    Promise.all(GH_ATTACHMENT_COMMANDS.map((item) =>
      ghInstalled ? probeLocalOutput("gh", item.args, execute) : Promise.resolve(undefined),
    )),
  ]);
  const [gitVersionOutput, ghVersionOutput, helpOutputs] = await probePromises;
  const attachments: LocalToolDiagnostics["gh"]["attachments"] = {
    "pr.create": supportsAttachFlag(helpOutputs[0]),
    "pr.edit": supportsAttachFlag(helpOutputs[1]),
    "pr.comment": supportsAttachFlag(helpOutputs[2]),
    "issue.create": supportsAttachFlag(helpOutputs[3]),
    "issue.edit": supportsAttachFlag(helpOutputs[4]),
    "issue.comment": supportsAttachFlag(helpOutputs[5]),
  };
  return {
    git: { installed: gitInstalled, ...(firstLine(gitVersionOutput) ? { version: firstLine(gitVersionOutput) } : {}) },
    gh: { installed: ghInstalled, ...(firstLine(ghVersionOutput) ? { version: firstLine(ghVersionOutput) } : {}), attachments },
  };
}

export function registerConfigCommand(program: Command, doctorDependencies: ConfigDoctorProbeDependencies = {}): void {
  const configCmd = program
    .command("config")
    .description("Configure AI permission, providers, models, and defaults");

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
        fail(`Configuration key '${key}' not found.`, { code: "invalid_arguments" });
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
    .description("Set a configuration value (e.g. ai_enabled true, ai_provider grok)")
    .action((key: string, value: string) => {
      if (!isConfigKey(key) || key === "first_run_completed") {
        fail(`Invalid configuration key. Valid keys are: ${settableKeys.join(", ")}`, { code: "invalid_arguments" });
        return;
      }
      const { value: coerced, problem } = validateConfigValue(key, value);
      if (problem) {
        fail(`${key} ${problem}.`, { code: "invalid_arguments" });
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
        fail(`Invalid configuration key. Valid keys are: ${settableKeys.join(", ")}`, { code: "invalid_arguments" });
        return;
      }
      if (dryRun(`unset ${key}`)) { jsonOut({ key, dryRun: true }); return; }
      saveConfig({ [key]: undefined });
      if (jsonOut({ key, value: getConfig()[key] })) return;
      p.log.success(`${pc.cyan(key)} reset.`);
    });

  configCmd
    .command("doctor")
    .description("Check configuration and inspect installed AI CLI versions and capabilities")
    .option("--fix", "Fix file permissions and invalid project keys without changing providers")
    .action(async (options?: { fix?: boolean }) => {
      header("Configuration Doctor");
      if (options?.fix && dryRun("repair config permissions and invalid project keys")) { jsonOut({ action: "doctor", dryRun: true }); return; }
      const { getProviderById, PROVIDER_ORDER, getConfiguredModel } = await import(
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

      const providers = doctorDependencies.providers ? [...doctorDependencies.providers] : await Promise.all(PROVIDER_ORDER.map(async (id) => {
        const provider = getProviderById(id);
        return { id, displayName: provider.displayName, model: getConfiguredModel(provider), ...await provider.getDiagnostics() };
      }));
      const localTools = await inspectLocalTools(doctorDependencies);
      const installation = getInstallationGuidance(process.platform, process.arch, packageJson.version);
      p.log.info(config.ai_enabled ? "AI is optional and currently enabled." : "AI is optional and disabled. No provider setup is required.");
      const installed = new Set(providers.filter((provider) => provider.installed).map((provider) => provider.id));
      p.log.info(pc.dim("Checks local CLI installation and help output only. Sign-in and model access are not checked."));
      for (const [name, tool] of [["Git", localTools.git], ["GitHub CLI", localTools.gh]] as const) {
        const mark = tool.installed ? pc.green("✓") : pc.red("✖");
        const version = tool.version ? ` ${pc.dim(tool.version)}` : "";
        p.log.message(`  ${mark} ${name}${version}`);
      }
      for (const item of GH_ATTACHMENT_COMMANDS) {
        const supported = localTools.gh.attachments[item.id];
        const state = supported === null ? "unknown" : supported ? "supported" : "not supported";
        p.log.message(`    ${pc.dim(`${item.label} --attach: ${state}`)}`);
      }
      for (const provider of providers) {
        const mark = provider.installed ? pc.green("✓") : pc.dim("○");
        const version = provider.version ? ` ${pc.dim(provider.version)}` : "";
        p.log.message(`  ${mark} ${provider.displayName.padEnd(18)} ${pc.dim(provider.model)}${version}`);
        if (provider.capabilities.length > 0) {
          p.log.message(`    ${pc.dim(`Capabilities: ${provider.capabilities.join(", ")}`)}`);
        }
      }
      if (!localTools.git.installed) {
        problems.push("Git is required but was not found on PATH. Install Git before using Good-GH-CLI.");
      }
      if (!localTools.gh.installed) {
        problems.push("GitHub CLI (gh) was not found on PATH. Install it to use GitHub features such as pull requests and issues.");
      }
      if (config.ai_enabled && !installed.has(config.ai_provider ?? "codex")) {
        problems.push(
          `AI is enabled, but configured provider '${config.ai_provider}' CLI is not installed${
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

      if (jsonOut({ config, projectFile: project?.path ?? null, problems, providers, localTools, fixed, installation })) {
        if (problems.length > 0) process.exitCode = 1;
        return;
      }

      if (fixed.length > 0) {
        for (const f of fixed) p.log.success(pc.green(f));
      }

      if (problems.length === 0) {
        p.outro(pc.green("No problems found."));
        return;
      }
      for (const problem of problems) p.log.warn(problem);
      for (const name of ["git", "gh"] as const) {
        if (!localTools[name].installed) {
          const remedy = installation.dependencies[name];
          p.log.info(`${name}: ${remedy.command ?? "Follow the installation instructions"}\n${remedy.url}`);
        }
      }
      p.log.info(`After repairs: ${installation.nextChecks.join("; ")}`);
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
