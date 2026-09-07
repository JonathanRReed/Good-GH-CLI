import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { push } from "../src/services/git.ts";

let root: string;
let repo: string;
function at(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}
function git(...args: string[]): string {
  return at(repo, ...args);
}
function commit(name: string): string {
  writeFileSync(join(repo, name), `${name}\n`);
  git("add", "--", name);
  git("-c", "commit.gpgsign=false", "commit", "-m", name);
  return git("rev-parse", "HEAD");
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ggh-push-target-")));
  repo = join(root, "repo");
  mkdirSync(repo);
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  for (const name of ["origin", "backup"]) {
    const path = join(root, name);
    mkdirSync(path);
    at(path, "init", "--bare", "-b", "main");
    git("remote", "add", name, path);
  }
  commit("initial.txt");
  git("push", "-u", "origin", "main");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("explicit push destinations", () => {
  it("honors an explicit remote on a branch that already tracks another remote", async () => {
    const before = git("rev-parse", "HEAD");
    const next = commit("next.txt");
    await push({ remote: "backup", branch: "main", cwd: repo });
    expect(at(join(root, "origin"), "rev-parse", "main")).toBe(before);
    expect(at(join(root, "backup"), "rev-parse", "main")).toBe(next);
  });
  it("pushes only the requested branch even when a different branch is checked out", async () => {
    const main = git("rev-parse", "main");
    git("checkout", "-b", "feature");
    git("push", "-u", "origin", "feature");
    const feature = commit("feature.txt");
    git("checkout", "main");
    commit("not-requested.txt");
    git("config", "push.default", "matching");
    await push({ branch: "feature", cwd: repo });
    expect(at(join(root, "origin"), "rev-parse", "feature")).toBe(feature);
    expect(at(join(root, "origin"), "rev-parse", "main")).toBe(main);
    expect(git("branch", "--show-current")).toBe("main");
  });
  for (const key of ["branch.main.pushRemote", "remote.pushDefault"]) {
    it(`preserves ${key} when no explicit remote is supplied`, async () => {
      const before = git("rev-parse", "main");
      const next = commit("configured.txt");
      git("config", key, "backup");
      await push({ branch: "main", cwd: repo });
      expect(at(join(root, "origin"), "rev-parse", "main")).toBe(before);
      expect(at(join(root, "backup"), "rev-parse", "main")).toBe(next);
    });
  }
  it("uses an explicitly named branch even when a tag has the same name", async () => {
    git("tag", "main");
    const next = commit("tag-collision.txt");
    await push({ remote: "backup", branch: "main", cwd: repo });
    expect(at(join(root, "backup"), "rev-parse", "refs/heads/main")).toBe(next);
    expect(at(join(root, "backup"), "tag", "--list")).toBe("");
  });
  it("leaves the normal configured upstream mapping intact for an unqualified push", async () => {
    git("push", "origin", "main:renamed");
    git("config", "branch.main.merge", "refs/heads/renamed");
    git("config", "push.default", "upstream");
    const before = git("rev-parse", "main");
    const next = commit("upstream.txt");
    await push({ cwd: repo });
    expect(at(join(root, "origin"), "rev-parse", "renamed")).toBe(next);
    expect(at(join(root, "origin"), "rev-parse", "main")).toBe(before);
  });
});
