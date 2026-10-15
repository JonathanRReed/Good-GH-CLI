import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureRoot, runFixture } from "./cli-fixture.ts";

const root = fixtureRoot("ggh-json-contract-");
const repo = join(root, "repo");

beforeAll(async () => {
  const git = async (args: string[]) => {
    const child = Bun.spawn(["git", ...args], { cwd: root, stdout: "ignore", stderr: "pipe" });
    expect(await child.exited).toBe(0);
  };
  await git(["init", "-b", "main", repo]);
  await git(["-C", repo, "config", "user.name", "Fixture"]);
  await git(["-C", repo, "config", "user.email", "fixture@example.com"]);
  writeFileSync(join(repo, "a.txt"), "base\n");
  await git(["-C", repo, "add", "."]);
  await git(["-C", repo, "commit", "-m", "base"]);
  writeFileSync(join(repo, "a.txt"), "changed\n");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("command JSON contracts", () => {
  it("returns JSON for a missing required argument", async () => {
    const result = await runFixture(["config", "get", "--json"], { root });
    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "failed" });
  });
  it("reports invalid config as a structured failure", async () => {
    const result = await runFixture(["config", "set", "missing-key", "x", "--json"], { root });
    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "failed" });
    expect(result.stderr).toContain("Invalid configuration key");
  });

  it("emits a dry-run plan without changing HEAD", async () => {
    const before = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo }).stdout.toString();
    const result = await runFixture(["undo", "--dry-run", "--json"], { root, cwd: repo });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "planned" });
    expect(Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo }).stdout.toString()).toBe(before);
  });

  it("reports missing confirmation without discarding work", async () => {
    const result = await runFixture(["discard", "--all", "--json"], { root, cwd: repo });
    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "needs_input" });
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("changed\n");
  });

  it("returns the created repository URL as JSON", async () => {
    const result = await runFixture(["repo", "create", "demo", "--private", "-y", "--json"], {
      root, responses: [
        { prefix: ["api", "repos/fixture/demo"], stderr: "HTTP 404: Not Found", exitCode: 1 },
        { prefix: ["repo", "create"], stdout: "https://github.com/fixture/demo\n" },
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ name: "demo", visibility: "private", url: "https://github.com/fixture/demo" });
    expect(result.calls.filter(args => args[0] === "repo" && args[1] === "create")).toHaveLength(1);
  });
});
