import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/services/config.ts";
import { refreshProjectIndex } from "../src/services/projects/index-store.ts";
import { readProjectStatuses } from "../src/services/projects/status.ts";
import { run } from "../src/utils/exec.ts";

export async function createProjectsFixture(root: string, count = 70): Promise<string> {
  const seed = join(root, "seed"); mkdirSync(seed); writeFileSync(join(seed, "README.md"), "fixture\n");
  const env = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" };
  for (const args of [["init", "-b", "main"], ["config", "user.name", "Fixture"], ["config", "user.email", "fixture@example.invalid"], ["add", "README.md"], ["commit", "-m", "initial"]]) await run("git", args, { cwd: seed, env });
  const repos = join(root, "repos"); mkdirSync(repos, { recursive: true });
  for (let i = 0; i < count; i++) { const path = join(repos, `project-${String(i).padStart(3, "0")}`); cpSync(seed, path, { recursive: true }); writeFileSync(join(path, "untracked.txt"), "fixture\n"); }
  return repos;
}

export async function measureProjects(roots: string[], configDir: string, hosts: { t3?: string } = {}) {
  const config = { ...DEFAULT_CONFIG, project_roots: roots, host_worktree_dirs: hosts };
  const start = performance.now();
  const index = await refreshProjectIndex({ config, configDir });
  const discoveryMs = performance.now() - start;
  const statuses = await readProjectStatuses(index.clones);
  return { clones: index.clones.length, checkouts: index.clones.reduce((sum, clone) => sum + clone.checkouts.length, 0), discoveryMs: Math.round(discoveryMs), totalMs: Math.round(performance.now() - start), unavailableDirty: statuses.flatMap(status => status.checkouts).filter(checkout => checkout.dirty.state !== "ok").length, skipped: index.coverage?.skipped.length ?? 0 };
}

export async function measureProjectsCli(roots: string[], configHome: string): Promise<number> {
  const start = performance.now();
  await run(process.execPath, [join(import.meta.dir, "..", "bin", "ggh.ts")], {
    env: { XDG_CONFIG_HOME: configHome, GGH_PROJECT_ROOTS: JSON.stringify(roots), GGH_HOST_WORKTREE_DIRS: "{}", GGH_NO_PLUGINS: "1", NO_COLOR: "1" },
  });
  return Math.round(performance.now() - start);
}

if (import.meta.main) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ggh-project-bench-")));
  try {
    const repos = await createProjectsFixture(root);
    const cold = await measureProjects([repos], join(root, "config"));
    const warm = await measureProjects([repos], join(root, "config"));
    const cli = { coldMs: await measureProjectsCli([repos], join(root, "cli-config")), warmMs: await measureProjectsCli([repos], join(root, "cli-config")) };
    const real = process.env.GGH_BENCH_REAL === "1" ? { cold: await measureProjects([join(homedir(), "Downloads")], join(root, "real-config"), { t3: join(homedir(), ".t3", "worktrees") }), warm: await measureProjects([join(homedir(), "Downloads")], join(root, "real-config"), { t3: join(homedir(), ".t3", "worktrees") }) } : undefined;
    process.stdout.write(`${JSON.stringify({ fixture: { cold, warm, cli }, ...(real ? { real } : {}) }, null, 2)}\n`);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
