import { privateTemporaryDirectory } from "../private-storage.ts";
import { commandExists, run } from "../../utils/exec.ts";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliAIProvider } from "./base.ts";
import type { AIProviderId } from "./provider.ts";

/**
 * Grok is the last resort in the provider chain, and the model list is
 * account-specific (`grok models`), so there is no safe hardcoded second tier:
 * an unknown slug would turn a working fallback into a hard failure.
 */
export class GrokProvider extends CliAIProvider {
  readonly id: AIProviderId = "grok";
  readonly displayName = "xAI Grok";
  readonly defaultModel = "grok-4.5";
  readonly fallbackModels: readonly string[] = [];
  protected readonly cliCommand = "grok";
  protected readonly diagnosticsVersionArgs = ["--version"] as const;
  protected readonly diagnosticsHelpArgs = ["--help"] as const;
  protected readonly diagnosticsCapabilities = [
    { name: "JSON output", pattern: /--output-format/ },
  ] as const;

  async isAvailable(options?: { timeoutMs: number }): Promise<boolean> {
    try {
      if (!commandExists("grok")) {
        return false;
      }
      if (existsSync(join(homedir(), ".grok", "auth.json"))) {
        return true;
      }
      const { stdout, stderr, exitCode } = await run("grok", ["models"], {
        reject: false,
        timeoutMs: options?.timeoutMs ?? 15_000,
      });
      return exitCode === 0 && !/not authenticated|please (?:run )?grok login/i.test(`${stdout} ${stderr}`);
    } catch {
      return false;
    }
  }

  protected async invoke(prompt: string, model: string, timeoutMs: number, metadataOnly = false): Promise<string> {
    const tmpDir = privateTemporaryDirectory("good-gh-grok-");
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
          // Disable web/subagents; the vendor CLI remains a trusted executable.
          ...metadataOnly ? ["--tools", "", "--deny", "*", "--max-turns", "1"] : [],
          "--no-subagents",
          "--disable-web-search",
        ],
        { timeoutMs, cwd: tmpDir },
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
