import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureRoot, runFixture } from "./cli-fixture.ts";

let root: string;
let repo: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
beforeEach(() => {
  root = fixtureRoot("ggh-compact-status-"); repo = join(root, "repo"); mkdirSync(repo);
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "file"), "base\n"); git("add", "file"); git("commit", "-m", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD"); git("config", "remote.origin.url", "offline.invalid/repo"); git("config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  git("config", "branch.main.remote", "origin"); git("config", "branch.main.merge", "refs/heads/main");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("clean agent status retains full identity within 1.5 times porcelain", async () => {
  const out = await runFixture(["status", "--agent"], { root, cwd: repo });
  expect(out.exitCode).toBe(0);
  expect(JSON.parse(out.stdout)).toEqual({ contract: "ggh.agent", version: 1, command: ["status"], status: "succeeded", result: { branch: "main", head: git("rev-parse", "HEAD"), upstream: "origin/main" } });
  expect(Buffer.byteLength(out.stdout)).toBeLessThanOrEqual(Buffer.byteLength(git("status", "--porcelain=v2", "--branch") + "\n") * 1.5);
  expect(out.calls).toEqual([]); expect(out.providerCalls).toEqual([]);
});

test("agent status retains exact porcelain records, root from a subdirectory, and operation", async () => {
  const path = " leading\n-dash "; writeFileSync(join(repo, path), "new\n"); git("add", "--", path);
  writeFileSync(join(repo, path), "unstaged\n"); mkdirSync(join(repo, "sub"));
  writeFileSync(join(repo, ".git", "CHERRY_PICK_HEAD"), git("rev-parse", "HEAD") + "\n");
  const out = await runFixture(["status", "--agent"], { root, cwd: join(repo, "sub") });
  expect(out.exitCode).toBe(0);
  const result = JSON.parse(out.stdout).result;
  expect(result).toMatchObject({ root: repo, operation: "cherry-pick", staged: 1, unstaged: 1 });
  expect(result.changes).toEqual(git("status", "--porcelain=v2", "-z", "-uall").split("\0").filter(Boolean));
});

test("agent schema defines every compact default", async () => {
  const out = await runFixture(["agent", "schema"], { root, cwd: repo });
  const schema = JSON.parse(out.stdout);
  expect(schema.coreResultSchemas.status.schema.properties.head.type).toEqual(["string", "null"]);
  expect(schema.coreResultSchemas.status.schema.properties.operation.default).toBeNull();
  expect(schema.coreResultSchemas.status.schema.properties.conflicts.default).toBe(0);
  expect(schema.envelope.required).not.toContain("effects");
});

test("conflict status retains all index stages and the merge operation", async () => {
  git("checkout", "-b", "other"); writeFileSync(join(repo, "file"), "other\n"); git("commit", "-am", "other");
  git("checkout", "main"); writeFileSync(join(repo, "file"), "main\n"); git("commit", "-am", "main");
  try { git("merge", "other"); } catch { /* Expected content conflict. */ }
  const result = await runFixture(["status", "--agent"], { root, cwd: repo });
  expect(result.exitCode).toBe(0);
  const payload = JSON.parse(result.stdout).result;
  expect(payload).toMatchObject({ branch: "main", conflicts: 1, operation: "merge" });
  expect(payload.changes).toEqual(git("status", "--porcelain=v2", "-z", "-uall").split("\0").filter(Boolean));
});

test("status separates base, upstream, push remote and local fetch timestamp", async () => {
  git("remote", "add", "fork", "offline.invalid/fork"); git("config", "branch.main.pushRemote", "fork");
  git("config", "branch.main.gh-merge-base", "release"); writeFileSync(join(repo, ".git", "FETCH_HEAD"), "fixture\n");
  const result = await runFixture(["status", "--agent"], { root, cwd: repo });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).result).toMatchObject({ upstream: "origin/main", push: "fork/main", base: "release", fetchedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) });
});

test("unborn and detached HEAD identities remain explicit", async () => {
  git("checkout", "--detach");
  let result = await runFixture(["status", "--agent"], { root, cwd: repo });
  expect(JSON.parse(result.stdout).result).toMatchObject({ branch: null, head: git("rev-parse", "HEAD") });
  git("switch", "--orphan", "unborn");
  result = await runFixture(["status", "--agent"], { root, cwd: repo });
  expect(JSON.parse(result.stdout).result).toMatchObject({ branch: "unborn", head: null });
});
