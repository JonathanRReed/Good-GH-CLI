import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFixture } from "./cli-fixture.ts";
import { acquireStackOperationLock, createStackRecovery, readStackRecovery, writeStackRecovery, type StackRecoveryCheckpoint } from "../src/services/git/stack.ts";

let root: string;
setDefaultTimeout(30_000);

interface RemoteViewBranch {
  branch: string;
  parent: string | null;
  remote: {
    state: string;
    reason?: string;
    pr?: {
      number: number;
      reviewDecision: string | null;
      checks: { state: string; runs?: Array<{ name: string; state: string }> };
    };
  };
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function commitFile(path: string, content: string, message = path): void {
  writeFileSync(join(root, path), content);
  git("add", "--", path);
  git("-c", "commit.gpgsign=false", "commit", "-m", message);
}

function setParent(child: string, parent: string, parentTip: string): void {
  git("config", "branch." + child + ".gh-merge-base", parent);
  git("config", "branch." + child + ".gh-merge-base-sha", parentTip);
}

function setupStack(conflict = false): { parentTip: string; childTip: string; grandTip: string; sideTip: string } {
  git("init", "-b", "main");
  git("config", "user.name", "Stack tests");
  git("config", "user.email", "stack-tests@example.invalid");
  git("config", "commit.gpgsign", "false");
  commitFile("shared.txt", "base\n", "base");
  git("switch", "-c", "parent");
  commitFile("shared.txt", conflict ? "parent\n" : "parent\n", "parent");
  const parentTip = git("rev-parse", "HEAD");
  git("switch", "-c", "child");
  setParent("child", "parent", parentTip);
  if (conflict) commitFile("shared.txt", "child\n", "child conflict");
  else commitFile("child.txt", "child\n", "child");
  const childTip = git("rev-parse", "HEAD");
  git("switch", "-c", "grandchild");
  setParent("grandchild", "child", childTip);
  commitFile("grandchild.txt", "grandchild\n", "grandchild");
  const grandTip = git("rev-parse", "HEAD");
  git("switch", "main");
  git("switch", "-c", "side");
  git("config", "branch.side.gh-merge-base", "main");
  git("config", "branch.side.gh-merge-base-sha", git("rev-parse", "main"));
  commitFile("side.txt", "side\n", "side");
  const sideTip = git("rev-parse", "HEAD");
  git("switch", "main");
  git("switch", "parent");
  writeFileSync(join(root, "shared.txt"), "amended parent\n");
  git("add", "shared.txt");
  git("-c", "commit.gpgsign=false", "commit", "--amend", "--no-edit");
  git("switch", "main");
  return { parentTip: git("rev-parse", "parent"), childTip, grandTip, sideTip };
}

function originalTips(): Record<string, string> {
  return Object.fromEntries(["main", "parent", "child", "grandchild", "side"].map((branch) => [branch, git("rev-parse", branch)]));
}

async function cli(...args: string[]) {
  const fixture = join(root, "fixture-");
  mkdirSync(fixture, { recursive: true });
  return runFixture(["stack", ...args], { root: fixture, cwd: root });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ggh-stack-recovery-")));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("stack recovery", () => {
  it("serializes concurrent stack commands and leaves stale lock cleanup explicit", async () => {
    setupStack();
    const attempts = await Promise.allSettled([
      acquireStackOperationLock(root, "stack restack"),
      acquireStackOperationLock(root, "stack submit"),
    ]);
    const acquired = attempts.filter((item): item is PromiseFulfilledResult<() => Promise<void>> => item.status === "fulfilled");
    const blocked = attempts.find((item): item is PromiseRejectedResult => item.status === "rejected");
    expect(acquired).toHaveLength(1);
    expect(blocked?.reason).toBeInstanceOf(Error);
    expect(String(blocked?.reason)).toContain("Another stack command is active");
    await acquired[0]?.value();

    const lock = join(root, ".git", "ggh-stack-recovery", "operation.lock");
    writeFileSync(lock, JSON.stringify({ schemaVersion: 1, pid: 2_147_483_647, token: "stale", command: "stack restack", startedAt: new Date(0).toISOString() }));
    chmodSync(lock, 0o600);
    await expect(acquireStackOperationLock(root, "stack submit")).rejects.toThrow("A stale stack lock");
    expect(existsSync(lock)).toBe(true);
    writeFileSync(lock, "x".repeat(5 * 1024));
    chmodSync(lock, 0o600);
    await expect(acquireStackOperationLock(root, "stack submit")).rejects.toThrow("exceeds 4 KiB");
    expect(existsSync(lock)).toBe(true);
  });

  it("creates a recovery checkpoint exclusively instead of replacing another operation", async () => {
    setupStack();
    const checkpoint = (operationId: string): StackRecoveryCheckpoint => ({
      schemaVersion: 1,
      operationId,
      mode: "restack",
      selected: "child",
      originalBranch: "main",
      entries: [],
      activeIndex: 0,
      resources: [],
    });
    const first = checkpoint(randomUUID());
    await createStackRecovery(first, root);
    await expect(createStackRecovery(checkpoint(randomUUID()), root)).rejects.toThrow("checkpoint already exists");
    expect((await readStackRecovery(root))?.operationId).toBe(first.operationId);
  });

  it("rejects recovery checkpoints over 64 KiB before creating or replacing them", async () => {
    setupStack();
    const large: StackRecoveryCheckpoint = {
      schemaVersion: 1,
      operationId: randomUUID(),
      mode: "restack",
      selected: "child",
      originalBranch: "main",
      entries: Array.from({ length: 100 }, (_, index) => ({
        branch: "branch-" + index + "-" + "b".repeat(700),
        parent: "p".repeat(700),
        originalTip: "a".repeat(40),
        expectedTip: "a".repeat(40),
        state: "pending" as const,
      })),
      activeIndex: 0,
      resources: [],
    };
    const path = join(root, ".git", "ggh-stack-recovery", "active.json");
    await expect(createStackRecovery(large, root)).rejects.toThrow("exceeds 64 KiB");
    expect(existsSync(path)).toBe(false);

    const small = { ...large, operationId: randomUUID(), entries: [] };
    await createStackRecovery(small, root);
    await expect(writeStackRecovery(large, root)).rejects.toThrow("exceeds 64 KiB");
    expect((await readStackRecovery(root))?.operationId).toBe(small.operationId);
  });

  it("rejects a conflicting explicit repository before pushing and rejects -R for local restacks", async () => {
    setupStack();
    git("remote", "add", "origin", "https://github.com/other/repo.git");
    mkdirSync(join(root, "fixture-target-"), { recursive: true });
    const tips = originalTips();
    const submit = await runFixture(["stack", "submit", "child", "--repo", "github.com/test/repo", "--yes", "--json"], {
      root: join(root, "fixture-target-"), cwd: root,
    });
    expect(submit.exitCode).not.toBe(0);
    expect(submit.stderr).toContain("does not match push remote origin");
    expect(submit.calls.every((args) => args[0] === "auth")).toBe(true);
    expect(originalTips()).toEqual(tips);

    mkdirSync(join(root, "fixture-restack-target-"), { recursive: true });
    const restack = await runFixture(["stack", "restack", "child", "--repo", "test/repo", "--yes", "--json"], {
      root: join(root, "fixture-restack-target-"), cwd: root,
    });
    expect(restack.exitCode).not.toBe(0);
    expect(restack.stderr).toContain("does not accept --repo");
    expect(originalTips()).toEqual(tips);
  });

  it("replays only descendant work after a parent amendment and keeps parent pointers", async () => {
    const tips = setupStack();
    const amendedParent = git("rev-parse", "parent");
    const result = await cli("restack", "child", "--yes", "--json");
    expect(result.exitCode).toBe(0);
    expect(git("merge-base", "--is-ancestor", amendedParent, "child")).toBe("");
    expect(git("log", "--format=%s", "parent..child")).toContain("child");
    expect(git("config", "branch.child.gh-merge-base")).toBe("parent");
    expect(git("branch", "--show-current")).toBe("main");
    expect(git("rev-parse", "side")).toBe(tips.sideTip);
    expect(git("rev-parse", "parent")).toBe(amendedParent);
    expect(git("rev-list", "--count", "parent..child")).toBe("1");
  });

  it("continues a conflict and replays the remaining descendants", async () => {
    setupStack(true);
    const first = await cli("restack", "child", "--yes", "--json");
    expect(first.exitCode).not.toBe(0);
    expect(git("status", "--porcelain")).toContain("UU shared.txt");
    const rebaseDir = git("rev-parse", "--git-path", "rebase-merge");
    expect(readFileSync(join(root, rebaseDir, "head-name"), "utf8").trim()).toBe("refs/heads/child");
    writeFileSync(join(root, "shared.txt"), "resolved\n");
    git("add", "shared.txt");
    const continued = await cli("restack", "--continue", "--json");
    expect(continued.exitCode).toBe(0);
    expect(git("branch", "--show-current")).toBe("main");
    expect(git("merge-base", "--is-ancestor", "child", "grandchild")).toBe("");
    expect(git("show", "grandchild:grandchild.txt")).toBe("grandchild");
    expect(git("config", "branch.child.gh-merge-base")).toBe("parent");
    expect(git("config", "branch.grandchild.gh-merge-base")).toBe("child");
  });

  it("aborts a conflict, restores saved tips, and returns to the original branch", async () => {
    setupStack(true);
    const tips = originalTips();
    const first = await cli("restack", "child", "--yes", "--json");
    expect(first.exitCode).not.toBe(0);
    const aborted = await cli("restack", "--abort", "--json");
    expect(aborted.exitCode).toBe(0);
    expect(originalTips()).toEqual(tips);
    expect(git("branch", "--show-current")).toBe("main");
    expect(git("config", "branch.child.gh-merge-base")).toBe("parent");
  });

  it("submits the selected tree, keeps earlier URLs on failure, restores the branch, and retries safely", async () => {
    setupStack();
    const remote = join(root, "remote.git");
    execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { cwd: root, stdio: "ignore" });
    git("remote", "add", "origin", remote);
    git("push", "-u", "origin", "main");
    mkdirSync(join(root, "fixture-one-"), { recursive: true });
    const partial = await runFixture(["stack", "submit", "child", "--yes", "--json"], {
      root: join(root, "fixture-one-"), cwd: root,
      responses: [
        { prefix: ["pr", "view"], stdout: "" },
        { prefix: ["pr", "create", "--title", "parent"], stdout: "https://github.com/test/repo/pull/10" },
        { prefix: ["pr", "create", "--title", "child"], stderr: "fixture PR failure", exitCode: 1 },
      ],
    });
    expect(partial.exitCode).not.toBe(0);
    const report = JSON.parse(partial.stdout);
    expect(report.status).toBe("partially_completed");
    expect(report.opened.map((item: { url: string }) => item.url)).toEqual(["https://github.com/test/repo/pull/10"]);
    expect(git("branch", "--show-current")).toBe("main");
    expect(git("show-ref", "--verify", "refs/remotes/origin/parent")).toBeTruthy();
    expect(git("show-ref", "--verify", "refs/heads/side")).toBeTruthy();

    mkdirSync(join(root, "fixture-two-"), { recursive: true });
    const retry = await runFixture(["stack", "submit", "child", "--yes", "--json"], {
      root: join(root, "fixture-two-"), cwd: root,
      responses: [
        { prefix: ["pr", "view"], stdout: "" },
        { prefix: ["pr", "create", "--title", "child"], stdout: "https://github.com/test/repo/pull/11" },
        { prefix: ["pr", "view"], stdout: "" },
        { prefix: ["pr", "create", "--title", "grandchild"], stdout: "https://github.com/test/repo/pull/12" },
      ],
    });
    expect(retry.exitCode).toBe(0);
    expect(JSON.parse(retry.stdout).map((item: { url: string }) => item.url)).toEqual([
      "https://github.com/test/repo/pull/10",
      "https://github.com/test/repo/pull/11",
      "https://github.com/test/repo/pull/12",
    ]);
    expect(git("branch", "--show-current")).toBe("main");
    expect(git("show-ref", "--verify", "refs/remotes/origin/grandchild")).toBeTruthy();
    expect(git("show-ref", "--verify", "refs/heads/side")).toBeTruthy();
    expect(() => git("show-ref", "--verify", "refs/remotes/origin/side")).toThrow();
  });

