import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureRoot, runFixture } from "./cli-fixture.ts";
import { run } from "../src/utils/exec.ts";
import { discoverProjects } from "../src/services/projects/discovery.ts";
import { syncProjects } from "../src/services/projects/sync.ts";
import { classifyBranchDeletion, deleteGoneBranch } from "../src/services/git/branch-safety.ts";
import type { IndexedClone } from "../src/services/projects/types.ts";
import { quoteShellArgument } from "../src/utils/command-args.ts";

let root: string;
const git = async (cwd: string, ...args: string[]) => (await run("git", args, { cwd, env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" } })).stdout.trim();
beforeEach(() => { root = fixtureRoot("ggh-sync-"); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

async function fixture(name = "project") {
  const remote = join(root, `${name}.git`); const seed = join(root, `${name}-seed`); const local = join(root, name);
  mkdirSync(remote); mkdirSync(seed);
  await git(remote, "init", "--bare", "-b", "main");
  await git(seed, "init", "-b", "main");
  await git(seed, "config", "user.name", "Fixture"); await git(seed, "config", "user.email", "fixture@example.invalid");
  await git(seed, "commit", "--allow-empty", "-m", "initial");
  await git(seed, "remote", "add", "origin", remote); await git(seed, "push", "-u", "origin", "main");
  await git(root, "clone", remote, local);
  const clone = (await discoverProjects({ registered: [local], config: { project_roots: [], host_worktree_dirs: {} } })).clones[0]!;
  return { remote, seed, local, clone };
}
async function advance(seed: string, branch = "main") {
  await git(seed, "checkout", branch); writeFileSync(join(seed, `${branch}.txt`), await git(seed, "rev-parse", "HEAD")); await git(seed, "add", "."); await git(seed, "commit", "-m", "advance");
  await git(seed, "push", "origin", branch); return git(seed, "rev-parse", "HEAD");
}
async function cli(clones: IndexedClone[], args: string[], responses?: Parameters<typeof runFixture>[1]["responses"]) {
  const indexModule = new URL("../src/services/projects/index-store.ts", import.meta.url).href;
  const entry = new URL("../src/index.ts", import.meta.url).href;
  return runFixture([], { root, config: { host_worktree_dirs: {}, project_roots: [] }, responses,
    invoke: `const {updateProjectIndex}=await import(${JSON.stringify(indexModule)}); await updateProjectIndex(index=>({...index,clones:${JSON.stringify(clones)}})); const {runCli}=await import(${JSON.stringify(entry)}); await runCli(['bun','ggh',...${JSON.stringify(args)}]);` });
}

it("single-repo sync reports fetch and prune effects and skips dry-run writes", async () => {
  const { local } = await fixture();
  const result = await runFixture(["sync", "--agent", "--yes"], { root, cwd: local });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).effects.completed).toContain("refs_fetched_pruned");
  const fetchHead = readFileSync(join(local, ".git", "FETCH_HEAD"), "utf8");
  const dry = await runFixture(["sync", "--agent", "--yes", "--dry-run"], { root, cwd: local });
  expect(dry.exitCode).toBe(0);
  expect(JSON.parse(dry.stdout)).toMatchObject({ status: "planned", effects: { completed: [] } });
  expect(readFileSync(join(local, ".git", "FETCH_HEAD"), "utf8")).toBe(fetchHead);
});

it("reports uncertain refs when fetch fails after it may have applied updates", async () => {
  const { local } = await fixture();
  await git(local, "remote", "set-url", "origin", join(root, "missing.git"));
  const result = await runFixture(["sync", "--agent", "--yes"], { root, cwd: local });
  expect(JSON.parse(result.stdout).effects).toMatchObject({ completed: [], uncertain: ["refs_fetched_pruned"] });
});

describe("indexed sync", () => {
  it("fetches once per clone and updates live worktrees without switching branches or pruning local branches", async () => {
    const { local, seed, clone } = await fixture(); const other = join(root, "other");
    await git(seed, "branch", "topic"); await git(seed, "push", "origin", "topic");
    await git(local, "fetch", "origin"); await git(local, "worktree", "add", "--track", "-b", "topic", other, "origin/topic");
    await git(local, "branch", "keep");
    const old = await git(local, "rev-parse", "HEAD"); const main = await advance(seed); const topic = await advance(seed, "topic");
    const result = await syncProjects([clone, clone]);
    expect(result.clones).toHaveLength(1); expect(result.clones[0]?.fetches).toEqual([{ remote: "origin", outcome: "updated" }]);
    expect(result.clones[0]?.checkouts).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: local, branch: "main", outcome: "updated", old, new: main }),
      expect.objectContaining({ path: other, branch: "topic", outcome: "updated", old, new: topic }),
    ]));
    expect(await git(local, "branch", "--show-current")).toBe("main"); expect(await git(other, "branch", "--show-current")).toBe("topic");
    expect(await git(local, "rev-parse", "keep")).toBe(old);
    expect(readFileSync(join(local, "main.txt"), "utf8")).toBe(old); expect(readFileSync(join(other, "topic.txt"), "utf8")).toBe(old);
    expect((await syncProjects([clone])).clones[0]?.checkouts.every(row => row.outcome === "up-to-date")).toBe(true);
  });

  it("skips deleted worktrees as missing and still syncs the clone through --all", async () => {
    const { local, seed, clone } = await fixture(); const gone = join(root, "gone");
    await git(local, "worktree", "add", "-b", "agent/gone", gone, "main");
    rmSync(gone, { recursive: true }); const tip = await advance(seed);
    const result = await cli([clone], ["sync", "--all", "--agent"]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "succeeded", result: { clones: [expect.objectContaining({ outcome: "updated", checkouts: expect.arrayContaining([
      expect.objectContaining({ path: gone, outcome: "skipped", reason: "missing" }),
      expect.objectContaining({ path: local, outcome: "updated", new: tip }),
    ]) })] } });
    expect(await git(local, "rev-parse", "HEAD")).toBe(tip);
    expect(await git(local, "rev-parse", "agent/gone")).not.toBe(tip);
  });

  it("labels dry runs with the fetch timestamp and leaves remote refs and files untouched", async () => {
    const { local, seed, clone } = await fixture(); const old = await git(local, "rev-parse", "HEAD");
    await git(local, "fetch", "origin"); const fetchHead = readFileSync(join(local, ".git", "FETCH_HEAD"), "utf8");
    const tip = await advance(seed);
    const dry = await cli([clone], ["sync", "--all", "--dry-run", "--agent"]);
    expect(dry.exitCode, dry.stderr).toBe(0);
    expect(JSON.parse(dry.stdout).result.clones[0]).toMatchObject({ outcome: "up-to-date", refSnapshot: { fetchedAt: expect.any(String) } });
    expect(await git(local, "rev-parse", "origin/main")).toBe(old); expect(await git(local, "rev-parse", "HEAD")).toBe(old);
    expect(readFileSync(join(local, ".git", "FETCH_HEAD"), "utf8")).toBe(fetchHead);
    const human = await cli([clone], ["sync", "--all", "--dry-run"]); expect(human.stderr).toContain("Dry run uses local refs fetched"); expect(human.stderr).toContain("ago");
    const real = await cli([clone], ["sync", "--all", "--agent"]); expect(real.exitCode, real.stderr).toBe(0); expect(await git(local, "rev-parse", "HEAD")).toBe(tip);
  });

  it("skips dirty, detached, diverged, busy, locked, and upstreamless checkouts", async () => {
    const { local, seed, clone } = await fixture();
    const paths = Object.fromEntries(["dirty", "detached", "diverged", "busy", "locked", "no-upstream"].map(name => [name, join(root, name)]));
    for (const [name, path] of Object.entries(paths)) {
      await git(local, "worktree", "add", "-b", name, path, "main");
      if (name !== "no-upstream") await git(path, "branch", "--set-upstream-to=origin/main");
    }
    writeFileSync(join(paths.dirty!, "untracked"), "keep");
    await git(paths.detached!, "checkout", "--detach");
    await git(paths.diverged!, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "local");
    const busyDir = await git(paths.busy!, "rev-parse", "--absolute-git-dir"); writeFileSync(join(busyDir, "MERGE_HEAD"), await git(local, "rev-parse", "HEAD"));
    await git(local, "worktree", "lock", paths.locked!);
    await advance(seed);
    const result = await syncProjects([clone]); const checkouts = result.clones[0]!.checkouts;
    for (const [name, reason] of Object.entries({ dirty: "dirty", detached: "detached", diverged: "diverged", busy: "busy-operation", locked: "locked", "no-upstream": "no-upstream" })) {
      expect(checkouts.find(row => row.path === paths[name])).toMatchObject({ outcome: "skipped", reason });
    }
    expect(readFileSync(join(paths.dirty!, "untracked"), "utf8")).toBe("keep"); expect(existsSync(join(busyDir, "MERGE_HEAD"))).toBe(true);
  });

  it("protects host directories even when the index predates the worktree, unless included", async () => {
    const { local, seed, clone } = await fixture(); const hosts = join(root, ".t3", "worktrees"); const hosted = join(hosts, "session");
    await git(local, "worktree", "add", "-b", "host", hosted, "main"); await git(hosted, "branch", "--set-upstream-to=origin/main");
    const old = await git(hosted, "rev-parse", "HEAD"); const head = await advance(seed);
    const result = await syncProjects([clone], { hostWorktreeDirs: [hosts] });
    expect(result.clones[0]?.checkouts.find(row => row.path === hosted)).toMatchObject({ outcome: "skipped", reason: "host-owned" });
    expect(await git(hosted, "rev-parse", "HEAD")).toBe(old);
    await syncProjects([clone], { hostWorktreeDirs: [hosts], includeHostWorktrees: true }); expect(await git(hosted, "rev-parse", "HEAD")).toBe(head);
  });

  it("follows upstream rather than pushRemote and leaves both bare remotes unchanged", async () => {
    const { local, remote, seed, clone } = await fixture(); const pushRemote = join(root, "fork.git");
    await git(root, "clone", "--bare", remote, pushRemote); await git(local, "remote", "rename", "origin", "upstream");
    await git(local, "remote", "add", "origin", pushRemote); await git(local, "config", "branch.main.pushRemote", "origin");
    const forkTip = await git(pushRemote, "rev-parse", "main"); const head = await advance(seed);
    const result = await syncProjects([clone]);
    expect(result.clones[0]?.fetches.map(row => row.remote).sort()).toEqual(["origin", "upstream"]);
    expect(await git(local, "rev-parse", "HEAD")).toBe(head); expect(await git(pushRemote, "rev-parse", "main")).toBe(forkTip);
    expect(await git(remote, "rev-parse", "main")).toBe(head); expect(result.clones[0]?.forkUpstream).toEqual({ outcome: "skipped", reason: "not-requested" });
  });

  it("confines fetch pruning to tracking refs despite a mirror refspec", async () => {
    const { local, seed, clone } = await fixture(); const old = await git(local, "rev-parse", "HEAD");
    await git(local, "branch", "keep"); await git(local, "config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*");
    const head = await advance(seed); const result = await syncProjects([clone]);
    expect(result.clones[0]?.fetches[0]?.outcome).toBe("updated");
    expect(await git(local, "rev-parse", "keep")).toBe(old); expect(await git(local, "rev-parse", "origin/main")).toBe(head);
  });

  it("stops scheduling after cancellation and reports untouched clones", async () => {
    const a = await fixture("a"); const b = await fixture("b"); const controller = new AbortController();
    const spawn = Bun.spawn; let fetched = false;
    Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
      const child = spawn(...args);
      if (Array.isArray(args[0]) && args[0].includes("fetch")) { fetched = true; controller.abort(); }
      return child;
    }) as typeof Bun.spawn;
    try {
      const result = await syncProjects([a.clone, b.clone], { concurrency: 1, signal: controller.signal });
      expect(fetched).toBe(true); expect(result.cancelled).toBe(true); expect(result.clones[0]?.fetches[0]?.outcome).toBe("updated");
      expect(result.clones[1]).toMatchObject({ outcome: "skipped", reason: "cancelled", fetches: [], checkouts: [expect.objectContaining({ outcome: "skipped", reason: "cancelled" })] });
    } finally { Bun.spawn = spawn; }
  });

  it("bounds concurrent clones", async () => {
    const clones = [];
    for (let i = 0; i < 6; i++) clones.push((await fixture(`project-${i}`)).clone);
    const spawn = Bun.spawn; let active = 0; let peak = 0; let fetches = 0;
    Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
      const child = spawn(...args);
      if (Array.isArray(args[0]) && args[0].includes("fetch")) {
        active++; fetches++; peak = Math.max(peak, active); void child.exited.finally(() => { active--; });
      }
      return child;
    }) as typeof Bun.spawn;
    try { await syncProjects(clones, { concurrency: 2 }); expect(fetches).toBe(6); expect(peak).toBeLessThanOrEqual(2); expect(peak).toBeGreaterThan(0); }
    finally { Bun.spawn = spawn; }
  });

  it("reports failed fetches, deadline failures, and missing clones without updating their checkouts", async () => {
    const { clone, remote, local } = await fixture(); const old = await git(local, "rev-parse", "HEAD");
    rmSync(remote, { recursive: true });
    const result = await syncProjects([clone]);
    expect(result.status).toBe("failed"); expect(result.clones[0]?.fetches[0]).toMatchObject({ outcome: "failed", remote: "origin" });
    expect(result.clones[0]?.checkouts[0]).toMatchObject({ outcome: "skipped", reason: "fetch-failed" });
    expect(await git(local, "rev-parse", "HEAD")).toBe(old);
    expect((await syncProjects([clone], { timeoutMs: 1 })).clones[0]?.outcome).toBe("failed");
    expect((await syncProjects([{ ...clone, commonDir: join(root, "missing") }])).clones[0]?.outcome).toBe("failed");
  });

  it("kills a timed-out local upload-pack and reports uncertain fetch refs without updating a checkout", async () => {
    if (process.platform === "win32") return;
    const { local, seed, clone } = await fixture(); const old = await git(local, "rev-parse", "HEAD"); await advance(seed);
    const uploadPack = join(root, "slow-upload-pack");
    writeFileSync(uploadPack, `#!${process.execPath}\nawait Bun.sleep(2000); const child=Bun.spawn(['git-upload-pack',...process.argv.slice(2)],{stdin:'inherit',stdout:'inherit',stderr:'inherit'}); process.exit(await child.exited);\n`); chmodSync(uploadPack, 0o700);
    await git(local, "config", "remote.origin.uploadpack", quoteShellArgument(uploadPack));
    const result = await syncProjects([clone], { timeoutMs: 1000 });
    expect(result.clones[0]).toMatchObject({ outcome: "uncertain", fetches: [{ remote: "origin", outcome: "uncertain", message: expect.stringContaining("timed out") }], checkouts: [expect.objectContaining({ outcome: "skipped", reason: "fetch-failed" })] });
    expect(await git(local, "rev-parse", "HEAD")).toBe(old); expect(existsSync(join(clone.commonDir, "ggh.lock"))).toBe(false);
  });

  it("treats a failed fast-forward as uncertain and never leaves a merge in progress", async () => {
    const { local, seed, clone } = await fixture(); const old = await git(local, "rev-parse", "HEAD");
    writeFileSync(join(local, ".git", "info", "exclude"), "main.txt\n"); writeFileSync(join(local, "main.txt"), "private"); await advance(seed);
    const result = await syncProjects([clone]);
    expect(result.clones[0]?.checkouts[0]).toMatchObject({ outcome: "uncertain" });
    expect(readFileSync(join(local, "main.txt"), "utf8")).toBe("private"); expect(await git(local, "rev-parse", "HEAD")).toBe(old);
    expect(existsSync(join(local, ".git", "MERGE_HEAD"))).toBe(false);
  });

  it("selects indexed names, paths, and fuzzy matches and rejects ambiguity before effects", async () => {
    const a = await fixture("alpha"); const b = await fixture("beta"); const tip = await advance(a.seed);
    for (const query of ["alpha", a.local, "alpa"]) {
      const result = await cli(query === "alpa" ? [a.clone] : [a.clone, b.clone], ["sync", query, "--json"]);
      expect(result.exitCode, result.stderr).toBe(0); const data = JSON.parse(result.stdout);
      expect(data.clones).toHaveLength(1); expect(data.clones[0].name).toBe("alpha"); expect(result.stdout.trim().split("\n")).toHaveLength(1); expect(result.calls).toEqual([]);
    }
    expect(await git(a.local, "rev-parse", "HEAD")).toBe(tip);
    const ambiguous = await cli([{ ...a.clone, displayName: "duplicate" }, { ...b.clone, displayName: "duplicate" }], ["sync", "duplicate", "--agent"]);
    expect(ambiguous.exitCode).toBe(1); expect(JSON.parse(ambiguous.stdout)).toMatchObject({ status: "failed", error: { code: "missing_input" }, result: { candidates: expect.any(Array) } });
    const dry = await cli([a.clone, b.clone], ["sync", "--all", "--dry-run", "--agent"]);
    expect(JSON.parse(dry.stdout)).toMatchObject({ status: "planned", result: { schemaVersion: 1, clones: expect.any(Array) } }); expect(dry.calls).toEqual([]);
  });

  it("requires fork confirmation, targets the selected fork default only, and reports uncertainty", async () => {
    const { clone } = await fixture(); const fork = { ...clone, primary: { host: "github.com", owner: "fixture", name: "fork" } };
    const denied = await cli([fork], ["sync", "--all", "--fork-upstream", "--agent"]);
    expect(denied.calls).toEqual([]); expect(JSON.parse(denied.stdout)).toMatchObject({ status: "needs_input", error: { code: "confirmation_required" } });
    const allowed = await cli([fork], ["sync", "--all", "--fork-upstream", "--yes", "--agent"], [{ prefix: ["repo", "sync"], stdout: "synced" }]);
    expect(allowed.exitCode, allowed.stderr).toBe(0); expect(allowed.calls).toEqual([["repo", "sync", "github.com/fixture/fork"]]);
    expect(JSON.parse(allowed.stdout)).toMatchObject({ status: "succeeded", effects: { completed: expect.arrayContaining(["fork:github.com/fixture/fork"]) }, result: { clones: [expect.objectContaining({ forkUpstream: { target: "github.com/fixture/fork", outcome: "updated" } })] } });
    const uncertain = await cli([fork], ["sync", "--all", "--fork-upstream", "--yes", "--agent"], [{ prefix: ["repo", "sync"], exitCode: 1, stderr: "connection lost" }]);
    expect(uncertain.exitCode).toBe(1); expect(JSON.parse(uncertain.stdout)).toMatchObject({ status: "partially_completed", effects: { uncertain: ["fork:github.com/fixture/fork"] } });
  });

  it("registers the bulk versioned schema", async () => {
    const result = await runFixture(["agent", "schema"], { root }); const data = JSON.parse(result.stdout);
    expect(data.coreResultSchemas.sync.schema.anyOf[0].properties.schemaVersion).toEqual({ const: 1 });
  });

  it("prints one partial agent report on a real CLI interrupt after a local fetch starts", async () => {
    if (process.platform === "win32") return;
    const a = await fixture("cancel-a"); const b = await fixture("cancel-b");
    const indexModule = new URL("../src/services/projects/index-store.ts", import.meta.url).href;
    const entry = new URL("../bin/ggh.ts", import.meta.url).href;
    const result = await runFixture([], { root, config: { host_worktree_dirs: {}, project_roots: [] }, invoke: `
      const {updateProjectIndex}=await import(${JSON.stringify(indexModule)});
      await updateProjectIndex(index=>({...index,clones:${JSON.stringify([a.clone, b.clone])}}));
      const actualSpawn=Bun.spawn;
      Bun.spawn=(args,options)=>{const child=actualSpawn(args,options); if(args[0]==='git'&&args.includes('fetch')) process.kill(process.pid,'SIGINT'); return child;};
      process.argv=['bun','ggh','sync','--all','--agent','--concurrency','1'];
      await import(${JSON.stringify(entry)});
    ` });
    expect(result.exitCode, result.stderr).toBe(130); expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "partially_completed", effects: { completed: expect.arrayContaining([`fetch:${a.clone.commonDir}:origin`]), pending: expect.arrayContaining([`sync:${b.clone.commonDir}`]), uncertain: [] }, result: { cancelled: true, clones: [expect.any(Object), expect.objectContaining({ outcome: "skipped", reason: "cancelled" })] } });
    expect(existsSync(join(a.clone.commonDir, "ggh.lock"))).toBe(false);
  });
});

