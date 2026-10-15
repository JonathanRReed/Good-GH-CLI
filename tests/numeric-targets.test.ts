import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureRoot, runFixture } from "./cli-fixture.ts";

const root = fixtureRoot("ggh-numeric-targets-");
const repo = join(root, "repo");
const invalidIds = ["42junk", "0", "-1", "1.2"];

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
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("numeric issue and pull request targets", () => {
  it("rejects invalid read and mutation targets before any GitHub call", async () => {
    const commands = [
      { args: (id: string) => ["issue", id, "--json"] },
      { args: (id: string) => ["issue", "close", id, "--yes", "--json"] },
      { args: (id: string) => ["pr", id, "--json"] },
      { args: (id: string) => ["pr", "close", id, "--yes", "--json"] },
    ];

    for (const id of invalidIds) {
      for (const command of commands) {
        const result = await runFixture(command.args(id), { root, cwd: repo });
        expect(result.exitCode, `${command.args(id).join(" ")}: ${result.stdout}`).not.toBe(0);
        expect(result.calls, `${command.args(id).join(" ")} called gh`).toEqual([]);
      }
    }
  });

  it("rejects invalid lifecycle and review IDs without looking up the current PR", async () => {
    for (const id of invalidIds) {
      for (const args of [
        ["pr", "view", id, "--json"],
        ["pr", "review", id, "--ai", "--json"],
      ]) {
        const result = await runFixture(args, { root, cwd: repo });
        expect(result.exitCode, `${args.join(" ")}: ${result.stdout}`).not.toBe(0);
        expect(result.calls, `${args.join(" ")} called gh`).toEqual([]);
      }
    }
  });

  it("preserves valid issue and PR number 42", async () => {
    const issue = await runFixture(["issue", "42", "--json"], {
      root,
      cwd: repo,
      responses: [{
        prefix: ["issue", "view", "42", "--json"],
        stdout: JSON.stringify({ number: 42, title: "Fixture issue", state: "OPEN", url: "https://github.com/fixture/repo/issues/42", author: { login: "fixture" } }),
      }],
    });
    expect(issue.exitCode).toBe(0);
    expect(JSON.parse(issue.stdout)).toMatchObject({ number: 42, title: "Fixture issue" });
    expect(issue.calls.some((args) => args[0] === "issue" && args[1] === "view" && args[2] === "42")).toBe(true);

    const closedIssue = await runFixture(["issue", "close", "42", "--yes", "--json"], {
      root,
      cwd: repo,
      responses: [{ prefix: ["issue", "close", "42"] }],
    });
    expect(closedIssue.exitCode).toBe(0);
    expect(JSON.parse(closedIssue.stdout)).toMatchObject({ number: 42, action: "close" });
    expect(closedIssue.calls.some((args) => args[0] === "issue" && args[1] === "close" && args[2] === "42")).toBe(true);

    const pr = await runFixture(["pr", "42", "--web", "--json"], {
      root,
      cwd: repo,
      responses: [{ prefix: ["pr", "view", "--web", "42"] }],
    });
    expect(pr.exitCode).toBe(0);
    expect(JSON.parse(pr.stdout)).toMatchObject({ action: "open", number: 42 });
    expect(pr.calls.some((args) => args[0] === "pr" && args[1] === "view" && args.at(-1) === "42")).toBe(true);
  });
});
