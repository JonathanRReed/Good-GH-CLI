import type {
  CommitMessageResult,
  CommitPromptInput,
  PrContentResult,
  PrPromptInput,
  ReleaseNotesPromptInput,
  ReviewPromptInput,
  ReviewResult,
} from "./prompt.ts";

export type AIProviderId = "codex" | "grok" | "claude" | "ollama";

export interface AIProvider {
  readonly id: AIProviderId;
  readonly displayName: string;
  readonly defaultModel: string;
  /** Models to try in order, cheapest-but-capable last, when the configured model fails. */
  readonly fallbackModels: readonly string[];
  isAvailable(): Promise<boolean>;
  generateCommit(input: CommitPromptInput, model?: string): Promise<CommitMessageResult>;
  generatePr(input: PrPromptInput, model?: string): Promise<PrContentResult>;
  generateBranchName(taskDescription: string, model?: string): Promise<string>;
  generateReleaseNotes(input: ReleaseNotesPromptInput, model?: string): Promise<string>;
  generateReview(input: ReviewPromptInput, model?: string): Promise<ReviewResult>;
}

/**
 * Why a single provider/model attempt failed. Drives both the retry policy and the
 * message the user sees, so "I ran out of Codex credits" never surfaces as a bare
 * "AI unavailable".
 */
export type AIFailureKind =
  | "not_installed"
  | "not_authenticated"
  | "usage_limit"
  | "timeout"
  | "empty_response"
  | "unknown";

const FAILURE_HINTS: Record<AIFailureKind, string> = {
  not_installed: "CLI not found on PATH",
  not_authenticated: "not signed in",
  usage_limit: "usage limit or credits exhausted",
  timeout: "timed out",
  empty_response: "returned an empty response",
  unknown: "failed",
};

export class AIGenerationError extends Error {
  readonly kind: AIFailureKind;
  readonly providerId: AIProviderId;
  readonly model: string;
  /** Trimmed provider output, useful for `--verbose`-style reporting. */
  readonly detail: string;

  constructor(
    providerId: AIProviderId,
    model: string,
    kind: AIFailureKind,
    detail = "",
  ) {
    const summary = detail.trim().split("\n").filter(Boolean).pop() || FAILURE_HINTS[kind];
    super(`${providerId} (${model}): ${summary}`);
    this.name = "AIGenerationError";
    this.kind = kind;
    this.providerId = providerId;
    this.model = model;
    this.detail = detail.trim();
  }

  /** Short, human-readable reason suitable for a one-line CLI message. */
  get shortReason(): string {
    return FAILURE_HINTS[this.kind];
  }
}

const USAGE_LIMIT_PATTERNS = [
  /usage limit/i,
  /rate limit/i,
  /purchase more credits/i,
  /out of credits/i,
  /credits? (?:depleted|exhausted)/i,
  /quota/i,
  /\b429\b/,
  /too many requests/i,
];

const AUTH_PATTERNS = [
  /not (?:logged|signed) in/i,
  /unauthorized/i,
  /authentication (?:failed|required)/i,
  /please (?:run )?(?:codex|grok) login/i,
  /\b401\b/,
];

/**
 * Maps raw CLI output onto a failure kind. Ordering matters: a 401 emitted while
 * rate limited should still read as a usage limit, so that check runs first.
 */
export function classifyAIFailure(err: unknown): AIFailureKind {
  if (err instanceof AIGenerationError) {
    return err.kind;
  }

  if ((err as { code?: string })?.code === "ENOENT") {
    return "not_installed";
  }

  const text = [
    (err as { stderr?: string })?.stderr,
    (err as { stdout?: string })?.stdout,
    err instanceof Error ? err.message : String(err),
  ]
    .filter(Boolean)
    .join("\n");

  if (/not found in \$PATH|command not found|ENOENT/i.test(text)) {
    return "not_installed";
  }
  if (/timed out/i.test(text)) {
    return "timeout";
  }
  if (USAGE_LIMIT_PATTERNS.some((re) => re.test(text))) {
    return "usage_limit";
  }
  if (AUTH_PATTERNS.some((re) => re.test(text))) {
    return "not_authenticated";
  }
  return "unknown";
}

/**
 * Extracts the most informative line from a failed CLI invocation. Codex and Grok
 * both print a banner before the real error, so the last non-empty ERROR-ish line
 * is far more useful than the first.
 */
export function extractFailureDetail(err: unknown): string {
  const raw = [
    (err as { stderr?: string })?.stderr,
    (err as { stdout?: string })?.stdout,
    err instanceof Error ? err.message : String(err),
  ]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join("\n");

  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const errorLine = [...lines].reverse().find((line) => /error|failed|limit|unauthor/i.test(line));
  return (errorLine || lines[lines.length - 1] || "").slice(0, 400);
}
