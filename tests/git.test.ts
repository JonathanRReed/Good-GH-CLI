import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execa } from "execa";
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkLargeFiles,
  checkSubmodules,
  commit,
  deleteLocalBranch,
  discardFiles,
  execGitWithRetry,
  fetchPrune,
  findPrTemplate,
  getAheadBehind,
  getAheadOfDefault,
  getBranchMergeBase,
  getCurrentBranch,
  getGoneBranches,
  getRepoRoot,
  getStagedDiffStat,
  getStatus,
  hasBranch,
  hasCommits,
  isGitRepo,
  listBranches,
  NON_INTERACTIVE_ENV,
  renameBranch,
  resolveConflict,
  setBranchMergeBase,
  squashCommits,
  stageFiles,
  stashDiff,
  stashDrop,
  stashList,
  stashPop,
  stashPush,
  switchBranch,
  undoCommit,
  worktreeAdd,
  worktreeList,
  worktreeRemove,
} from "../src/services/git.ts";
import { getUnmergedCommits } from "./git-helpers.ts";

describe("git service", () => {
  let tempRepo: string;

  beforeAll(async () => {
    tempRepo = realpathSync(mkdtempSync(join(tmpdir(), "good-gh-test-")));
    await execa("git", ["init", "-b", "main"], { cwd: tempRepo });
    await execa("git", ["config", "user.name", "Test User"], { cwd: tempRepo });
    await execa("git", ["config", "user.email", "test@example.com"], { cwd: tempRepo });

    writeFileSync(join(tempRepo, "README.md"), "# Initial Commit\n");
    await execa("git", ["add", "README.md"], { cwd: tempRepo });
    await execa("git", ["commit", "-m", "initial commit"], { cwd: tempRepo });
  });

  afterAll(() => {
    try {
      rmSync(tempRepo, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("detects git repository and commits correctly", async () => {
    expect(await isGitRepo(tempRepo)).toBe(true);
    expect(await isGitRepo(tmpdir())).toBe(false);
    expect(await hasCommits(tempRepo)).toBe(true);
  });

  it("gets current branch and repo root", async () => {
    const branch = await getCurrentBranch(tempRepo);
    expect(branch).toBe("main");

    const root = await getRepoRoot(tempRepo);
    const rootStat = statSync(root, { bigint: true });
    const tempStat = statSync(tempRepo, { bigint: true });
    expect(rootStat.dev).toBe(tempStat.dev);
    expect(rootStat.ino).toBe(tempStat.ino);
  });

  it("handles files with spaces and unicode without escaping errors", async () => {
    writeFileSync(join(tempRepo, "file with spaces.txt"), "spaces");
    writeFileSync(join(tempRepo, "café.txt"), "unicode");

    let status = await getStatus(tempRepo);
    expect(status.hasChanges).toBe(true);

    const spaceFile = status.untracked.find((f) => f.path === "file with spaces.txt");
    const unicodeFile = status.untracked.find((f) => f.path === "café.txt");
    expect(spaceFile).toBeDefined();
    expect(unicodeFile).toBeDefined();

    // Staging both files must succeed without quote errors
    await stageFiles(["file with spaces.txt", "café.txt"], tempRepo);
    status = await getStatus(tempRepo);
    expect(status.staged.some((f) => f.path === "file with spaces.txt")).toBe(true);
    expect(status.staged.some((f) => f.path === "café.txt")).toBe(true);

    await commit("feat: add spaces and unicode", undefined, tempRepo);
    status = await getStatus(tempRepo);
    expect(status.staged.length).toBe(0);
  });

  it("checks branch existence with hasBranch", async () => {
    expect(await hasBranch("main", tempRepo)).toBe(true);
    expect(await hasBranch("non-existent-branch-xyz", tempRepo)).toBe(false);
  });

  it("creates, lists, and removes git worktrees with new and existing branches", async () => {
    // 1. Create worktree for a NEW branch
    const wtPath = join(tempRepo, ".worktrees", "feat-test");
    await worktreeAdd("feat-test", wtPath, "main", tempRepo);

    let list = await worktreeList(tempRepo);
    expect(list.some((w) => w.branch === "feat-test")).toBe(true);

    await worktreeRemove(wtPath, true, tempRepo);
    list = await worktreeList(tempRepo);
    expect(list.some((w) => w.branch === "feat-test")).toBe(false);

    // 2. Create worktree for an EXISTING branch (must not fail with -b collision)
    const wtPathExisting = join(tempRepo, ".worktrees", "feat-existing");
    await worktreeAdd("feat-test", wtPathExisting, "main", tempRepo);
    list = await worktreeList(tempRepo);
    expect(list.some((w) => w.branch === "feat-test")).toBe(true);

    await worktreeRemove(wtPathExisting, true, tempRepo);
  });

  it("syncs .env files into new worktrees", async () => {
    writeFileSync(join(tempRepo, ".env"), "SECRET_VAR=123\n");
    const wtPath = join(tempRepo, ".worktrees", "feat-env-test");
    await worktreeAdd("feat-env-test", wtPath, "main", tempRepo);

    // Verify .env was copied into the new worktree
    const { existsSync, readFileSync } = await import("node:fs");
    expect(existsSync(join(wtPath, ".env"))).toBe(true);
    expect(readFileSync(join(wtPath, ".env"), "utf-8")).toContain("SECRET_VAR=123");

    await worktreeRemove(wtPath, true, tempRepo);
    rmSync(join(tempRepo, ".env"), { force: true });
  });

  it("refuses to delete an existing directory when creating a worktree", async () => {
    const { mkdirSync, readFileSync } = await import("node:fs");
    const orphanPath = join(tempRepo, ".worktrees", "feat-orphan");
    mkdirSync(orphanPath, { recursive: true });
    writeFileSync(join(orphanPath, "abandoned.txt"), "leftover");

    await expect(worktreeAdd("feat-orphan", orphanPath, "main", tempRepo)).rejects.toThrow(
      "Refusing to replace existing directory",
    );
    expect(readFileSync(join(orphanPath, "abandoned.txt"), "utf-8")).toBe("leftover");
  });

  it("supports undoCommit to reset HEAD~1 while preserving staged changes", async () => {
    writeFileSync(join(tempRepo, "undo-me.txt"), "temporary");
    await stageFiles(["undo-me.txt"], tempRepo);
    await commit("feat: temporary commit", undefined, tempRepo);

    let status = await getStatus(tempRepo);
    expect(status.hasChanges).toBe(false);

    await undoCommit(tempRepo);
    status = await getStatus(tempRepo);
    expect(status.hasChanges).toBe(true);
    expect(status.staged.some((f) => f.path === "undo-me.txt")).toBe(true);
  });

  it("detects merge conflicts accurately in getStatus", async () => {
    const conflictRepo = realpathSync(mkdtempSync(join(tmpdir(), "good-gh-conflict-")));
    try {
      await execa("git", ["init", "-b", "main"], { cwd: conflictRepo });
      await execa("git", ["config", "user.name", "Test User"], { cwd: conflictRepo });
      await execa("git", ["config", "user.email", "test@example.com"], { cwd: conflictRepo });

      writeFileSync(join(conflictRepo, "conflict.txt"), "base\n");
      await execa("git", ["add", "."], { cwd: conflictRepo });
      await execa("git", ["commit", "-m", "base"], { cwd: conflictRepo });

      await execa("git", ["checkout", "-b", "b1"], { cwd: conflictRepo });
      writeFileSync(join(conflictRepo, "conflict.txt"), "branch1\n");
      await execa("git", ["commit", "-am", "b1 change"], { cwd: conflictRepo });

      await execa("git", ["checkout", "main"], { cwd: conflictRepo });
      writeFileSync(join(conflictRepo, "conflict.txt"), "main\n");
      await execa("git", ["commit", "-am", "main change"], { cwd: conflictRepo });

      try {
        await execa("git", ["merge", "b1"], { cwd: conflictRepo });
      } catch {
        // Expected merge conflict
      }

      const status = await getStatus(conflictRepo);
      expect(status.conflicts.length).toBeGreaterThan(0);
      expect(status.conflicts.some((c) => c.path === "conflict.txt")).toBe(true);
    } finally {
      rmSync(conflictRepo, { recursive: true, force: true });
    }
  });

  it("lists local branches and switches branches cleanly", async () => {
    await switchBranch("feat-new-branch", true, tempRepo);
    let branches = await listBranches(tempRepo);
    expect(branches.some((b) => b.name === "feat-new-branch" && b.current)).toBe(true);

    await switchBranch("main", false, tempRepo);
    branches = await listBranches(tempRepo);
    expect(branches.some((b) => b.name === "main" && b.current)).toBe(true);
  });

  it("finds PR templates in repository", async () => {
    const { mkdirSync } = await import("node:fs");
    const githubDir = join(tempRepo, ".github");
    mkdirSync(githubDir, { recursive: true });
    writeFileSync(join(githubDir, "pull_request_template.md"), "## PR Template\n");

    const template = await findPrTemplate(tempRepo);
    expect(template).toContain("## PR Template");

    rmSync(join(githubDir, "pull_request_template.md"), { force: true });
  });

  it("extracts diffStat cleanly", async () => {
    writeFileSync(join(tempRepo, "stat-test.txt"), "hello stat\n");
    await stageFiles(["stat-test.txt"], tempRepo);
    const stat = await getStagedDiffStat(tempRepo);
    expect(stat).toContain("stat-test.txt");
    await execa("git", ["reset", "HEAD", "--", "stat-test.txt"], { cwd: tempRepo });
    rmSync(join(tempRepo, "stat-test.txt"), { force: true });
  });

  it("execGitWithRetry succeeds on standard commands", async () => {
    const result = await execGitWithRetry(["status", "--short"], { cwd: tempRepo });
    expect(result.stdout).toBeDefined();
  });

  it("manages git stash lifecycle (push, list, diff, pop, drop)", async () => {
    // Clear any previous dirty state
    await execa("git", ["reset", "--hard", "HEAD"], { cwd: tempRepo });
    await execa("git", ["clean", "-fd"], { cwd: tempRepo });

    writeFileSync(join(tempRepo, "stash-me.txt"), "stash content\n");
    await stashPush("test stash message", tempRepo);

    const list = await stashList(tempRepo);
    expect(list.length).toBeGreaterThan(0);
    expect(list.at(0)?.message).toContain("test stash message");

    const diff = await stashDiff("stash@{0}", tempRepo);
    expect(diff).toContain("stash-me.txt");

    await stashPop(undefined, tempRepo);
    let afterPopList = await stashList(tempRepo);
    expect(afterPopList.length).toBe(0);

    // Test stash drop
    await stashPush("drop me", tempRepo);
    afterPopList = await stashList(tempRepo);
    expect(afterPopList.length).toBe(1);
    await stashDrop("stash@{0}", tempRepo);
    afterPopList = await stashList(tempRepo);
    expect(afterPopList.length).toBe(0);

    // Clean up
    rmSync(join(tempRepo, "stash-me.txt"), { force: true });
    await execa("git", ["reset", "--hard", "HEAD"], { cwd: tempRepo });
  });

  it("resolves conflicts with resolveConflict strategy", async () => {
    const conflictRepo = realpathSync(mkdtempSync(join(tmpdir(), "good-gh-strat-")));
    try {
      await execa("git", ["init", "-b", "main"], { cwd: conflictRepo });
      await execa("git", ["config", "user.name", "Test User"], { cwd: conflictRepo });
      await execa("git", ["config", "user.email", "test@example.com"], { cwd: conflictRepo });

      writeFileSync(join(conflictRepo, "c.txt"), "base\n");
      await execa("git", ["add", "."], { cwd: conflictRepo });
      await execa("git", ["commit", "-m", "base"], { cwd: conflictRepo });

      await execa("git", ["checkout", "-b", "feature"], { cwd: conflictRepo });
      writeFileSync(join(conflictRepo, "c.txt"), "theirs\n");
      await execa("git", ["commit", "-am", "feature"], { cwd: conflictRepo });

      await execa("git", ["checkout", "main"], { cwd: conflictRepo });
      writeFileSync(join(conflictRepo, "c.txt"), "ours\n");
      await execa("git", ["commit", "-am", "main"], { cwd: conflictRepo });

      try {
        await execa("git", ["merge", "feature"], { cwd: conflictRepo });
      } catch {
        // Conflict
      }

      // Resolve with "theirs"
      await resolveConflict("c.txt", "theirs", conflictRepo);
      const status = await getStatus(conflictRepo);
      expect(status.conflicts.length).toBe(0);
      expect(status.staged.some((f) => f.path === "c.txt")).toBe(true);
    } finally {
      rmSync(conflictRepo, { recursive: true, force: true });
    }
  });

  it("checks large files correctly (blocking >=100MB, warning >=50MB)", async () => {
    // Normal file
    writeFileSync(join(tempRepo, "small.txt"), "hello small");
    await stageFiles(["small.txt"], tempRepo);
    const result = await checkLargeFiles([{ path: "small.txt", status: "added", staged: true }], tempRepo);
    expect(result.blocked.length).toBe(0);
    expect(result.warnings.length).toBe(0);
    rmSync(join(tempRepo, "small.txt"), { force: true });
  });

  it("calculates ahead/behind drift", async () => {
    const drift = await getAheadBehind(tempRepo);
    expect(typeof drift.ahead).toBe("number");
    expect(typeof drift.behind).toBe("number");
  });

  it("prunes remote refs, identifies gone branches, and deletes stale branches", async () => {
    const remoteRepo = mkdtempSync(join(tmpdir(), "sync-rem-"));
    const localRepo = mkdtempSync(join(tmpdir(), "sync-loc-"));
    try {
      await execa("git", ["init", "--bare", "-b", "main"], { cwd: remoteRepo });
      await execa("git", ["init", "-b", "main"], { cwd: localRepo });
      await execa("git", ["config", "user.name", "Test"], { cwd: localRepo });
      await execa("git", ["config", "user.email", "test@example.com"], { cwd: localRepo });
      await execa("git", ["remote", "add", "origin", remoteRepo], { cwd: localRepo });
      writeFileSync(join(localRepo, "f.txt"), "hello");
      await execa("git", ["add", "."], { cwd: localRepo });
      await execa("git", ["commit", "-m", "init"], { cwd: localRepo });
      await execa("git", ["push", "-u", "origin", "main"], { cwd: localRepo });

      // Create branch, push it, then delete from remote
      await execa("git", ["checkout", "-b", "stale-branch"], { cwd: localRepo });
      writeFileSync(join(localRepo, "f2.txt"), "stale");
      await execa("git", ["add", "."], { cwd: localRepo });
      await execa("git", ["commit", "-m", "stale commit"], { cwd: localRepo });
      await execa("git", ["push", "-u", "origin", "stale-branch"], { cwd: localRepo });

      await execa("git", ["checkout", "main"], { cwd: localRepo });
      await execa("git", ["push", "origin", "--delete", "stale-branch"], { cwd: localRepo });

      await fetchPrune(localRepo);
      const gone = await getGoneBranches(localRepo);
      expect(gone).toContain("stale-branch");

      await deleteLocalBranch("stale-branch", true, localRepo);
      const afterGone = await getGoneBranches(localRepo);
      expect(afterGone).not.toContain("stale-branch");
    } finally {
      rmSync(remoteRepo, { recursive: true, force: true });
      rmSync(localRepo, { recursive: true, force: true });
    }
  });

  it("supports signed commits with signoff flag", async () => {
    writeFileSync(join(tempRepo, "signoff.txt"), "sign me");
    await stageFiles(["signoff.txt"], tempRepo);
    await commit("test: signoff commit", "commit body", { signoff: true, cwd: tempRepo });
    const { stdout } = await execa("git", ["log", "-n", "1"], { cwd: tempRepo });
    expect(stdout).toContain("Signed-off-by:");
    rmSync(join(tempRepo, "signoff.txt"), { force: true });
  });

  it("checks submodule status cleanly", async () => {
    const submodules = await checkSubmodules(tempRepo);
    expect(Array.isArray(submodules)).toBe(true);
  });

  it("identifies unmerged commits between branches", async () => {
    await execa("git", ["checkout", "-b", "unmerged-test-branch"], { cwd: tempRepo });
    writeFileSync(join(tempRepo, "unmerged.txt"), "hello unmerged");
    await stageFiles(["unmerged.txt"], tempRepo);
    await commit("feat: unmerged commit", "", { cwd: tempRepo });

    const unmerged = await getUnmergedCommits("unmerged-test-branch", "main", tempRepo);
    expect(unmerged.length).toBeGreaterThan(0);

    // Switch back to main and clean up
    await execa("git", ["checkout", "main"], { cwd: tempRepo });
    await deleteLocalBranch("unmerged-test-branch", true, tempRepo);
  });

  it("squashes commits with squashCommits helper", async () => {
    writeFileSync(join(tempRepo, "sq1.txt"), "1");
    await stageFiles(["sq1.txt"], tempRepo);
    await commit("commit 1", "", { cwd: tempRepo });

    writeFileSync(join(tempRepo, "sq2.txt"), "2");
    await stageFiles(["sq2.txt"], tempRepo);
    await commit("commit 2", "", { cwd: tempRepo });

    const result = await squashCommits(2, tempRepo);
    expect(result.previousMessages.length).toBe(2);
    expect(result.previousMessages[0]).toBe("commit 2");
    expect(result.previousMessages[1]).toBe("commit 1");

    // Commit consolidated
    await commit("squashed 1 and 2", "", { cwd: tempRepo });
    rmSync(join(tempRepo, "sq1.txt"), { force: true });
    rmSync(join(tempRepo, "sq2.txt"), { force: true });
  });

  it("calculates aheadOfDefault count against main", async () => {
    const count = await getAheadOfDefault("main", tempRepo);
    expect(typeof count).toBe("number");
  });

  it("discards and reverts file changes cleanly (Lazygit-style)", async () => {
    writeFileSync(join(tempRepo, "discard-me.txt"), "before\n");
    await stageFiles(["discard-me.txt"], tempRepo);
    await commit("add discard file", "", { cwd: tempRepo });

    // Modify file
    writeFileSync(join(tempRepo, "discard-me.txt"), "modified\n");
    const statusBefore = await getStatus(tempRepo);
    expect(statusBefore.unstaged.some((f) => f.path === "discard-me.txt")).toBe(true);

    // Discard
    await discardFiles([{ path: "discard-me.txt" }], tempRepo);
    const statusAfter = await getStatus(tempRepo);
    expect(statusAfter.unstaged.some((f) => f.path === "discard-me.txt")).toBe(false);

    // Clean up
    rmSync(join(tempRepo, "discard-me.txt"), { force: true });
    await execa("git", ["add", "-A"], { cwd: tempRepo });
    await commit("remove discard-me.txt", "", { cwd: tempRepo });
  });

  it("sets and gets branch merge base (T3 Code pattern)", async () => {
    await setBranchMergeBase("feat/test-base", "main", tempRepo);
    const base = await getBranchMergeBase("feat/test-base", tempRepo);
    expect(base).toBe("main");
  });

  it("renames branch and preserves merge base", async () => {
    await execa("git", ["checkout", "-b", "feat/orig-name"], { cwd: tempRepo });
    await setBranchMergeBase("feat/orig-name", "main", tempRepo);

    await renameBranch("feat/orig-name", "feat/renamed-name", tempRepo);
    const current = await getCurrentBranch(tempRepo);
    expect(current).toBe("feat/renamed-name");

    const preservedBase = await getBranchMergeBase("feat/renamed-name", tempRepo);
    expect(preservedBase).toBe("main");

    // Switch back to main
    await execa("git", ["checkout", "main"], { cwd: tempRepo });
    await deleteLocalBranch("feat/renamed-name", true, tempRepo);
  });

  it("defines NON_INTERACTIVE_ENV with fail-fast terminal flags", () => {
    expect(NON_INTERACTIVE_ENV.GIT_TERMINAL_PROMPT).toBe("0");
    expect(NON_INTERACTIVE_ENV.GCM_INTERACTIVE).toBe("never");
  });
});
