import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/services/config.ts";
import { readProjectIndex, refreshProjectIndex } from "../src/services/projects/index-store.ts";
import { readProjectStatuses } from "../src/services/projects/status.ts";
import { projectStatusScope, readProjectStatusCache, writeProjectStatusCache } from "../src/services/projects/status-cache.ts";
import { formatProjects, sortProjects } from "../src/services/projects/view.ts";
import { run } from "../src/utils/exec.ts";

export async function createProjectsFixture(root: string, count = 70, realistic = false): Promise<string> {
  const seed = join(root, "seed"); mkdirSync(seed); writeFileSync(join(seed, "README.md"), "fixture\n");
  const env = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" };
  for (const args of [["init", "-b", "main"], ["config", "user.name", "Fixture"], ["config", "user.email", "fixture@example.invalid"], ["add", "README.md"], ["commit", "-m", "initial"]]) await run("git", args, { cwd: seed, env });
  const repos = join(root, "repos"); mkdirSync(repos, { recursive: true });
  for (let i = 0; i < count; i++) { const path = join(repos, `project-${String(i).padStart(3, "0")}`); cpSync(seed, path, { recursive: true }); writeFileSync(join(path, "untracked.txt"), "fixture\n"); }
  if (realistic) {
    for (let i = 0; i < Math.min(10, count); i++) {
      const path = join(repos, `project-${String(i).padStart(3, "0")}`);
      await run("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: path, env });
      for (let branch = 0; branch < 10; branch++) {
        const name = `feature-${branch}`;
        await run("git", ["branch", name], { cwd: path, env });
        if (branch < 8) await run("git", ["worktree", "add", join(root, "t3", `project-${i}`, name), name], { cwd: path, env });
      }
      await run("git", ["commit", "--allow-empty", "-m", "local work"], { cwd: path, env });
    }
    for (let i = 0; i < Math.min(3, count); i++) {
      const path = join(repos, `project-${String(i).padStart(3, "0")}`);
      const files = join(path, "files"); mkdirSync(files);
      for (let file = 0; file < 20_000; file++) writeFileSync(join(files, `${file}.txt`), "fixture\n");
      await run("git", ["add", "files"], { cwd: path, env });
      await run("git", ["commit", "-m", "20k tracked files"], { cwd: path, env });
      writeFileSync(join(files, "0.txt"), "dirty\n");
    }
  }
  return repos;
}

export async function measureProjects(roots: string[], configDir: string, hosts: { t3?: string } = {}) {
  const config = { ...DEFAULT_CONFIG, project_roots: roots, host_worktree_dirs: hosts };
  const start = performance.now();
  const previous = readProjectIndex(configDir);
  const cached = readProjectStatusCache(projectStatusScope(previous, config), configDir);
  const cachedRows = cached ? sortProjects(previous.clones.flatMap(clone => {
    const status = cached.statuses.find(status => status.commonDir === clone.commonDir);
    return status ? [{ clone, status, stale: true }] : [];
  })) : [];
  const cachedLines = cachedRows.length ? formatProjects(cachedRows, { width: 100 }) : [];
  const cachedRenderMs = cachedLines.length ? Math.round(performance.now() - start) : null;
  const index = await refreshProjectIndex({ config, configDir });
  const discoveryMs = performance.now() - start;
  const statuses = await readProjectStatuses(index.clones);
  await writeProjectStatusCache(projectStatusScope(index, config), statuses, configDir);
  const unavailable = statuses.flatMap(status => status.checkouts).filter(checkout => checkout.dirty.state !== "ok");
  const timedOut = unavailable.filter(checkout => checkout.dirty.state === "unknown" && /deadline/i.test(checkout.dirty.reason)).length;
  const missing = unavailable.filter(checkout => checkout.dirty.state === "unknown" && /missing/i.test(checkout.dirty.reason)).length;
  return { cachedRenderMs, cachedRows: cachedRows.length, timedOut, missing, clones: index.clones.length, checkouts: index.clones.reduce((sum, clone) => sum + clone.checkouts.length, 0), discoveryMs: Math.round(discoveryMs), totalMs: Math.round(performance.now() - start), unavailableDirty: statuses.flatMap(status => status.checkouts).filter(checkout => checkout.dirty.state !== "ok").length, skipped: index.coverage?.skipped.length ?? 0 };
}

export async function measureProjectsCli(roots: string[], configHome: string): Promise<number> {
  const start = performance.now();
  await run(process.execPath, [join(import.meta.dir, "..", "bin", "ggh.ts")], {
    env: { XDG_CONFIG_HOME: configHome, GGH_PROJECT_ROOTS: JSON.stringify(roots), GGH_HOST_WORKTREE_DIRS: "{}", GGH_NO_PLUGINS: "1", NO_COLOR: "1" },
  });
  return Math.round(performance.now() - start);
}

export async function measureProjectsTerminal(roots: string[], configHome: string, hosts: { t3?: string } = {}) {
  const start = performance.now();
  let output = "";
  let firstRowsMs: number | null = null;
  const closed = Promise.withResolvers<void>();
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "bin", "ggh.ts")], {
    env: { ...process.env, XDG_CONFIG_HOME: configHome, GGH_PROJECT_ROOTS: JSON.stringify(roots), GGH_HOST_WORKTREE_DIRS: JSON.stringify(hosts), GGH_NO_PLUGINS: "1", NO_COLOR: "1" },
    terminal: {
      cols: 100, rows: 200,
      data(_terminal, bytes) {
        output += new TextDecoder().decode(bytes);
        if (firstRowsMs === null && output.includes("Name") && output.split("\n").length >= 3) firstRowsMs = Math.round(performance.now() - start);
      },
      exit() { closed.resolve(); },
    },
  });
  const timer = setTimeout(() => { proc.kill(); proc.terminal?.close(); closed.resolve(); }, 30_000);
  try {
    const exitCode = await proc.exited;
    await closed.promise;
    if (exitCode !== 0 || firstRowsMs === null) throw new Error(`Projects terminal benchmark failed: ${output}`);
    return { firstRowsMs, totalMs: Math.round(performance.now() - start), stale: output.includes("stale"), rerender: output.includes("\x1b[0J") };
  } finally { clearTimeout(timer); proc.terminal?.close(); }
}