  it("uses force-with-lease and refuses a changed remote tip", async () => {
    git("init", "-b", "main");
    git("config", "user.name", "Stack tests");
    git("config", "user.email", "stack-tests@example.invalid");
    git("config", "commit.gpgsign", "false");
    commitFile("base.txt", "base\n", "base");
    git("switch", "-c", "feature");
    commitFile("feature.txt", "first\n", "feature first");
    const originalFeature = git("rev-parse", "HEAD");
    setParent("feature", "main", git("rev-parse", "main"));
    const remote = join(root, "remote.git");
    execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { cwd: root, stdio: "ignore" });
    git("remote", "add", "origin", remote);
    git("push", "-u", "origin", "main");
    git("push", "-u", "origin", "feature");

    const other = join(root, "other");
    execFileSync("git", ["clone", remote, other], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Other writer"], { cwd: other });
    execFileSync("git", ["config", "user.email", "other@example.invalid"], { cwd: other });
    execFileSync("git", ["switch", "-c", "feature", "--track", "origin/feature"], { cwd: other });
    writeFileSync(join(other, "remote.txt"), "remote\n");
    execFileSync("git", ["add", "remote.txt"], { cwd: other });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "remote update"], { cwd: other, stdio: "ignore" });
    execFileSync("git", ["push", "origin", "feature"], { cwd: other, stdio: "ignore" });
    git("reset", "--hard", originalFeature);
    writeFileSync(join(root, "feature.txt"), "rewritten\n");
    git("add", "feature.txt");
    git("-c", "commit.gpgsign=false", "commit", "--amend", "--no-edit");
    const rewritten = git("rev-parse", "HEAD");
    expect(rewritten).not.toBe(originalFeature);
    git("switch", "main");

