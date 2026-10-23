import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfig } from "../src/services/config.ts";
import { discoverProjects } from "../src/services/projects/discovery.ts";
import { checkoutForReview } from "../src/services/git/worktree.ts";
import { buildTidyPlan, volumeAvailable, type TidyPlan } from "../src/services/projects/tidy-plan.ts";
import { executeTidyPlan, tidyLockPath } from "../src/services/projects/tidy-execute.ts";
import { renderTidyPlan } from "../src/commands/tidy.ts";
import { renderLost } from "../src/commands/lost.ts";
import { findLost } from "../src/services/projects/lost.ts";
import { listOperations } from "../src/services/operations.ts";
import { acquireProcessLock } from "../src/services/process-lock.ts";
import { run } from "../src/utils/exec.ts";
import { fixtureRoot, runFixture } from "./cli-fixture.ts";

let root: string;
let repo: string;
let remote: string;
let home: string;
let oldHome: string | undefined;
let oldXdg: string | undefined;
const config = () => ({ ...getConfig(), project_roots: [repo], project_exclude: [], host_worktree_dirs: { t3: join(root, ".t3", "worktrees") } });
async function git(...args: string[]) { return (await run("git", args, { cwd: repo, env: { HOME: home, GIT_CONFIG_NOSYSTEM: "1" } })).stdout.trim(); }
async function clones() { return (await discoverProjects({ config: config() })).clones; }
async function plan(options: Parameters<typeof buildTidyPlan>[1] = {}) { return buildTidyPlan(await clones(), options, config()); }
async function apply(snapshot: TidyPlan) { return executeTidyPlan(snapshot, await clones(), { approvedSnapshot: snapshot.snapshotId, config: config() }); }
async function tree(name: string, where = join(root, name), detached = false) {
  await checkoutForReview(detached ? "HEAD" : name, where, { cwd: repo, baseBranch: "HEAD", detached });
  return where;
}
beforeEach(async () => {
  root = fixtureRoot("ggh-tidy-"); repo = join(root, "repo"); remote = join(root, "remote.git"); home = join(root, "home");
  mkdirSync(repo); mkdirSync(home);
  oldHome = process.env.HOME; oldXdg = process.env.XDG_CONFIG_HOME; process.env.HOME = home; process.env.XDG_CONFIG_HOME = home;
  await git("init", "-b", "main"); await git("config", "user.name", "Fixture"); await git("config", "user.email", "fixture@example.invalid"); await git("config", "ggh.created", "true");
  writeFileSync(join(repo, ".gitignore"), ".env\nignored/\n");
  await git("add", ".gitignore"); await git("commit", "-m", "initial");
  await git("init", "--bare", remote); await git("remote", "add", "origin", remote); await git("push", "-u", "origin", "main"); await git("remote", "set-head", "origin", "main");
});
afterEach(() => { process.env.HOME = oldHome; process.env.XDG_CONFIG_HOME = oldXdg; rmSync(root, { recursive: true, force: true }); });

describe("tidy ancestry and publication", () => {
  it("deletes a branch merged by ancestry and journals the expected ref effect", async () => {
    await git("checkout", "-b", "merged"); await git("commit", "--allow-empty", "-m", "integrated"); await git("checkout", "main"); await git("merge", "--ff-only", "merged"); await git("push", "origin", "main");
    const snapshot = await plan();
    expect(snapshot.clones[0]?.actions.map(action => action.kind), JSON.stringify(snapshot)).toContain("delete-local-branch");
    const outcomes = await apply(snapshot);
    expect(outcomes).toMatchObject([{ state: "completed", kind: "delete-local-branch" }]);
    expect(await git("branch", "--list", "merged")).toBe("");
    expect((await listOperations(repo))[0]).toMatchObject({ command: "tidy", status: { state: "succeeded" }, steps: [{ state: "completed" }] });
  });
  it("keeps commits added after merge, even if the branch has a recorded merged PR", async () => {
    await git("branch", "later"); const merged = await git("rev-parse", "main");
    await git("checkout", "later"); await git("commit", "--allow-empty", "-m", "after merge"); await git("checkout", "main");
    await git("update-ref", "refs/ggh/merged-prs/later", merged);
    const snapshot = await plan();
    expect(snapshot.clones[0]?.actions.some(action => "branch" in action && action.branch === "later")).toBe(false);
    expect(snapshot.clones[0]?.kept).toContainEqual({ target: "later", reason: "Exact tip is not proven merged by ancestry" });
  });
  it("keeps a published branch absent default-branch or recorded-merge ancestry", async () => {
    await git("checkout", "-b", "unmerged"); await git("commit", "--allow-empty", "-m", "only on feature"); await git("push", "origin", "unmerged"); await git("checkout", "main");
    expect((await plan()).clones[0]?.actions.some(action => "branch" in action && action.branch === "unmerged")).toBe(false);
  });
  it("uses an exact recorded merge commit only when the tip is also published", async () => {
    await git("checkout", "-b", "pr-branch"); await git("commit", "--allow-empty", "-m", "feature"); await git("push", "origin", "pr-branch");
    const tip = await git("rev-parse", "HEAD"); await git("checkout", "main");
    await git("update-ref", "refs/ggh/merged-prs/pr-branch", tip);
    expect((await plan()).clones[0]?.actions).toContainEqual(expect.objectContaining({ kind: "delete-local-branch", branch: "pr-branch" }));
  });
  it("refuses local ref movement and checking out a branch after preview", async () => {
    await git("branch", "merged"); const snapshot = await plan();
    await git("checkout", "merged");
    expect(await apply(snapshot)).toMatchObject([{ state: "refused" }]);
    await git("checkout", "main"); await git("checkout", "-b", "other"); await git("commit", "--allow-empty", "-m", "later"); const oid = await git("rev-parse", "HEAD"); await git("checkout", "main"); await git("branch", "-f", "merged", oid);
    expect(await apply(snapshot)).toMatchObject([{ state: "refused" }]);
    expect(await git("rev-parse", "merged")).toBe(oid);
  });
  it("keeps all removal candidates when clone-level stashes exist", async () => {
    await git("branch", "merged"); const path = await tree("safe");
    writeFileSync(join(path, "work.txt"), "precious"); await run("git", ["stash", "push", "-u", "-m", "keep this"], { cwd: path });
    expect((await plan()).clones[0]?.actions).toEqual([]);
    expect((await findLost(await clones(), config())).items).toContainEqual(expect.objectContaining({ kind: "stash", count: 1, stashes: [expect.objectContaining({ message: expect.stringContaining("keep this") })] }));
  });
});

