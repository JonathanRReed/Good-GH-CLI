import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createProgram } from "../src/index.ts";
import { AGENT_CAPABLE, JSON_CAPABLE, DRY_RUN_CAPABLE, REPO_SCOPED } from "../src/utils/flags.ts";
import { fixtureRoot, runFixture } from "./cli-fixture.ts";

const root = fixtureRoot("ggh-cuts-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const removed = ["label", "secret", "variable", "gist", "search", "browse", "team", "triage", "workflow", "release", "changelog", "draft"];

describe("0.6 cuts", () => {
  test("removes commands from help, completion, capabilities, schema and MCP", async () => {
    const program = await createProgram();
    const names = program.commands.map(command => command.name());
    const schemaResult = await runFixture(["agent", "schema"], { root });
    expect(schemaResult.exitCode).toBe(0);
    const schema = JSON.parse(schemaResult.stdout);
    const mcp = await runFixture(["mcp", "--list-tools"], { root });
    expect(mcp.exitCode).toBe(0);
    for (const name of removed) {
      expect(names).not.toContain(name);
      for (const set of [AGENT_CAPABLE, JSON_CAPABLE, DRY_RUN_CAPABLE, REPO_SCOPED]) expect(set.has(name)).toBe(false);
      expect(schema.supportedCommandPaths.some((path: string[]) => path[0] === name)).toBe(false);
      expect(mcp.stdout).not.toContain(`ggh_${name}`);
      const completion = await runFixture(["completion", "--query", "--", name], { root });
      expect(completion.exitCode).toBe(0);
      expect(completion.stdout.split("\n")).not.toContain(name);
    }
  });

  for (const name of [...removed, "labels", "secrets", "variables", "gists", "workflows", "rel"]) {
    test(`${name} returns migration instructions without GitHub or AI calls`, async () => {
      const result = await runFixture([name, "--agent"], { root });
      expect(result.exitCode).toBe(1);
      const output = JSON.parse(result.stdout);
      expect(output.status).toBe("failed");
      expect(result.stdout).toContain("removed in 0.6; use");
      expect(result.stdout).toContain(name === "draft" ? "ggh stash" : "ggh gh");
      expect(result.stderr).toContain("removed in 0.6; use");
      expect(result.calls).toEqual([]);
      expect(result.providerCalls).toEqual([]);
    });
  }

  test("plain output names the native command and masked secret input", async () => {
    const result = await runFixture(["secret", "set", "TOKEN"], { root });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("removed in 0.6; use `ggh gh secret`");
    expect(result.stderr).toContain("masked `ggh gh secret set NAME` prompt");
    expect(result.calls).toEqual([]);
  });
});

function git(repo: string, args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", repo, ...args], { stderr: "pipe" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
}
function repo(name: string): string {
  const path = join(root, name);
  const init = Bun.spawnSync(["git", "init", "-b", "main", path]);
  expect(init.exitCode).toBe(0);
  git(path, ["config", "user.name", "Fixture"]);
  git(path, ["config", "user.email", "fixture@example.test"]);
  writeFileSync(join(path, "file"), "base\n");
  git(path, ["add", "file"]);
  git(path, ["-c", "commit.gpgsign=false", "commit", "-m", "base"]);
  return path;
}
function save(path: string, message: string, content: string): void {
  writeFileSync(join(path, "file"), content);
  git(path, ["stash", "push", "-m", message]);
}

describe("named stash migration", () => {
  test("lists and restores legacy tagged stashes without AI naming", async () => {
    const cwd = repo("legacy");
    save(cwd, "ggh-draft: interrupted work", "saved work\n");
    save(cwd, "ordinary stash", "ordinary work\n");
    const list = await runFixture(["stash", "list", "--named", "--agent"], { root, cwd });
    expect(list.exitCode).toBe(0);
    expect(JSON.parse(list.stdout).result).toEqual([expect.objectContaining({ ref: "stash@{1}", name: "interrupted work" })]);
    const before = git(cwd, ["stash", "list"]);
    const dry = await runFixture(["stash", "restore", "interrupted work", "--dry-run", "--agent"], { root, cwd });
    expect(dry.exitCode).toBe(0);
    expect(JSON.parse(dry.stdout).effects.completed).toEqual([]);
    expect(git(cwd, ["stash", "list"])).toBe(before);
    const restored = await runFixture(["stash", "restore", "interrupted work", "--yes", "--agent"], { root, cwd });
    expect(restored.exitCode, restored.stdout).toBe(0);
    expect(JSON.parse(restored.stdout).result).toMatchObject({ action: "restore", name: "interrupted work", ref: "stash@{1}" });
    expect(readFileSync(join(cwd, "file"), "utf8")).toBe("saved work\n");
    expect(git(cwd, ["stash", "list"])).toContain("ordinary stash");
    expect(git(cwd, ["stash", "list"])).not.toContain("ggh-draft:");
    expect(restored.providerCalls).toEqual([]);
  });

  test("creates a named stash and refuses duplicate or missing names", async () => {
    const cwd = repo("named");
    writeFileSync(join(cwd, "file"), "new named work\n");
    const pushed = await runFixture(["stash", "push", "--name", "same name", "--agent"], { root, cwd });
    expect(pushed.exitCode).toBe(0);
    expect(JSON.parse(pushed.stdout).result).toMatchObject({ name: "same name" });
    expect(pushed.providerCalls).toEqual([]);
    save(cwd, "ggh-draft: same name", "second work\n");
    const before = git(cwd, ["stash", "list"]);
    for (const name of ["same name", "missing"]) {
      const result = await runFixture(["stash", "restore", name, "--yes", "--agent"], { root, cwd });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain(name === "missing" ? "No stash named" : "Multiple stashes named");
      expect(git(cwd, ["stash", "list"])).toBe(before);
      expect(readFileSync(join(cwd, "file"), "utf8")).toBe("base\n");
    }
  });
});

test("notifications is a non-interactive list and mark-read inbox", async () => {
  const program = await createProgram();
  expect(program.commands.find(command => command.name() === "notifications")?.commands.map(command => command.name())).toEqual(["list", "mark"]);
  const rows = [{ id: "123", subject: { title: "An issue", type: "Issue" }, reason: "mention", unread: true, updated_at: "2026-10-22T00:00:00Z" }];
  const listed = await runFixture(["notifications", "--agent"], { root, responses: [{ prefix: ["api", "/notifications?per_page=30&page=1"], stdout: JSON.stringify(rows) }] });
  expect(listed.exitCode, listed.stdout).toBe(0);
  expect(JSON.parse(listed.stdout).result).toEqual(rows);
  for (const [id, method, endpoint] of [["123", "PATCH", "/notifications/threads/123"], [undefined, "PUT", "/notifications"]] as const) {
    const marked = await runFixture(["notifications", "mark", ...(id ? [id] : []), "--agent"], { root, responses: [{ prefix: ["api", "--method", method, endpoint] }] });
    expect(marked.exitCode, marked.stdout).toBe(0);
    expect(marked.calls).toContainEqual(["api", "--method", method, endpoint, "-f", "read=true"]);
  }
  const dry = await runFixture(["notifications", "mark", "123", "--dry-run", "--agent"], { root });
  expect(dry.exitCode).toBe(0);
  expect(dry.calls.some(call => call.includes("PATCH") || call.includes("PUT"))).toBe(false);
});
