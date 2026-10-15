import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureRoot, runFixture } from "./cli-fixture.ts";

const root = fixtureRoot("ggh-ai-opt-in-");
const repo = join(root, "repo");
const squashRepo = join(root, "squash-repo");

beforeAll(async () => {
  const git = async (args: string[]) => {
    const child = Bun.spawn(["git", ...args], { cwd: root, stdout: "ignore", stderr: "pipe" });
    expect(await child.exited).toBe(0);
  };
  await git(["init", "-b", "main", repo]);
  await git(["-C", repo, "config", "user.name", "Fixture"]);
  await git(["-C", repo, "config", "user.email", "fixture@example.com"]);
  writeFileSync(join(repo, "base.txt"), "base\n");
  await git(["-C", repo, "add", "."]);
  await git(["-C", repo, "commit", "-m", "base"]);

  await git(["init", "-b", "main", squashRepo]);
  await git(["-C", squashRepo, "config", "user.name", "Fixture"]);
  await git(["-C", squashRepo, "config", "user.email", "fixture@example.com"]);
  writeFileSync(join(squashRepo, "first.txt"), "first\n");
  await git(["-C", squashRepo, "add", "."]);
  await git(["-C", squashRepo, "commit", "-m", "first change"]);
  writeFileSync(join(squashRepo, "second.txt"), "second\n");
  await git(["-C", squashRepo, "add", "."]);
  await git(["-C", squashRepo, "commit", "-m", "second change"]);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("AI opt-in", () => {
  it("creates a worktree from a deterministic slug without probing a provider by default", async () => {
    writeFileSync(join(repo, ".ggh.json"), JSON.stringify({ ai_enabled: true }));
    const result = await runFixture(["worktree", "add", "Add Search Panel", "--json"], { root, cwd: repo });

    expect(result.exitCode).toBe(0);
    expect(result.providerCalls).toEqual([]);
    expect(existsSync(join(repo, ".worktrees", "feat-add-search-panel"))).toBe(true);
    expect(result.stderr).not.toMatch(/provider|AI generation failed/i);
  });

  it("lets --ai override the disabled default and keeps provider execution inside the fixture", async () => {
    const result = await runFixture(["worktree", "add", "Create Profile Page", "--ai"], {
      root,
      cwd: repo,
      config: { ai_enabled: false, hosted_ai_consent: true },
    });

    expect(result.exitCode).toBe(0);
    expect(result.providerCalls.some(([provider]) => provider === "codex")).toBe(true);
    expect(existsSync(join(repo, ".worktrees", "feat-create-profile-page"))).toBe(true);
  });

  it("lets --no-ai override an enabled user setting", async () => {
    const result = await runFixture(["worktree", "add", "Add Reports Page", "--no-ai"], {
      root,
      cwd: repo,
      config: { ai_enabled: true, hosted_ai_consent: true },
    });

    expect(result.exitCode).toBe(0);
    expect(result.providerCalls).toEqual([]);
    expect(existsSync(join(repo, ".worktrees", "feat-add-reports-page"))).toBe(true);
  });

  it("squashes without AI by using commit history in a no-input run", async () => {
    const before = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: squashRepo }).stdout.toString();
    const refused = await runFixture(["squash", "2", "--no-input", "--json"], { root, cwd: squashRepo });
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stdout).status).toBe("needs_input");
    expect(Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: squashRepo }).stdout.toString()).toBe(before);
    const result = await runFixture(["squash", "2", "--no-input", "--yes"], { root, cwd: squashRepo });

    expect(result.exitCode).toBe(0);
    expect(result.providerCalls).toEqual([]);
    const count = Bun.spawnSync(["git", "rev-list", "--count", "HEAD"], { cwd: squashRepo }).stdout.toString().trim();
    expect(count).toBe("1");
  });

  it("commits an explicit message without AI even when the user enabled it", async () => {
    writeFileSync(join(repo, "change.txt"), "change\n");
    const result = await runFixture(
      ["commit", "--all", "--message", "test: explicit message", "--no-verify"],
      { root, cwd: repo, config: { ai_enabled: true } },
    );

    expect(result.exitCode).toBe(0);
    expect(result.providerCalls).toEqual([]);
    const subject = Bun.spawnSync(["git", "log", "-1", "--format=%s"], { cwd: repo }).stdout.toString().trim();
    expect(subject).toBe("test: explicit message");
  });

  it("does not stage files when a no-input commit lacks its required message", async () => {
    writeFileSync(join(repo, "unstaged.txt"), "keep unstaged\n");
    const before = Bun.spawnSync(["git", "diff", "--cached", "--name-only"], { cwd: repo }).stdout.toString();
    const result = await runFixture(["commit", "--all", "--no-input"], { root, cwd: repo });
    expect(result.exitCode).not.toBe(0);
    expect(result.providerCalls).toEqual([]);
    expect(result.stderr).toContain("commit message is required");
    expect(Bun.spawnSync(["git", "diff", "--cached", "--name-only"], { cwd: repo }).stdout.toString()).toBe(before);
  });
});
