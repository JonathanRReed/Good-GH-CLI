import { afterEach, beforeEach, expect, it } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readProjectStatusCache, writeProjectStatusCache, projectStatusPath } from "../src/services/projects/status-cache.ts";
import type { CloneStatus, FieldState } from "../src/services/projects/types.ts";
import { fixtureRoot, runFixture } from "./cli-fixture.ts";
import { run } from "../src/utils/exec.ts";

let root: string;
beforeEach(() => { root = fixtureRoot("ggh-status-cache-"); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
function ok<T>(value: T): FieldState<T> { return { state: "ok", value, observedAt: "2026-10-22T00:00:00.000Z" }; }
function fixture(): CloneStatus {
  return { commonDir: "/repo/.git", checkouts: [], stashes: ok(1), newestStash: ok("stash"), unpublished: ok([{ ref: "refs/heads/main", commits: 2 }]), mergedBranches: ok([]), lastCommit: ok(null) };
}
it("stores compact snapshots with timestamps privately and replaces them atomically", async () => {
  const config = join(root, "config");
  await writeProjectStatusCache("scope", [fixture()], config);
  const file = projectStatusPath(config);
  const first = readProjectStatusCache("scope", config);
  expect(first?.statuses).toEqual([fixture()]);
  expect(Number.isFinite(Date.parse(first?.observedAt ?? ""))).toBe(true);
  expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1);
  if (process.platform !== "win32") { expect(statSync(config).mode & 0o777).toBe(0o700); expect(statSync(file).mode & 0o777).toBe(0o600); }
  let reads = 0;
  const timer = setInterval(() => { expect(readProjectStatusCache("scope", config)?.statuses).toHaveLength(1); reads++; }, 1);
  try { await Promise.all(Array.from({ length: 5 }, () => writeProjectStatusCache("scope", [fixture()], config))); }
  finally { clearInterval(timer); }
  expect(reads).toBeGreaterThan(0);
  expect(readdirSync(config)).toEqual(["projects-status.json"]);
  expect(readProjectStatusCache("changed-roots", config)).toBeNull();
});
it("ignores malformed snapshots and refuses symlinks or shared files", async () => {
  expect(readProjectStatusCache("scope", join(root, "absent"))).toBeNull();
  await writeProjectStatusCache("scope", [fixture()], root);
  const file = projectStatusPath(root);
  writeFileSync(file, '{"version":1,"scope":"scope","observedAt":"bad","statuses":[]}');
  expect(readProjectStatusCache("scope", root)).toBeNull();
  if (process.platform !== "win32") {
    chmodSync(file, 0o644);
    expect(() => readProjectStatusCache("scope", root)).toThrow("Unsafe project status cache");
    await expect(writeProjectStatusCache("scope", [], root)).rejects.toThrow("Unsafe project status cache");
    rmSync(file); const target = join(root, "target"); writeFileSync(target, "private"); symlinkSync(target, file);
    expect(() => readProjectStatusCache("scope", root)).toThrow("Unsafe project status cache");
    await expect(writeProjectStatusCache("scope", [], root)).rejects.toThrow("Unsafe project status cache");
    expect(readFileSync(target, "utf8")).toBe("private");
  }
});
it("renders the cached table before any refresh probe, then replaces it with fresh status", async () => {
  const repo = join(root, "repo"); mkdirSync(repo);
  for (const args of [["init", "-b", "main"], ["config", "user.name", "Fixture"], ["config", "user.email", "fixture@example.invalid"], ["commit", "--allow-empty", "-m", "initial"]]) await run("git", args, { cwd: repo });
  const entry = new URL("../src/index.ts", import.meta.url).href;
  for (const tty of [true, false]) {
    const result = await runFixture([], { root, config: { project_roots: [root], host_worktree_dirs: {} }, invoke: `
      const { runCli } = await import(${JSON.stringify(entry)});
      await runCli(['bun','ggh','projects']);
      const { writeFileSync } = await import('node:fs');
      writeFileSync(${JSON.stringify(join(repo, "new.txt"))}, 'dirty');
      Object.defineProperty(process.stdout, 'isTTY', {value:${tty}});
      Object.defineProperty(process.stderr, 'isTTY', {value:${tty}});
      const write = process.stderr.write.bind(process.stderr); let output = '';
      process.stderr.write = (chunk, ...args) => { output += String(chunk); return write(chunk, ...args); };
      const spawn = Bun.spawn.bind(Bun); let probes = 0;
      Bun.spawn = (args, options) => {
        if (args[0] === 'git') { probes++; if (${tty} && !output.includes('cached ')) throw new Error('refresh started before cached rows'); }
        return spawn(args, options);
      };
      await runCli(['bun','ggh','projects']);
      if (!probes) throw new Error('refresh did not run');
    ` });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toContain("1 dirty");
    if (tty) {
      // One "cached <age>" header line marks the warm preview instead of
      // per-row stale labels, so the preview (header + column header + row)
      // erases three lines and the fresh render carries no cached marker.
      expect(result.stderr).toMatch(/cached \d+[smhd] ago/);
      expect(result.stderr).toContain("\x1b[3A\r\x1b[0J");
      expect(result.stderr.slice(result.stderr.indexOf("\x1b[3A"))).not.toMatch(/cached \d+[smhd] ago/);
    } else { expect(result.stderr).not.toMatch(/cached \d+[smhd] ago/); expect(result.stderr).not.toContain("\x1b[3A"); }
    rmSync(join(repo, "new.txt"));
  }
});
