import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG } from "../src/services/config.ts";
import { discoverProjects } from "../src/services/projects/discovery.ts";
import { findLost, type LostResult } from "../src/services/projects/lost.ts";
import { run } from "../src/utils/exec.ts";

/** Disposable local history. No fetches, real-repo scans, or index writes. */
export async function createLostFixture(root: string, count = 16, branches = 24): Promise<string> {
  const seed = join(root, "seed"); mkdirSync(seed);
  const git = (...args: string[]) => run("git", args, { cwd: seed, env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" } });
  await git("init", "-b", "main"); await git("config", "user.name", "Fixture"); await git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(seed, "a.txt"), "initial\n"); await git("add", "."); await git("commit", "-m", "initial"); await git("update-ref", "refs/remotes/origin/main", "HEAD");
  await git("checkout", "-b", "shared"); await git("commit", "--allow-empty", "-m", "shared unpublished");
  for (let i = 0; i < branches; i++) {
    await git("checkout", "-b", `agent/${i}`, "shared"); await git("commit", "--allow-empty", "-m", `work ${i}`);
    await git("commit", "--allow-empty", "-m", `orphan ${i}`); await git("reset", "--hard", "HEAD~");
  }
  await git("checkout", "main");
  const repos = join(root, "repos"); mkdirSync(repos);
  for (let i = 0; i < count; i++) cpSync(seed, join(repos, `clone-${String(i).padStart(2, "0")}`), { recursive: true });
  return repos;
}

function detectedWork(result: LostResult): string {
  // Rescue names and ordering intentionally change. Every detected item and count must match.
  return JSON.stringify(result.items.map(({ nextSteps: _nextSteps, ...item }) => item.kind === "reflog-only" ? { ...item, commits: [...item.commits].sort() } : item)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}

if (import.meta.main) {
  const baselineRoot = process.argv[2];
  if (!baselineRoot) throw new Error("Usage: bun scripts/bench-lost.ts <baseline source directory with dependencies>");
  const baselineLost: typeof import("../src/services/projects/lost.ts") = await import(join(resolve(baselineRoot), "src/services/projects/lost.ts"));
  const baselineDiscovery: typeof import("../src/services/projects/discovery.ts") = await import(join(resolve(baselineRoot), "src/services/projects/discovery.ts"));
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ggh-lost-bench-")));
  try {
    const repos = await createLostFixture(root);
    const config = { ...DEFAULT_CONFIG, project_roots: [repos], host_worktree_dirs: {} };
    let expected: string | undefined;
    for (let iteration = 1; iteration <= 5; iteration++) {
      for (const side of ["before", "after"] as const) {
        const start = performance.now();
        const discovery = await (side === "before" ? baselineDiscovery.discoverProjects : discoverProjects)({ config });
        const discoveryMs = performance.now() - start;
        const result = await (side === "before" ? baselineLost.findLost : findLost)(discovery.clones, config);
        const totalMs = performance.now() - start;
        const work = detectedWork(result);
        expected ??= work;
        if (result.warnings.length || discovery.coverage.skipped.length || result.clones.length !== 16 || result.items.length !== 800 || result.clones.reduce((sum, clone) => sum + clone.uniqueCommits, 0) !== 784 || work !== expected) throw new Error(`Benchmark inventory changed or is incomplete: ${JSON.stringify(result.warnings)}`);
        process.stdout.write(`${JSON.stringify({ iteration, side, totalMs: Math.round(totalMs), discoveryMs: Math.round(discoveryMs), clones: result.clones.length, items: result.items.length, uniqueCommits: result.clones.reduce((sum, clone) => sum + clone.uniqueCommits, 0), warnings: result.warnings.length })}\n`);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}
