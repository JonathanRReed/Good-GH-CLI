import {
  AIGenerationError,
  classifyAIFailure,
  extractFailureDetail,
  type AIProvider,
  type AIProviderId,
} from "./provider.ts";
import {
  buildBranchNamePrompt,
  buildCommitPrompt,
  buildPrPrompt,
  buildReleaseNotesPrompt,
  buildReviewPrompt,
  parseJsonResponse,
  type CommitMessageResult,
  type CommitPromptInput,
  type PrContentResult,
  type PrPromptInput,
  type ReleaseNotesPromptInput,
  type ReviewPromptInput,
  type ReviewResult,
} from "./prompt.ts";

/** Upper bound for a single provider invocation. Overridable via config `ai_timeout_ms`. */
export const DEFAULT_AI_TIMEOUT_MS = 120_000;

/**
 * Shared plumbing for CLI-backed providers: prompt building, JSON recovery, and
 * uniform error classification. Subclasses only implement the actual invocation.
 */
export abstract class CliAIProvider implements AIProvider {
  abstract readonly id: AIProviderId;
  abstract readonly displayName: string;
  abstract readonly defaultModel: string;
  abstract readonly fallbackModels: readonly string[];

  abstract isAvailable(): Promise<boolean>;

  /** Runs one prompt and returns the raw assistant text. */
  protected abstract invoke(prompt: string, model: string, timeoutMs: number): Promise<string>;

  protected timeoutMs = DEFAULT_AI_TIMEOUT_MS;

  /** Wraps `invoke` so every failure surfaces as a classified AIGenerationError. */
  protected async runPrompt(prompt: string, model: string): Promise<string> {
    let raw: string;
    try {
      raw = await this.invoke(prompt, model, this.timeoutMs);
    } catch (err) {
      if (err instanceof AIGenerationError) throw err;
      throw new AIGenerationError(this.id, model, classifyAIFailure(err), extractFailureDetail(err));
    }

    if (!raw || !raw.trim()) {
      throw new AIGenerationError(this.id, model, "empty_response");
    }
    return raw.trim();
  }

  async generateCommit(
    input: CommitPromptInput,
    model = this.defaultModel,
  ): Promise<CommitMessageResult> {
    const raw = await this.runPrompt(buildCommitPrompt(input), model);
    const parsed = parseJsonResponse<CommitMessageResult>(raw, {
      subject: raw.split("\n")[0]?.slice(0, 72) || "update files",
      body: raw.split("\n").slice(1).join("\n").trim(),
    });

    const subject = String(parsed.subject ?? "").replace(/\.$/, "").trim();
    if (!subject) {
      throw new AIGenerationError(this.id, model, "empty_response", "no commit subject in response");
    }

    return { subject, body: String(parsed.body ?? "").trim() };
  }

  async generatePr(input: PrPromptInput, model = this.defaultModel): Promise<PrContentResult> {
    const raw = await this.runPrompt(buildPrPrompt(input), model);
    const parsed = parseJsonResponse<PrContentResult>(raw, {
      title: raw.split("\n")[0]?.slice(0, 72) || "Update repository",
      body: raw.split("\n").slice(1).join("\n").trim(),
    });

    const title = String(parsed.title ?? "").trim();
    if (!title) {
      throw new AIGenerationError(this.id, model, "empty_response", "no PR title in response");
    }

    return { title, body: String(parsed.body ?? "").trim() };
  }

  async generateBranchName(taskDescription: string, model = this.defaultModel): Promise<string> {
    const raw = await this.runPrompt(buildBranchNamePrompt(taskDescription), model);
    const branch = (raw.split("\n")[0] ?? "")
      .replace(/[`'"]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .toLowerCase();

    if (!branch) {
      throw new AIGenerationError(this.id, model, "empty_response", "no branch name in response");
    }
    return branch;
  }

  async generateReleaseNotes(
    input: ReleaseNotesPromptInput,
    model = this.defaultModel,
  ): Promise<string> {
    const raw = await this.runPrompt(buildReleaseNotesPrompt(input), model);
    // Models occasionally wrap Markdown in a fence despite the instruction.
    const unfenced = raw.replace(/^```(?:markdown|md)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    return unfenced.trim();
  }

  async generateReview(input: ReviewPromptInput, model = this.defaultModel): Promise<ReviewResult> {
    const raw = await this.runPrompt(buildReviewPrompt(input), model);
    const parsed = parseJsonResponse<ReviewResult>(raw, { summary: raw.slice(0, 800), findings: [] });

    // Drop anything malformed rather than posting a comment with a bad anchor.
    const findings = Array.isArray(parsed.findings)
      ? parsed.findings.filter(
          (f) =>
            f &&
            typeof f.path === "string" &&
            f.path.trim().length > 0 &&
            Number.isInteger(f.line) &&
            f.line > 0 &&
            typeof f.body === "string" &&
            f.body.trim().length > 0,
        )
      : [];

    return {
      summary: String(parsed.summary ?? "").trim(),
      findings: findings.map((f) => ({
        path: f.path.trim(),
        line: f.line,
        severity: ["blocker", "concern", "nit"].includes(f.severity) ? f.severity : "concern",
        body: f.body.trim(),
      })),
    };
  }
}
