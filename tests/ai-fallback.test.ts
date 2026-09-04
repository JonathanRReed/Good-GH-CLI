import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AIConsentError,
  AIChainError,
  AIGenerationError,
  buildAttemptChain,
  classifyAIFailure,
  describeAIFailure,
  extractFailureDetail,
  resetProviderExhaustion,
  runAIWithFallback,
  ensureHostedAIConsent,
  type AIAttempt,
  type AIProvider,
  type AIProviderId,
} from "../src/services/ai/index.ts";
import { CliAIProvider } from "../src/services/ai/base.ts";
import { getConfig, saveConfig } from "../src/services/config.ts";

/** A provider whose every invocation is scripted, so no CLI is ever spawned. */
class FakeProvider extends CliAIProvider {
  readonly id: AIProviderId;
  readonly displayName: string;
  readonly defaultModel: string;
  readonly fallbackModels: readonly string[];
  readonly calls: string[] = [];

  constructor(
    id: AIProviderId,
    private readonly responses: Record<string, string | Error>,
    models: string[] = [],
  ) {
    super();
    this.id = id;
    this.displayName = id === "codex" ? "Codex (ChatGPT)" : "xAI Grok";
    this.defaultModel = models[0] ?? "model-a";
    this.fallbackModels = models.slice(1);
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  protected async invoke(_prompt: string, model: string): Promise<string> {
    this.calls.push(model);
    const scripted = this.responses[model];
    if (scripted === undefined) throw new Error(`unscripted model ${model}`);
    if (scripted instanceof Error) throw scripted;
    return scripted;
  }
}

describe("hosted AI consent", () => {
  let configDir: string;
  let previousXdg: string | undefined;

  beforeEach(() => {
    previousXdg = process.env.XDG_CONFIG_HOME;
    configDir = mkdtempSync(join(tmpdir(), "good-gh-consent-"));
    process.env.XDG_CONFIG_HOME = configDir;
  });

  afterEach(() => {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    rmSync(configDir, { recursive: true, force: true });
  });

  it("persists explicit consent before hosted repository data may be sent", async () => {
    let prompts = 0;
    await ensureHostedAIConsent(async () => {
      prompts += 1;
      return true;
    });
    await ensureHostedAIConsent(async () => {
      prompts += 1;
      return false;
    });

    expect(prompts).toBe(1);
    expect(getConfig().hosted_ai_consent).toBe(true);
  });

  it("fails closed when consent is declined", async () => {
    await expect(ensureHostedAIConsent(async () => false)).rejects.toBeInstanceOf(AIConsentError);
    expect(getConfig().hosted_ai_consent).toBe(false);
  });
});

function attempt(provider: AIProvider, model: string): AIAttempt {
  return { provider, providerName: provider.displayName, model };
}

const COMMIT_INPUT = {
  branch: "main",
  stagedFiles: [{ path: "a.ts", status: "modified" as const, staged: true }],
  stagedDiff: "diff --git a/a.ts b/a.ts\n+const a = 1;\n",
};

describe("classifyAIFailure", () => {
  it("recognises an exhausted Codex quota from real CLI output", () => {
    const err = Object.assign(new Error("codex exec exited with code 1"), {
      stderr:
        "ERROR: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 7th, 2026 8:50 PM.",
    });
    expect(classifyAIFailure(err)).toBe("usage_limit");
  });

  it("recognises HTTP 429 and 'too many requests' as a usage limit", () => {
    expect(classifyAIFailure(new Error("request failed with 429"))).toBe("usage_limit");
    expect(classifyAIFailure(new Error("Too Many Requests"))).toBe("usage_limit");
  });

  it("recognises a missing binary from an ENOENT spawn error", () => {
    expect(classifyAIFailure(Object.assign(new Error("nope"), { code: "ENOENT" }))).toBe(
      "not_installed",
    );
    expect(classifyAIFailure(new Error('Executable not found in $PATH: "grok"'))).toBe(
      "not_installed",
    );
  });

  it("recognises a logged-out CLI", () => {
    expect(classifyAIFailure(new Error("You are not logged in. Run grok login."))).toBe(
      "not_authenticated",
    );
  });

  it("recognises a timeout", () => {
    expect(classifyAIFailure(new Error("codex exec timed out"))).toBe("timeout");
  });

  it("prefers usage_limit over auth when a rate limit surfaces as a 401", () => {
    expect(classifyAIFailure(new Error("401 Unauthorized: usage limit reached"))).toBe(
      "usage_limit",
    );
  });

  it("falls back to unknown for unrecognised output", () => {
    expect(classifyAIFailure(new Error("segmentation fault"))).toBe("unknown");
  });
});

describe("extractFailureDetail", () => {
  it("picks the real error line out of a CLI banner", () => {
    const err = Object.assign(new Error("codex exited with code 1"), {
      stderr: [
        "OpenAI Codex v0.149.1",
        "model: gpt-5.6-luna",
        "user",
        "ERROR: You've hit your usage limit.",
      ].join("\n"),
    });
    expect(extractFailureDetail(err)).toContain("usage limit");
  });
});

describe("runAIWithFallback", () => {
  beforeEach(() => resetProviderExhaustion());
  afterEach(() => resetProviderExhaustion());

  it("returns the first successful attempt without trying later ones", async () => {
    const codex = new FakeProvider("codex", {
      "gpt-5.6-luna": JSON.stringify({ subject: "feat: add thing", body: "" }),
    });
    const grok = new FakeProvider("grok", { "grok-4.5": "unused" });

    const run = await runAIWithFallback((p, m) => p.generateCommit(COMMIT_INPUT, m), {
      chain: [attempt(codex, "gpt-5.6-luna"), attempt(grok, "grok-4.5")],
    });

    expect(run.result.subject).toBe("feat: add thing");
    expect(run.providerName).toBe("Codex (ChatGPT)");
    expect(run.failures).toEqual([]);
    expect(grok.calls).toEqual([]);
  });

  it("falls through Codex model tiers before switching providers", async () => {
    const codex = new FakeProvider("codex", {
      "gpt-5.6-luna": new Error("stream disconnected"),
      "gpt-5.6-terra": JSON.stringify({ subject: "fix: repair tier", body: "" }),
    });
    const grok = new FakeProvider("grok", { "grok-4.5": "unused" });

    const run = await runAIWithFallback((p, m) => p.generateCommit(COMMIT_INPUT, m), {
      chain: [
        attempt(codex, "gpt-5.6-luna"),
        attempt(codex, "gpt-5.6-terra"),
        attempt(grok, "grok-4.5"),
      ],
    });

    expect(codex.calls).toEqual(["gpt-5.6-luna", "gpt-5.6-terra"]);
    expect(grok.calls).toEqual([]);
    expect(run.model).toBe("gpt-5.6-terra");
    expect(run.failures).toHaveLength(1);
    expect(run.failures.at(0)?.kind).toBe("unknown");
  });

  it("skips the remaining Codex tiers and reaches Grok when the account is out of credits", async () => {
    const usageLimit = Object.assign(new Error("codex exec exited with code 1"), {
      stderr: "ERROR: You've hit your usage limit. Visit ... to purchase more credits.",
    });
    const codex = new FakeProvider("codex", {
      "gpt-5.6-luna": usageLimit,
      "gpt-5.6-terra": usageLimit,
    });
    const grok = new FakeProvider("grok", {
      "grok-4.5": JSON.stringify({ subject: "chore: rescued by grok", body: "" }),
    });

    const seen: string[] = [];
    const run = await runAIWithFallback((p, m) => p.generateCommit(COMMIT_INPUT, m), {
      chain: [
        attempt(codex, "gpt-5.6-luna"),
        attempt(codex, "gpt-5.6-terra"),
        attempt(grok, "grok-4.5"),
      ],
      onAttemptFailed: (failure, next) => seen.push(`${failure.kind}->${next?.model ?? "none"}`),
    });

    // The second Codex tier is never spawned: the quota is account-wide.
    expect(codex.calls).toEqual(["gpt-5.6-luna"]);
    expect(run.providerName).toBe("xAI Grok");
    expect(run.result.subject).toBe("chore: rescued by grok");
    expect(seen).toEqual(["usage_limit->grok-4.5"]);
  });

  it("remembers the exhausted provider for the rest of the process", async () => {
    const usageLimit = Object.assign(new Error("boom"), { stderr: "hit your usage limit" });
    const codex = new FakeProvider("codex", { "gpt-5.6-luna": usageLimit });
    const grok = new FakeProvider("grok", {
      "grok-4.5": JSON.stringify({ subject: "chore: one", body: "" }),
    });
    const chain = [attempt(codex, "gpt-5.6-luna"), attempt(grok, "grok-4.5")];

    await runAIWithFallback((p, m) => p.generateCommit(COMMIT_INPUT, m), { chain });
    await runAIWithFallback((p, m) => p.generateCommit(COMMIT_INPUT, m), { chain });

    expect(codex.calls).toEqual(["gpt-5.6-luna"]);
    expect(grok.calls).toEqual(["grok-4.5", "grok-4.5"]);
  });

  it("stops retrying a provider whose CLI is not installed", async () => {
    const missing = Object.assign(new Error("not found"), { code: "ENOENT" });
    const codex = new FakeProvider("codex", {
      "gpt-5.6-luna": missing,
      "gpt-5.6-terra": missing,
    });
    const grok = new FakeProvider("grok", {
      "grok-4.5": JSON.stringify({ subject: "chore: grok only", body: "" }),
    });

    await runAIWithFallback((p, m) => p.generateCommit(COMMIT_INPUT, m), {
      chain: [
        attempt(codex, "gpt-5.6-luna"),
        attempt(codex, "gpt-5.6-terra"),
        attempt(grok, "grok-4.5"),
      ],
    });

    expect(codex.calls).toEqual(["gpt-5.6-luna"]);
  });

  it("throws an AIChainError naming every provider, model, and reason", async () => {
    const codex = new FakeProvider("codex", {
      "gpt-5.6-luna": Object.assign(new Error("x"), { stderr: "hit your usage limit" }),
    });
    const grok = new FakeProvider("grok", {
      "grok-4.5": new Error("You are not logged in"),
    });

    const err = await runAIWithFallback((p, m) => p.generateCommit(COMMIT_INPUT, m), {
      chain: [attempt(codex, "gpt-5.6-luna"), attempt(grok, "grok-4.5")],
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AIChainError);
    const chainError = err as AIChainError;
    expect(chainError.failures.map((f) => f.kind)).toEqual(["usage_limit", "not_authenticated"]);

    const described = describeAIFailure(chainError);
    expect(described.summary).toContain("gpt-5.6-luna");
    expect(described.summary).toContain("usage limit");
    expect(described.summary).toContain("grok-4.5");
    expect(described.summary).toContain("not signed in");
    // Remediation is deduplicated and actionable.
    expect(described.steps.length).toBe(2);
    expect(described.steps.join(" ")).toContain("codex login");
  });

  it("treats an empty provider response as a failure and moves on", async () => {
    const codex = new FakeProvider("codex", { "gpt-5.6-luna": "   " });
    const grok = new FakeProvider("grok", {
      "grok-4.5": JSON.stringify({ subject: "chore: real answer", body: "" }),
    });

    const run = await runAIWithFallback((p, m) => p.generateCommit(COMMIT_INPUT, m), {
      chain: [attempt(codex, "gpt-5.6-luna"), attempt(grok, "grok-4.5")],
    });

    expect(run.failures.at(0)?.kind).toBe("empty_response");
    expect(run.result.subject).toBe("chore: real answer");
  });
});

describe("buildAttemptChain", () => {
  let configDir: string;
  let previousXdg: string | undefined;

  beforeEach(() => {
    previousXdg = process.env.XDG_CONFIG_HOME;
    configDir = mkdtempSync(join(tmpdir(), "good-gh-config-"));
    process.env.XDG_CONFIG_HOME = configDir;
  });

  afterEach(() => {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    rmSync(configDir, { recursive: true, force: true });
  });

  it("tries every Codex tier before Grok when Codex is preferred", () => {
    saveConfig({ ai_provider: "codex", codex_model: "gpt-5.6-luna" });
    const chain = buildAttemptChain().map((a) => `${a.provider.id}/${a.model}`);

    expect(chain[0]).toBe("codex/gpt-5.6-luna");
    expect(chain.filter((c) => c.startsWith("codex/")).length).toBeGreaterThan(1);

    // Every Codex tier is exhausted before any other provider is tried.
    const lastCodex = chain.map((c) => c.startsWith("codex/")).lastIndexOf(true);
    const firstOther = chain.findIndex((c) => !c.startsWith("codex/"));
    expect(firstOther).toBeGreaterThan(lastCodex);
    expect(chain[firstOther]).toStartWith("grok/");
  });

  it("keeps the local provider last, so it is the final safety net", () => {
    saveConfig({ ai_provider: "codex" });
    const chain = buildAttemptChain().map((a) => a.provider.id);
    expect(chain[chain.length - 1]).toBe("ollama");
  });

  it("puts Grok first when it is the configured provider", () => {
    saveConfig({ ai_provider: "grok" });
    const chain = buildAttemptChain().map((a) => a.provider.id);
    expect(chain[0]).toBe("grok");
    expect(chain).toContain("codex");
  });

  it("honours an explicit --provider override", () => {
    saveConfig({ ai_provider: "codex" });
    expect(buildAttemptChain("grok").at(0)?.provider.id).toBe("grok");
  });

  it("never repeats a model when the configured one is also a fallback tier", () => {
    saveConfig({ ai_provider: "codex", codex_model: "gpt-5.6-terra" });
    const codexModels = buildAttemptChain()
      .filter((a) => a.provider.id === "codex")
      .map((a) => a.model);
    expect(new Set(codexModels).size).toBe(codexModels.length);
    expect(codexModels[0]).toBe("gpt-5.6-terra");
  });
});

describe("AIGenerationError", () => {
  it("summarises the provider's own last error line", () => {
    const err = new AIGenerationError("codex", "gpt-5.6-luna", "usage_limit", "ERROR: hit your usage limit");
    expect(err.message).toContain("gpt-5.6-luna");
    expect(err.message).toContain("hit your usage limit");
    expect(err.shortReason).toBe("usage limit or credits exhausted");
  });
});
