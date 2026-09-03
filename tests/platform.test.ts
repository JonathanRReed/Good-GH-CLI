import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execa } from "execa";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findProjectConfigPath,
  getConfig,
  getConfigWithSources,
  saveConfig,
} from "../src/services/config.ts";
import { cached, clearCache } from "../src/services/cache.ts";
import { getFlags, isNonInteractive, resetFlags, setFlags } from "../src/services/runtime.ts";
import {
  getStackAncestors,
  getStackDescendants,
  getStackGraph,
  setBranchMergeBase,
} from "../src/services/git.ts";
import { withRepo } from "../src/services/github.ts";

/* ------------------------------------------------------------------ *
 * Layered configuration
 * ------------------------------------------------------------------ */

describe("configuration layers", () => {
  let home: string;
  let project: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "ggh-cfg-home-")));
    project = realpathSync(mkdtempSync(join(tmpdir(), "ggh-cfg-proj-")));
    for (const key of ["XDG_CONFIG_HOME", "GGH_AI_PROVIDER", "GGH_CODEX_MODEL", "GGH_AI_TIMEOUT_MS"]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.XDG_CONFIG_HOME = home;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it("falls back to defaults when nothing is configured", () => {
    expect(getConfig(project).ai_provider).toBe("codex");
    expect(getConfig(project).ai_timeout_ms).toBe(120_000);
  });

  it("lets the user file override defaults", () => {
    saveConfig({ ai_provider: "grok" });
    expect(getConfig(project).ai_provider).toBe("grok");
  });

  it("lets a project .ggh.json override the user file", () => {
    saveConfig({ ai_provider: "grok", codex_model: "gpt-5.6-luna" });
    writeFileSync(join(project, ".ggh.json"), JSON.stringify({ ai_provider: "claude" }), "utf-8");

    const config = getConfig(project);
    expect(config.ai_provider).toBe("claude");
    // Keys the project file does not mention still come from the user file.
    expect(config.codex_model).toBe("gpt-5.6-luna");
  });

  it("lets the environment override everything below it", () => {
    saveConfig({ ai_provider: "grok" });
    writeFileSync(join(project, ".ggh.json"), JSON.stringify({ ai_provider: "claude" }), "utf-8");
    process.env.GGH_AI_PROVIDER = "ollama";

    expect(getConfig(project).ai_provider).toBe("ollama");
  });

  it("ignores an environment value that is not a real provider", () => {
    process.env.GGH_AI_PROVIDER = "not-a-provider";
    expect(getConfig(project).ai_provider).toBe("codex");
  });

  it("ignores an ai_timeout_ms below the floor", () => {
    process.env.GGH_AI_TIMEOUT_MS = "10";
    expect(getConfig(project).ai_timeout_ms).toBe(120_000);
  });

  it("reports which layer supplied each value", () => {
    saveConfig({ ai_provider: "grok" });
    writeFileSync(join(project, ".ggh.json"), JSON.stringify({ commit_style: "gitmoji" }), "utf-8");
    process.env.GGH_CODEX_MODEL = "gpt-5.6-terra";

    const byKey = Object.fromEntries(getConfigWithSources(project).map((s) => [s.key, s.source]));
    expect(byKey.ai_provider).toBe("user");
    expect(byKey.commit_style).toBe("project");
    expect(byKey.codex_model).toBe("env");
  });

  it("finds a project config in a parent directory", () => {
    const nested = join(project, "packages", "app", "src");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(project, ".ggh.json"), "{}", "utf-8");
    expect(findProjectConfigPath(nested)).toBe(join(project, ".ggh.json"));
  });

  it("writes only to the user file, never absorbing the project or env layers", () => {
    const projectFile = join(project, ".ggh.json");
    writeFileSync(projectFile, JSON.stringify({ ai_provider: "claude" }), "utf-8");
    process.env.GGH_CODEX_MODEL = "gpt-5.6-terra";

    saveConfig({ commit_style: "concise" });

    // The project file is the user's to edit and must be untouched.
    expect(JSON.parse(readFileSync(projectFile, "utf-8"))).toEqual({ ai_provider: "claude" });

    // The user file must not have baked in the higher layers, or removing the
    // project file or the env var would silently keep their values forever.
    const userFile = JSON.parse(readFileSync(join(home, "good-gh", "config.json"), "utf-8"));
    expect(userFile.commit_style).toBe("concise");
    expect(userFile.ai_provider).not.toBe("claude");
    expect(userFile.codex_model).not.toBe("gpt-5.6-terra");
  });
});

/* ------------------------------------------------------------------ *
 * Runtime flags
 * ------------------------------------------------------------------ */

describe("runtime flags", () => {
  afterEach(() => resetFlags());

  it("treats --json as non-interactive, because stdout is being parsed", () => {
    setFlags({ json: true });
    expect(isNonInteractive()).toBe(true);
  });

  it("treats --no-input as non-interactive even on a terminal", () => {
    setFlags({ noInput: true });
    expect(isNonInteractive()).toBe(true);
  });

  it("threads --repo into gh arguments and leaves them alone otherwise", () => {
    expect(withRepo(["pr", "list"])).toEqual(["pr", "list"]);
    setFlags({ repo: "octocat/hello" });
    expect(withRepo(["pr", "list"])).toEqual(["pr", "list", "--repo", "octocat/hello"]);
  });

  it("resets cleanly between commands", () => {
    setFlags({ json: true, dryRun: true, repo: "a/b" });
    resetFlags();
    expect(getFlags()).toEqual({
      json: false,
      quiet: false,
      noInput: false,
      dryRun: false,
      repo: undefined,
    });
  });
});

