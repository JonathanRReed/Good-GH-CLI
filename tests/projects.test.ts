import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, getConfig, saveConfig, validateConfigValue } from "../src/services/config.ts";
import { checkoutCreator, discoverProjects, mainWorktreePath, projectPath, redactRemoteUrl, remoteIdentity } from "../src/services/projects/discovery.ts";
import { forgetProject, readProjectIndex, refreshProjectIndex, registerProject, updateProjectIndex } from "../src/services/projects/index-store.ts";
import { parseCheckoutStatus, projectHistory, readCloneStatus, readProjectStatuses } from "../src/services/projects/status.ts";
import { fixtureRoot } from "./cli-fixture.ts";
import { commandExists, run } from "../src/utils/exec.ts";
import { quoteShellArgument } from "../src/utils/command-args.ts";

let root: string;
let repos: string;
let configDir: string;
let previousXdg: string | undefined;
const git = async (cwd: string, ...args: string[]) => (await run("git", args, { cwd, env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" } })).stdout.trim();
async function repo(name: string, commit = true): Promise<string> {
  const path = join(repos, name);
  mkdirSync(path, { recursive: true });
  await git(path, "init", "-b", "main");
  await git(path, "config", "user.name", "Fixture");
  await git(path, "config", "user.email", "fixture@example.invalid");
  if (commit) await git(path, "commit", "--allow-empty", "-m", "initial");
  return path;
}
function config() { return { ...DEFAULT_CONFIG, project_roots: [repos], host_worktree_dirs: {} }; }

beforeEach(() => {
  root = fixtureRoot("ggh-projects-"); repos = join(root, "repos"); configDir = join(root, "config"); mkdirSync(repos);
  previousXdg = process.env.XDG_CONFIG_HOME; process.env.XDG_CONFIG_HOME = join(root, "xdg");
});
afterEach(() => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previousXdg;
  rmSync(root, { recursive: true, force: true });
});

describe("project configuration", () => {
  it("validates roots, excludes, depth, host directories, and open target", () => {
    expect(DEFAULT_CONFIG.project_roots).toEqual([]);
    expect(DEFAULT_CONFIG.project_scan_depth).toBe(4);
    expect(DEFAULT_CONFIG.host_worktree_dirs).toEqual({ t3: "~/.t3/worktrees", codex: "~/.codex/worktrees", cursor: "~/.cursor/worktrees" });
    for (const value of [[repos, "~/Downloads"], JSON.stringify([repos])]) expect(validateConfigValue("project_roots", value).problem).toBeUndefined();
    for (const value of ["relative", ["relative"], [1], ["~someone/repos"], ["/path\0bad"]]) expect(validateConfigValue("project_roots", value).problem).toBeDefined();
    expect(validateConfigValue("project_exclude", '["**/old/**"]' ).value).toEqual(["**/old/**"]);
    for (const value of [-1, 9, 1.5, "4junk"]) expect(validateConfigValue("project_scan_depth", value).problem).toBeDefined();
    expect(validateConfigValue("project_scan_depth", "8").value).toBe(8);
    expect(validateConfigValue("host_worktree_dirs", { codex: "~/worktrees" }).problem).toBeUndefined();
    expect(validateConfigValue("host_worktree_dirs", { other: repos }).problem).toBeDefined();
    expect(validateConfigValue("host_worktree_dirs", { t3: "relative" }).problem).toBeDefined();
    expect(validateConfigValue("go_default", "editor").value).toBe("editor");
    expect(validateConfigValue("go_default", "other").problem).toBeDefined();
    saveConfig({ project_roots: [repos], host_worktree_dirs: { codex: repos }, go_default: "t3" });
    expect(getConfig().project_roots).toEqual([repos]);
    expect(getConfig().host_worktree_dirs).toEqual({ codex: repos });
  });
  it("does not let repository config change discovery consent", async () => {
    const path = await repo("untrusted");
    writeFileSync(join(path, ".ggh.json"), JSON.stringify({ project_roots: ["/"], host_worktree_dirs: { t3: "/" }, go_default: "editor" }));
    expect(getConfig(path).project_roots).toEqual([]);
    expect(getConfig(path).go_default).toBe("cd");
  });
});

describe("project discovery", () => {
  it("keeps clones separate even when they share a remote or basename", async () => {
    const a = await repo("a/same"); const b = await repo("b/same");
    for (const path of [a, b]) await git(path, "remote", "add", "origin", "https://github.com/owner/same.git");
    const result = await discoverProjects({ config: config() });
    expect(result.clones).toHaveLength(2);
    expect(new Set(result.clones.map(clone => clone.commonDir)).size).toBe(2);
    expect(result.clones.map(clone => clone.primary)).toEqual([{ host: "github.com", owner: "owner", name: "same" }, { host: "github.com", owner: "owner", name: "same" }]);
  });
  it("stops at repositories and skips dependencies, but honors explicit nested registration", async () => {
    await repo("outer"); const nested = await repo("outer/nested"); await repo("node_modules/hidden"); await repo("vendor/hidden");
    expect((await discoverProjects({ config: config() })).clones).toHaveLength(1);
    expect((await discoverProjects({ config: config(), registered: [nested] })).clones).toHaveLength(2);
  });
  it("finds bare and unborn repositories and reports broken checkout coverage", async () => {
    await repo("unborn", false);
    const bare = join(repos, "bare.git"); await git(repos, "init", "--bare", bare);
    const broken = join(repos, "broken"); mkdirSync(broken); writeFileSync(join(broken, ".git"), "gitdir: /no/such/gitdir\n");
    const result = await discoverProjects({ config: config() });
    expect(result.clones).toHaveLength(2);
    expect(result.clones.some(clone => clone.checkouts.some(checkout => checkout.bare))).toBe(true);
    expect(result.clones.find(clone => clone.displayName === "unborn")?.checkouts[0]?.head).toBeNull();
    expect(result.coverage.skipped).toContainEqual({ path: broken, reason: "Broken checkout: cannot resolve Git common directory" });
  });
  it("unions authoritative outside worktrees, locks, detached heads and host provenance", async () => {
    const main = await repo("main");
    const t3 = join(root, ".t3", "worktrees"); const outside = join(t3, "Project", "one"); mkdirSync(join(t3, "Project"), { recursive: true });
    await git(main, "worktree", "add", "--detach", outside);
    await git(main, "worktree", "lock", "--reason", "owner active", outside);
    const claude = join(main, ".claude", "worktrees", "two");
    await git(main, "worktree", "add", "-b", "claude", claude);
    const result = await discoverProjects({ config: { ...config(), host_worktree_dirs: { t3 } } });
    expect(result.clones).toHaveLength(1);
    const trees = result.clones[0]?.checkouts ?? [];
    expect(trees).toHaveLength(3);
    expect(trees.find(tree => tree.path === outside)).toMatchObject({ branch: null, createdBy: "t3", locked: { reason: "owner active" } });
    expect(trees.find(tree => tree.path === claude)?.createdBy).toBe("claude");
    expect(trees.find(tree => tree.path === outside)?.gitDir).toBe(realpathSync(join(main, ".git", "worktrees", "one")));
  });
  it("keeps a prunable checkout's own Git directory after its path disappears", async () => {
    const main = await repo("main"); const missing = join(root, "missing");
    await git(main, "worktree", "add", "--detach", missing); rmSync(missing, { recursive: true });
    const result = await discoverProjects({ config: config() });
    const checkout = result.clones[0]?.checkouts.find(checkout => checkout.path === missing);
    expect(checkout?.prunable).not.toBeNull(); expect(checkout?.gitDir).toBe(join(main, ".git", "worktrees", "missing"));
  });
  it("finds host-only clones and unregistered in-repo host checkouts", async () => {
    const main = await repo("main");
    const independent = await repo("main/.cursor/worktrees-old/independent");
    const hostRepo = await repo("host-project/n");
    const result = await discoverProjects({ config: { ...config(), project_roots: [main], host_worktree_dirs: { codex: join(repos, "host-project") } } });
    expect(result.clones).toHaveLength(3);
    expect(result.clones.find(clone => clone.checkouts[0]?.path === independent)?.checkouts[0]?.createdBy).toBe("cursor");
    expect(result.clones.find(clone => clone.checkouts[0]?.path === hostRepo)?.checkouts[0]?.createdBy).toBe("codex");
  });
  it("uses local ggh markers after host prefixes", async () => {
    const path = await repo("created"); await git(path, "config", "ggh.created", "true");
    expect((await discoverProjects({ config: config() })).clones[0]?.checkouts[0]?.createdBy).toBe("ggh");
    expect(checkoutCreator(path, { host_worktree_dirs: { t3: repos } }, true)).toBe("t3");
  });
  it("skips initialized submodules unless explicitly registered", async () => {
    const source = await repo("source"); const main = await repo("parent");
    await git(main, "-c", "protocol.file.allow=always", "submodule", "add", source, "module");
    const nested = join(main, "module");
    expect((await discoverProjects({ config: { ...config(), project_roots: [nested] } })).clones).toHaveLength(0);
    expect((await discoverProjects({ config: config(), registered: [nested] })).clones).toHaveLength(3);
  });
  it("bounds depth, excludes paths and reports inaccessible coverage", async () => {
    const kept = await repo("a"); await repo("deep/one/two/hidden"); await repo("excluded");
    const result = await discoverProjects({ config: { ...config(), project_scan_depth: 1, project_exclude: ["excluded"] } });
    expect(result.clones.map(clone => clone.checkouts[0]?.path)).toEqual([kept]);
    expect(result.coverage.truncated).toBe(true);
    const unreadable = join(repos, "unreadable"); mkdirSync(unreadable); chmodSync(unreadable, 0);
    try { if (process.platform !== "win32" && process.getuid?.() !== 0) expect((await discoverProjects({ config: config() })).coverage.skipped.some(item => item.path === unreadable)).toBe(true); }
    finally { chmodSync(unreadable, 0o700); }
  });
  it("scans overlapping explicit roots independently at their depth limits", async () => {
    const path = await repo("one/two/three");
    const result = await discoverProjects({ config: { ...config(), project_roots: [repos, join(repos, "one")], project_scan_depth: 2 } });
    expect(result.clones[0]?.checkouts[0]?.path).toBe(path);
  });
  it("refuses symlink escapes and detects loops", async () => {
    if (process.platform === "win32") return;
    await repo("kept"); const outside = join(root, "outside"); mkdirSync(outside);
    symlinkSync(repos, join(repos, "loop")); symlinkSync(outside, join(repos, "escape"));
    const result = await discoverProjects({ config: config() });
    expect(result.clones).toHaveLength(1);
    expect(result.coverage.skipped.some(item => item.reason.includes("loop"))).toBe(true);
    expect(result.coverage.skipped.some(item => item.reason.includes("leaves"))).toBe(true);
  });
  it("redacts credentials before persistence while retaining remote identity", async () => {
    const path = await repo("credentialed");
    const url = "https://user:password@example.org/owner/project.git?token=private";
    await git(path, "remote", "add", "origin", url);
    const result = await discoverProjects({ config: config() });
    expect(JSON.stringify(result)).not.toContain("password"); expect(JSON.stringify(result)).not.toContain("token=private");
    expect(result.clones[0]?.primary).toEqual({ host: "example.org", owner: "owner", name: "project" });
    expect(redactRemoteUrl("user:password@example.org:owner/project.git")).toBe("example.org:owner/project.git");
    expect(remoteIdentity("git@github.com:owner/repo.git")).toEqual({ host: "github.com", owner: "owner", name: "repo" });
    expect(remoteIdentity("ssh://git@example.org:2222/owner/repo.git")?.host).toBe("example.org");
    expect(redactRemoteUrl("https://user:pass@github.com/o/r.git")).toBe("https://github.com/o/r.git");
  });
});

describe("project index", () => {
  it("writes privately and preserves registrations/exclusions through concurrent refreshes", async () => {
    const path = await repo("main"); const nested = await repo("main/nested"); const excluded = await repo("excluded");
    await registerProject(nested, configDir); await forgetProject(excluded, configDir);
    await Promise.all([refreshProjectIndex({ configDir, config: config() }), refreshProjectIndex({ configDir, config: config() })]);
    const index = readProjectIndex(configDir);
    expect(index.registered).toEqual([nested]); expect(index.excluded).toEqual([excluded]); expect(index.clones).toHaveLength(2);
    expect(index.clones.some(clone => clone.checkouts[0]?.path === path)).toBe(true);
    if (process.platform !== "win32") expect(statSync(join(configDir, "projects.json")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(configDir, "projects.lock"))).toBe(false);
    expect(JSON.parse(readFileSync(join(configDir, "projects.json"), "utf8")).version).toBe(1);
  });
  it("marks a vanished clone missing for one refresh cycle", async () => {
    const path = await repo("gone"); await refreshProjectIndex({ configDir, config: config() }); rmSync(path, { recursive: true });
    expect((await refreshProjectIndex({ configDir, config: config() })).clones[0]?.missing).toBe(true);
    expect((await refreshProjectIndex({ configDir, config: config() })).clones).toHaveLength(0);
  });
  it("forgets only the requested checkout, excludes it on future refresh, and permits registration again", async () => {
    const path = await repo("keep"); const outside = join(root, "outside"); await git(path, "worktree", "add", "-b", "other", outside);
    await refreshProjectIndex({ configDir, config: config() }); await forgetProject(outside, configDir);
    expect((await refreshProjectIndex({ configDir, config: config() })).clones[0]?.checkouts).toHaveLength(1);
    await registerProject(outside, configDir);
    expect((await refreshProjectIndex({ configDir, config: config() })).clones[0]?.checkouts).toHaveLength(2);
  });
  it("rejects corrupt or symlinked index files", async () => {
    await updateProjectIndex(index => index, configDir);
    writeFileSync(join(configDir, "projects.json"), '{"version":1,"clones":[{}]}');
    expect(() => readProjectIndex(configDir)).toThrow("Cannot read");
    if (process.platform !== "win32") {
      rmSync(join(configDir, "projects.json")); symlinkSync(join(root, "target"), join(configDir, "projects.json"));
      writeFileSync(join(root, "target"), "{}");
      expect(() => readProjectIndex(configDir)).toThrow("Cannot read");
    }
  });
});

describe("local project status", () => {
  it("reports dirty counts, drift, stashes, merged branches and unpublished detached commits", async () => {
    const main = await repo("status");
    const base = await git(main, "rev-parse", "HEAD");
    await git(main, "update-ref", "refs/remotes/origin/main", base);
    await git(main, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    await git(main, "remote", "add", "origin", "https://github.com/o/r.git");
    await git(main, "branch", "--set-upstream-to=origin/main", "main");
    await git(main, "branch", "merged");
    writeFileSync(join(main, "stash.txt"), "stash"); await git(main, "add", "."); await git(main, "stash", "push", "-m", "saved work");
    writeFileSync(join(main, "staged.txt"), "staged"); await git(main, "add", "."); writeFileSync(join(main, "untracked.txt"), "untracked");
    const detached = join(root, "detached"); await git(main, "worktree", "add", "--detach", detached); await git(detached, "commit", "--allow-empty", "-m", "detached only");
    const clone = (await discoverProjects({ config: config() })).clones[0]; if (!clone) throw new Error("Missing fixture clone");
    const status = await readCloneStatus(clone);
    expect(status.stashes).toMatchObject({ state: "ok", value: 1 }); expect(status.newestStash).toMatchObject({ state: "ok", value: "On main: saved work" });
    expect(status.mergedBranches).toMatchObject({ state: "ok", value: ["main", "merged"] });
    expect(status.checkouts.find(checkout => checkout.path === main)?.dirty).toMatchObject({ state: "ok", value: { staged: 1, unstaged: 0, untracked: 1, conflicted: 0 } });
    expect(status.checkouts.find(checkout => checkout.path === main)?.upstream).toMatchObject({ state: "ok", value: { name: "origin/main", ahead: 0, behind: 0 } });
    expect(status.unpublished.state).toBe("ok");
    if (status.unpublished.state === "ok") expect(status.unpublished.value.some(ref => ref.ref === clone.checkouts.find(checkout => !checkout.branch)?.head && ref.commits === 1)).toBe(true);
    const history = await projectHistory(clone, status);
    expect(history.unpublished).toMatchObject({ state: "ok", value: [{ subject: "detached only" }] });
    expect(history.recent.state).toBe("ok");
  });
  it("counts local branches against every remote, and treats unknown default separately", async () => {
    const main = await repo("local"); await git(main, "branch", "other");
    const clone = (await discoverProjects({ config: config() })).clones[0]; if (!clone) throw new Error("Missing fixture");
    const status = await readCloneStatus(clone);
    expect(status.unpublished).toMatchObject({ state: "ok", value: [{ ref: "refs/heads/main", commits: 1 }, { ref: "refs/heads/other", commits: 1 }] });
    expect(status.mergedBranches.state).toBe("unknown");
    await git(main, "update-ref", "refs/remotes/elsewhere/main", "HEAD");
    expect((await readCloneStatus(clone)).unpublished).toMatchObject({ state: "ok", value: [{ ref: "refs/heads/main", commits: 0 }, { ref: "refs/heads/other", commits: 0 }] });
  });
  it("keeps timeout fields unknown instead of reporting clean or zero", async () => {
    await repo("slow"); const clones = (await discoverProjects({ config: config() })).clones;
    const statuses = await readProjectStatuses(clones, { deadlineMs: 0 });
    expect(statuses[0]?.stashes.state).toBe("unknown"); expect(statuses[0]?.unpublished.state).toBe("unknown"); expect(statuses[0]?.checkouts[0]?.dirty.state).toBe("unknown");
  });
  it("bounds a slow Git subprocess while preserving other completed fields", async () => {
    if (process.platform === "win32" || !commandExists("sh")) return;
    const path = await repo("slow-stash"); writeFileSync(join(path, "stashed.txt"), "saved"); await git(path, "add", "."); await git(path, "stash", "push", "-m", "slow stash");
    const clone = (await discoverProjects({ config: config() })).clones[0]; if (!clone) throw new Error("Missing fixture");
    const binary = Bun.which("git"); if (!binary) throw new Error("Missing Git");
    const bin = join(root, "bin"); mkdirSync(bin);
    const wrapper = join(bin, "git");
    writeFileSync(wrapper, `#!/bin/sh\ncase "$*" in *"stash list"*) sleep 2;; esac\nexec ${quoteShellArgument(binary)} "$@"\n`); chmodSync(wrapper, 0o700);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath}`;
    try {
      const start = performance.now(); const status = await readCloneStatus(clone, { deadlineMs: 500 });
      expect(status.checkouts[0]?.dirty.state).toBe("ok"); expect(status.unpublished.state).toBe("ok"); expect(status.stashes.state).toBe("unknown"); expect(performance.now() - start).toBeLessThan(1800);
    } finally { process.env.PATH = previousPath; }
  });
  it("does not turn a missing upstream tip into zero drift", () => {
    expect(parseCheckoutStatus("# branch.upstream origin/gone\0").upstream.state).toBe("unknown");
  });
  it("reports unborn HEAD as no commits and bare working-tree fields as unknown", async () => {
    await repo("unborn", false); await git(repos, "init", "--bare", join(repos, "bare"));
    const clones = (await discoverProjects({ config: config() })).clones;
    const statuses = await readProjectStatuses(clones);
    expect(statuses.every(status => status.unpublished.state === "ok" && status.unpublished.value.length === 0)).toBe(true);
    expect(statuses.every(status => status.lastCommit.state === "ok" && status.lastCommit.value === null)).toBe(true);
    expect(statuses.find(status => status.commonDir.endsWith("bare"))?.checkouts[0]?.dirty.state).toBe("unknown");
  });
  it("reads bare clone refs and commit history without a working tree", async () => {
    const main = await repo("source"); const bare = join(repos, "copy.git"); await git(repos, "clone", "--bare", main, bare);
    const clone = (await discoverProjects({ config: config() })).clones.find(clone => clone.commonDir === bare); if (!clone) throw new Error("Missing bare clone");
    const status = await readCloneStatus(clone); expect(status.lastCommit).toMatchObject({ state: "ok", value: { subject: "initial" } });
    expect((await projectHistory(clone, status)).recent).toMatchObject({ state: "ok", value: [{ subject: "initial" }] });
  });
  it("parses renames with hostile source names, conflicts and submodule dirtiness", () => {
    const value = parseCheckoutStatus(["# branch.head main", "? x", "u UU other", "2 R. meta target", "? not-an-untracked-file", "1 .M S.M. meta module", ""].join("\0"));
    expect(value.dirty).toMatchObject({ state: "ok", value: { staged: 1, unstaged: 1, untracked: 1, conflicted: 1 } });
    expect(projectPath(repos)).toBe(repos);
  });
});

it("matches batched unpublished counts to per-tip Git walks across merges and detached worktrees", async () => {
  const main = await repo("graph");
  const base = await git(main, "rev-parse", "HEAD");
  await git(main, "update-ref", "refs/remotes/origin/main", base);
  await git(main, "checkout", "-b", "left");
  await git(main, "commit", "--allow-empty", "-m", "left");
  await git(main, "checkout", "-b", "right", base);
  await git(main, "commit", "--allow-empty", "-m", "right");
  await git(main, "merge", "--no-ff", "left", "-m", "merge");
  await git(main, "branch", "no-upstream");
  const detached = join(root, "graph-detached");
  await git(main, "worktree", "add", "--detach", detached);
  await git(detached, "commit", "--allow-empty", "-m", "detached");
  const clone = (await discoverProjects({ config: config() })).clones[0];
  if (!clone) throw new Error("Missing fixture");
  const status = await readCloneStatus(clone);
  if (status.unpublished.state !== "ok") throw new Error(JSON.stringify(status.unpublished));
  expect(status.unpublished.value).toHaveLength(5);
  for (const ref of status.unpublished.value) expect(ref.commits).toBe(Number(await git(main, "rev-list", "--count", ref.ref, "--not", "--remotes")));
  await git(main, "update-ref", "refs/remotes/other/right", "right");
  const refreshed = await readCloneStatus(clone);
  if (refreshed.unpublished.state !== "ok") throw new Error("Missing refreshed counts");
  for (const ref of refreshed.unpublished.value) expect(ref.commits).toBe(Number(await git(main, "rev-list", "--count", ref.ref, "--not", "--remotes")));
});

it("starts each queued checkout deadline when its own status work starts", async () => {
  if (process.platform === "win32" || !commandExists("sh")) return;
  const main = await repo("queued");
  for (let i = 0; i < 2; i++) await git(main, "worktree", "add", "-b", `linked-${i}`, join(root, `linked-${i}`));
  const clone = (await discoverProjects({ config: config() })).clones[0];
  if (!clone) throw new Error("Missing fixture");
  const binary = Bun.which("git"); if (!binary) throw new Error("Missing Git");
  const bin = join(root, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!/bin/sh\ncase "$*" in *"status --porcelain"*) sleep 0.2;; esac\nexec ${quoteShellArgument(binary)} "$@"\n`); chmodSync(join(bin, "git"), 0o700);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  try {
    const start = performance.now();
    const status = await readCloneStatus(clone, { deadlineMs: 500, workers: 1 });
    expect(performance.now() - start).toBeGreaterThan(500);
    expect(status.checkouts).toHaveLength(3);
    expect(status.checkouts.every(checkout => checkout.dirty.state === "ok")).toBe(true);
  } finally { process.env.PATH = previous; }
});

it("reads shared refs and stashes once for a clone with several linked checkouts", async () => {
  if (process.platform === "win32" || !commandExists("sh")) return;
  const main = await repo("shared");
  for (let i = 0; i < 3; i++) await git(main, "worktree", "add", "-b", `shared-${i}`, join(root, `shared-${i}`));
  writeFileSync(join(main, "saved.txt"), "stash"); await git(main, "add", "."); await git(main, "stash", "push", "-m", "saved");
  const clone = (await discoverProjects({ config: config() })).clones[0];
  if (!clone) throw new Error("Missing fixture");
  const binary = Bun.which("git"); if (!binary) throw new Error("Missing Git");
  const bin = join(root, "bin"); mkdirSync(bin); const trace = join(root, "git-calls");
  writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quoteShellArgument(trace)}\nexec ${quoteShellArgument(binary)} "$@"\n`); chmodSync(join(bin, "git"), 0o700);
  const previous = process.env.PATH; process.env.PATH = `${bin}:${previous}`;
  try {
    const status = await readCloneStatus(clone);
    expect(status.stashes).toMatchObject({ state: "ok", value: 1 });
    expect(status.checkouts).toHaveLength(4);
    const calls = readFileSync(trace, "utf8").trim().split("\n");
    expect(calls.filter(line => line.includes(" for-each-ref "))).toHaveLength(1);
    expect(calls.filter(line => line.includes(" rev-list "))).toHaveLength(1);
    expect(calls.filter(line => line.includes(" stash list "))).toHaveLength(1);
    expect(calls.filter(line => line.includes(" status "))).toHaveLength(4);
  } finally { process.env.PATH = previous; }
});

it("resolves the main checkout when only an external linked worktree is scanned", async () => {
  const main = await repo("outside-main");
  const host = join(root, "host");
  const linked = join(host, "Project", "task");
  await git(main, "worktree", "add", "-b", "task", linked);
  const result = await discoverProjects({ config: { ...config(), project_roots: [], host_worktree_dirs: { t3: host } } });
  expect(result.clones).toHaveLength(1);
  expect(result.clones[0]?.checkouts[0]).toMatchObject({ path: main, gitDir: join(main, ".git"), bare: false, branch: "main" });
  expect(result.clones[0]?.checkouts.map(checkout => checkout.path)).not.toContain(join(main, ".git"));
});

it("normalizes a .git main-worktree path without changing bare or separate git directories", () => {
  const main = join(root, "main");
  expect(mainWorktreePath(join(main, ".git"), { path: join(main, ".git"), isBare: false })).toBe(main);
  expect(mainWorktreePath(join(main, ".git"), { path: join(main, ".git"), isBare: true })).toBe(join(main, ".git"));
  expect(mainWorktreePath(join(root, "metadata"), { path: main, isBare: false })).toBe(main);
  expect(mainWorktreePath(join(root, "metadata", ".git"), { path: main, isBare: false })).toBe(main);
});
