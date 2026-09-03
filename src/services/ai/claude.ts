import { commandExists, run } from "../../utils/exec.ts";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
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
    const { stdout } = await run(
      "claude",
      ["--print", "--model", model, "--permission-mode", "plan"],
      { input: prompt, timeoutMs },
    );
    return stdout;
  }
}
