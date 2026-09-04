import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/services/config.ts";
import { AIChainError, buildAttemptChain, resetProviderExhaustion, runAIWithFallback } from "../src/services/ai/index.ts";

let home: string;
let previousXdg: string | undefined;
let previousCwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ggh-strict-"));
  previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = home;
  delete process.env.GGH_AI_FALLBACK;
  delete process.env.GGH_AI_PROVIDER;
  previousCwd = process.cwd();
  resetProviderExhaustion();
});

afterEach(() => {
  process.chdir(previousCwd);
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  rmSync(home, { recursive: true, force: true });
});

/**
 * "Set ai_provider to ollama and nothing leaves at all" is a promise in the
 * README. It is only true if a failing Ollama does not fall through to a
 * hosted provider.
 */
describe("ai_fallback=false keeps the chain to one provider", () => {
  it("builds a chain containing only the configured provider", () => {
    saveConfig({ ai_provider: "ollama", ai_fallback: false });
    const providers = new Set(buildAttemptChain().map((a) => a.provider.id));
    expect([...providers]).toEqual(["ollama"]);
  });

  it("still fans out across the configured provider's own model tiers", () => {
    saveConfig({ ai_provider: "codex", ai_fallback: false });
    const chain = buildAttemptChain();
    expect(chain.every((a) => a.provider.id === "codex")).toBe(true);
    expect(chain.length).toBeGreaterThan(1);
  });

  it("defaults to falling back when unset", () => {
    saveConfig({ ai_provider: "ollama" });
    const providers = new Set(buildAttemptChain().map((a) => a.provider.id));
    expect(providers.size).toBeGreaterThan(1);
  });

  it("an explicit --provider never falls through to another provider", () => {
    saveConfig({ ai_provider: "codex" });
    const providers = new Set(buildAttemptChain("grok").map((a) => a.provider.id));
    expect([...providers]).toEqual(["grok"]);
  });

  it("a project .ggh.json cannot override the user's local-only policy", () => {
    const repo = mkdtempSync(join(tmpdir(), "ggh-strict-repo-"));
    writeFileSync(join(repo, ".ggh.json"), JSON.stringify({ ai_provider: "codex", ai_fallback: true }));
    saveConfig({ ai_provider: "ollama", ai_fallback: false });
    process.chdir(repo);
    try {
      expect([...new Set(buildAttemptChain().map((a) => a.provider.id))]).toEqual(["ollama"]);
    } finally {
      process.chdir(previousCwd);
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("fails with a strict-mode hint instead of contacting anyone else", async () => {
    saveConfig({ ai_provider: "ollama", ai_fallback: false });
    const contacted: string[] = [];
    let error: unknown;
    try {
      await runAIWithFallback(async (provider) => {
        contacted.push(provider.id);
        throw new Error("connection refused");
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(AIChainError);
    expect(new Set(contacted)).toEqual(new Set(["ollama"]));
    expect((error as AIChainError).remediation.join("\n")).toContain("ai_fallback");
  });
});
