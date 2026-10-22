import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureRoot, runFixture } from "./cli-fixture.ts";

const root = fixtureRoot("ggh-json-mutations-");
const repo = join(root, "repo");
const remote = join(root, "remote.git");

beforeAll(async () => {
  const git = async (args: string[]) => {
    const child = Bun.spawn(["git", ...args], { cwd: root, stdout: "ignore", stderr: "pipe" });
    expect(await child.exited).toBe(0);
  };
  await git(["init", "-b", "main", repo]);
  await git(["-C", repo, "config", "user.name", "Fixture"]);
  await git(["-C", repo, "config", "user.email", "fixture@example.com"]);
  writeFileSync(join(repo, "tracked.txt"), "base\n");
  await git(["-C", repo, "add", "."]);
  await git(["-C", repo, "commit", "-m", "base"]);
  await git(["init", "--bare", remote]);
  await git(["-C", repo, "remote", "add", "origin", remote]);
  await git(["-C", repo, "push", "origin", "HEAD:refs/pull/45/head"]);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("JSON results for mutations", () => {
  it("returns stash push and pop targets after Git succeeds", async () => {
    writeFileSync(join(repo, "tracked.txt"), "changed\n");
    writeFileSync(join(repo, "new.txt"), "new\n");

    const push = await runFixture(["stash", "push", "--message", "fixture work", "--json"], { root, cwd: repo });
    expect(push.exitCode).toBe(0);
    expect(JSON.parse(push.stdout)).toMatchObject({ action: "push", files: 2, message: "fixture work" });

    const pop = await runFixture(["stash", "pop", "--json"], { root, cwd: repo });
    expect(pop.exitCode).toBe(0);
    expect(JSON.parse(pop.stdout)).toMatchObject({ action: "pop", ref: "latest" });

    const stashAgain = await runFixture(["stash", "push", "--json"], { root, cwd: repo });
    expect(stashAgain.exitCode).toBe(0);
    const drop = await runFixture(["stash", "drop", "stash@{0}", "--json"], { root, cwd: repo });
    expect(drop.exitCode).toBe(0);
    expect(JSON.parse(drop.stdout)).toMatchObject({ action: "drop", ref: "stash@{0}" });
  });

  it("returns issue action and issue target", async () => {
    for (const action of ["lock", "unlock", "pin", "unpin"] as const) {
      const result = await runFixture(["issue", action, "31", "--yes", "--json"], {
        root,
        cwd: repo,
        responses: [{ prefix: ["issue", action, "31"] }],
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ action, number: 31 });
    }

    const transfer = await runFixture(["issue", "transfer", "31", "other/project", "--yes", "--json"], {
      root,
      cwd: repo,
      responses: [{ prefix: ["issue", "transfer", "31", "other/project"] }],
    });
    expect(transfer.exitCode).toBe(0);
    expect(JSON.parse(transfer.stdout)).toMatchObject({ action: "transfer", number: 31, destinationRepo: "other/project" });
  });

  it("returns PR checkout target for both advertised paths", async () => {
    for (const args of [["pr", "checkout", "42"], ["pr", "42", "--checkout"]]) {
      const result = await runFixture([...args, "--json"], {
        root,
        cwd: repo,
        responses: [{ prefix: ["pr", "checkout", "42"] }],
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ action: "checkout", number: 42 });
    }

    const worktree = await runFixture(["pr", "45", "--worktree", "--json"], { root, cwd: repo });
    expect(worktree.exitCode).toBe(0);
    expect(JSON.parse(worktree.stdout)).toMatchObject({ action: "worktree", number: 45, branch: "pr-45", path: ".worktrees/pr-45" });
  });
});
