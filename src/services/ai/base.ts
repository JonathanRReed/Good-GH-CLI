import { getFlags } from "../runtime.ts";
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
  buildIssueBodyPrompt,
  buildIssueFromDiffPrompt,
  buildPrPrompt,
  buildReleaseNotesPrompt,
  buildReviewPrompt,
  buildSplitPrompt,
  buildTriagePrompt,
  parseJsonResponse,
  type CommitMessageResult,
  type CommitPromptInput,
  type IssueBodyPromptInput,
  type IssueFromDiffPromptInput,
  type IssueFromDiffResult,
  type PrContentResult,
  type PrPromptInput,
  type ReleaseNotesPromptInput,
  type ReviewPromptInput,
  type ReviewResult,
  type SplitPromptInput,
  type SplitResult,
  type TriageItem,
  type TriageResult,
} from "./prompt.ts";
import { sanitizeForAI, sanitizeDiffForAI } from "../../utils/diff.ts";
import { sanitizeBranchName } from "../../utils/branch-name.ts";

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
    if (getFlags().aiDisabled || getFlags().dryRun) throw new Error("AI invocation is disabled for this operation.");
    let raw: string;
    try {
      raw = await this.invoke(sanitizeForAI(prompt, 80_000).text, model, this.timeoutMs);
    } catch (err) {
      if (err instanceof AIGenerationError) throw err;
      throw new AIGenerationError(this.id, model, classifyAIFailure(err), extractFailureDetail(err));
    }

    const trimmed = raw?.trim();
    if (!trimmed) {
      throw new AIGenerationError(this.id, model, "empty_response");
    }
    return trimmed;
  }

  async generateCommit(
    input: CommitPromptInput,
    model = this.defaultModel,
  ): Promise<CommitMessageResult> {
    const raw = await this.runPrompt(buildCommitPrompt({ ...input, stagedDiff: sanitizeDiffForAI(input.stagedDiff).diff }), model);
    const lines = raw.split("\n");
    const parsed = parseJsonResponse<CommitMessageResult>(raw, {
      subject: lines[0]?.slice(0, 72) || "update files",
      body: lines.slice(1).join("\n").trim(),
    });

    const subject = String(parsed.subject ?? "").replace(/\.$/, "").trim();
    if (!subject) {
      throw new AIGenerationError(this.id, model, "empty_response", "no commit subject in response");
    }

    return { subject, body: String(parsed.body ?? "").trim() };
  }

  async generatePr(input: PrPromptInput, model = this.defaultModel): Promise<PrContentResult> {
    const raw = await this.runPrompt(buildPrPrompt({ ...input, diff: sanitizeDiffForAI(input.diff).diff }), model);
    const lines = raw.split("\n");
    const parsed = parseJsonResponse<PrContentResult>(raw, {
      title: lines[0]?.slice(0, 72) || "Update repository",
      body: lines.slice(1).join("\n").trim(),
    });

    const title = String(parsed.title ?? "").trim();
    if (!title) {
      throw new AIGenerationError(this.id, model, "empty_response", "no PR title in response");
    }

    return { title, body: String(parsed.body ?? "").trim() };
  }

  async generateBranchName(taskDescription: string, model = this.defaultModel): Promise<string> {
    const raw = await this.runPrompt(buildBranchNamePrompt(taskDescription), model);
    // Model output is untrusted: a leading dash would become a git flag and a
    // space would split the name into branch + start-point.
    const branch = sanitizeBranchName(raw);

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

  async generateIssueBody(
    input: IssueBodyPromptInput,
    model = this.defaultModel,
  ): Promise<string> {
    const raw = await this.runPrompt(buildIssueBodyPrompt(input), model);
    const unfenced = raw.replace(/^```(?:markdown|md)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    return unfenced.trim();
  }

  async generateReview(input: ReviewPromptInput, model = this.defaultModel): Promise<ReviewResult> {
    const raw = await this.runPrompt(buildReviewPrompt({ ...input, diff: sanitizeDiffForAI(input.diff).diff }), model);
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
        suggestedFix: typeof f.suggestedFix === "string" && f.suggestedFix.trim() ? f.suggestedFix.trim() : undefined,
      })),
    };
  }

  async generateTriage(items: TriageItem[], model = this.defaultModel): Promise<TriageResult> {
    const raw = await this.runPrompt(buildTriagePrompt(items), model);
    const parsed = parseJsonResponse<TriageResult>(raw, { groups: [], suggestions: [] });

    const groups = Array.isArray(parsed.groups)
      ? parsed.groups.filter(
          (g) =>
            g &&
            typeof g.label === "string" &&
            Array.isArray(g.itemIds),
        )
      : [];

    const suggestions = Array.isArray(parsed.suggestions)
      ? parsed.suggestions.filter(
          (s) =>
            s &&
            typeof s.itemId === "string" &&
            ["high", "medium", "low"].includes(s.priority),
        )
      : [];

    return {
      groups: groups.map((g) => ({
        label: String(g.label).trim(),
        itemIds: g.itemIds.map(String),
        summary: String(g.summary ?? "").trim(),
      })),
      suggestions: suggestions.map((s) => ({
        itemId: String(s.itemId).trim(),
        suggestedLabel: typeof s.suggestedLabel === "string" ? s.suggestedLabel.trim() : undefined,
        priority: s.priority as "high" | "medium" | "low",
        draftResponse: typeof s.draftResponse === "string" ? s.draftResponse.trim() : undefined,
      })),
    };
  }

  async generateSplit(input: SplitPromptInput, model = this.defaultModel): Promise<SplitResult> {
    const raw = await this.runPrompt(buildSplitPrompt({ ...input, stagedDiff: sanitizeDiffForAI(input.stagedDiff).diff }), model);
    const parsed = parseJsonResponse<SplitResult>(raw, { commits: [] });

    // Reject the entire proposal. Silently dropping malformed groups or coercing
    // filenames can turn an invalid model response into an unintended commit.
    if (!parsed || !Array.isArray(parsed.commits) || !parsed.commits.length ||
        parsed.commits.some((c) => !c || typeof c.subject !== "string" || !c.subject.trim() ||
          (c.body !== undefined && typeof c.body !== "string") || !Array.isArray(c.files) || !c.files.length ||
          c.files.some((file) => typeof file !== "string" || !file))) {
      throw new AIGenerationError(this.id, model, "empty_response", "invalid split plan; no commits were attempted");
    }
    return { commits: parsed.commits.map((c) => ({ ...c, body: c.body ?? "" })) };
  }

  async generateIssueFromDiff(
    input: IssueFromDiffPromptInput,
    model = this.defaultModel,
  ): Promise<IssueFromDiffResult> {
    const raw = await this.runPrompt(buildIssueFromDiffPrompt({ ...input, diff: sanitizeDiffForAI(input.diff).diff }), model);
    const lines = raw.split("\n");
    const parsed = parseJsonResponse<IssueFromDiffResult>(raw, {
      title: lines[0]?.slice(0, 72) || "New issue",
      body: lines.slice(1).join("\n").trim(),
    });

    const title = String(parsed.title ?? "").trim();
    if (!title) {
      throw new AIGenerationError(this.id, model, "empty_response", "no issue title in response");
    }

    return { title, body: String(parsed.body ?? "").trim() };
  }
}
