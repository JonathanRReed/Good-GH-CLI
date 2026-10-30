import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/services/config.ts";
import { checkoutForReview } from "../src/services/git/worktree.ts";
import { discoverProjects } from "../src/services/projects/discovery.ts";
import { findLost } from "../src/services/projects/lost.ts";
import { run } from "../src/utils/exec.ts";
import { fixtureRoot, runFixture } from "./cli-fixture.ts";

let root: string;
let repo: string;
const config = () => ({ ...DEFAULT_CONFIG, project_roots: [repo], host_worktree_dirs: {} });
const git = async (cwd: string, ...args: string[]) => (await run("git", args, { cwd, env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" } })).stdout.trim();
const inventory = async () => (await discoverProjects({ config: config() })).clones;
beforeEach(async () => {
  root = fixtureRoot("ggh-lost-"); repo = join(root, "repo"); mkdirSync(repo);
  await git(repo, "init", "-b", "main"); await git(repo, "config", "user.name", "Fixture"); await git(repo, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(repo, "a.txt"), "initial\n"); writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  await git(repo, "add", "."); await git(repo, "commit", "-m", "initial"); await git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it("reports staged, unstaged and untracked work in plain, ggh and main checkouts, excluding ignored files", async () => {
  const plain = join(root, "plain"); const ggh = join(root, "ggh"); const host = join(root, ".t3", "worktrees", "repo", "ignored");
  await git(repo, "worktree", "add", "-b", "agent/plain", plain, "main");
  await checkoutForReview("agent/ggh", ggh, { cwd: repo, baseBranch: "main" });
  await git(repo, "worktree", "add", "-b", "agent/host", host, "main");
  writeFileSync(join(plain, "a.txt"), "unstaged\n"); writeFileSync(join(ggh, "a.txt"), "staged\n"); await git(ggh, "add", "a.txt");
  writeFileSync(join(repo, "new.txt"), "untracked\n"); mkdirSync(join(host, "node_modules")); writeFileSync(join(host, "node_modules", "ignored"), "dependency\n");
  const result = await runFixture(["lost", "--agent"], { root, config: config() });
  expect(result.exitCode, result.stderr).toBe(0);
  const items = JSON.parse(result.stdout).result.items;
  expect(items).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "dirty-checkout", path: plain, dirty: { staged: 0, unstaged: 1, untracked: 0, conflicted: 0 } }),
    expect.objectContaining({ kind: "dirty-checkout", path: ggh, createdBy: "ggh", dirty: { staged: 1, unstaged: 0, untracked: 0, conflicted: 0 } }),
    expect.objectContaining({ kind: "dirty-checkout", path: repo, dirty: { staged: 0, unstaged: 0, untracked: 1, conflicted: 0 } }),
  ]));
  expect(items.some((item: { path: string }) => item.path === host)).toBe(false);
  expect(result.stderr).not.toContain("Inspecting");
});

it("scopes broken-checkout warnings and items to the selected project", async () => {
  const other = join(root, "other"); mkdirSync(other); await git(other, "init", "-b", "main");
  await git(other, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "other");
  const broken = join(other, ".claude", "worktrees", "broken"); mkdirSync(broken, { recursive: true }); writeFileSync(join(broken, ".git"), "gitdir: /missing-ggh-fixture\n");
  const cfg = { ...config(), project_roots: [repo, other] };
  for (const command of ["lost", "projects"]) {
    const human = await runFixture([command, "repo"], { root, config: cfg });
    expect(human.exitCode, human.stderr).toBe(0); expect(human.stderr).toContain("1 broken checkouts elsewhere: ggh lost"); expect(human.stderr).not.toContain(broken);
    const agent = await runFixture([command, "repo", "--agent"], { root, config: cfg }); const payload = JSON.parse(agent.stdout).result;
    expect(payload.coverage.skipped).toEqual([]); expect(payload.coverage.brokenElsewhere).toBe(1);
    if (command === "lost") expect(payload.items.some((item: { path: string }) => item.path === broken)).toBe(false);
  }
  const selected = await runFixture(["lost", "other", "--agent"], { root, config: cfg });
  expect(JSON.parse(selected.stdout).result.items).toContainEqual(expect.objectContaining({ kind: "broken-gitdir", path: broken, commonDir: join(other, ".git") }));
});

