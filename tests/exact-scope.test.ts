import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { scopeFixture } from "./fixtures/exact-scope.ts";

let f: ReturnType<typeof scopeFixture>;
beforeEach(() => { f = scopeFixture(); });
afterEach(() => rmSync(f.root, { recursive: true, force: true }));
const stage = (path = "one", bytes: string | Uint8Array = "staged\n") => { f.save(path, bytes); f.git("add", "--", path); };
const contents = (path: string) => readFileSync(join(f.repo, path));
async function exactCommit(extra: string[] = []) {
  const intended = f.tree(); const index = f.index();
  const result = await f.commit(...extra);
  expect({ code: result.exitCode, error: result.stderr }).toEqual({ code: 0, error: "" });
  expect(f.git("rev-parse", "HEAD^{tree}")).toBe(intended);
  expect(f.tree()).toBe(intended);
  expect(f.index()).toEqual(index);
  expect(f.git("diff", "--cached")).toBe("");
  return { result, index };
}

test("01 staged hunks commit while unstaged hunks in the same file remain", async () => {
  stage("one", "staged first\n\nlast\n"); f.save("one", "staged first\n\nunstaged last\n");
  const before = contents("one"); await exactCommit(); expect(contents("one")).toEqual(before);
  expect(f.git("show", "HEAD:one")).toBe("staged first\n\nlast");
});
test("02 untracked files are excluded from staged-only commits", async () => {
  stage(); f.save("private", "untracked\n"); await exactCommit();
  expect(f.git("ls-tree", "--name-only", "HEAD")).not.toContain("private"); expect(contents("private").toString()).toBe("untracked\n");
});
test("03 explicit all stages untracked selections but never ignored env files", async () => {
  f.save("one", "selected\n"); f.save("selected", "new\n"); f.save(".env", "PRIVATE=fixture\n");
  const intended = f.plannedTree(["one", "selected"]);
  const expected = f.git("hash-object", "-w", "selected");
  expect((await f.commit("--all")).exitCode).toBe(0);
  expect(f.git("rev-parse", "HEAD:selected")).toBe(expected); expect(f.git("rev-parse", "HEAD^{tree}")).toBe(intended);
  expect(f.git("ls-tree", "--name-only", "HEAD")).not.toContain(".env"); expect(contents(".env").toString()).toBe("PRIVATE=fixture\n");
  expect(f.git("status", "--porcelain")).toBe("");
});
test("04 renamed files do not absorb a recreated untracked source", async () => {
  f.git("mv", "one", "renamed"); f.save("one", "recreated\n"); await exactCommit(); expect(contents("one").toString()).toBe("recreated\n");
});
test("05 staged deletion does not remove a recreated worktree file", async () => {
  f.git("rm", "two"); f.save("two", "keep untracked\n"); await exactCommit(); expect(contents("two").toString()).toBe("keep untracked\n");
});
test("06 binary staged blobs remain exact with different worktree bytes", async () => {
  stage("binary", new Uint8Array([0, 255, 1, 128])); f.save("binary", new Uint8Array([0, 17, 4]));
  const bytes = contents("binary"); await exactCommit(); expect(contents("binary")).toEqual(bytes);
});
for (const [id, path] of [["07", "with spaces"], ["08", "with\nnewline"], ["09", "--leading-dash"]]) {
  // Windows filenames cannot contain newlines.
  test.skipIf(process.platform === "win32" && path!.includes("\n"))(`${id} literal path ${JSON.stringify(path)} commits exactly`, async () => {
    stage(path!); f.save(path!, "unstaged\n"); await exactCommit(); expect(contents(path!).toString()).toBe("unstaged\n");
  });
}
test("10 index changed after preview is refused without absorbing concurrent staging", async () => {
  stage(); f.save("two", "concurrent\n"); const head = f.head();
  const result = await f.cli(["commit", "-m", "scoped", "--yes"], f.race("execFileSync('git',['add','--','two']);"));
  // The mutation must change the index tree, not just refresh stat data.
  expect(result.exitCode).not.toBe(0); expect(f.head()).toBe(head); expect(f.git("show", ":two")).toBe("concurrent");
});
test("11 HEAD changed after preview is refused without adding another commit", async () => {
  stage(); const head = f.head();
  const result = await f.cli(["commit", "-m", "scoped", "--yes"], f.race("execFileSync('git',['commit','--allow-empty','--only','-m','concurrent']);"));
  expect(result.exitCode).not.toBe(0); expect(f.git("rev-parse", "HEAD^")).toBe(head); expect(f.git("log", "-1", "--format=%s")).toBe("concurrent");
});
test("12 squash refuses staged, unstaged and untracked work without rewriting", async () => {
  stage(); f.git("commit", "-m", "second"); stage(); f.save("two", "unstaged\n"); f.save("private", "untracked\n");
  const head = f.head(); const tree = f.tree(); const before = contents("two");
  expect((await f.cli(["squash", "2", "-m", "scoped", "--yes"])).exitCode).not.toBe(0);
  expect(f.head()).toBe(head); expect(f.tree()).toBe(tree); expect(contents("two")).toEqual(before); expect(contents("private").toString()).toBe("untracked\n");
});
test("13 CLI split commits the staged partition while keeping partial staging and untracked work", async () => {
  stage(); stage("two"); f.save("one", "unstaged\n"); f.save("private", "private\n"); const tree = f.tree(); const index = f.index();
  const result = await f.split([["one"], ["two"]]);
  expect({ code: result.exitCode, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
  expect(f.git("rev-parse", "HEAD^{tree}")).toBe(tree); expect(f.git("rev-list", "--count", "HEAD")).toBe("3");
  expect(f.git("show", "HEAD~1:one")).toBe("staged"); expect(f.git("show", "HEAD~1:two")).toBe("base two");
  expect(f.index()).toEqual(index); expect(contents("one").toString()).toBe("unstaged\n"); expect(contents("private").toString()).toBe("private\n");
});
test("14 amend consumes only the staged tree and keeps unrelated worktree changes", async () => {
  stage("two"); f.save("one", "unrelated\n"); const parents = f.git("rev-list", "--count", "HEAD");
  await exactCommit(["--amend"]); expect(contents("one").toString()).toBe("unrelated\n"); expect(f.git("rev-list", "--count", "HEAD")).toBe(parents);
});
test("15 commit push honors the publish remote and own branch instead of comparison upstream", async () => {
  const origin = f.remote("origin"); const fork = f.remote("fork"); f.git("push", "-u", "origin", "main"); const base = f.head();
  f.git("checkout", "-b", "feature"); f.git("config", "branch.feature.remote", "origin"); f.git("config", "branch.feature.merge", "refs/heads/main"); f.git("config", "branch.feature.pushRemote", "fork");
  stage(); const intended = f.tree(); expect((await f.commit("--push")).exitCode).toBe(0);
  expect(origin("rev-parse", "main")).toBe(base); expect(fork("rev-parse", "feature^{tree}")).toBe(intended); expect(fork("for-each-ref", "--format=%(refname)")).toBe("refs/heads/feature");
});
test("16 detached HEAD commits stay local and push refuses without publishing", async () => {
  const origin = f.remote("origin"); f.git("push", "origin", "main"); const main = f.head(); f.git("checkout", "--detach"); stage();
  await exactCommit(); expect(f.git("rev-parse", "main")).toBe(main);
  stage("two"); const intended = f.tree();
  const out = await f.cli(["commit", "--push", "-m", "local only", "--yes"]);
  expect(out.exitCode).not.toBe(0); expect(f.git("rev-parse", "HEAD^{tree}")).toBe(intended);
  expect(origin("rev-parse", "main")).toBe(main); expect(f.git("branch", "--show-current")).toBe("");
  expect(out.providerCalls).toEqual([]);
});
test("17 submodule pointer commits preserve mode and leave nested working files alone", async () => {
  const previous = f.head(); stage(); f.git("commit", "-m", "child tip"); const next = f.head();
  f.git("update-index", "--add", "--cacheinfo", `160000,${previous},module`); f.git("commit", "-m", "module base");
  f.git("update-index", "--cacheinfo", `160000,${next},module`); await exactCommit(); expect(f.git("ls-tree", "HEAD", "module")).toBe(`160000 commit ${next}\tmodule`);
});
test("18 a staging hook cannot widen the committed tree or trigger publication", async () => {
  const origin = f.remote("origin"); f.git("push", "origin", "main"); stage(); f.save("private", "private\n");
  const head = f.head(); const tree = f.tree(); const index = f.index(); f.hook("printf 'hook edit\\n' > two\ngit add -- two private");
  const result = await f.commit("--push");
  expect(result.exitCode).not.toBe(0); expect(f.head()).toBe(head); expect(origin("rev-parse", "main")).toBe(head);
  expect(f.tree()).toBe(tree); expect(f.index()).toEqual(index); expect(contents("private").toString()).toBe("private\n"); expect(contents("two").toString()).toBe("hook edit\n");
});
test("19 interrupted split retains reachable completed commits, original index and recovery checkpoint", async () => {
  stage(); stage("two"); f.save("two", "unstaged\n"); f.tree(); const index = f.index(); const head = f.head();
  const result = await f.split([["one"], ["two"]], true);
  expect(result.exitCode).not.toBe(0);
  expect(f.git("rev-parse", "HEAD^")).toBe(head); expect(f.index()).toEqual(index); expect(f.git("diff", "--cached", "--name-only")).toBe("two"); expect(contents("two").toString()).toBe("unstaged\n");
  const checkpoint = readdirSync(join(f.repo, ".git", "ggh-split"))[0]!;
  const state = JSON.parse(readFileSync(join(f.repo, ".git", "ggh-split", checkpoint, "state.json"), "utf8"));
  expect(state.completed).toEqual([f.head()]); expect(state.originalHead).toBe(head); expect(existsSync(join(f.repo, ".git", "index.lock"))).toBe(true);
  // The fixture owns the killed process and has awaited its exit. Remove only
  // its stale index lock before retrying the remaining staged group.
  rmSync(join(f.repo, ".git", "index.lock"));
  const intended = f.tree();
  expect((await f.split([["two"]])).exitCode).toBe(0);
  expect(f.git("rev-parse", "HEAD^{tree}")).toBe(intended); expect(f.git("rev-list", "--count", "HEAD")).toBe("3");
  expect(contents("two").toString()).toBe("unstaged\n");
});
test("20 unqualified push cannot publish another branch through matching configuration", async () => {
  const origin = f.remote("origin"); f.git("push", "-u", "origin", "main"); const before = f.head();
  f.git("branch", "other"); f.git("push", "origin", "other"); f.git("checkout", "other"); stage("two"); f.git("commit", "-m", "private other"); f.git("checkout", "main"); stage(); f.git("commit", "-m", "publish main");
  f.git("config", "push.default", "matching"); const main = f.head();
  const result = await f.cli(["status"], `const {push}=await import(${JSON.stringify(new URL("../src/services/git.ts", import.meta.url).href)}); const {setFlags}=await import(${JSON.stringify(new URL("../src/services/runtime.ts", import.meta.url).href)}); setFlags({json:true,noInput:true}); await push();`);
  expect(result.exitCode).toBe(0); expect(origin("rev-parse", "main")).toBe(main); expect(origin("rev-parse", "other")).toBe(before);
});