describe("tidy checkout authority and files", () => {
  it("removes a clean ggh checkout and refuses an ignored .env added after approval", async () => {
    const path = await tree("safe"); const snapshot = await plan();
    expect(snapshot.clones[0]?.actions).toContainEqual(expect.objectContaining({ kind: "remove-checkout", checkout: expect.objectContaining({ path }) }));
    writeFileSync(join(path, ".env"), "secret\n");
    expect(await apply(snapshot)).toMatchObject([{ state: "refused" }]); expect(existsSync(path)).toBe(true);
    expect((await plan()).clones[0]?.kept).toContainEqual(expect.objectContaining({ target: path, reason: expect.stringContaining("Ignored files present") }));
    rmSync(join(path, ".env")); expect(await apply(snapshot)).toMatchObject([{ state: "completed" }]); expect(existsSync(path)).toBe(false);
  });
  it("requires exact per-item ignored approval and refuses a changed ignored file", async () => {
    const path = await tree("ignored-tree"); writeFileSync(join(path, ".env"), "A=1\n");
    const snapshot = await plan({ allowIgnored: [path] }); expect(snapshot.clones[0]?.actions).toHaveLength(1);
    writeFileSync(join(path, ".env"), "A=2\n"); expect(await apply(snapshot)).toMatchObject([{ state: "refused" }]);
    expect(await apply(await plan({ allowIgnored: [path] }))).toMatchObject([{ state: "completed" }]);
  });
  it("keeps locked, dirty, nested, and submodule checkouts", async () => {
    const locked = await tree("locked"); await git("worktree", "lock", locked);
    const dirty = await tree("dirty"); writeFileSync(join(dirty, "untracked"), "work");
    const nested = await tree("nested"); mkdirSync(join(nested, "inner")); await run("git", ["init"], { cwd: join(nested, "inner") });
    const submodule = await tree("submodule"); await run("git", ["update-index", "--add", "--cacheinfo", `160000,${await git("rev-parse", "HEAD")},module`], { cwd: submodule });
    const snapshot = await plan(); expect(snapshot.clones[0]?.actions).toEqual([]);
    expect(snapshot.clones[0]?.kept).toContainEqual({ target: locked, reason: "Locked worktree" });
  });
  it("never removes clean T3 or Claude worktrees, including a queued host turn", async () => {
    const t3 = await tree("t3-clean", join(root, ".t3", "worktrees", "Project", "queued-turn"));
    const claude = await tree("claude-clean", join(repo, ".claude", "worktrees", "idle"));
    // A queued turn is invisible to Git. There is deliberately no host-state probe.
    const snapshot = await plan({ allowUnknown: [t3, claude], allowIgnored: [t3, claude] });
    expect(snapshot.clones[0]?.hostManual).toEqual(expect.arrayContaining([expect.objectContaining({ target: t3, host: "t3" }), expect.objectContaining({ target: claude, host: "claude" })]));
    expect(snapshot.clones[0]?.actions.filter(action => action.kind === "remove-checkout")).toEqual([]);
    await apply(snapshot); expect(existsSync(t3)).toBe(true); expect(existsSync(claude)).toBe(true);
  });
  it("respects T3 config claims on a ggh-created checkout outside host locations", async () => {
    const path = await tree("host-bound"); await git("config", "branch.host-bound.t3-merge-base-ref", "main");
    const snapshot = await plan(); expect(snapshot.clones[0]?.hostManual).toContainEqual(expect.objectContaining({ target: path, host: "t3" })); expect(snapshot.clones[0]?.actions).toEqual([]);
  });
  it("requires exact unknown-owner approval without authorizing other unknown checkouts", async () => {
    const a = join(root, "unknown-a"); const b = join(root, "unknown-b");
    await git("worktree", "add", "-b", "unknown-a", a); await git("worktree", "add", "-b", "unknown-b", b);
    expect((await plan()).clones[0]?.actions).toEqual([]);
    const snapshot = await plan({ allowUnknown: [a] });
    expect(snapshot.clones[0]?.actions).toMatchObject([{ kind: "remove-checkout", checkout: { path: a } }]);
    await apply(snapshot); expect(existsSync(a)).toBe(false); expect(existsSync(b)).toBe(true);
  });
  it("refuses a locked checkout and a new stash after approval", async () => {
    const path = await tree("race"); const snapshot = await plan(); await git("worktree", "lock", path);
    expect(await apply(snapshot)).toMatchObject([{ state: "refused" }]); await git("worktree", "unlock", path);
    writeFileSync(join(repo, "stash-me"), "work"); await git("stash", "push", "-u");
    expect(await apply(snapshot)).toMatchObject([{ state: "refused" }]);
  });
});