it("gives detached and reflog recovery commands distinct unused branch names", async () => {
  for (let i = 0; i < 2; i++) {
    const path = join(root, `detached-${i}`); await git(repo, "worktree", "add", "--detach", path, "main");
    await git(path, "commit", "--allow-empty", "-m", `detached ${i}`);
  }
  const first = await findLost(await inventory(), config());
  for (const step of first.items.flatMap(item => item.nextSteps).filter(step => step.includes("branch"))) await run(step[0] ?? "git", step.slice(1));
  const second = await findLost(await inventory(), config());
  const steps = second.items.flatMap(item => item.nextSteps).filter(step => step.includes("branch"));
  const names = steps.map(step => step[step.indexOf("branch") + 1]); expect(new Set(names).size).toBe(names.length); expect(names.length).toBe(2);
  for (const step of steps) await run(step[0] ?? "git", step.slice(1));
});

it("preserves shared, exclusive and orphaned counts with a bounded number of Git processes", async () => {
  await git(repo, "checkout", "-b", "shared"); await git(repo, "commit", "--allow-empty", "-m", "shared");
  for (let i = 0; i < 12; i++) { await git(repo, "checkout", "-b", `agent/${i}`, "shared"); await git(repo, "commit", "--allow-empty", "-m", `unique ${i}`); }
  await git(repo, "commit", "--allow-empty", "-m", "orphan"); const orphan = await git(repo, "rev-parse", "HEAD"); await git(repo, "reset", "--hard", "HEAD~"); await git(repo, "checkout", "main");
  const clones = await inventory(); const spawn = Bun.spawn; let calls = 0;
  Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => { if (Array.isArray(args[0]) && args[0][0] === "git") calls++; return spawn(...args); }) as typeof Bun.spawn;
  try {
    const result = await findLost(clones, config()); expect(result.warnings).toEqual([]); expect(calls).toBeLessThan(20);
    expect(result.clones[0]).toMatchObject({ uniqueCommits: 14, branches: 13 });
    expect(result.items).toContainEqual(expect.objectContaining({ kind: "unpublished", branch: "agent/0", commits: 2, uniqueCommits: 1, sharedCommits: 1 }));
    expect(result.items).toContainEqual(expect.objectContaining({ kind: "reflog-only", branch: "agent/11", commits: [orphan] }));
  } finally { Bun.spawn = spawn; }
});

it("keeps tied items and discovery coverage in a stable order across agent runs", async () => {
  for (const branch of ["z-last", "a-first"]) await git(repo, "branch", branch);
  for (const name of ["z-broken", "a-broken"]) { const path = join(root, name); mkdirSync(path); writeFileSync(join(path, ".git"), "gitdir: /missing-ggh-fixture\n"); }
  await git(repo, "update-ref", "-d", "refs/remotes/origin/main");
  const cfg = { ...config(), project_roots: [root] };
  for (const command of ["projects", "lost"]) {
    const outputs = [];
    for (let i = 0; i < 3; i++) { const result = await runFixture([command, "--agent"], { root, config: cfg }); expect(result.exitCode, result.stderr).toBe(0); outputs.push(JSON.parse(result.stdout).result); }
    expect(outputs.map(output => output.coverage.skipped)).toEqual(Array(3).fill(outputs[0].coverage.skipped));
    expect(outputs[0].coverage.skipped.map((gap: { path: string }) => gap.path)).toEqual([...outputs[0].coverage.skipped.map((gap: { path: string }) => gap.path)].sort());
    if (command === "lost") {
      expect(outputs.map(output => output.items)).toEqual(Array(3).fill(outputs[0].items));
      expect(outputs[0].items.filter((item: { kind: string }) => item.kind === "unpublished").map((item: { branch: string }) => item.branch)).toEqual(["a-first", "z-last", "main"]);
    }
  }
});

