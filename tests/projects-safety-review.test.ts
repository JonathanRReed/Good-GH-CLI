import { afterEach, beforeEach, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfig, validateConfigValue } from "../src/services/config.ts";
import { discoverProjects } from "../src/services/projects/discovery.ts";
import { fetchCleanupClones } from "../src/services/projects/cleanup-fetch.ts";
import { buildTidyPlan, volumeAvailable } from "../src/services/projects/tidy-plan.ts";
import { executeTidyPlan, tidyLockPath } from "../src/services/projects/tidy-execute.ts";
import { syncProjects } from "../src/services/projects/sync.ts";
import { findLost } from "../src/services/projects/lost.ts";
import { worktreeRemove } from "../src/services/git/worktree.ts";
import { deleteGoneBranch } from "../src/services/git/branch-safety.ts";
import { markGghCheckout } from "../src/services/git/provenance.ts";
import { acquireProcessLock } from "../src/services/process-lock.ts";
import { run } from "../src/utils/exec.ts";
import { runFixture } from "./cli-fixture.ts";

let root: string;
let repo: string;
let remote: string;
const git = async (cwd: string, ...args: string[]) => (await run("git", args, { cwd, env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" } })).stdout.trim();
const config = () => ({ ...getConfig(), project_roots: [repo], project_exclude: [], host_worktree_dirs: {} });
const clones = async () => (await discoverProjects({ config: config() })).clones;
const plan = async () => buildTidyPlan(await clones(), {}, config());
const moduleUrl = (name: string) => new URL(`../src/${name}.ts`, import.meta.url).href;
beforeEach(async () => {
  root = realpathSync(mkdtempSync(process.platform === "win32" ? join(process.env.TEMP ?? ".", "ggh-safety-review-") : "/tmp/ggh-safety-review-")); repo = join(root, "repo"); remote = join(root, "remote.git"); mkdirSync(repo);
  await git(repo, "init", "-b", "main"); await git(repo, "config", "user.name", "Fixture"); await git(repo, "config", "user.email", "fixture@example.invalid"); await git(repo, "config", "ggh.created", "true");
  writeFileSync(join(repo, ".gitignore"), ".env\n"); await git(repo, "add", "."); await git(repo, "commit", "-m", "initial");
  await git(repo, "init", "--bare", "-b", "main", remote); await git(repo, "remote", "add", "origin", remote); await git(repo, "push", "-u", "origin", "main"); await git(repo, "remote", "set-head", "origin", "main"); await git(repo, "fetch", "origin");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

for (const refspec of ["+refs/*:refs/*", "+refs/heads/*:refs/heads/*"]) it(`cleanup fetch preserves unpublished refs with ${refspec}`, async () => {
  const mirror = join(root, "mirror.git"); await git(root, "clone", "--mirror", remote, mirror);
  await git(mirror, "config", "remote.origin.fetch", refspec); await git(mirror, "branch", "precious");
  await git(mirror, "update-ref", "refs/ggh/reviews/1/pin", "HEAD");
  await git(mirror, "update-ref", "refs/remotes/origin/stale", "HEAD");
  const inventory = (await discoverProjects({ registered: [mirror], config: { project_roots: [], host_worktree_dirs: {} } })).clones;
  await fetchCleanupClones(inventory, "lost", new AbortController().signal);
  expect(await git(mirror, "rev-parse", "precious")).toBe(await git(mirror, "rev-parse", "HEAD"));
  expect(await git(mirror, "rev-parse", "refs/ggh/reviews/1/pin")).toBe(await git(mirror, "rev-parse", "HEAD"));
  expect((await run("git", ["show-ref", "--verify", "--quiet", "refs/remotes/origin/stale"], { cwd: mirror, reject: false })).exitCode).toBe(1);
});

it("worktree remove protects ignored env files unless forced", async () => {
  const path = join(root, "checkout"); await git(repo, "worktree", "add", "-b", "topic", path);
  writeFileSync(join(path, ".env"), "FIXTURE=private\n");
  await expect(worktreeRemove(path, false, repo)).rejects.toThrow(".env");
  expect(readFileSync(join(path, ".env"), "utf8")).toBe("FIXTURE=private\n");
  await worktreeRemove(path, true, repo); expect(existsSync(path)).toBe(false);
});

for (const missing of [false, true]) it(`tidy protects ${missing ? "missing metadata" : "checkout"} HEAD reflog and lost reports reflog-only work`, async () => {
  const path = join(root, "checkout"); await git(repo, "worktree", "add", "--detach", path); await markGghCheckout(path);
  await git(path, "commit", "--allow-empty", "-m", "reflog secret"); const orphan = await git(path, "rev-parse", "HEAD"); await git(path, "reset", "--hard", "main");
  if (missing) {
    const gitDir = await git(path, "rev-parse", "--absolute-git-dir"); rmSync(path, { recursive: true });
    const old = new Date("2020-01-01"); for (const name of ["gitdir", "index"]) utimesSync(join(gitDir, name), old, old);
  }
  const snapshot = await plan();
  expect(snapshot.clones[0]?.actions.some(action => action.kind === (missing ? "prune-worktree-metadata" : "remove-checkout"))).toBe(false);
  expect(snapshot.clones[0]?.kept).toContainEqual(expect.objectContaining({ reason: expect.stringContaining("reflog holds 1 unpublished commits") }));
  expect((await findLost(await clones(), config())).items).toContainEqual(expect.objectContaining({ kind: "reflog-only", commits: expect.arrayContaining([orphan]) }));
});
it("tidy protects branch reflog commits after reset", async () => {
  await git(repo, "checkout", "-b", "reset-branch"); await git(repo, "commit", "--allow-empty", "-m", "orphan"); await git(repo, "reset", "--hard", "main"); await git(repo, "checkout", "main");
  expect((await plan()).clones[0]?.actions).toEqual([]);
  expect((await plan()).clones[0]?.kept).toContainEqual({ target: "reset-branch", reason: expect.stringContaining("reflog holds 1 unpublished commits") });
});
for (const age of ["old", "unknown"] as const) it(`tidy keeps publication proofs with ${age} fetch age`, async () => {
  await git(repo, "branch", "merged");
  if (age === "unknown") { rmSync(join(repo, ".git", "FETCH_HEAD")); rmSync(join(repo, ".git", "logs", "refs", "remotes"), { recursive: true }); }
  else { const old = new Date(Date.now() - 31 * 86400000); utimesSync(join(repo, ".git", "FETCH_HEAD"), old, old); }
  const snapshot = await plan(); expect(snapshot.clones[0]?.actions).toEqual([]);
  expect(snapshot.clones[0]?.kept).toContainEqual(expect.objectContaining({ target: "merged", reason: expect.stringContaining(age === "old" ? "remote refs older than 30 days" : "fetch age unknown") }));
});
it("sync waits for tidy's common-dir lock before fetching", async () => {
  const inventory = await clones(); const clone = inventory[0]!;
  const release = await acquireProcessLock(tidyLockPath(clone.commonDir)); let settled = false;
  const pending = syncProjects(inventory).then(result => { settled = true; return result; });
  try { await Bun.sleep(1000); expect(settled).toBe(false); } finally { await release(); }
  expect((await pending).clones[0]?.fetches).toEqual([{ remote: "origin", outcome: "updated" }]);
});
it("gone branch deletion rejects a tip moved at the deletion syscall", async () => {
  await git(repo, "branch", "gone"); await git(repo, "config", "branch.gone.remote", "origin"); await git(repo, "config", "branch.gone.merge", "refs/heads/gone");
  const tip = await git(repo, "rev-parse", "HEAD"); const moved = await git(repo, "commit-tree", `${tip}^{tree}`, "-p", tip, "-m", "unpublished");
  const spawn = Bun.spawn;
  Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
    const argv = args[0];
    if (Array.isArray(argv) && argv[0] === "git" && (argv.includes("update-ref") && argv.includes("-d") || argv.includes("-D"))) {
      const mutation = Bun.spawnSync(["git", "update-ref", "refs/heads/gone", moved], { cwd: repo }); expect(mutation.exitCode).toBe(0);
    }
    return spawn(...args);
  }) as typeof Bun.spawn;
  try { await expect(deleteGoneBranch("gone", "main", true, repo)).rejects.toThrow(); }
  finally { Bun.spawn = spawn; }
  expect(await git(repo, "rev-parse", "gone")).toBe(moved);
});
it("tidy rechecks ignored files immediately before worktree removal", async () => {
  const path = join(root, "checkout"); await git(repo, "worktree", "add", "-b", "topic", path); await markGghCheckout(path); const snapshot = await plan(); const inventory = await clones();
  // The journal's uncertain write occurs after per-action classification.
  const spawn = Bun.spawn; let injected = false;
  Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
    const argv = args[0];
    if (!injected && Array.isArray(argv) && argv[0] === "git" && argv.includes("count-objects")) { injected = true; writeFileSync(join(path, ".env"), "late ignored file\n"); }
    return spawn(...args);
  }) as typeof Bun.spawn;
  try { expect(await executeTidyPlan(snapshot, inventory, { approvedSnapshot: snapshot.snapshotId, config: config() })).toContainEqual(expect.objectContaining({ state: "refused" })); }
  finally { Bun.spawn = spawn; }
  expect(readFileSync(join(path, ".env"), "utf8")).toBe("late ignored file\n");
});
it("volume guard rejects an autofs prefix even when its directory exists", async () => {
  const mount = join(root, "sshfs"); mkdirSync(mount);
  const result = await runFixture([], { root, invoke: `
    const original=Bun.spawn.bind(Bun); Bun.spawn=(args,options)=>args[0]==='mount'?{pid:0,stdout:new Blob([${JSON.stringify(`/dev/root on / type ext4 (rw)\nauto on ${mount} type autofs (rw)\n`)}]).stream(),stderr:new Blob([]).stream(),exited:Promise.resolve(0),kill(){},stdin:null}:original(args,options);
    const {volumeAvailable}=await import(${JSON.stringify(moduleUrl("services/projects/tidy-plan"))}); console.log(JSON.stringify(await volumeAvailable(${JSON.stringify(join(mount, "missing"))})));
  ` });
  expect(result.exitCode, result.stderr).toBe(0); expect(JSON.parse(result.stdout)).toBe(false);
  expect(await volumeAvailable(join(root, "missing"))).toBe(true);
});

it("lost human subjects strip terminal controls and JSON stays raw", async () => {
  const subject = "subject\x1b[2J\x1b]0;forged\x07";
  await git(repo, "commit", "--allow-empty", "-m", subject);
  const cfg = { project_roots: [repo], host_worktree_dirs: {} };
  const human = await runFixture(["lost", "--verbose", "--wide"], { root, config: cfg });
  expect(human.exitCode, human.stderr).toBe(0); expect(human.stderr).toContain("subject"); expect(human.stderr).not.toContain("\x1b"); expect(human.stderr).not.toContain("forged");
  const raw = await runFixture(["lost", "--json"], { root, config: cfg });
  expect(JSON.parse(raw.stdout).items[0].newestSubject).toBe(subject);
});


it("tidy refuses reflog scans beyond 1000 entries", async () => {
  await git(repo, "branch", "long-log");
  const log = join(repo, ".git", "logs", "refs", "heads", "long-log");
  writeFileSync(log, readFileSync(log, "utf8").repeat(1001));
  const snapshot = await plan();
  expect(snapshot.clones[0]?.actions).toEqual([]);
  expect(snapshot.clones[0]?.kept).toContainEqual({ target: "long-log", reason: expect.stringContaining("reflog scan exceeds 1000 entries") });
});
it("tidy accepts tracking reflog dates without FETCH_HEAD and honors the age setting", async () => {
  await git(repo, "branch", "merged"); rmSync(join(repo, ".git", "FETCH_HEAD"));
  expect((await plan()).clones[0]?.actions).toContainEqual(expect.objectContaining({ kind: "delete-local-branch", branch: "merged" }));
  const date = new Date(Date.now() - 2 * 86400000);
  writeFileSync(join(repo, ".git", "FETCH_HEAD"), "fixture fetch"); utimesSync(join(repo, ".git", "FETCH_HEAD"), date, date);
  const strict = await buildTidyPlan(await clones(), {}, { ...config(), tidy_max_fetch_age_days: 1 });
  expect(strict.clones[0]?.actions).toEqual([]);
  expect(strict.clones[0]?.kept).toContainEqual({ target: "merged", reason: "remote refs older than 1 days; run with --fetch" });
  expect(validateConfigValue("tidy_max_fetch_age_days", "7")).toEqual({ value: 7 });
  expect(validateConfigValue("tidy_max_fetch_age_days", 0).problem).toBeDefined();
});
it("context and tidy human views strip untrusted subjects and branch formatting controls", async () => {
  const branch = "topic\u202eevil"; const subject = "subject\x1b[2J\x1b]0;forged\x07";
  await git(repo, "branch", branch);
  const inventory = await clones(); const clone = inventory[0]!;
  const { readCloneStatus } = await import("../src/services/projects/status.ts");
  const { formatProjectCard } = await import("../src/services/projects/view.ts");
  const { formatTidyPlan } = await import("../src/services/projects/cleanup-view.ts");
  const status = await readCloneStatus(clone);
  const history = { recent: { state: "ok" as const, observedAt: new Date().toISOString(), value: [{ oid: "a".repeat(40), subject, committedAt: new Date().toISOString() }] }, unpublished: { state: "ok" as const, observedAt: new Date().toISOString(), value: [] } };
  const card = formatProjectCard({ clone, status }, history, false, { wide: true }).join("\n");
  expect(card).toContain("subject"); expect(card).not.toContain("\x1b"); expect(card).not.toContain("forged"); expect(card).not.toContain("\u202e");
  const snapshot = await plan(); const human = formatTidyPlan(snapshot, { wide: true }).join("\n");
  expect(human).toContain("topicevil"); expect(human).not.toContain("\u202e"); expect(JSON.stringify(snapshot)).toContain(branch);
});

it("a fresh fetch does not refresh unrelated stale tracking refs", async () => {
  await git(repo, "branch", "merged"); const head = await git(repo, "rev-parse", "HEAD");
  const other = await git(repo, "commit-tree", `${head}^{tree}`, "-p", head, "-m", "only in old remote");
  await run("git", ["update-ref", "refs/remotes/other/old", other], { cwd: repo, env: { GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z" } });
  const snapshot = await plan();
  expect(snapshot.clones[0]?.actions).toEqual([]);
  expect(snapshot.clones[0]?.kept).toContainEqual({ target: "merged", reason: "remote refs older than 30 days; run with --fetch" });
});
