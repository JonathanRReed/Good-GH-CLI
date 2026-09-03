import { getConfig, saveConfig, type AIProvider as ConfigAIProvider } from "../config.ts";
import { CodexProvider } from "./codex.ts";
import { GrokProvider } from "./grok.ts";
import { ClaudeProvider } from "./claude.ts";
import { OllamaProvider } from "./ollama.ts";
import { DEFAULT_AI_TIMEOUT_MS } from "./base.ts";
import {
  AIGenerationError,
  classifyAIFailure,
  extractFailureDetail,
  type AIFailureKind,
  type AIProvider,
  type AIProviderId,
} from "./provider.ts";
import type {
  CommitMessageResult,
  CommitPromptInput,
  PrContentResult,
  PrPromptInput,
  ReleaseNotesPromptInput,
  ReviewPromptInput,
  ReviewResult,
} from "./prompt.ts";

export * from "./provider.ts";
export * from "./prompt.ts";
export * from "./base.ts";
export * from "./codex.ts";
export * from "./grok.ts";
export * from "./claude.ts";
export * from "./ollama.ts";

// Lazily constructed so commands that never touch AI don't pay for provider setup
const instances = new Map<AIProviderId, AIProvider>();

function make(id: AIProviderId): AIProvider {
  switch (id) {
    case "grok": return new GrokProvider();
    case "claude": return new ClaudeProvider();
    case "ollama": return new OllamaProvider();
    default: return new CodexProvider();
  }
}

export function getProviderById(id: ConfigAIProvider): AIProvider {
  const existing = instances.get(id);
  if (existing) return existing;
  const created = make(id);
  instances.set(id, created);
  return created;
}

/** Chain order when no preference applies: hosted first, local last. */
export const PROVIDER_ORDER: AIProviderId[] = ["codex", "grok", "claude", "ollama"];

function getCodex(): AIProvider {
  return getProviderById("codex");
}

/**
 * Providers whose account-wide quota is already known to be exhausted in this
 * process. Once Codex says "usage limit", every remaining Codex tier would say
 * the same, so later commands in the same run skip straight to the next provider.
 */
const exhaustedProviders = new Set<AIProviderId>();

/** Test seam: clears the per-process usage-limit memo. */
export function resetProviderExhaustion(): void {
  exhaustedProviders.clear();
}

const MODEL_KEYS: Record<AIProviderId, keyof ReturnType<typeof getConfig>> = {
  codex: "codex_model",
  grok: "grok_model",
  claude: "claude_model",
  ollama: "ollama_model",
};

export function getConfiguredModel(provider: AIProvider): string {
  const config = getConfig();
  return (config[MODEL_KEYS[provider.id]] as string | undefined) || provider.defaultModel;
}

export async function getAvailableProviders(): Promise<AIProvider[]> {
  const providers = PROVIDER_ORDER.map(getProviderById);
  const availability = await Promise.all(providers.map((p) => p.isAvailable()));
  return providers.filter((_, i) => availability[i]);
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

export interface AIAttempt {
  provider: AIProvider;
  providerName: string;
  model: string;
}

export interface AIAttemptFailure {
  providerId: AIProviderId;
  providerName: string;
  model: string;
  kind: AIFailureKind;
  /** One-line human reason, e.g. "usage limit or credits exhausted". */
  reason: string;
  /** Raw provider output line, when there was one. */
  detail: string;
}

export interface AIRunResult<T> {
  result: T;
  provider: AIProvider;
  providerName: string;
  model: string;
  /** Every attempt that failed before the one that succeeded. */
  failures: AIAttemptFailure[];
}

const REMEDIATION: Partial<Record<AIFailureKind, string>> = {
  not_installed: "Install the CLI, or switch providers with `ggh config set ai_provider <codex|grok>`.",
  not_authenticated: "Sign in with `codex login` or `grok login`.",
  usage_limit: "Wait for your quota to reset, buy more credits, or switch providers with `ggh config set ai_provider grok`.",
  timeout: "Increase the limit with `ggh config set ai_timeout_ms 180000`, or commit with `-m` / `--no-ai`.",
};

/** Raised only when every provider and model in the chain has failed. */
export class AIChainError extends Error {
  readonly failures: AIAttemptFailure[];

  constructor(failures: AIAttemptFailure[]) {
    const summary = failures.length
      ? failures.map((f) => `${f.providerName} [${f.model}]: ${f.reason}`).join("; ")
      : "no AI provider is configured";
    super(`AI generation failed — ${summary}`);
    this.name = "AIChainError";
    this.failures = failures;
  }

  /** Actionable next steps, deduplicated across attempts. */
  get remediation(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const failure of this.failures) {
      const hint = REMEDIATION[failure.kind];
      if (hint && !seen.has(hint)) {
        seen.add(hint);
        out.push(hint);
      }
    }
    return out;
  }
}

/**
 * Builds the full ordered attempt list: every model tier of the preferred
 * provider first, then every model tier of the other provider.
 */
export function buildAttemptChain(explicitId?: ConfigAIProvider): AIAttempt[] {
  const config = getConfig();
  const primaryId: ConfigAIProvider = explicitId || config.ai_provider || "codex";
  // Preferred provider first, then the rest in their default order.
  const ordered: AIProvider[] = [
    getProviderById(primaryId),
    ...PROVIDER_ORDER.filter((id) => id !== primaryId).map(getProviderById),
  ];

  const attempts: AIAttempt[] = [];
  for (const provider of ordered) {
    const seen = new Set<string>();
    for (const model of [getConfiguredModel(provider), ...provider.fallbackModels]) {
      if (!model || seen.has(model)) continue;
      seen.add(model);
      attempts.push({ provider, providerName: provider.displayName, model });
    }
  }
  return attempts;
}

