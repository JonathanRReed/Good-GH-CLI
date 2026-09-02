import { Command } from "commander";
import { getConfig, saveConfig, getConfigPath, type GoodGhConfig, type AIProvider } from "../services/config.ts";
import { header, p, pc } from "../utils/ui.ts";

export function registerConfigCommand(program: Command): void {
  const configCmd = program
    .command("config")
    .description("View and update Good GH CLI configuration");

  configCmd
    .command("list")
    .alias("ls")
    .description("List all configuration settings")
    .action(() => {
      header("Configuration Settings");
      const config = getConfig();
      p.log.message(`Config file: ${pc.dim(getConfigPath())}\n`);
      for (const [k, v] of Object.entries(config)) {
        p.log.message(`  ${pc.cyan(k)}: ${pc.green(String(v))}`);
      }
      p.outro("Done.");
    });

  configCmd
    .command("get <key>")
    .description("Get a specific configuration value")
    .action((key: string) => {
      const config = getConfig();
      const val = (config as Record<string, unknown>)[key];
      if (val === undefined) {
        console.error(pc.red(`Configuration key '${key}' not found.`));
      } else {
        console.log(String(val));
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
        "default_clone_dir",
        "default_clone_mode",
        "commit_style",
      ];

      if (!validKeys.includes(key as keyof GoodGhConfig)) {
        console.error(
          pc.red(`Invalid configuration key. Valid keys are: ${validKeys.join(", ")}`),
        );
        return;
      }

      if (key === "ai_provider" && value !== "codex" && value !== "grok") {
        console.error(pc.red("ai_provider must be 'codex' or 'grok'."));
        return;
      }

      saveConfig({ [key]: value });
      p.log.success(`${pc.cyan(key)} set to ${pc.green(value)}`);
    });

  // Default interactive config if no subcommand is given
  configCmd.action(async () => {
    header("Interactive Configuration");
    const current = getConfig();

    const provider = await p.select({
      message: "Select default AI Provider:",
      options: [
        { value: "codex" as const, label: "Codex (Luna / ChatGPT)", hint: "Fast & high quality (gpt-5.6-luna)" },
        { value: "grok" as const, label: "xAI Grok", hint: "Local Grok CLI session" },
      ],
      initialValue: current.ai_provider || "codex",
    });

    if (p.isCancel(provider)) {
      p.cancel("Configuration unchanged.");
      return;
    }

    const commitStyle = await p.select({
      message: "Select default commit message style:",
      options: [
        { value: "auto", label: "Auto-detect", hint: "Matches existing repository conventions" },
        { value: "conventional", label: "Conventional Commits", hint: "feat: ..., fix: ..." },
        { value: "gitmoji", label: "Gitmoji", hint: ":sparkles: feat: ..." },
        { value: "concise", label: "Concise", hint: "Short imperative sentence" },
      ],
      initialValue: current.commit_style || "auto",
    });

    if (p.isCancel(commitStyle)) {
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
