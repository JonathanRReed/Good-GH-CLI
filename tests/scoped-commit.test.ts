import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { scopeFixture } from "./fixtures/exact-scope.ts";

let f: ReturnType<typeof scopeFixture>;
beforeEach(() => { f = scopeFixture(); });
afterEach(() => rmSync(f.root, { recursive: true, force: true }));

test("split rejects hook-added paths, keeps original staging and never attempts later groups", async () => {
  f.save("one", "staged\n"); f.save("two", "staged\n"); f.git("add", "--", "one", "two"); f.save("private", "private\n");
  const tree = f.tree(); const index = f.index(); const head = f.head();
  f.hook("git add -- private"); const result = await f.split([["one"], ["two"]]);
  expect(result.exitCode).not.toBe(0); expect(result.stdout).toContain("hook changed");
  expect(f.head()).toBe(head); expect(f.tree()).toBe(tree); expect(f.index()).toEqual(index);
});

test("squash hook failures retain the original tree and recovery ref, including ignored env", async () => {
  for (const name of ["one", "two"]) { f.save(name, "committed\n"); f.git("add", "--", name); f.git("commit", "-m", name); }
  f.save(".env", "PRIVATE=fixture\n"); const original = f.head(); const base = f.git("rev-parse", "HEAD~2"); const tree = f.tree();
  f.hook("printf 'hook edit\\n' > two\ngit add -- two");
  const result = await f.cli(["squash", "2", "-m", "scoped", "--yes"]);
  expect(result.exitCode).not.toBe(0); expect(result.stdout).toContain("hook changed");
  expect(f.head()).toBe(base); expect(f.tree()).toBe(tree);
  expect(f.git("rev-parse", `refs/ggh/squash/${original}`)).toBe(original);
  expect(readFileSync(join(f.repo, ".env"), "utf8")).toBe("PRIVATE=fixture\n");
});

test("amend can change the message on a clean index", async () => {
  const tree = f.tree(); const index = f.index();
  expect((await f.commit("--amend")).exitCode).toBe(0);
  expect(f.git("rev-parse", "HEAD^{tree}")).toBe(tree); expect(f.index()).toEqual(index);
  expect(f.git("log", "-1", "--format=%s")).toBe("scoped");
});