function toFailure(attempt: AIAttempt, err: unknown): AIAttemptFailure {
  const kind = classifyAIFailure(err);
  const asAiError =
    err instanceof AIGenerationError
      ? err
      : new AIGenerationError(attempt.provider.id, attempt.model, kind, extractFailureDetail(err));

  return {
    providerId: attempt.provider.id,
    providerName: attempt.providerName,
    model: attempt.model,
    kind,
    reason: asAiError.shortReason,
    detail: asAiError.detail,
  };
}

export interface FallbackOptions {
  explicitProvider?: ConfigAIProvider;
  /**
   * Called after each failed attempt, with the next attempt that will be tried
   * (undefined when the chain is exhausted). Lets the CLI narrate the fallback.
   */
  onAttemptFailed?: (failure: AIAttemptFailure, next?: AIAttempt) => void;
  /** Overrides the provider/model chain. Used by tests; commands should omit it. */
  chain?: AIAttempt[];
}

/**
 * Runs `task` against each provider/model in the chain until one succeeds.
 *
 * Ordering is: preferred provider's configured model, then its cheaper tiers,
 * then the other provider. A provider that reports an account-wide usage limit
 * is dropped for the remainder of the chain (and of the process) rather than
 * being retried once per model tier.
 */
export async function runAIWithFallback<T>(
  task: (provider: AIProvider, model: string) => Promise<T>,
  options: FallbackOptions = {},
): Promise<AIRunResult<T>> {
  const timeoutMs = getConfig().ai_timeout_ms || DEFAULT_AI_TIMEOUT_MS;
  const chain = options.chain ?? buildAttemptChain(options.explicitProvider);
  const failures: AIAttemptFailure[] = [];
  const skipped = new Set<AIProviderId>(exhaustedProviders);

  for (let i = 0; i < chain.length; i++) {
    const attempt = chain[i];
    if (skipped.has(attempt.provider.id)) continue;

    // Reflect the configured timeout onto the provider instance for this attempt.
    (attempt.provider as unknown as { timeoutMs: number }).timeoutMs = timeoutMs;

    try {
      const result = await task(attempt.provider, attempt.model);
      return {
        result,
        provider: attempt.provider,
        providerName: attempt.providerName,
        model: attempt.model,
        failures,
      };
    } catch (err) {
      const failure = toFailure(attempt, err);
      failures.push(failure);

      // A missing binary or an exhausted account applies to every tier of that
      // provider, so stop retrying it model by model.
      if (failure.kind === "usage_limit" || failure.kind === "not_installed") {
        skipped.add(attempt.provider.id);
        if (failure.kind === "usage_limit") {
          exhaustedProviders.add(attempt.provider.id);
        }
      }

      const next = chain.slice(i + 1).find((a) => !skipped.has(a.provider.id));
      options.onAttemptFailed?.(failure, next);
      if (!next) break;
    }
  }

  throw new AIChainError(failures);
}

export async function generateCommitWithFallback(
  input: CommitPromptInput,
  explicitProvider?: ConfigAIProvider,
  onAttemptFailed?: FallbackOptions["onAttemptFailed"],
): Promise<AIRunResult<CommitMessageResult>> {
  return runAIWithFallback((provider, model) => provider.generateCommit(input, model), {
    explicitProvider,
    onAttemptFailed,
  });
}

export async function generatePrWithFallback(
  input: PrPromptInput,
  explicitProvider?: ConfigAIProvider,
  onAttemptFailed?: FallbackOptions["onAttemptFailed"],
): Promise<AIRunResult<PrContentResult>> {
  return runAIWithFallback((provider, model) => provider.generatePr(input, model), {
    explicitProvider,
    onAttemptFailed,
  });
}

export async function generateBranchNameWithFallback(
  taskDescription: string,
  explicitProvider?: ConfigAIProvider,
  onAttemptFailed?: FallbackOptions["onAttemptFailed"],
): Promise<AIRunResult<string>> {
  return runAIWithFallback((provider, model) => provider.generateBranchName(taskDescription, model), {
    explicitProvider,
    onAttemptFailed,
  });
}

export async function generateReleaseNotesWithFallback(
  input: ReleaseNotesPromptInput,
  explicitProvider?: ConfigAIProvider,
  onAttemptFailed?: FallbackOptions["onAttemptFailed"],
): Promise<AIRunResult<string>> {
  return runAIWithFallback((provider, model) => provider.generateReleaseNotes(input, model), {
    explicitProvider,
    onAttemptFailed,
  });
}

export async function generateReviewWithFallback(
  input: ReviewPromptInput,
  explicitProvider?: ConfigAIProvider,
  onAttemptFailed?: FallbackOptions["onAttemptFailed"],
): Promise<AIRunResult<ReviewResult>> {
  return runAIWithFallback((provider, model) => provider.generateReview(input, model), {
    explicitProvider,
    onAttemptFailed,
  });
}

/**
 * Formats a failed chain for the CLI: one line naming what was tried and why it
 * failed, plus deduplicated remediation steps.
 */
export function describeAIFailure(err: unknown): { summary: string; steps: string[] } {
  if (err instanceof AIChainError) {
    const summary = err.failures.length
      ? err.failures.map((f) => `${f.providerName} [${f.model}] — ${f.reason}`).join("\n")
      : "No AI provider is installed or signed in.";
    return { summary, steps: err.remediation };
  }
  return { summary: err instanceof Error ? err.message : String(err), steps: [] };
}
