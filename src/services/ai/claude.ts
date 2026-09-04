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
        ["--print", "--model", model, "--safe-mode", "--tools", "", "--disallowedTools", "*",
          "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-session-persistence"],
        { input: prompt, timeoutMs, cwd },
      );
      return stdout;
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
}
