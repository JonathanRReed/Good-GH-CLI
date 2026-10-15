import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureRoot, runFixture } from "./cli-fixture.ts";

const root = fixtureRoot("ggh-routing-");
const repo = join(root, "repo");
beforeAll(() => {
  for (const args of [["init", "-b", "main", repo], ["-C", repo, "config", "user.name", "Fixture"], ["-C", repo, "config", "user.email", "fixture@example.com"]]) {
    expect(Bun.spawnSync(["git", ...args]).exitCode).toBe(0);
  }
  writeFileSync(join(repo, "file.txt"), "work\n");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("explicit command routing", () => {
  it("refuses implicit Git staging", async () => {
    const result = await runFixture(["add", "."], { root, cwd: repo });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("ggh git add");
    expect(Bun.spawnSync(["git", "diff", "--cached", "--name-only"], { cwd: repo }).stdout.toString()).toBe("");
  });
  it("passes Git arguments only through explicit escapes", async () => {
    const staged = await runFixture(["git", "add", "file.txt"], { root, cwd: repo });
    expect(staged.exitCode).toBe(0);
    expect(Bun.spawnSync(["git", "diff", "--cached", "--name-only"], { cwd: repo }).stdout.toString().trim()).toBe("file.txt");
    const result = await runFixture(["--", "rev-parse", "--is-inside-work-tree"], { root, cwd: repo });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("true");
  });
  it("does not reinterpret a ggh command's unknown flags as Git", async () => {
    const result = await runFixture(["status", "--porcelain"], { root, cwd: repo });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("ggh git status");
    expect(result.calls).toEqual([]);
  });
  it("preserves native gh streams and exit status", async () => {
    const result = await runFixture(["gh", "version"], { root, responses: [{ prefix: ["version"], stdout: "native gh output\n", exitCode: 7 }] });
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe("native gh output\n");
    expect(result.calls).toEqual([["version"]]);
  });
  it("protects the reserved escape names", async () => {
    for (const name of ["git", "gh"]) {
      const result = await runFixture(["alias", name, "config list", "--json"], { root });
      expect(result.exitCode).not.toBe(0);
      expect(JSON.parse(result.stdout).status).toBe("failed");
    }
  });
});
