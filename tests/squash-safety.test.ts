import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { squashCommits } from "../src/services/git.ts";

let root: string;
function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}
function save(name: string): void {
  writeFileSync(join(root, name), `${name}\n`);
  git("add", "--", name);
  git("commit", "-m", name);
}
async function cli(...args: string[]) {
  const proc = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "..", "bin", "ggh.ts"),
      "squash",
      ...args,
    ],
    {
      cwd: root,
      env: { ...process.env, GGH_NO_PLUGINS: "1", NO_COLOR: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ggh-squash-safety-")));
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("config", "commit.gpgsign", "false");
  save("initial.txt");
  save("second.txt");
  save("third.txt");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("squash preflight and recovery", () => {
  it("does not rewrite history when a message cannot be collected", async () => {
    const head = git("rev-parse", "HEAD");
    const index = readFileSync(join(root, ".git/index"));
    expect((await cli("2", "--no-ai")).code).not.toBe(0);
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(root, ".git/index"))).toEqual(index);
    expect(git("status", "--porcelain")).toBe("");
  });
  for (const count of ["2junk", "2.5", "0", "1"]) {
    it(`rejects count ${count} without rewriting history`, async () => {
      const head = git("rev-parse", "HEAD");
      expect((await cli(count, "-m", "squashed")).code).not.toBe(0);
      expect(git("rev-parse", "HEAD")).toBe(head);
      expect(git("status", "--porcelain")).toBe("");
    });
  }
  it("rejects a whitespace-only message before rewriting history", async () => {
    const head = git("rev-parse", "HEAD");
    expect((await cli("2", "-m", "   ")).code).not.toBe(0);
    expect(git("rev-parse", "HEAD")).toBe(head);
  });
  it("can squash the full history including the root into one commit", async () => {
    const tree = git("rev-parse", "HEAD^{tree}");
    const previous = git("rev-parse", "HEAD");
    const result = await cli("3", "-m", "entire history", "--json");
    expect({
      code: result.code,
      stderr: result.code ? result.stderr : "",
    }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout).squashed).toBe(3);
    expect(git("rev-list", "--count", "HEAD")).toBe("1");
    expect(git("rev-parse", "HEAD^{tree}")).toBe(tree);
    expect(git("rev-parse", `refs/ggh/squash/${previous}`)).toBe(previous);
    expect(git("status", "--porcelain")).toBe("");
  });
  it("preserves the combined tree when squashing only recent commits", async () => {
    const tree = git("rev-parse", "HEAD^{tree}");
    const result = await cli("2", "-m", "recent changes", "--json");
    expect(result.code).toBe(0);
    expect(git("rev-list", "--count", "HEAD")).toBe("2");
    expect(git("rev-parse", "HEAD^{tree}")).toBe(tree);
    expect(git("log", "-1", "--format=%s")).toBe("recent changes");
  });
  it("does not absorb uncommitted work through the service helper", async () => {
    const head = git("rev-parse", "HEAD");
    writeFileSync(join(root, "second.txt"), "private unstaged work\n");
    await expect(squashCommits(2, root)).rejects.toThrow(/uncommitted|clean/i);
    expect(git("rev-parse", "HEAD")).toBe(head);
  });
  it("rejects a stale HEAD captured before message selection", async () => {
    const expected = { head: git("rev-parse", "HEAD"), branch: "main" };
    save("concurrent.txt");
    const head = git("rev-parse", "HEAD");
    await expect(squashCommits(2, root, expected)).rejects.toThrow(/changed/i);
    expect(git("rev-parse", "HEAD")).toBe(head);
  });
  it("rejects a branch switch even when HEAD points to the same commit", async () => {
    const expected = { head: git("rev-parse", "HEAD"), branch: "main" };
    git("checkout", "-b", "other");
    await expect(squashCommits(2, root, expected)).rejects.toThrow(/changed/i);
    expect(git("rev-parse", "HEAD")).toBe(expected.head);
    expect(git("branch", "--show-current")).toBe("other");
  });
  it("refuses a full-history detached squash without invalidating HEAD", async () => {
    git("checkout", "--detach");
    const head = git("rev-parse", "HEAD");
    await expect(squashCommits(3, root)).rejects.toThrow(/branch/i);
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("status", "--porcelain")).toBe("");
  });
  it("refuses an ambiguous range across a merge without rewriting it", async () => {
    git("checkout", "-b", "side");
    save("side.txt");
    git("checkout", "main");
    save("main.txt");
    git("merge", "--no-ff", "side", "-m", "merge side");
    const head = git("rev-parse", "HEAD");
    await expect(squashCommits(2, root)).rejects.toThrow(/merge history/i);
    expect(git("rev-parse", "HEAD")).toBe(head);
  });
  it("retains a recovery ref and reports it if the final commit hook fails", async () => {
    const head = git("rev-parse", "HEAD");
    const hook = join(root, ".git/hooks/pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    const result = await cli("2", "-m", "blocked commit");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`refs/ggh/squash/${head}`);
    expect(git("rev-parse", `refs/ggh/squash/${head}`)).toBe(head);
    expect(git("diff", "--name-only")).toBe("");
    expect(git("diff", "--cached", "--name-only")).toBe(
      "second.txt\nthird.txt",
    );
  });
});