it("labels completed restack pre-images only when the checkpoint matches the current branch", async () => {
  const { createStackRecovery } = await import("../src/services/git/stack.ts");
  await git(repo, "checkout", "-b", "topic"); await git(repo, "commit", "--allow-empty", "-m", "before restack"); const old = await git(repo, "rev-parse", "HEAD");
  await git(repo, "reset", "--hard", "main"); await git(repo, "commit", "--allow-empty", "-m", "after restack"); const tip = await git(repo, "rev-parse", "HEAD");
  await git(repo, "checkout", "main");
  await git(repo, "worktree", "add", "--detach", join(root, "pre-image"), old);
  await createStackRecovery({ schemaVersion: 1, operationId: "be308d3a-1bb0-4076-9834-bfdb90600688", mode: "restack", selected: "topic", originalBranch: "topic", entries: [{ branch: "topic", parent: "main", originalTip: old, expectedTip: tip, state: "completed" }], activeIndex: 1, resources: [] }, repo);
  const result = await findLost(await inventory(), config());
  expect(result.items).toContainEqual(expect.objectContaining({ kind: "restack-preimage", branch: "topic", head: old }));
  expect(result.items.some(item => item.kind === "reflog-only" && item.commits.includes(old))).toBe(false);
  expect(result.clones[0]?.uniqueCommits).toBe(1);
  expect(result.items.some(item => item.kind === "unpublished" && item.branch === null)).toBe(false);
  const human = await runFixture(["lost", "repo", "--wide"], { root, config: config() }); expect(human.stderr).toContain("RESTACK PRE-IMAGE topic");
  await git(repo, "worktree", "remove", join(root, "pre-image"));
  await git(repo, "branch", "-f", "topic", "main");
  const moved = await findLost(await inventory(), config()); expect(moved.items.some(item => item.kind === "restack-preimage")).toBe(false);
  expect(moved.items).toContainEqual(expect.objectContaining({ kind: "reflog-only", commits: expect.arrayContaining([old]) }));
});

it("keeps per-ref reflog limits without letting a long log hide another branch", async () => {
  await git(repo, "checkout", "-b", "short"); await git(repo, "commit", "--allow-empty", "-m", "orphan"); const orphan = await git(repo, "rev-parse", "HEAD");
  await git(repo, "reset", "--hard", "main"); await git(repo, "checkout", "main");
  const log = join(repo, ".git", "logs", "refs", "heads", "main"); const line = readFileSync(log, "utf8"); writeFileSync(log, line.repeat(1002));
  const result = await findLost(await inventory(), config());
  expect(result.warnings).toContainEqual(expect.objectContaining({ target: "main", reason: expect.stringContaining("last 1000 entries") }));
  expect(result.items).toContainEqual(expect.objectContaining({ kind: "reflog-only", branch: "short", commits: [orphan], truncated: false }));
});

it("bounds clone workers and reports progress after each completed clone", async () => {
  const { cpSync } = await import("node:fs"); const clones = await inventory();
  for (let i = 0; i < 3; i++) { const path = join(root, `copy-${i}`); cpSync(repo, path, { recursive: true }); clones.push(...(await discoverProjects({ registered: [path], config: { ...config(), project_roots: [] } })).clones); }
  const spawn = Bun.spawn; let active = 0; let peak = 0; const progress: number[] = [];
  Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
    const child = spawn(...args);
    if (Array.isArray(args[0]) && args[0][0] === "git") { active++; peak = Math.max(peak, active); void child.exited.finally(() => { active--; }); }
    return child;
  }) as typeof Bun.spawn;
  try {
    const result = await findLost(clones, config(), { workers: 2, onProgress: (completed, total) => { expect(total).toBe(4); progress.push(completed); } });
    expect(result.clones).toHaveLength(4); expect(result.warnings).toEqual([]); expect(progress).toEqual([1, 2, 3, 4]);
    expect(peak).toBeGreaterThan(1); expect(peak).toBeLessThanOrEqual(4);
  } finally { Bun.spawn = spawn; }
});

it("writes TTY progress before Git inspection and keeps agent stdout data-only", async () => {
  const entry = new URL("../src/index.ts", import.meta.url).href;
  const result = await runFixture([], { root, config: config(), invoke: `
    Object.defineProperty(process.stderr, 'isTTY', {value:true});
    const write=process.stderr.write.bind(process.stderr); let output=''; process.stderr.write=(chunk,...args)=>{output+=String(chunk);return write(chunk,...args);};
    const spawn=Bun.spawn.bind(Bun); Bun.spawn=(args,options)=>{if(args[0]==='git'&&!output.includes('Discovering projects'))throw new Error('Git started without progress'); return spawn(args,options);};
    const {runCli}=await import(${JSON.stringify(entry)}); await runCli(['bun','ggh','lost']);
  ` });
  expect(result.exitCode, result.stderr).toBe(0); expect(result.stdout).toBe(""); expect(result.stderr).toContain("Inspected 1/1: repo");
});
