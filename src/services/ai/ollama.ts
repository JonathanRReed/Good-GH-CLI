import { commandExists, run } from "../../utils/exec.ts";
import { CliAIProvider } from "./base.ts";
import type { AIProviderId } from "./provider.ts";

/**
 * A local model via Ollama. It is the last link in the chain precisely because
 * it needs no account and no credits: when every hosted provider is rate limited
 * or signed out, this one still answers.
 */
export class OllamaProvider extends CliAIProvider {
  readonly id: AIProviderId = "ollama";
  readonly displayName = "Ollama (local)";
  readonly defaultModel = "qwen2.5-coder";
  readonly fallbackModels: readonly string[] = [];

  async isAvailable(): Promise<boolean> {
    try {
      if (!commandExists("ollama")) return false;
      // `ollama list` fails when the daemon is not running, which is the state
      // that matters: an installed binary with no server cannot answer.
      const { exitCode, stdout } = await run("ollama", ["list"], { reject: false, timeoutMs: 5_000 });
      return exitCode === 0 && stdout.trim().split("\n").length > 1;
    } catch {
      return false;
    }
  }

  protected async invoke(prompt: string, model: string, timeoutMs: number): Promise<string> {
    const { stdout } = await run("ollama", ["run", model], { input: prompt, timeoutMs });
    return stdout;
  }
}