describe("missing worktree metadata", () => {
  it("prunes only missing, expired metadata and honors Git's default expiry", async () => {
    const path = await tree("missing"); const data = (await clones())[0]?.checkouts.find(checkout => checkout.path === path)?.gitDir;
    if (!data) throw new Error("Missing fixture gitdir"); rmSync(path, { recursive: true });
    expect((await plan()).clones[0]?.actions.some(action => action.kind === "prune-worktree-metadata")).toBe(false);
    const old = new Date("2020-01-01T00:00:00Z"); utimesSync(join(data, "gitdir"), old, old); if (existsSync(join(data, "index"))) utimesSync(join(data, "index"), old, old);
    const snapshot = await plan(); expect(snapshot.clones[0]?.actions.some(action => action.kind === "prune-worktree-metadata"), JSON.stringify(snapshot)).toBe(true);
    expect((await apply(snapshot)).some(outcome => outcome.kind === "prune-worktree-metadata" && outcome.state === "completed")).toBe(true);
    expect(existsSync(data)).toBe(false);
  });
  it("blocks clone-wide prune when a path looks unmounted", async () => {
    const path = await tree("volume"); const data = (await clones())[0]?.checkouts.find(checkout => checkout.path === path)?.gitDir;
    if (!data) throw new Error("Missing fixture gitdir");
    const unavailable = join(parseRoot(), `ggh-unmounted-${process.pid}`, "repo");
    writeFileSync(join(data, "gitdir"), `${unavailable}/.git\n`); rmSync(path, { recursive: true });
    const old = new Date("2020-01-01T00:00:00Z"); utimesSync(join(data, "gitdir"), old, old); if (existsSync(join(data, "index"))) utimesSync(join(data, "index"), old, old);
    const snapshot = await plan(); expect(snapshot.clones[0]?.actions.some(action => action.kind === "prune-worktree-metadata")).toBe(false);
    expect(snapshot.clones[0]?.kept).toContainEqual(expect.objectContaining({ reason: expect.stringContaining("unmounted") }));
    expect(await volumeAvailable(unavailable)).toBe(false); expect(await volumeAvailable(join(root, "missing"))).toBe(true);
  });
});
function parseRoot() { return process.platform === "win32" ? "Z:\\" : "/"; }

describe("lost", () => {
  it("keeps and lists detached unpublished commits with rescue instructions", async () => {
    const path = await tree("detached", join(root, "detached"), true);
    await run("git", ["commit", "--allow-empty", "-m", "only here"], { cwd: path });
    const snapshot = await plan(); expect(snapshot.clones[0]?.actions).toEqual([]);
    const result = await findLost(await clones(), config());
    expect(result.items).toContainEqual(expect.objectContaining({ kind: "unpublished", path, branch: null, commits: 1, newestSubject: "only here", nextSteps: [expect.arrayContaining(["branch", "rescue-work"])] }));
  });
  it("sorts by commit count then oldest unpublished date, and reports dirty hosts and broken gitdirs", async () => {
    const a = await tree("a"); const b = await tree("b"); const c = await tree("c");
    const commit = (cwd: string, date: string) => run("git", ["commit", "--allow-empty", "-m", date], { cwd, env: { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date }, envAllowlist: ["GIT_COMMITTER_DATE", "GIT_AUTHOR_DATE"] });
    await commit(a, "2025-01-01T00:00:00Z"); await commit(b, "2024-01-01T00:00:00Z"); await commit(c, "2026-01-01T00:00:00Z"); await commit(c, "2026-01-02T00:00:00Z");
    const host = await tree("t3-dirty", join(root, ".t3", "worktrees", "Project", "dirty")); writeFileSync(join(host, "work"), "unfinished");
    const broken = await tree("broken"); writeFileSync(join(broken, ".git"), "gitdir: /missing-ggh-gitdir\n");
    const result = await findLost(await clones(), config());
    expect(result.items.filter(item => item.kind === "unpublished").map(item => item.path)).toEqual([c, b, a]);
    expect(result.items).toContainEqual(expect.objectContaining({ kind: "dirty-host-checkout", path: host }));
    expect(result.items).toContainEqual(expect.objectContaining({ kind: "broken-gitdir", path: broken }));
  });
});