/* ------------------------------------------------------------------ *
 * Response cache
 * ------------------------------------------------------------------ */

describe("gh response cache", () => {
  let cacheHome: string;
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.XDG_CACHE_HOME;
    cacheHome = realpathSync(mkdtempSync(join(tmpdir(), "ggh-cache-")));
    process.env.XDG_CACHE_HOME = cacheHome;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = saved;
    rmSync(cacheHome, { recursive: true, force: true });
  });

  it("calls the fetcher once and serves the second read from disk", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return { value: calls };
    };

    expect(await cached("k", fetcher, { ttlMs: 60_000 })).toEqual({ value: 1 });
    expect(await cached("k", fetcher, { ttlMs: 60_000 })).toEqual({ value: 1 });
    expect(calls).toBe(1);
  });

  it("refetches once the entry is stale", async () => {
    let calls = 0;
    const fetcher = async () => ({ value: ++calls });
    await cached("stale", fetcher, { ttlMs: 60_000 });
    await new Promise((r) => setTimeout(r, 5));
    await cached("stale", fetcher, { ttlMs: 1 });
    expect(calls).toBe(2);
  });

  it("bypasses the cache when refresh is requested", async () => {
    let calls = 0;
    const fetcher = async () => ({ value: ++calls });
    await cached("r", fetcher, { ttlMs: 60_000 });
    await cached("r", fetcher, { ttlMs: 60_000, refresh: true });
    expect(calls).toBe(2);
  });

  it("keys entries separately", async () => {
    await cached("a", async () => "first", { ttlMs: 60_000 });
    expect(await cached("b", async () => "second", { ttlMs: 60_000 })).toBe("second");
  });

  it("clears everything it wrote", async () => {
    await cached("x", async () => 1, { ttlMs: 60_000 });
    await cached("y", async () => 2, { ttlMs: 60_000 });
    expect(clearCache()).toBeGreaterThanOrEqual(2);
  });
});

/* ------------------------------------------------------------------ *
 * Branch stacks
 * ------------------------------------------------------------------ */

describe("branch stack graph", () => {
  let repo: string;

  beforeEach(async () => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "ggh-stack-")));
    const git = (args: string[]) => execa("git", args, { cwd: repo });
    await git(["init", "-b", "main"]);
    await git(["config", "user.name", "Test User"]);
    await git(["config", "user.email", "test@example.com"]);
    writeFileSync(join(repo, "a.txt"), "base\n");
    await git(["add", "-A"]);
    await git(["commit", "-m", "chore: base"]);

    // main <- one <- two <- three
    for (const [branch, parent] of [
      ["one", "main"],
      ["two", "one"],
      ["three", "two"],
    ]) {
      await git(["checkout", "-b", branch, parent]);
      writeFileSync(join(repo, `${branch}.txt`), `${branch}\n`);
      await git(["add", "-A"]);
      await git(["commit", "-m", `feat: ${branch}`]);
      await setBranchMergeBase(branch, parent, repo);
    }
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("reconstructs the tree from the recorded parent pointers", async () => {
    const graph = await getStackGraph(repo);
    expect(graph.get("one")?.parent).toBe("main");
    expect(graph.get("two")?.parent).toBe("one");
    expect(graph.get("three")?.parent).toBe("two");
    expect(graph.get("main")?.parent).toBeNull();
    expect(graph.get("one")?.children).toEqual(["two"]);
  });

  it("counts how far each branch is ahead of its parent", async () => {
    const graph = await getStackGraph(repo);
    expect(graph.get("two")?.ahead).toBe(1);
    expect(graph.get("two")?.behind).toBe(0);
  });

  it("detects drift after the bottom of the stack moves", async () => {
    const git = (args: string[]) => execa("git", args, { cwd: repo });
    await git(["checkout", "one"]);
    writeFileSync(join(repo, "one.txt"), "revised\n");
    await git(["commit", "-am", "feat: one revised"]);

    const graph = await getStackGraph(repo);
    expect(graph.get("two")?.behind).toBe(1);
  });

  it("walks ancestors from a branch down to the root", async () => {
    const graph = await getStackGraph(repo);
    expect(getStackAncestors(graph, "three")).toEqual(["two", "one", "main"]);
  });

  it("walks descendants from a branch upward", async () => {
    const graph = await getStackGraph(repo);
    expect(getStackDescendants(graph, "one")).toEqual(["two", "three"]);
  });

  it("treats a parent pointer to a deleted branch as no parent", async () => {
    await execa("git", ["checkout", "main"], { cwd: repo });
    await execa("git", ["branch", "-D", "one"], { cwd: repo });

    const graph = await getStackGraph(repo);
    // `two` recorded `one` as its parent; the edge must not dangle.
    expect(graph.get("two")?.parent).toBeNull();
  });

  it("never reports a branch as its own parent", async () => {
    await setBranchMergeBase("two", "two", repo);
    const graph = await getStackGraph(repo);
    expect(graph.get("two")?.parent).toBeNull();
  });
});