describe("gone branch deletion proof", () => {
  it("keeps unpublished tips even when merged into the local default and force is requested", async () => {
    const { local } = await fixture();
    await git(local, "checkout", "-b", "gone"); await git(local, "push", "-u", "origin", "gone");
    await git(local, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "unpublished");
    await git(local, "checkout", "main"); await git(local, "merge", "--ff-only", "gone"); await git(local, "push", "origin", "--delete", "gone"); await git(local, "fetch", "--prune");
    expect(await classifyBranchDeletion("gone", "main", local)).toMatchObject({ outcome: "keep", reason: "unpublished" });
    await expect(deleteGoneBranch("gone", "main", true, local)).rejects.toThrow("unpublished"); expect(await git(local, "rev-parse", "gone")).toBe(await git(local, "rev-parse", "main"));
    const result = await runFixture(["sync", "--force", "--yes", "--json"], { root, cwd: local });
    expect(result.exitCode, result.stderr).toBe(0); expect(JSON.parse(result.stdout)).toMatchObject({ deleted: [], protected: [{ name: "gone", reason: "unpublished" }] });
  });
  it("keeps branches checked out in any worktree and allows published merged branches", async () => {
    const { local } = await fixture(); const other = join(root, "checked");
    await git(local, "worktree", "add", "-b", "gone", other, "main");
    await git(other, "push", "-u", "origin", "gone"); await git(local, "push", "origin", "--delete", "gone"); await git(local, "fetch", "--prune");
    expect(await classifyBranchDeletion("gone", "main", local)).toMatchObject({ outcome: "keep", reason: "checked-out" });
    await expect(deleteGoneBranch("gone", "main", true, local)).rejects.toThrow("checked-out");
    await git(local, "worktree", "remove", other);
    const result = await runFixture(["sync", "--agent", "--yes"], { root, cwd: local });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).effects.completed).toEqual(["refs_fetched_pruned", "branch_deleted:gone"]);
    expect(await git(local, "branch", "--list", "gone")).toBe("");
  });

  it("refuses deletion when the approved tip changes", async () => {
    const { local } = await fixture();
    await git(local, "branch", "gone"); await git(local, "push", "-u", "origin", "gone"); await git(local, "push", "origin", "--delete", "gone"); await git(local, "fetch", "--prune");
    const proof = await classifyBranchDeletion("gone", "main", local); expect(proof.outcome).toBe("delete");
    if (proof.outcome !== "delete") throw new Error("Expected a deletion proof");
    await git(local, "checkout", "--orphan", "replacement"); await git(local, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "new-root");
    await git(local, "push", "origin", "replacement"); await git(local, "branch", "-f", "gone", "replacement"); await git(local, "checkout", "main");
    await expect(deleteGoneBranch("gone", "main", true, local, proof)).rejects.toThrow("proof changed"); expect(await git(local, "rev-parse", "gone")).toBe(await git(local, "rev-parse", "replacement"));
  });
});
