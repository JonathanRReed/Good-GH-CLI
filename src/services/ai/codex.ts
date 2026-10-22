import { assertWindowsPrivateDirectory, privateTemporaryDirectory } from "../private-storage.ts";
import { commandExists, run } from "../../utils/exec.ts";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliAIProvider } from "./base.ts";
import { AIGenerationError, type AIProviderId } from "./provider.ts";

/**
 * GPT-5.6 tiers, ordered flagship -> mini -> nano. `luna` is the smallest and
 * cheapest tier, so it is the last thing tried before switching providers.
 */
export const CODEX_MODEL_CHAIN = ["gpt-5.6-terra", "gpt-5.6-luna"] as const;

export class CodexProvider extends CliAIProvider {
  readonly id: AIProviderId = "codex";
  readonly displayName = "Codex (ChatGPT)";
  readonly defaultModel = "gpt-5.6-luna";
  readonly fallbackModels = CODEX_MODEL_CHAIN;
  protected readonly cliCommand = "codex";
  protected readonly diagnosticsVersionArgs = ["--version"] as const;
  protected readonly diagnosticsHelpArgs = ["exec", "--help"] as const;
  protected readonly diagnosticsCapabilities = [
    { name: "JSON event output", pattern: /--json/ },
  ] as const;

  async isAvailable(options?: { timeoutMs: number }): Promise<boolean> {
    try {
      if (!commandExists("codex")) {
        return false;
      }
      const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
      if (existsSync(join(codexHome, "auth.json"))) {
        return true;
      }
      const result = await run("codex", ["login", "status"], { reject: false, timeoutMs: options?.timeoutMs ?? 15_000 });
      return result.exitCode === 0 && /\blogged in\b/i.test(`${result.stdout} ${result.stderr}`) &&
        !/\bnot logged in\b/i.test(`${result.stdout} ${result.stderr}`);
    } catch {
      return false;
    }
  }

  protected async invoke(prompt: string, model: string, timeoutMs: number, metadataOnly = false): Promise<string> {
    const tmpDir = privateTemporaryDirectory("good-gh-codex-");
    const outputPath = join(tmpDir, "output.txt");

    try {
      const result = await run(
        "codex",
        [
          "exec",
          "--ephemeral",
          "--skip-git-repo-check",
          // Never load the user's config.toml: MCP servers, hooks, skills, and
          // developer_instructions all slow this down and leak unrelated
          // instructions into commit messages. Auth still resolves via CODEX_HOME.
          "--ignore-user-config",
          ...metadataOnly ? ["-c", "features.shell_tool=false", "-c", "features.view_image=false", "-c", "features.multi_agent=false", "-c", "features.multi_agent_v2=false", "-c", "web_search=\"disabled\""] : [],
          "--color",
          "never",
          "--json",
          "-s",
          "read-only",
          "--model",
          model,
          "-o",
          outputPath,
          "-",
        ],
        { input: prompt, timeoutMs, cwd: tmpDir },
      );
      this.setLastUsage(parseCodexUsage(result.stdout));

      assertWindowsPrivateDirectory(tmpDir, false, true);
      if (!existsSync(outputPath)) {
        throw new AIGenerationError(this.id, model, "empty_response", "codex wrote no output file");
      }
      return readFileSync(outputPath, "utf-8");
    } finally {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failure
      }
    }
  }
}

/** Extracts only the per-turn scalars in Codex's documented JSONL events. */
export function parseCodexUsage(output: string): unknown {
  let usage: unknown;
  for (const line of output.split(/\r?\n/)) {
    try {
      const event: unknown = JSON.parse(line);
      if (!event || typeof event !== "object" || Array.isArray(event)) continue;
      const eventRecord = new Map(Object.entries(event));
      if (eventRecord.get("type") !== "turn.completed") continue;
      const value = eventRecord.get("usage");
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const fields = new Map(Object.entries(value));
      usage = {
        inputTokens: fields.get("input_tokens"),
        outputTokens: fields.get("output_tokens"),
        cachedInputTokens: fields.get("cached_input_tokens"),
        cacheWriteInputTokens: fields.get("cache_write_input_tokens"),
      };
    } catch {
      // Ignore non-JSON lines and retain plain CLI output compatibility.
    }
  }
  return usage;
}
