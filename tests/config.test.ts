import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  getConfig,
  getConfigPath,
  getConfigWithSources,
  getProjectConfig,
  sanitizeConfig,
  saveConfig,
  validateConfigValue,
} from "../src/services/config.ts";

// Every test gets its own XDG_CONFIG_HOME: the suite must never touch the
// developer's real ~/.config/good-gh/config.json.
let home: string;
let previousXdg: string | undefined;
const envKeys = Object.keys(DEFAULT_CONFIG).map((k) => `GGH_${k.toUpperCase()}`);
const previousEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ggh-config-"));
  previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = home;
  for (const key of envKeys) {
    previousEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  for (const key of envKeys) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  rmSync(home, { recursive: true, force: true });
});

describe("config service", () => {
  it("provides config path under XDG_CONFIG_HOME/good-gh", () => {
    expect(getConfigPath()).toBe(join(home, "good-gh", "config.json"));
  });

  it("reads and updates configuration values", () => {
    expect(getConfig().codex_model).toBe(DEFAULT_CONFIG.codex_model);
    saveConfig({ codex_model: "gpt-5.6-luna-test" });
    expect(getConfig().codex_model).toBe("gpt-5.6-luna-test");
  });

  it("persists only the keys the user set, so `config list` can still name the winning layer", () => {
    saveConfig({ ai_provider: "grok" });
    const onDisk = JSON.parse(readFileSync(getConfigPath(), "utf-8"));
    expect(Object.keys(onDisk)).toEqual(["ai_provider"]);

    const sources = Object.fromEntries(getConfigWithSources().map((s) => [s.key, s.source]));
    expect(sources.ai_provider).toBe("user");
    expect(sources.codex_model).toBe("default");
    expect(sources.ai_fallback).toBe("default");
  });

  it("unsets a key when it is saved as undefined", () => {
    saveConfig({ ai_provider: "grok", commit_style: "gitmoji" });
    saveConfig({ ai_provider: undefined });
    expect(getConfig().ai_provider).toBe(DEFAULT_CONFIG.ai_provider);
    expect(getConfig().commit_style).toBe("gitmoji");
  });

  it("writes the file readable only by the owner", () => {
    if (process.platform === "win32") return;
    saveConfig({ ai_provider: "grok" });
    expect(statSync(getConfigPath()).mode & 0o777).toBe(0o600);
  });

  it("ignores invalid values in the user file instead of trusting them", () => {
    mkdirSync(join(home, "good-gh"), { recursive: true });
    writeFileSync(getConfigPath(), JSON.stringify({ ai_provider: "skynet", ai_timeout_ms: 1, codex_model: "ok-model" }));
    const config = getConfig();
    expect(config.ai_provider).toBe(DEFAULT_CONFIG.ai_provider);
    expect(config.ai_timeout_ms).toBe(DEFAULT_CONFIG.ai_timeout_ms);
    expect(config.codex_model).toBe("ok-model");
  });

  it("reads every GGH_* environment override through the same validator", () => {
    process.env.GGH_AI_FALLBACK = "false";
    process.env.GGH_HOSTED_AI_CONSENT = "true";
    process.env.GGH_CLAUDE_MODEL = "opus";
    process.env.GGH_AI_TIMEOUT_MS = "not-a-number";
    const config = getConfig();
    expect(config.ai_fallback).toBe(false);
    expect(config.hosted_ai_consent).toBe(true);
    expect(config.claude_model).toBe("opus");
    expect(config.ai_timeout_ms).toBe(DEFAULT_CONFIG.ai_timeout_ms);
  });
});

describe("project .ggh.json", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "ggh-project-"));
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("applies allowed keys and reports the rest as problems", () => {
    writeFileSync(
      join(repo, ".ggh.json"),
      JSON.stringify({
        ai_provider: "ollama",
        ai_fallback: false,
        commit_style: "concise",
        default_clone_dir: "/tmp/evil",
        first_run_completed: true,
        hosted_ai_consent: true,
        bogus: 1,
        codex_model: "has spaces in it",
      }),
    );
    const project = getProjectConfig(repo);
    expect(project?.config).toEqual({ commit_style: "concise" });
    const problemKeys = project?.problems.map((x) => x.key).sort();
    expect(problemKeys).toEqual([
      "ai_fallback",
      "ai_provider",
      "bogus",
      "codex_model",
      "default_clone_dir",
      "first_run_completed",
      "hosted_ai_consent",
    ]);

    const config = getConfig(repo);
    expect(config.ai_provider).toBe(DEFAULT_CONFIG.ai_provider);
    expect(config.commit_style).toBe("concise");
    expect(config.default_clone_dir).toBe(DEFAULT_CONFIG.default_clone_dir);
  });

  it("cannot redirect a user's local-only AI choice to a hosted provider", () => {
    saveConfig({ ai_provider: "ollama", ai_fallback: false });
    writeFileSync(
      join(repo, ".ggh.json"),
      JSON.stringify({ ai_provider: "codex", ai_fallback: true, codex_model: "gpt-5.6-sol" }),
    );

    const config = getConfig(repo);
    expect(config.ai_provider).toBe("ollama");
    expect(config.ai_fallback).toBe(false);
    expect(getProjectConfig(repo)?.problems.map((problem) => problem.key).sort()).toEqual([
      "ai_fallback",
      "ai_provider",
      "codex_model",
    ]);
  });

  it("is found from a nested directory", () => {
    writeFileSync(join(repo, ".ggh.json"), JSON.stringify({ commit_style: "concise" }));
    const nested = join(repo, "a", "b");
    mkdirSync(nested, { recursive: true });
    expect(getConfig(nested).commit_style).toBe("concise");
    expect(getConfigWithSources(nested).find((s) => s.key === "commit_style")?.source).toBe("project");
  });

  it("treats a non-object file as a single problem", () => {
    writeFileSync(join(repo, ".ggh.json"), "[1,2,3]");
    const project = getProjectConfig(repo);
    expect(project?.config).toEqual({});
    expect(project?.problems[0]?.key).toBe("<root>");
  });
});

describe("validateConfigValue", () => {
  it("coerces booleans and integers from strings", () => {
    expect(validateConfigValue("ai_fallback", "false").value).toBe(false);
    expect(validateConfigValue("hosted_ai_consent", "true").value).toBe(true);
    expect(validateConfigValue("ai_fallback", "on").value).toBe(true);
    expect(validateConfigValue("ai_timeout_ms", "60000").value).toBe(60000);
  });

  it("rejects out-of-range and unknown values", () => {
    expect(validateConfigValue("ai_timeout_ms", "10").problem).toBeDefined();
    expect(validateConfigValue("ai_provider", "gemini").problem).toBeDefined();
    expect(validateConfigValue("commit_style", "loud").problem).toBeDefined();
    expect(validateConfigValue("codex_model", "--dangerous").problem).toBeDefined();
    expect(validateConfigValue("nope", "x").problem).toBe("unknown key");
  });

  it("sanitizeConfig drops arrays and non-objects", () => {
    expect(sanitizeConfig(null).problems.length).toBe(1);
    expect(sanitizeConfig("str").problems.length).toBe(1);
    expect(sanitizeConfig({ ai_provider: "grok" }).config).toEqual({ ai_provider: "grok" });
  });
});
