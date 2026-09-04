import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { cached, clearCache } from "../src/services/cache.ts";
import { validateConfigValue } from "../src/services/config.ts";
import { sanitizeDiffForAI } from "../src/utils/diff.ts";
import { checkLargeFiles, detectDefaultBranch, getStatus } from "../src/services/git.ts";

let root: string;
let oldCache: string | undefined;
function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ggh-release-safety-")));
  oldCache = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = join(root, "cache");
});
afterEach(() => {
  if (oldCache === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = oldCache;
  rmSync(root, { recursive: true, force: true });
});
function initRepo(): void {
  git("init", "-b", "main");
  git("config", "user.name", "Safety tests");
  git("config", "user.email", "tests@example.invalid");
  git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "initial");
}

describe("cache ownership", () => {
  it("does not delete arbitrary JSON in its own directory", async () => {
    await cached("owned", async () => 1);
    const unrelated = join(root, "cache", "good-gh", "unrelated.json");
    writeFileSync(unrelated, '{"belongsTo":"another-tool"}');
    clearCache();
    expect(existsSync(unrelated)).toBe(true);
  });
  it("disables storage when the cache root is not a directory", async () => {
    writeFileSync(join(root, "blocker"), "not a directory");
    process.env.XDG_CACHE_HOME = join(root, "blocker");
    let calls = 0;
    await cached("disabled", async () => ++calls);
    await cached("disabled", async () => ++calls);
    expect(calls).toBe(2);
  });
  it.skipIf(process.platform === "win32")("does not follow a cache directory symlink", async () => {
    mkdirSync(join(root, "cache"));
    mkdirSync(join(root, "victim"));
    symlinkSync(join(root, "victim"), join(root, "cache", "good-gh"));
    writeFileSync(join(root, "victim", "canary.json"), "canary");
    await cached("not-stored", async () => 1);
    clearCache();
    expect(readdirSync(join(root, "victim"))).toEqual(["canary.json"]);
  });
  it("does not reuse a mismatched cache envelope", async () => {
    await cached("first", async () => "first");
    const dir = join(root, "cache", "good-gh");
    const file = readdirSync(dir).find((f) => f.endsWith(".json"))!;
    const entry = JSON.parse(readFileSync(join(dir, file), "utf8"));
    writeFileSync(join(dir, file), JSON.stringify({ ...entry, key: "second", value: "wrong" }));
    expect(await cached("first", async () => "fresh")).toBe("fresh");
  });
});

describe("config integer contract", () => {
  for (const bad of ["5000garbage", "5000.5", "5e3", "0x1388", true, null, Infinity, NaN]) {
    it(`rejects ${String(bad)}`, () => expect(validateConfigValue("ai_timeout_ms", bad).problem).toBeDefined());
  }
});

describe("Git identity and staged objects", () => {
  it("uses the repository default rather than a feature branch parent", async () => {
    initRepo(); git("branch", "parent"); git("switch", "-c", "child");
    git("config", "branch.child.gh-merge-base", "parent");
    expect(await detectDefaultBranch(root)).toBe("main");
  });
  it("uses a non-main remote HEAD as the repository default", async () => {
    initRepo(); git("branch", "trunk");
    git("update-ref", "refs/remotes/origin/trunk", "HEAD");
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    expect(await detectDefaultBranch(root)).toBe("trunk");
  });
  it("measures the staged blob, not the unstaged working copy", async () => {
    initRepo(); writeFileSync(join(root, "big.bin"), ""); truncateSync(join(root, "big.bin"), 101 * 1024 * 1024);
    git("add", "big.bin"); writeFileSync(join(root, "big.bin"), "small");
    const result = await checkLargeFiles((await getStatus(root)).staged, root);
    expect(result.blocked.map((f) => f.path)).toEqual(["big.bin"]);
  });
  it("allows a small staged blob even when its working copy is large", async () => {
    initRepo(); writeFileSync(join(root, "small.bin"), "small"); git("add", "small.bin");
    truncateSync(join(root, "small.bin"), 101 * 1024 * 1024);
    expect((await checkLargeFiles((await getStatus(root)).staged, root)).blocked).toEqual([]);
  });
});


describe("quoted diff paths", () => {
  for (const name of ["private\tdata/.env", "privé/.env.production.local", "private\nname/credentials.json"]) {
    it.skipIf(process.platform === "win32" && [...name].some((c) => c.charCodeAt(0) < 32))(`drops sensitive content at ${JSON.stringify(name)}`, () => {
      initRepo(); mkdirSync(join(root, name, ".."), { recursive: true });
      writeFileSync(join(root, name), "PRIVATE_CANARY_WITH_NO_TOKEN_PREFIX\n"); git("add", "--", name);
      const sanitized = sanitizeDiffForAI(git("diff", "--cached"));
      expect(sanitized.diff).not.toContain("PRIVATE_CANARY_WITH_NO_TOKEN_PREFIX");
      expect(sanitized.strippedBlocks).toBeGreaterThan(0);
    });
  }
  it("fails closed on an unparseable file header", () => {
    const patch = 'diff --git "a/bad\\q.env" "b/bad\\q.env"\n+PRIVATE_CANARY';
    expect(sanitizeDiffForAI(patch).diff).not.toContain("PRIVATE_CANARY");
  });
});


describe("canonical branch names", () => {
  it("does not prefix the GitHub default branch with the remote name", async () => {
    initRepo(); git("update-ref", "refs/remotes/origin/trunk", "HEAD");
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    expect(await detectDefaultBranch(root)).toBe("trunk");
  });
});
