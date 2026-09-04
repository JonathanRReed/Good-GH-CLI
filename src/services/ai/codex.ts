import { commandExists, run } from "../../utils/exec.ts";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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

  async isAvailable(): Promise<boolean> {
    try {
      if (!commandExists("codex")) {
        return false;
      }
      const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
      if (existsSync(join(codexHome, "auth.json"))) {
        return true;
      }
      const result = await run("codex", ["login", "status"], { reject: false, timeoutMs: 15_000 });
      return `${result.stdout} ${result.stderr}`.toLowerCase().includes("logged in");
    } catch {
      return false;
    }
  }

  protected async invoke(prompt: string, model: string, timeoutMs: number): Promise<string> {
    const tmpDir = mkdtempSync(join(tmpdir(), "good-gh-codex-"));
    const outputPath = join(tmpDir, "output.txt");

    try {
      await run(
        "codex",
        [
          "exec",
          "--ephemeral",
          "--skip-git-repo-check",
          // Never load the user's config.toml: MCP servers, hooks, skills, and
          // developer_instructions all slow this down and leak unrelated
          // instructions into commit messages. Auth still resolves via CODEX_HOME.
          "--ignore-user-config",
          "--color",
          "never",
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
