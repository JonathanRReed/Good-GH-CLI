import { getConfig, saveConfig, type AIProvider as ConfigAIProvider } from "../config.ts";
import { CodexProvider } from "./codex.ts";
import { GrokProvider } from "./grok.ts";
import type { AIProvider } from "./provider.ts";
import type { CommitMessageResult, CommitPromptInput } from "./prompt.ts";

export * from "./provider.ts";
export * from "./prompt.ts";
export * from "./codex.ts";
export * from "./grok.ts";

// Lazily constructed so commands that never touch AI don't pay for provider setup
let _codex: CodexProvider | null = null;
let _grok: GrokProvider | null = null;

function getCodex(): CodexProvider {
  return (_codex ??= new CodexProvider());
}

function getGrok(): GrokProvider {
  return (_grok ??= new GrokProvider());
}

export function getProviderById(id: ConfigAIProvider): AIProvider {
  return id === "grok" ? getGrok() : getCodex();
}

export async function getAvailableProviders(): Promise<AIProvider[]> {
  const [codex, grok] = await Promise.all([getCodex(), getGrok()]);
  const [codexOk, grokOk] = await Promise.all([codex.isAvailable(), grok.isAvailable()]);
  const providers: AIProvider[] = [];
  if (codexOk) {
    providers.push(codex);
  }
  if (grokOk) {
    providers.push(grok);
  }
  return providers;
}

export async function resolveAIProvider(
  explicitId?: ConfigAIProvider,
): Promise<{ provider: AIProvider; model: string }> {
  const config = getConfig();
  const targetId = explicitId || config.ai_provider || "codex";

  const primary = getProviderById(targetId);
  const secondary = targetId === "codex" ? getGrok() : getCodex();

  if (await primary.isAvailable()) {
    const model =
      targetId === "codex"
        ? config.codex_model || primary.defaultModel
        : config.grok_model || primary.defaultModel;
    return { provider: primary, model };
  }

  if (await secondary.isAvailable()) {
    const model =
      secondary.id === "codex"
        ? config.codex_model || secondary.defaultModel
        : config.grok_model || secondary.defaultModel;
    return { provider: secondary, model };
  }

  // If neither check passed, return primary anyway (command will fail with a clear message)
  const model =
    targetId === "codex"
      ? config.codex_model || primary.defaultModel
      : config.grok_model || primary.defaultModel;
  return { provider: primary, model };
}

export async function ensureFirstRunSetup(
  promptFn?: (providers: AIProvider[]) => Promise<ConfigAIProvider>,
): Promise<AIProvider> {
  const config = getConfig();
  if (config.first_run_completed && config.ai_provider) {
    return getProviderById(config.ai_provider);
  }

  if (promptFn) {
    const available = await getAvailableProviders();
    const chosen = await promptFn(available);
    saveConfig({ ai_provider: chosen, first_run_completed: true });
    return getProviderById(chosen);
  }

  saveConfig({ ai_provider: "codex", first_run_completed: true });
  return getCodex();
}

export async function generateCommitWithFallback(
  input: CommitPromptInput,
  explicitProvider?: ConfigAIProvider,
  onFallback?: (primaryName: string, fallbackName: string) => void,
): Promise<{ result: CommitMessageResult; providerName: string; model: string }> {
  const { provider: primary, model: primaryModel } = await resolveAIProvider(explicitProvider);

  try {
    const result = await primary.generateCommit(input, primaryModel);
    return { result, providerName: primary.displayName, model: primaryModel };
  } catch (primaryErr) {
    const alternate = primary.id === "codex" ? getGrok() : getCodex();
    if (await alternate.isAvailable()) {
      const config = getConfig();
      const alternateModel =
        alternate.id === "codex"
          ? config.codex_model || alternate.defaultModel
          : config.grok_model || alternate.defaultModel;

      if (onFallback) {
        onFallback(primary.displayName, alternate.displayName);
      }
      const result = await alternate.generateCommit(input, alternateModel);
      return { result, providerName: alternate.displayName, model: alternateModel };
    }
    throw primaryErr;
  }
}