it("serializes two real processes and refuses the stale second approved action", async () => {
  await git("branch", "merged"); const snapshot = await plan(); const inventory = await clones();
  const file = join(root, "approved.json"); writeFileSync(file, JSON.stringify({ snapshot, inventory }));
  const module = new URL("../src/services/projects/tidy-execute.ts", import.meta.url).href;
  const script = `const {readFileSync}=await import('node:fs'); const {executeTidyPlan}=await import(${JSON.stringify(module)}); const {snapshot,inventory}=JSON.parse(readFileSync(process.argv[1],'utf8')); console.log(JSON.stringify(await executeTidyPlan(snapshot,inventory,{approvedSnapshot:snapshot.snapshotId})));`;
  const release = await acquireProcessLock(tidyLockPath(inventory[0]!.commonDir));
  const spawn = () => Bun.spawn([process.execPath, "-e", script, file], { env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home }, stdout: "pipe", stderr: "pipe" });
  const a = spawn(); const b = spawn();
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(await git("branch", "--list", "merged")).toBe("merged"); await release();
  const output = await Promise.all([new Response(a.stdout).text(), new Response(b.stdout).text(), a.exited, b.exited]);
  expect(output[2]).toBe(0); expect(output[3]).toBe(0);
  const states = [JSON.parse(String(output[0]))[0].state, JSON.parse(String(output[1]))[0].state].sort(); expect(states).toEqual(["completed", "refused"]);
});

it("skips effects on cancellation and records skipped state", async () => {
  await git("branch", "merged"); const snapshot = await plan(); const controller = new AbortController(); controller.abort();
  const outcomes = await executeTidyPlan(snapshot, await clones(), { approvedSnapshot: snapshot.snapshotId, signal: controller.signal, config: config() });
  expect(outcomes).toMatchObject([{ state: "skipped" }]); expect(await git("branch", "--list", "merged")).toBe("merged");
});

it("exposes one offline preview, lost JSON and agent schema, and rejects changed agent approval", async () => {
  await git("branch", "merged"); const cfg = { project_roots: [repo], host_worktree_dirs: {} };
  const preview = await runFixture(["tidy", "--all", "--dry-run", "--agent"], { root, config: cfg });
  expect(preview.exitCode, preview.stderr).toBe(0); expect(preview.calls).toEqual([]); expect(preview.providerCalls).toEqual([]);
  const original = JSON.parse(preview.stdout); expect(original).toMatchObject({ status: "planned", result: { plan: { schemaVersion: 1 } } });
  expect(original.result.plan.clones[0].actions).toHaveLength(1);
  await git("branch", "another-merged");
  const changed = await runFixture(["tidy", "--all", "--agent", "--approve-plan", original.result.plan.snapshotId], { root, config: cfg });
  expect(changed.exitCode).toBe(1); expect(JSON.parse(changed.stdout)).toMatchObject({ status: "needs_input", error: { code: "confirmation_required" } });
  expect(await git("branch", "--list", "merged")).toBe("merged");
  const lost = await runFixture(["lost", "--agent"], { root, config: cfg }); expect(lost.exitCode, lost.stderr).toBe(0); expect(JSON.parse(lost.stdout)).toMatchObject({ result: { schemaVersion: 1, items: [], warnings: [] } }); expect(lost.calls).toEqual([]);
  const human = await runFixture(["tidy", "--all", "--dry-run"], { root, config: cfg }); expect(human.stdout).toBe(""); expect(human.stderr.match(/Tidy plan /g)).toHaveLength(1); expect(human.stderr).not.toContain("proof:"); expect(human.stderr).toContain("⊂ origin/main");
  const noApproval = await runFixture(["tidy", "--all", "--agent", "--yes"], { root, config: cfg }); expect(noApproval.exitCode).toBe(1); expect(JSON.parse(noApproval.stdout).status).toBe("needs_input");
});