    mkdirSync(join(root, "fixture-lease-"), { recursive: true });
    const result = await runFixture(["stack", "submit", "feature", "--yes", "--json"], {
      root: join(root, "fixture-lease-"), cwd: root,
      responses: [{ prefix: ["pr", "view"], stdout: "" }, { prefix: ["pr", "create"], stdout: "https://github.com/test/repo/pull/20" }],
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("stale info");
    expect(git("branch", "--show-current")).toBe("main");
    expect(execFileSync("git", ["--git-dir", remote, "rev-parse", "refs/heads/feature"], { encoding: "utf8" }).trim()).not.toBe(rewritten);
  });
});

describe("remote stack view", () => {
  it("keeps ordinary JSON stack views offline", async () => {
    setupStack();
    const result = await cli("list", "--all", "--json");
    expect(result.exitCode).toBe(0);
    expect(result.calls).toEqual([]);
    expect(JSON.parse(result.stdout).every((branch: { remote?: unknown }) => branch.remote === undefined)).toBe(true);
  });

  it("adds explicit-repository PR review and CI status while preserving local branches on remote failures", async () => {
    setupStack();
    git("remote", "add", "origin", "https://github.com/test/repo.git");
    mkdirSync(join(root, "fixture-remote-"), { recursive: true });
    const result = await runFixture(["stack", "list", "--all", "--remote", "--json"], {
      root: join(root, "fixture-remote-"), cwd: root,
      responses: [
        { prefix: ["pr", "list", "--head", "main"], stdout: "[]" },
        { prefix: ["pr", "list", "--head", "parent"], stdout: JSON.stringify([{ number: 41, title: "Parent change", state: "OPEN", url: "https://github.com/test/repo/pull/41", reviewDecision: "APPROVED" }]) },
        { prefix: ["pr", "checks", "41"], stdout: JSON.stringify([{ name: "unit", state: "SUCCESS", description: "passed", link: "https://github.com/test/repo/actions/runs/1" }]) },
        { prefix: ["pr", "list", "--head", "child"], stdout: "[]" },
        { prefix: ["pr", "list", "--head", "grandchild"], stderr: "fixture remote unavailable", exitCode: 1 },
        { prefix: ["pr", "list", "--head", "side"], stdout: "[]" },
      ],
    });
    expect(result.exitCode).toBe(0);
    const branches = JSON.parse(result.stdout) as RemoteViewBranch[];
    const byName = new Map(branches.map((branch) => [branch.branch, branch]));
    expect(byName.get("parent")?.parent).toBeNull();
    expect(byName.get("parent")?.remote).toMatchObject({
      state: "available",
      pr: { number: 41, reviewDecision: "APPROVED", checks: { state: "available", runs: [{ name: "unit", state: "SUCCESS" }] } },
    });
    expect(byName.get("child")?.remote).toEqual({ state: "available" });
    expect(byName.get("grandchild")?.remote).toMatchObject({ state: "unavailable", reason: "fixture remote unavailable" });
    expect(byName.get("grandchild")?.parent).toBe("child");
    expect(byName.get("side")?.remote).toEqual({ state: "available" });
    expect(result.calls).toHaveLength(6);
    expect(result.calls.every((args) => args.includes("--repo") && args.includes("test/repo"))).toBe(true);
  });
});
