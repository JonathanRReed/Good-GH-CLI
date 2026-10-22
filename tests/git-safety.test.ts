import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execa } from "execa";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getBranchMergeBase,
  getGoneBranches,
  getStatus,
  setBranchMergeBase,
} from "../src/services/git.ts";

const repoRoot = join(import.meta.dir, "..");

async function runCli(
  args: string[],
  cwd: string = repoRoot,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", join(repoRoot, "bin", "ggh.ts"), ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, GGH_NO_RECORDS: "1", NO_COLOR: "1" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("git safety behaviours", () => {
  let repo: string;

  beforeEach(async () => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "ggh-safety-")));
    const git = (args: string[]) => execa("git", args, { cwd: repo });
    await git(["init", "-b", "main"]);
    await git(["config", "user.name", "Test User"]);
    await git(["config", "user.email", "test@example.com"]);
    writeFileSync(join(repo, "README.md"), "# init\n");
    await git(["add", "README.md"]);
    await git(["commit", "-m", "init"]);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("sync keeps unpublished gone branches even with --force", async () => {
    const remote = realpathSync(mkdtempSync(join(tmpdir(), "ggh-safety-remote-")));
    const git = (args: string[]) => execa("git", args, { cwd: repo });
    try {
      await execa("git", ["init", "--bare", "-b", "main"], { cwd: remote });
      await git(["remote", "add", "origin", remote]);
      await git(["push", "-u", "origin", "main"]);

      await git(["checkout", "-b", "stale"]);
      writeFileSync(join(repo, "stale.txt"), "x");
      await git(["add", "stale.txt"]);
      await git(["commit", "-m", "stale commit"]);
      await git(["push", "-u", "origin", "stale"]);

      await git(["checkout", "main"]);
      await git(["push", "origin", "--delete", "stale"]);
      await git(["fetch", "--prune"]);

      const gone = await getGoneBranches(repo);
      expect(gone).toContain("stale");

      const { exitCode, stderr } = await runCli(["sync", "--yes"], repo);
      expect(exitCode).toBe(0);
      expect(stderr).toContain("unpublished");

      const stillGone = await getGoneBranches(repo);
      expect(stillGone).toContain("stale");

      const force = await runCli(["sync", "--yes", "--force"], repo);
      expect(force.exitCode).toBe(0);
      const afterForce = await getGoneBranches(repo);
      expect(afterForce).toContain("stale");
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it("commit --dry-run creates no commit", async () => {
    writeFileSync(join(repo, "new.txt"), "new");
    const before = (await execa("git", ["rev-list", "--count", "HEAD"], { cwd: repo })).stdout;
    const { exitCode, stderr } = await runCli(["commit", "--all", "--dry-run", "-m", "test"], repo);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("dry run");
    const after = (await execa("git", ["rev-list", "--count", "HEAD"], { cwd: repo })).stdout;
    expect(after).toBe(before);
  });

  it("getStatus reports the new path for a rename", async () => {
    const git = (args: string[]) => execa("git", args, { cwd: repo });
    writeFileSync(join(repo, "old.txt"), "a");
    await git(["add", "old.txt"]);
    await git(["commit", "-m", "add old"]);
    await git(["mv", "old.txt", "new.txt"]);
    const status = await getStatus(repo);
    expect(status.staged).toHaveLength(1);
    expect(status.staged[0]?.path).toBe("new.txt");
    expect(status.staged[0]?.status).toBe("renamed");
  });

  it("rename rewrites a child's parent pointer", async () => {
    const git = (args: string[]) => execa("git", args, { cwd: repo });
    await git(["checkout", "-b", "parent"]);
    writeFileSync(join(repo, "parent.txt"), "p");
    await git(["add", "parent.txt"]);
    await git(["commit", "-m", "parent"]);

    await git(["checkout", "-b", "child"]);
    writeFileSync(join(repo, "child.txt"), "c");
    await git(["add", "child.txt"]);
    await git(["commit", "-m", "child"]);
    await setBranchMergeBase("child", "parent", repo);

    await git(["checkout", "parent"]);
    const { exitCode } = await runCli(["rename", "renamed-parent"], repo);
    expect(exitCode).toBe(0);

    const childBase = await getBranchMergeBase("child", repo);
    expect(childBase).toBe("renamed-parent");
  });

  it("stack on refuses detached HEAD", async () => {
    const git = (args: string[]) => execa("git", args, { cwd: repo });
    const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
    await git(["checkout", head]);

    const { exitCode, stderr } = await runCli(["stack", "on", "main"], repo);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("detached HEAD");
  });

  it("log --json is valid JSON", async () => {
    writeFileSync(join(repo, "a.txt"), "1");
    const git = (args: string[]) => execa("git", args, { cwd: repo });
    await git(["add", "a.txt"]);
    await git(["commit", "-m", "second"]);

    const { exitCode, stdout } = await runCli(["log", "-n", "5", "--json"], repo);
    expect(exitCode).toBe(0);
    const records = JSON.parse(stdout);
    expect(Array.isArray(records)).toBe(true);
    expect(records.length).toBeGreaterThanOrEqual(1);
    const first = records[0];
    expect(first).toHaveProperty("hash");
    expect(first).toHaveProperty("abbrev");
    expect(first).toHaveProperty("subject");
    expect(first).toHaveProperty("author");
    expect(first).toHaveProperty("email");
    expect(first).toHaveProperty("date");
    expect(first).toHaveProperty("refs");
  });
});