if (import.meta.main) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ggh-project-bench-")));
  try {
    const repos = await createProjectsFixture(root, 70, true);
    const hosts = { t3: join(root, "t3") };
    const cold = await measureProjects([repos], join(root, "config"), hosts);
    const warm = await measureProjects([repos], join(root, "config"), hosts);
    const cli = { coldMs: await measureProjectsCli([repos], join(root, "cli-config")), warmMs: await measureProjectsCli([repos], join(root, "cli-config")) };
    const terminal = process.platform === "win32" ? undefined : { cold: await measureProjectsTerminal([repos], join(root, "tty-config"), hosts), warm: await measureProjectsTerminal([repos], join(root, "tty-config"), hosts) };
    let real;
    if (process.env.GGH_BENCH_REAL === "1") {
      const roots = [join(homedir(), "Downloads")];
      const realHosts = { t3: join(homedir(), ".t3", "worktrees") };
      real = {
        cold: await measureProjects(roots, join(root, "real-config"), realHosts),
        warm: await measureProjects(roots, join(root, "real-config"), realHosts),
        ...(process.platform !== "win32" ? { terminal: { cold: await measureProjectsTerminal(roots, join(root, "real-tty-config"), realHosts), warm: await measureProjectsTerminal(roots, join(root, "real-tty-config"), realHosts) } } : {}),
      };
    }
    process.stdout.write(`${JSON.stringify({ fixture: { cold, warm, cli, terminal }, ...(real ? { real } : {}) }, null, 2)}\n`);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
