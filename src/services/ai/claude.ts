import { commandExists, run } from "../../utils/exec.ts";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CliAIProvider } from "./base.ts";
import type { AIProviderId } from "./provider.ts";

/**
 * The Claude Code CLI, driven headlessly. Another zero-API-key provider for
 * anyone already signed in to it.
 */
export class ClaudeProvider extends CliAIProvider {
  readonly id: AIProviderId = "claude";
  readonly displayName = "Claude Code";
  readonly defaultModel = "sonnet";
  readonly fallbackModels = ["haiku"] as const;
  protected readonly cliCommand = "claude";
  protected readonly diagnosticsVersionArgs = ["--version"] as const;
  protected readonly diagnosticsHelpArgs = ["--help"] as const;
  protected readonly diagnosticsCapabilities = [
    { name: "JSON output", pattern: /--output-format/ },
  ] as const;

  async isAvailable(): Promise<boolean> {
    try {
      if (!commandExists("claude")) return false;
      return existsSync(join(homedir(), ".claude.json")) || existsSync(join(homedir(), ".claude"));
    } catch {
      return false;
    }
  }

  protected async invoke(prompt: string, model: string, timeoutMs: number): Promise<string> {
    const cwd = mkdtempSync(join(tmpdir(), "good-gh-claude-"));
    try {
      const { stdout } = await run(
        "claude",
        ["--print", "--model", model, "--output-format", "json", "--safe-mode", "--tools", "", "--disallowedTools", "*",
          "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-session-persistence"],
        { input: prompt, timeoutMs, cwd },
      );
      const response = parseClaudeResponse(stdout);
      this.setLastUsage(response.usage);
      return response.text;
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
}

/** Keeps Claude's final text separate from its provider-reported usage. */
export function parseClaudeResponse(output: string): { text: string; usage?: unknown } {
  try {
    const value: unknown = JSON.parse(output);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { text: output };
    const response = new Map(Object.entries(value));
    const text = response.get("result");
    if (response.get("type") !== "result" || typeof text !== "string") return { text: output };
    const usageValue = response.get("usage");
    if (!usageValue || typeof usageValue !== "object" || Array.isArray(usageValue)) return { text };
    const usage = new Map(Object.entries(usageValue));
    return {
      text,
      usage: {
        inputTokens: usage.get("input_tokens"),
        outputTokens: usage.get("output_tokens"),
        cachedInputTokens: usage.get("cache_read_input_tokens"),
        cacheWriteInputTokens: usage.get("cache_creation_input_tokens"),
        costUsd: response.get("total_cost_usd"),
      },
    };
  } catch {
    return { text: output };
  }
}
