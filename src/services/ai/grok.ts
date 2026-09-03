import { commandExists, run } from "../../utils/exec.ts";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CliAIProvider } from "./base.ts";
import type { AIProviderId } from "./provider.ts";

/**
 * Grok is the last resort in the provider chain, and the model list is
 * account-specific (`grok models`), so there is no safe hardcoded second tier:
 * an unknown slug would turn a working fallback into a hard failure.
 */
export const GROK_MODEL_CHAIN: readonly string[] = [];

export class GrokProvider extends CliAIProvider {
  readonly id: AIProviderId = "grok";
  readonly displayName = "xAI Grok";
  readonly defaultModel = "grok-4.5";
  readonly fallbackModels = GROK_MODEL_CHAIN;

  async isAvailable(): Promise<boolean> {
    try {
      if (!commandExists("grok")) {
        return false;
      }
      if (existsSync(join(homedir(), ".grok", "auth.json"))) {
        return true;
      }
      const { stdout, stderr } = await run("grok", ["models"], {
        reject: false,
        timeoutMs: 15_000,
      });
      return !/not authenticated|please (?:run )?grok login/i.test(`${stdout} ${stderr}`);
    } catch {
      return false;
    }
  }

  protected async invoke(prompt: string, model: string, timeoutMs: number): Promise<string> {
    const tmpDir = mkdtempSync(join(tmpdir(), "good-gh-grok-"));
    const promptPath = join(tmpDir, "prompt.txt");

    try {
      // 0o600 so the prompt (which contains the diff) is not world-readable, and
      // passing it by path keeps it out of `ps aux`.
      writeFileSync(promptPath, prompt, { encoding: "utf-8", mode: 0o600 });

      const { stdout } = await run(
        "grok",
        [
          "--prompt-file",
          promptPath,
          "--model",
          model,
          "--output-format",
          "plain",
          // Single-turn text generation: no tools, no web, no subagents.
          "--no-subagents",
          "--disable-web-search",
        ],
        { timeoutMs },
      );
      return stdout;
    } finally {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failure
      }
    }
  }
}