async function remoteFixtureInvocation(body: string) {
  if (!await git("branch", "--list", "topic")) await git("branch", "topic");
  await git("push", "origin", "topic");
  const script = join(root, "offline-ssh.cjs");
  writeFileSync(script, `const {spawnSync}=require('node:child_process'); const command=process.argv.at(-1); const operation=command.includes('git-receive-pack')?'receive-pack':'upload-pack'; const child=spawnSync('git',[operation,${JSON.stringify(remote)}],{stdio:'inherit'}); process.exit(child.status??1);`);
  const { quoteShellArgument } = await import("../src/utils/command-args.ts");
  await git("config", "core.sshCommand", `${quoteShellArgument(process.execPath)} ${quoteShellArgument(script)}`); await git("config", "ssh.variant", "ssh");
  await git("remote", "set-url", "origin", "ssh://git@github.com/fixture/repo.git");
  const discovery = new URL("../src/services/projects/discovery.ts", import.meta.url).href;
  const classifier = new URL("../src/services/projects/tidy-plan.ts", import.meta.url).href;
  const execution = new URL("../src/services/projects/tidy-execute.ts", import.meta.url).href;
  return runFixture([], { root, cwd: repo, config: { project_roots: [repo], host_worktree_dirs: {} }, responses: [{ prefix: ["config", "get", "user", "--host", "github.com"], stdout: "fixture\n" }], invoke: `
    const {discoverProjects}=await import(${JSON.stringify(discovery)});
    const {buildTidyPlan}=await import(${JSON.stringify(classifier)});
    const {executeTidyPlan}=await import(${JSON.stringify(execution)});
    const {run}=await import(${JSON.stringify(new URL("../src/utils/exec.ts", import.meta.url).href)});
    const {clones}=await discoverProjects();
    const plan=await buildTidyPlan(clones,{remoteBranches:true});
    const spawn=Bun.spawn.bind(Bun); const networkEnvs=[];
    Bun.spawn=(argv,options)=>{
      if(argv[0]==='git' && (argv.includes('ls-remote')||argv.includes('push'))){
        networkEnvs.push(options.env);
        return spawn(argv,{...options,env:{...options.env,GIT_SSH_COMMAND:${JSON.stringify(`${quoteShellArgument(process.execPath)} ${quoteShellArgument(script)}`)}}});
      }
      return spawn(argv,options);
    };
    ${body}
  ` });
}
it("deletes only the approved owned remote ref through a lease, using offline SSH to a bare fixture", async () => {
  const result = await remoteFixtureInvocation(`console.log(JSON.stringify({plan,outcomes:await executeTidyPlan(plan,clones,{approvedSnapshot:plan.snapshotId})}));`);
  expect(result.exitCode, result.stderr).toBe(0); const payload = JSON.parse(result.stdout);
  expect(payload.plan.clones[0].actions).toContainEqual(expect.objectContaining({ kind: "delete-remote-branch", branch: "topic", login: "fixture" }));
  expect(payload.outcomes).toContainEqual(expect.objectContaining({ kind: "delete-remote-branch", state: "completed" }));
  const ref = await run("git", ["--git-dir", remote, "show-ref", "--quiet", "--verify", "refs/heads/topic"], { reject: false }); expect(ref.exitCode).toBe(1);
  expect(result.calls.every(call => call[0] === "config" && call[1] === "get")).toBe(true);
});
it("refuses a moved remote tip immediately before deletion and leaves it intact", async () => {
  const result = await remoteFixtureInvocation(`
    const original=(await run('git',['rev-parse','HEAD'],{cwd:${JSON.stringify(repo)}})).stdout.trim();
    const moved=(await run('git',['commit-tree',original+'^{tree}','-p',original,'-m','moved remote'],{cwd:${JSON.stringify(repo)}})).stdout.trim();
    await run('git',['push',${JSON.stringify(remote)},moved+':refs/heads/topic'],{cwd:${JSON.stringify(repo)}});
    const outcomes=await executeTidyPlan(plan,clones,{approvedSnapshot:plan.snapshotId});
    console.log(JSON.stringify({outcomes,moved}));
  `);
  expect(result.exitCode, result.stderr).toBe(0); const payload = JSON.parse(result.stdout);
  expect(payload.outcomes).toContainEqual(expect.objectContaining({ kind: "delete-remote-branch", state: "refused", reason: "Remote tip changed after preview" }));
  expect((await run("git", ["--git-dir", remote, "rev-parse", "refs/heads/topic"])).stdout.trim()).toBe(payload.moved);
});
it("skips unprovable remote ownership without an auth/network probe", async () => {
  await git("branch", "topic"); await git("push", "origin", "topic");
  const snapshot = await plan({ remoteBranches: true });
  expect(snapshot.clones[0]?.actions.some(action => action.kind === "delete-remote-branch")).toBe(false);
  expect(snapshot.clones[0]?.kept).toContainEqual(expect.objectContaining({ target: "refs/remotes/origin/topic", reason: expect.stringContaining("Ownership unproven") }));
});
it("keeps hidden index changes and missing detached unpublished metadata", async () => {
  const path = await tree("hidden"); await run("git", ["update-index", "--assume-unchanged", ".gitignore"], { cwd: path }); writeFileSync(join(path, ".gitignore"), "changed but hidden\n");
  const snapshot = await plan(); expect(snapshot.clones[0]?.actions).toEqual([]);
  expect(snapshot.clones[0]?.kept).toContainEqual(expect.objectContaining({ target: path, reason: expect.stringContaining("hide file state") }));
  const detached = await tree("missing-detached", join(root, "missing-detached"), true); await run("git", ["commit", "--allow-empty", "-m", "do not prune"], { cwd: detached });
  const data = (await clones())[0]?.checkouts.find(checkout => checkout.path === detached)?.gitDir;
  if (!data) throw new Error("Missing fixture gitdir"); rmSync(detached, { recursive: true });
  const old = new Date("2020-01-01T00:00:00Z"); utimesSync(join(data, "gitdir"), old, old); utimesSync(join(data, "index"), old, old);
  const missing = await plan(); expect(missing.clones[0]?.actions.some(action => action.kind === "prune-worktree-metadata")).toBe(false);
  expect(missing.clones[0]?.kept).toContainEqual(expect.objectContaining({ reason: expect.stringContaining("Unpublished or unknown HEAD") }));
});
it("applies an agent-approved plan, registers result schemas, and performs an explicit offline fetch", async () => {
  await git("branch", "merged");
  const cfg = { project_roots: [repo], host_worktree_dirs: {} };
  const preview = await runFixture(["tidy", "--all", "--dry-run", "--agent"], { root, config: cfg }); const snapshot = JSON.parse(preview.stdout).result.plan.snapshotId;
  const applied = await runFixture(["tidy", "--all", "--agent", "--approve-plan", snapshot], { root, config: cfg });
  expect(applied.exitCode, applied.stderr).toBe(0); expect(JSON.parse(applied.stdout)).toMatchObject({ status: "succeeded", result: { outcomes: [{ state: "completed" }] }, effects: { completed: [expect.any(String)], pending: [], uncertain: [] } });
  const schema = await runFixture(["agent", "schema"], { root, config: cfg }); const schemas = JSON.parse(schema.stdout).coreResultSchemas;
  expect(schemas.tidy.schema.required).toContain("plan"); expect(schemas.lost.schema.required).toContain("items");
  const fetched = await runFixture(["tidy", "--all", "--fetch", "--dry-run", "--json"], { root, config: cfg });
  expect(fetched.exitCode, fetched.stderr).toBe(0); expect(JSON.parse(fetched.stdout).plan.clones[0].fetchedAt).not.toBeNull(); expect(fetched.calls).toEqual([]);
});
it("the actual launcher records cancellation and leaves the next effect untouched", async () => {
  await git("branch", "merged");
  const snapshot = await plan();
  mkdirSync(join(home, "good-gh"), { mode: 0o700 }); writeFileSync(join(home, "good-gh", "config.json"), JSON.stringify({ project_roots: [repo], host_worktree_dirs: {} }));
  const release = await acquireProcessLock(tidyLockPath(snapshot.clones[0]!.commonDir));
  const entry = new URL("../bin/ggh.ts", import.meta.url).href;
  const script = `if(process.platform==='win32') process.stdin.on('data',()=>process.emit('SIGINT','SIGINT')); process.argv=[process.execPath,'ggh','tidy','--all','--yes']; await import(${JSON.stringify(entry)});`;
  const child = Bun.spawn([process.execPath, "-e", script], { cwd: root, env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home, GGH_NO_PLUGINS: "1", GIT_CONFIG_NOSYSTEM: "1", NO_COLOR: "1" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = child.stderr.getReader(); let output = ""; const decoder = new TextDecoder();
  try {
    const deadline = Date.now() + 10000;
    while (!output.includes("gc-hint") && Date.now() < deadline) { const part = await reader.read(); if (part.done) break; output += decoder.decode(part.value); }
    expect(output).toContain("Tidy plan"); if (process.platform === "win32") child.stdin.write("interrupt\n"); else child.kill("SIGINT"); await new Promise(resolve => setTimeout(resolve, 30)); await release();
    expect(await child.exited).toBe(130); expect(await git("branch", "--list", "merged")).toBe("merged");
    const records = await listOperations(repo); expect(records.every(record => record.steps.every(step => step.state !== "completed"))).toBe(true);
  } finally { await release(); child.kill(); await child.exited; reader.releaseLock(); }
});
it("never follows a symbolic local branch when deleting its name", async () => {
  await git("symbolic-ref", "refs/heads/alias", "refs/heads/main");
  const snapshot = await plan(); await apply(snapshot);
  expect(await git("rev-parse", "--verify", "refs/heads/main")).toMatch(/^[a-f0-9]{40,64}$/);
  expect(await git("symbolic-ref", "refs/heads/alias")).toBe("refs/heads/main");
});
it("keeps ignored nested bare repositories even with an ignored-file override", async () => {
  const path = await tree("bare-nested"); const nested = join(path, "ignored", "backup.git"); mkdirSync(nested, { recursive: true }); await run("git", ["init", "--bare"], { cwd: nested });
  const snapshot = await plan({ allowIgnored: [path] });
  expect(snapshot.clones[0]?.actions.some(action => action.kind === "remove-checkout")).toBe(false);
  expect(existsSync(nested)).toBe(true);
});
it("emits one agent document when the launcher gracefully cancels tidy", async () => {
  await git("branch", "merged"); const snapshot = await plan();
  mkdirSync(join(home, "good-gh"), { mode: 0o700 }); writeFileSync(join(home, "good-gh", "config.json"), JSON.stringify({ project_roots: [repo], host_worktree_dirs: {} }));
  const bin = new URL("../bin/ggh.ts", import.meta.url).href;
  const script = `if(process.platform==='win32') process.stdin.on('data',()=>process.emit('SIGINT','SIGINT')); const spawn=Bun.spawn.bind(Bun); Bun.spawn=(argv,options)=>{ if(argv[0]==='git'&&argv.includes('count-objects')) process.stderr.write('PLAN_READY\\n'); return spawn(argv,options); }; process.argv=[process.execPath,'ggh','tidy','--all','--agent','--approve-plan',${JSON.stringify(snapshot.snapshotId)}]; await import(${JSON.stringify(bin)});`;
  const child = Bun.spawn([process.execPath, "-e", script], { cwd: root, env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home, GGH_NO_PLUGINS: "1", GIT_CONFIG_NOSYSTEM: "1", NO_COLOR: "1" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = child.stderr.getReader(); let output = "";
  try {
    while (!output.includes("PLAN_READY")) { const part = await reader.read(); if (part.done) break; output += new TextDecoder().decode(part.value); }
    expect(output).toContain("PLAN_READY"); if (process.platform === "win32") child.stdin.write("interrupt\n"); else child.kill("SIGINT");
    const data = await new Response(child.stdout).text(); expect(await child.exited).toBe(130);
    const lines = data.trim().split("\n"); expect(lines).toHaveLength(1); expect(JSON.parse(lines[0]!)).toMatchObject({ status: "cancelled" });
    expect(await git("branch", "--list", "merged")).toBe("merged");
  } finally { child.kill(); await child.exited; reader.releaseLock(); }
});
it("orders equal commit risks by actual time across timezone offsets", async () => {
  const older = await tree("older-zone"); const newer = await tree("newer-zone");
  for (const [cwd, date] of [[older, "2025-01-01T00:00:00+14:00"], [newer, "2024-12-31T20:00:00Z"]]) await run("git", ["commit", "--allow-empty", "-m", "local work"], { cwd, env: { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date }, envAllowlist: ["GIT_COMMITTER_DATE", "GIT_AUTHOR_DATE"] });
  expect((await findLost(await clones(), config())).items.filter(item => item.kind === "unpublished").map(item => item.path)).toEqual([older, newer]);
});

it("deduplicates shared unpublished histories per clone and counts exclusive commits per ref", async () => {
  await git("checkout", "-b", "shared");
  await git("commit", "--allow-empty", "-m", "shared one");
  await git("commit", "--allow-empty", "-m", "shared two");
  await git("branch", "alias");
  await git("checkout", "-b", "exclusive");
  await git("commit", "--allow-empty", "-m", "exclusive");
  const detached = await tree("same-head", join(root, "same-head"), true);
  const result = await findLost(await clones(), config());
  const expected = Number(await git("rev-list", "--count", "--branches", "HEAD", "--not", "--remotes"));
  expect(result.clones[0]).toMatchObject({ uniqueCommits: expected, branches: 3, detachedHeads: 1 });
  expect(result.items.filter(item => item.kind === "unpublished")).toEqual(expect.arrayContaining([
    expect.objectContaining({ branch: "shared", commits: 2, uniqueCommits: 0, sharedCommits: 2 }),
    expect.objectContaining({ branch: "alias", commits: 2, uniqueCommits: 0, sharedCommits: 2 }),
    expect.objectContaining({ branch: "exclusive", commits: 3, uniqueCommits: 0, sharedCommits: 3 }),
    expect.objectContaining({ branch: null, path: detached, commits: 3, uniqueCommits: 0, sharedCommits: 3 }),
  ]));
  await run("git", ["commit", "--allow-empty", "-m", "detached exclusive"], { cwd: detached });
  const updated = await findLost(await clones(), config());
  expect(updated.clones[0]?.uniqueCommits).toBe(expected + 1);
  expect(updated.items[0]).toMatchObject({ kind: "unpublished", branch: null, uniqueCommits: 1, sharedCommits: 3 });
});
it("shows fetch age, uncertainty, and a fetch suggestion in lost and tidy", async () => {
  await git("commit", "--allow-empty", "-m", "local only");
  writeFileSync(join(repo, ".git", "FETCH_HEAD"), "");
  const old = new Date(Date.now() - 3 * 86400000);
  utimesSync(join(repo, ".git", "FETCH_HEAD"), old, old);
  const lost = await findLost(await clones(), config());
  expect(lost.clones[0]?.fetchedAt).toBe(old.toISOString());
  const text = renderLost(lost, { wide: true }).join("\n");
  expect(text).toContain("fetch 3d ago");
  expect(text).toContain("may already exist on the remote");
  expect(text).toContain("--fetch");
  expect(renderTidyPlan(await plan(), { wide: true }).join("\n")).toContain("--fetch");
});
it("keeps a large tidy preview compact and bounded, with verbose details and full JSON proofs", async () => {
  const snapshot = await plan();
  const clone = snapshot.clones[0]!;
  const proof = { commonDir: clone.commonDir, cloneIdentity: "identity", refs: [], remoteRefs: Array.from({ length: 100 }, (_, i) => ({ ref: `refs/remotes/origin/remote-${i}`, oid: "a".repeat(40) })), stash: "none" };
  clone.actions = Array.from({ length: 20 }, (_, i) => ({ kind: "delete-local-branch", branch: `finish/branch-${i}`, tip: "b".repeat(40), integration: { ref: "refs/remotes/origin/main", oid: "a".repeat(40) }, id: String(i), proof }));
  clone.hostManual = Array.from({ length: 40 }, (_, i) => ({ target: `/host/worktree-${i}`, host: "t3", reason: "Host-owned worktree" }));
  const coverage = { roots: [repo], truncated: false, skipped: Array.from({ length: 14 }, (_, i) => ({ path: join(repo, ".claude", "worktrees", `broken-${i}`), reason: "Broken checkout: cannot resolve Git common directory" })) };
  const options = { coverage, clones: await clones(), width: 100 };
  const lines = renderTidyPlan(snapshot, options);
  expect(lines.length).toBeLessThan(60);
  expect(lines.every(line => Bun.stringWidth(line) <= 97)).toBe(true);
  expect(lines.join("\n")).toContain("20 branches");
  expect(lines.join("\n")).toContain("40 T3 worktrees");
  expect(lines.join("\n")).toContain("14 broken checkout dirs");
  expect(lines.join("\n")).not.toContain("remote-99");
  expect(JSON.stringify(snapshot)).toContain("remote-99");
  expect(renderTidyPlan(snapshot, { ...options, verbose: true }).length).toBeGreaterThan(lines.length);
  expect(renderTidyPlan(snapshot, { ...options, width: 45 }).every(line => Bun.stringWidth(line) <= 42)).toBe(true);
  expect(renderTidyPlan(snapshot, { ...options, wide: true }).some(line => Bun.stringWidth(line) > 97)).toBe(true);
  expect(renderLost(await findLost(await clones(), config()), { width: 45 }).every(line => Bun.stringWidth(line) <= 42)).toBe(true);
});
it("lost --fetch refreshes stale tracking refs using a local bare remote", async () => {
  const tracked = await git("rev-parse", "refs/remotes/origin/main");
  await git("commit", "--allow-empty", "-m", "already on remote");
  await git("push", remote, "main");
  // Newer Git can update the tracking ref when pushing to a matching URL; pin it stale.
  await git("update-ref", "refs/remotes/origin/main", tracked);
  const cfg = { project_roots: [repo], host_worktree_dirs: {} };
  const stale = await runFixture(["lost", "--json"], { root, config: cfg });
  expect(JSON.parse(stale.stdout).clones[0].uniqueCommits).toBe(1);
  const fresh = await runFixture(["lost", "--fetch", "--json"], { root, config: cfg });
  expect(fresh.exitCode, fresh.stderr).toBe(0);
  expect(JSON.parse(fresh.stdout).clones[0]).toMatchObject({ uniqueCommits: 0, fetchedAt: expect.any(String) });
  expect(JSON.parse(fresh.stdout).items).toEqual([]);
});
it("shows full lost detail for a named clone and preserves JSON and agent inventories", async () => {
  await git("commit", "--allow-empty", "-m", "local only");
  for (let i = 0; i < 7; i++) await git("branch", `alias-${i}`);
  const cfg = { project_roots: [repo], host_worktree_dirs: {} };
  const compact = await runFixture(["lost"], { root, config: cfg });
  const scoped = await runFixture(["lost", repo], { root, config: cfg });
  const verbose = await runFixture(["lost", "--verbose"], { root, config: cfg });
  for (const output of [compact, scoped, verbose]) expect(output.exitCode, output.stderr).toBe(0);
  expect(compact.stderr).toContain("… 5 more branches (5 with 0 unique commits)");
  expect(compact.stderr).not.toContain("next:");
  const withoutAge = (text: string) => text.replace(/\b\d+[smhd] ago\b/g, "<age>");
  expect(withoutAge(scoped.stderr)).toBe(withoutAge(verbose.stderr));
  expect(scoped.stderr).toContain("alias-6");
  expect(scoped.stderr).toContain('next: "git"');
  const json = await runFixture(["lost", "--json"], { root, config: cfg });
  const fullJson = await runFixture(["lost", "--verbose", "--json"], { root, config: cfg });
  const agent = await runFixture(["lost", "--agent"], { root, config: cfg });
  for (const output of [json, fullJson, agent]) expect(output.exitCode, output.stderr).toBe(0);
  expect(JSON.parse(json.stdout)).toEqual(JSON.parse(fullJson.stdout));
  const inventory = JSON.parse(json.stdout);
  expect(JSON.parse(agent.stdout).result).toEqual(inventory);
  expect(inventory.items.filter((item: { kind: string }) => item.kind === "unpublished")).toHaveLength(8);
});

it("tidy remote deletion preserves SSH agent auth and forces batch mode", async () => {
  const result = await remoteFixtureInvocation(`
    process.env.SSH_AUTH_SOCK='/tmp/ggh-fixture-agent';
    const outcomes=await executeTidyPlan(plan,clones,{approvedSnapshot:plan.snapshotId});
    console.log(JSON.stringify({outcomes,envs:networkEnvs.map(env=>({sock:env.SSH_AUTH_SOCK,ssh:env.GIT_SSH_COMMAND,prompt:env.GIT_TERMINAL_PROMPT}))}));
  `);
  expect(result.exitCode, result.stderr).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.outcomes).toContainEqual(expect.objectContaining({ kind: "delete-remote-branch", state: "completed" }));
  expect(payload.envs).toEqual(Array.from({ length: 2 }, () => ({ sock: "/tmp/ggh-fixture-agent", ssh: "ssh -oBatchMode=yes", prompt: "0" })));
});
it("tidy reports remote auth denial as refused and network timeout as uncertain", async () => {
  for (const denial of [true, false]) {
    const result = await remoteFixtureInvocation(`
      const original=Bun.spawn.bind(Bun);
      Bun.spawn=(argv,options)=>argv[0]==='git'&&argv.includes('ls-remote')?{pid:0,stdout:new Blob([]).stream(),stderr:new Blob([${JSON.stringify(denial ? "Permission denied (publickey)" : "Connection timed out")}]).stream(),exited:Promise.resolve(128),kill(){},stdin:null}:original(argv,options);
      console.log(JSON.stringify(await executeTidyPlan(plan,clones,{approvedSnapshot:plan.snapshotId})));
    `);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toContainEqual(expect.objectContaining({ kind: "delete-remote-branch", state: denial ? "refused" : "uncertain" }));
  }
});
