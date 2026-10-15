import { describe, expect, it } from "bun:test";
import { CliAIProvider, normalizeAIUsage } from "../src/services/ai/base.ts";
import { parseClaudeResponse } from "../src/services/ai/claude.ts";
import { parseCodexUsage } from "../src/services/ai/codex.ts";
import {
  clearAIUsageReports,
  getAIUsageReports,
  runAIWithFallback,
  type AIAttempt,
} from "../src/services/ai/index.ts";
import type { AIProviderId } from "../src/services/ai/provider.ts";

class UsageProvider extends CliAIProvider {
  readonly id: AIProviderId = "codex";
  readonly displayName = "Usage test";
  readonly defaultModel = "test-model";
  readonly fallbackModels: readonly string[] = [];
  protected readonly cliCommand = "unused-test-command";
  protected readonly diagnosticsVersionArgs = ["--version"] as const;
  protected readonly diagnosticsHelpArgs = ["--help"] as const;
  protected readonly diagnosticsCapabilities: readonly { name: string; pattern: RegExp }[] = [];

  constructor(private readonly shouldFail = false) { super(); }

  async isAvailable(): Promise<boolean> { return true; }

  protected async invoke(): Promise<string> {
    this.setLastUsage({ inputTokens: 12, cachedInputTokens: 4 });
    if (this.shouldFail) throw new Error("private prompt canary failed");
    return "feature-usage-report";
  }
}

describe("provider usage extraction", () => {
  it("reads only turn-completed usage from Codex JSONL", () => {
    const events = [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "private text" } }),
      JSON.stringify({ type: "turn.completed", usage: {
        input_tokens: 120,
        cached_input_tokens: 45,
        cache_write_input_tokens: 8,
        output_tokens: 17,
      } }),
    ].join("\n");
    expect(normalizeAIUsage(parseCodexUsage(events))).toEqual({
      inputTokens: 120,
      outputTokens: 17,
      cachedInputTokens: 45,
      cacheWriteInputTokens: 8,
    });
  });

  it("separates Claude result text from provider-reported usage", () => {
    const response = parseClaudeResponse(JSON.stringify({
      type: "result",
      result: "parsed assistant content",
      total_cost_usd: 0.00024,
      usage: {
        input_tokens: 30,
        output_tokens: 9,
        cache_read_input_tokens: 12,
        cache_creation_input_tokens: 3,
      },
    }));
    expect(response.text).toBe("parsed assistant content");
    expect(normalizeAIUsage(response.usage)).toEqual({
      inputTokens: 30,
      outputTokens: 9,
      cachedInputTokens: 12,
      cacheWriteInputTokens: 3,
      costUsd: 0.00024,
    });
  });

  it("preserves prior plain text output without inventing usage", () => {
    expect(parseClaudeResponse("plain provider response")).toEqual({ text: "plain provider response" });
    expect(normalizeAIUsage(parseCodexUsage("plain provider response"))).toBeUndefined();
  });

  it("drops invalid token and cost scalars", () => {
    expect(normalizeAIUsage({
      inputTokens: -1,
      outputTokens: Number.NEGATIVE_INFINITY,
      cachedInputTokens: Number.NaN,
      cacheWriteInputTokens: 2.5,
      costUsd: Number.POSITIVE_INFINITY,
    })).toBeUndefined();
    expect(normalizeAIUsage({ inputTokens: 2, costUsd: -0.1 })).toEqual({ inputTokens: 2 });
  });
});

describe("AI usage reports", () => {
  it("records provider, model, outcome, and scalars without prompt or error text", async () => {
    clearAIUsageReports();
    const provider = new UsageProvider();
    const attempt: AIAttempt = { provider, providerName: provider.displayName, model: "test-model" };
    const result = await runAIWithFallback((candidate) => candidate.generateBranchName("private prompt canary"), {
      chain: [attempt],
    });

    expect(result.usage).toEqual({ inputTokens: 12, cachedInputTokens: 4 });
    expect(getAIUsageReports()).toEqual([{
      provider: "codex",
      model: "test-model",
      outcome: "succeeded",
      usage: { inputTokens: 12, cachedInputTokens: 4 },
    }]);
    expect(JSON.stringify(getAIUsageReports())).not.toContain("private prompt canary");
  });

  it("records failed attempts without preserving error detail and caps history", async () => {
    clearAIUsageReports();
    const provider = new UsageProvider(true);
    const attempt: AIAttempt = { provider, providerName: provider.displayName, model: "test-model" };
    await expect(runAIWithFallback((candidate) => candidate.generateBranchName("private prompt canary"), {
      chain: [attempt],
    })).rejects.toThrow();
    expect(getAIUsageReports()[0]).toEqual({
      provider: "codex",
      model: "test-model",
      outcome: "failed",
      usage: { inputTokens: 12, cachedInputTokens: 4 },
    });
    expect(JSON.stringify(getAIUsageReports())).not.toContain("private prompt canary");

    clearAIUsageReports();
    const successful = new UsageProvider();
    const successAttempt: AIAttempt = { provider: successful, providerName: successful.displayName, model: "test-model" };
    for (let index = 0; index < 101; index += 1) {
      await runAIWithFallback((candidate) => candidate.generateBranchName("small test"), { chain: [successAttempt] });
    }
    expect(getAIUsageReports()).toHaveLength(100);
  });
});
