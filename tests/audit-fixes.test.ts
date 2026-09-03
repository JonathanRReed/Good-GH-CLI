import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execa } from "execa";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commit,
  detectDefaultBranch,
  getStatus,
  hasCommits,
  listBranches,
  switchBranch,
  worktreeAdd,
} from "../src/services/git.ts";

describe("audit regression fixes", () => {
  let tempRepo: string;

  beforeAll(async () => {
    tempRepo = realpathSync(mkdtempSync(join(tmpdir(), "good-gh-audit-")));
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

  it("commit() with amend rewrites the last commit instead of creating a new one", async () => {
    writeFileSync(join(tempRepo, "amend-me.txt"), "temporary");
    await execa("git", ["add", "amend-me.txt"], { cwd: tempRepo });

    await commit("feat: original subject", undefined, { cwd: tempRepo });
    const before = await execa("git", ["rev-list", "--count", "HEAD"], { cwd: tempRepo });
    const countBefore = parseInt(before.stdout.trim(), 10);

    await commit("feat: amended subject", "amended body", { cwd: tempRepo, amend: true });

    const after = await execa("git", ["rev-list", "--count", "HEAD"], { cwd: tempRepo });
    const countAfter = parseInt(after.stdout.trim(), 10);
    expect(countAfter).toBe(countBefore);

    const log = await execa("git", ["log", "-1", "--pretty=%s%n%b"], { cwd: tempRepo });
    expect(log.stdout).toContain("feat: amended subject");
    expect(log.stdout).toContain("amended body");
  }, 20000);

  it("switchBranch with a baseBranch creates the branch from that base (no pathspec '--' bug)", async () => {
    // Create a second commit on main so we can verify the base
    writeFileSync(join(tempRepo, "base-marker.txt"), "base");
    await execa("git", ["add", "base-marker.txt"], { cwd: tempRepo });
    await execa("git", ["commit", "-m", "second commit"], { cwd: tempRepo });

    // This used to fail with: fatal: 'main' is not a commit (pathspec bug)
    await switchBranch("feat-from-base", true, tempRepo, "main");
    expect(await hasCommits(tempRepo)).toBe(true);

    const log = await execa("git", ["log", "-1", "--pretty=%s"], { cwd: tempRepo });
    expect(log.stdout.trim()).toBe("second commit");

    // Merge base tracking should record the base branch
    const config = await execa("git", ["config", "branch.feat-from-base.gh-merge-base"], { cwd: tempRepo });
    expect(config.stdout.trim()).toBe("main");

    await switchBranch("main", false, tempRepo);
    await execa("git", ["branch", "-D", "feat-from-base"], { cwd: tempRepo });
  }, 20000);

  it("listBranches parses branch names containing pipe characters", async () => {
    await execa("git", ["branch", "weird|pipe"], { cwd: tempRepo });

    const branches = await listBranches(tempRepo);
    const names = branches.map((b) => b.name);
    expect(names).toContain("weird|pipe");
    expect(names).toContain("main");

    await execa("git", ["branch", "-D", "weird|pipe"], { cwd: tempRepo });
  }, 20000);

  it("detectDefaultBranch prefers recorded merge base, then main, then master", async () => {
    expect(await detectDefaultBranch(tempRepo)).toBe("main");
  }, 20000);

  it("worktreeAdd refuses to clean up directories outside the repository root", async () => {
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "good-gh-outside-")));
    try {
      writeFileSync(join(outsideDir, "precious.txt"), "do not delete");

      let threw = false;
      try {
        await worktreeAdd("feat-outside", outsideDir, "main", tempRepo);
      } catch {
        threw = true;
      }

      expect(threw).toBe(true);
      expect(existsSync(join(outsideDir, "precious.txt"))).toBe(true);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  }, 20000);

  it("worktreeAdd reports which env files were copied", async () => {
    writeFileSync(join(tempRepo, ".env"), "AUDIT_TEST_VAR=1\n");
    const wtPath = join(tempRepo, ".worktrees", "feat-env-report");
    const result = await worktreeAdd("feat-env-report", wtPath, "main", tempRepo);

    expect(result.copiedEnvFiles).toContain(".env");
    expect(existsSync(join(wtPath, ".env"))).toBe(true);

    await execa("git", ["worktree", "remove", "--force", "--", wtPath], { cwd: tempRepo });
    rmSync(join(tempRepo, ".env"), { force: true });
  }, 20000);

  it("getStatus reports detached HEAD state", async () => {
    const sha = (await execa("git", ["rev-parse", "HEAD"], { cwd: tempRepo })).stdout.trim();
    await execa("git", ["checkout", "--detach", sha], { cwd: tempRepo });

    const detached = await getStatus(tempRepo);
    expect(detached.isDetached).toBe(true);
    expect(detached.isRepo).toBe(true);

    await execa("git", ["checkout", "main"], { cwd: tempRepo });
  }, 20000);
});
