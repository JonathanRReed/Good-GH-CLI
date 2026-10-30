import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectGit } from "../src/services/projects/git.ts";
import { lostReflogs } from "../src/services/projects/lost-inventory.ts";

const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ggh-reflog-fallback-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" }).trim();

test("falls back to bounded per-log reads when the batched reflog read fails", async () => {
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "one");
  const first = git("rev-parse", "HEAD");
  git("commit", "-q", "--allow-empty", "-m", "two");
  const commonDir = join(root, ".git");
  const calls: string[][] = [];
  // The batched read fails as an oversized reflog would; per-log reads use real git.
  const read: typeof projectGit = (cwd, args, ...rest) => {
    calls.push(args);
    return args[0] === "reflog" && args.includes("--all") ? Promise.reject(new Error("output exceeded 16 MiB")) : projectGit(cwd, args, ...rest);
  };
  const clone = { commonDir, checkouts: [{ bare: false, gitDir: commonDir, path: root, branch: "main" }] } as unknown as Parameters<typeof lostReflogs>[0];
  const logs = await lostReflogs(clone, [{ ref: "refs/heads/main" }] as unknown as Parameters<typeof lostReflogs>[1], read);
  const branch = logs.find(log => log.branch === "main" && log.path === null);
  expect(branch?.tips).toContain(first);
  expect(branch?.truncated).toBe(false);
  expect(calls.some(args => args.includes("-n1001") && args.includes("refs/heads/main"))).toBe(true);
});

test("reports a log it still cannot read as truncated instead of hiding it", async () => {
  const commonDir = join(root, ".git");
  const failing: typeof projectGit = () => Promise.reject(new Error("deadline exceeded"));
  const clone = { commonDir, checkouts: [] } as unknown as Parameters<typeof lostReflogs>[0];
  const logs = await lostReflogs(clone, [{ ref: "refs/heads/main" }] as unknown as Parameters<typeof lostReflogs>[1], failing);
  expect(logs).toEqual([{ branch: "main", path: null, tips: [], truncated: true }]);
});
