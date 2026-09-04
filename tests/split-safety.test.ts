import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureStagedSnapshot, executeSplitCommits, validateSplitPlan } from "../src/services/git/split.ts";
import { resetFlags, setFlags } from "../src/services/runtime.ts";

let root: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const group = (files: string[], subject = "feat: staged") => ({ subject, body: "", files });
beforeEach(() => {
  resetFlags(); root = realpathSync(mkdtempSync(join(tmpdir(), "ggh-split-safety-")));
  git("init", "-b", "main"); git("config", "user.name", "Split tests"); git("config", "user.email", "split@example.invalid");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(root, "one.txt"), "initial\n"); git("add", "one.txt"); git("commit", "-m", "initial");
  writeFileSync(join(root, "one.txt"), "staged\n"); writeFileSync(join(root, "two.txt"), "second\n");
  git("add", "one.txt", "two.txt");
});
afterEach(() => { resetFlags(); rmSync(root, { recursive: true, force: true }); });

describe("split index transactions", () => {
  it("commits the captured staged tree and preserves unstaged edits", async () => {
    const snapshot = await captureStagedSnapshot(root);
    writeFileSync(join(root, "one.txt"), "unstaged private bytes\n");
    await executeSplitCommits(snapshot, [group(["one.txt"]), group(["two.txt"])], {});
    expect(git("rev-parse", "HEAD^{tree}")).toBe(snapshot.tree);
    expect(git("show", "HEAD:one.txt")).toBe("staged");
    expect(readFileSync(join(root, "one.txt"), "utf8")).toBe("unstaged private bytes\n");
    expect(git("diff", "--cached")).toBe("");
  });
  it("supports detached HEAD without changing named branches or adding duplicate commits", async () => {
    const main = git("rev-parse", "main");
    git("checkout", "--detach");
    const snapshot = await captureStagedSnapshot(root);
    const completed = await executeSplitCommits(snapshot, [group(["one.txt"]), group(["two.txt"])], {});
    expect(completed).toHaveLength(2);
    expect(git("rev-list", "--count", `${main}..HEAD`)).toBe("2");
    expect(git("rev-parse", "main")).toBe(main);
    expect(git("rev-parse", "HEAD^{tree}")).toBe(snapshot.tree);
    expect(git("diff", "--cached")).toBe("");
  });
  it("removes a staged file before replacing it with a directory in one group", async () => {
    rmSync(join(root, "one.txt")); mkdirSync(join(root, "one.txt"));
    writeFileSync(join(root, "one.txt", "nested.txt"), "nested staged\n"); git("add", "-A");
    const snapshot = await captureStagedSnapshot(root);
    await executeSplitCommits(snapshot, [group(["one.txt/nested.txt", "one.txt"]), group(["two.txt"])], {});
    expect(git("rev-parse", "HEAD^{tree}")).toBe(snapshot.tree);
    expect(git("show", "HEAD:one.txt/nested.txt")).toBe("nested staged");
    expect(git("rev-list", "--count", "HEAD")).toBe("3");
  });
  for (const [name, groups] of Object.entries({
    extra: [group(["one.txt", "two.txt", "private.txt"])],
    duplicate: [group(["one.txt"]), group(["one.txt", "two.txt"])],
    missing: [group(["one.txt"])],
    empty: [group([])],
  })) {
    it(`rejects ${name} paths before changing the repository`, async () => {
      const snapshot = await captureStagedSnapshot(root); const head = git("rev-parse", "HEAD");
      expect(() => validateSplitPlan({ commits: groups }, snapshot)).toThrow();
      expect(git("rev-parse", "HEAD")).toBe(head); expect(git("write-tree")).toBe(snapshot.tree);
    });
  }
  it("rejects an index changed while the model was planning", async () => {
    const snapshot = await captureStagedSnapshot(root); const head = git("rev-parse", "HEAD");
    writeFileSync(join(root, "one.txt"), "concurrent staging\n"); git("add", "one.txt");
    await expect(executeSplitCommits(snapshot, [group(["one.txt", "two.txt"])], {})).rejects.toThrow("changed");
    expect(git("rev-parse", "HEAD")).toBe(head); expect(git("show", ":one.txt")).toBe("concurrent staging");
    expect(existsSync(join(root, ".git", "index.lock"))).toBe(false);
  });
  it("does not delete another process's index lock", async () => {
    const snapshot = await captureStagedSnapshot(root); const lock = join(root, ".git", "index.lock");
    writeFileSync(lock, "other owner");
    await expect(executeSplitCommits(snapshot, [group(["one.txt", "two.txt"])], {})).rejects.toThrow();
    expect(readFileSync(lock, "utf8")).toBe("other owner");
  });
  it("cannot execute a split under dry-run policy", async () => {
    const snapshot = await captureStagedSnapshot(root); const head = git("rev-parse", "HEAD");
    setFlags({ dryRun: true });
    await expect(executeSplitCommits(snapshot, [group(["one.txt", "two.txt"])], {})).rejects.toThrow("dry run");
    expect(git("rev-parse", "HEAD")).toBe(head);
  });
  it("keeps a recovery checkpoint and remaining staged changes after a hook failure", async () => {
    const snapshot = await captureStagedSnapshot(root);
    const hook = join(root, ".git", "hooks", "pre-commit");
    writeFileSync(hook, '#!/bin/sh\n[ "$(git rev-list --count HEAD)" = 1 ]\n', { mode: 0o755 });
    writeFileSync(join(root, "two.txt"), "unstaged private bytes\n");
    await expect(executeSplitCommits(snapshot, [group(["one.txt"]), group(["two.txt"])], {})).rejects.toThrow("Recovery checkpoint");
    expect(git("rev-list", "--count", "HEAD")).toBe("2");
    expect(git("diff", "--cached", "--name-only")).toBe("two.txt");
    expect(git("show", ":two.txt")).toBe("second");
    expect(readFileSync(join(root, "two.txt"), "utf8")).toBe("unstaged private bytes\n");
  });
});
