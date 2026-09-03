import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execa } from "execa";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getBranchDiff,
  getBranchDiffStat,
  getCommitsSinceBase,
  getCurrentBranch,
  getStagedDiff,
  getStagedDiffStat,
  hasCommits,
  isDetachedHead,
} from "../src/services/git.ts";

/**
 * A Pull Request describes a whole branch, not the last staged change. These
 * cover the branch-scoped diff helpers that `ggh commit --pr` uses after the
 * commit already emptied the index.
 */
describe("branch-scoped diff helpers", () => {
  let repo: string;

  beforeAll(async () => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "good-gh-branchdiff-")));
    const git = (args: string[]) => execa("git", args, { cwd: repo });

    await git(["init", "-b", "main"]);
    await git(["config", "user.name", "Test User"]);
    await git(["config", "user.email", "test@example.com"]);
    writeFileSync(join(repo, "base.txt"), "base\n");
    await git(["add", "base.txt"]);
    await git(["commit", "-m", "chore: base"]);

    await git(["checkout", "-b", "feat/two-commits"]);
    writeFileSync(join(repo, "one.txt"), "one\n");
    await git(["add", "one.txt"]);
    await git(["commit", "-m", "feat: add one"]);
    writeFileSync(join(repo, "two.txt"), "two\n");
    await git(["add", "two.txt"]);
    await git(["commit", "-m", "feat: add two"]);
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("returns an empty staged diff once everything is committed", async () => {
    expect((await getStagedDiff(repo)).trim()).toBe("");
    expect(await getStagedDiffStat(repo)).toBe("");
  });

  it("still describes the full branch against its base", async () => {
    const diff = await getBranchDiff("main", repo);
    expect(diff).toContain("one.txt");
    expect(diff).toContain("two.txt");

    const stat = await getBranchDiffStat("main", repo);
    expect(stat).toContain("2 files changed");
  });

  it("lists every commit the branch adds, newest first", async () => {
    expect(await getCommitsSinceBase("main", 50, repo)).toEqual([
      "feat: add two",
      "feat: add one",
    ]);
  });

  it("returns empty results for an unknown base instead of throwing", async () => {
    expect(await getBranchDiff("does-not-exist", repo)).toBe("");
    expect(await getBranchDiffStat("does-not-exist", repo)).toBe("");
    expect(await getCommitsSinceBase("does-not-exist", 50, repo)).toEqual([]);
  });
});

describe("getCurrentBranch on edge-case HEAD states", () => {
  let repo: string;

  beforeAll(async () => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "good-gh-headstate-")));
    await execa("git", ["init", "-b", "trunk"], { cwd: repo });
    await execa("git", ["config", "user.name", "Test User"], { cwd: repo });
    await execa("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("names the unborn branch of a fresh repository instead of reporting HEAD", async () => {
    expect(await hasCommits(repo)).toBe(false);
    expect(await getCurrentBranch(repo)).toBe("trunk");
    expect(await isDetachedHead(repo)).toBe(false);
  });

  it("reports HEAD once the repository is genuinely detached", async () => {
    writeFileSync(join(repo, "f.txt"), "one\n");
    await execa("git", ["add", "f.txt"], { cwd: repo });
    await execa("git", ["commit", "-m", "chore: first"], { cwd: repo });
    const { stdout: sha } = await execa("git", ["rev-parse", "HEAD"], { cwd: repo });

    await execa("git", ["checkout", "--detach", sha.trim()], { cwd: repo });
    expect(await isDetachedHead(repo)).toBe(true);
    expect(await getCurrentBranch(repo)).toBe("HEAD");
  });
});
