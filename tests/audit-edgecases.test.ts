import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execa } from "execa";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commit,
  getCommitCount,
  getRemotes,
  getRemoteTrackingBranch,
  getStatus,
  isDetachedHead,
  push,
  squashCommits,
  undoCommit,
} from "../src/services/git.ts";
import { hasRemote } from "./git-helpers.ts";

describe("audit edge cases", () => {
  let tempRepo: string;

  beforeEach(async () => {
    tempRepo = realpathSync(mkdtempSync(join(tmpdir(), "good-gh-audit-test-")));
    await execa("git", ["init", "-b", "main"], { cwd: tempRepo });
    await execa("git", ["config", "user.name", "Audit Tester"], { cwd: tempRepo });
    await execa("git", ["config", "user.email", "audit@example.com"], { cwd: tempRepo });
  });

  afterEach(() => {
    try {
      rmSync(tempRepo, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it("rejects empty or whitespace commit message", async () => {
    writeFileSync(join(tempRepo, "a.txt"), "hello");
    await execa("git", ["add", "a.txt"], { cwd: tempRepo });

    await expect(commit("", undefined, tempRepo)).rejects.toThrow(
      "Commit message cannot be empty.",
    );
    await expect(commit("   ", undefined, tempRepo)).rejects.toThrow(
      "Commit message cannot be empty.",
    );
  });

  it("handles single-commit repository undoCommit cleanly via update-ref", async () => {
    writeFileSync(join(tempRepo, "root.txt"), "initial content");
    await execa("git", ["add", "root.txt"], { cwd: tempRepo });
    await commit("feat: initial commit", undefined, tempRepo);

    expect(await getCommitCount(tempRepo)).toBe(1);

    // In a 1-commit repo, HEAD~1 does not exist. undoCommit must not crash!
    await undoCommit(tempRepo);

    // Commit count should now be 0 (unborn branch)
    expect(await getCommitCount(tempRepo)).toBe(0);

    // Changes should remain staged
    const status = await getStatus(tempRepo);
    expect(status.staged.some((f) => f.path === "root.txt")).toBe(true);
  });

  it("detects detached HEAD and prevents pushing from detached HEAD", async () => {
    writeFileSync(join(tempRepo, "c1.txt"), "one");
    await execa("git", ["add", "c1.txt"], { cwd: tempRepo });
    await commit("feat: first", undefined, tempRepo);

    writeFileSync(join(tempRepo, "c2.txt"), "two");
    await execa("git", ["add", "c2.txt"], { cwd: tempRepo });
    await commit("feat: second", undefined, tempRepo);

    // Initially on main branch
    expect(await isDetachedHead(tempRepo)).toBe(false);
    let status = await getStatus(tempRepo);
    expect(status.isDetached).toBe(false);

    // Checkout commit directly -> detached HEAD
    const { stdout: headSha } = await execa("git", ["rev-parse", "HEAD~1"], { cwd: tempRepo });
    await execa("git", ["checkout", headSha.trim()], { cwd: tempRepo });

    expect(await isDetachedHead(tempRepo)).toBe(true);
    status = await getStatus(tempRepo);
    expect(status.isDetached).toBe(true);
    expect(status.branch).toBe("HEAD");

    // Attempting push from detached HEAD must fail with clear error
    await expect(push({ cwd: tempRepo })).rejects.toThrow(
      "Cannot push from a detached HEAD state",
    );
  });

  it("detects missing git remotes and prevents pushing without remote", async () => {
    writeFileSync(join(tempRepo, "file.txt"), "data");
    await execa("git", ["add", "file.txt"], { cwd: tempRepo });
    await commit("feat: file", undefined, tempRepo);

    const remotes = await getRemotes(tempRepo);
    expect(remotes).toEqual([]);
    expect(await hasRemote("origin", tempRepo)).toBe(false);

    // Push with no remotes must throw descriptive message
    await expect(push({ cwd: tempRepo })).rejects.toThrow(
      "No git remotes configured",
    );
  });

  it("accurately calculates commit count and guards against squashing more commits than available", async () => {
    writeFileSync(join(tempRepo, "1.txt"), "1");
    await execa("git", ["add", "1.txt"], { cwd: tempRepo });
    await commit("feat: 1", undefined, tempRepo);

    writeFileSync(join(tempRepo, "2.txt"), "2");
    await execa("git", ["add", "2.txt"], { cwd: tempRepo });
    await commit("feat: 2", undefined, tempRepo);

    expect(await getCommitCount(tempRepo)).toBe(2);

    // Trying to squash 5 commits when only 2 exist should throw a clean error
    await expect(squashCommits(5, tempRepo)).rejects.toThrow(
      "Cannot squash 5 commits: only 2 commit(s) available.",
    );

    // Squashing <= 1 commit should throw
    await expect(squashCommits(1, tempRepo)).rejects.toThrow(
      "Squash count must be at least 2.",
    );
  });

  it("returns null safely for getRemoteTrackingBranch when branch has no upstream", async () => {
    writeFileSync(join(tempRepo, "init.txt"), "test");
    await execa("git", ["add", "init.txt"], { cwd: tempRepo });
    await commit("feat: init", undefined, tempRepo);

    const tracking = await getRemoteTrackingBranch(tempRepo, "main");
    expect(tracking).toBeNull();
  });
});
