import { commandExists, run } from "../../utils/exec.ts";
import { CliAIProvider } from "./base.ts";
import type { AIProviderId } from "./provider.ts";

/**
 * A local model via Ollama. It is the last link in the chain precisely because
 * it needs no account and no credits. A local daemon and an installed local
 * model are required; failed local verification never sends the prompt.
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
    const configured = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
    const endpoint = new URL(configured.includes("://") ? configured : `http://${configured}`);
    if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
        endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/") {
      throw new Error("Ollama must use a loopback HTTP endpoint. Remote/cloud inference is not supported by the local adapter.");
    }
    const env = { OLLAMA_HOST: endpoint.origin, HTTP_PROXY: "", http_proxy: "", NO_PROXY: "*", no_proxy: "*" };
    // Check the actual resolved definition, not the model's display name. Cloud
    // aliases lack a local weights blob. Inspection sends no repository content.
    const shown = await run("ollama", ["show", "--modelfile", model], { env, timeoutMs: Math.min(timeoutMs, 10_000) });
    const from = shown.stdout.match(/^FROM[ \t]+(.+)$/im)?.[1]?.trim().replace(/^"(.*)"$/, "$1");
    if (!from || !/^(?:\/|[A-Za-z]:[\\/])/.test(from) || !/[\\/]blobs[\\/]sha256[-:][a-f0-9]{64}$/i.test(from)) {
      throw new Error("Ollama model is not a verified local weights blob. Pull a local model; cloud models and unverified aliases are refused.");
    }
    const { stdout } = await run("ollama", ["run", model], { input: prompt, timeoutMs, env });
    return stdout;
  }
}
