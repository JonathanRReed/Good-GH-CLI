import { afterEach, beforeEach, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/services/config.ts";
import { checkoutForReview, worktreeAdd } from "../src/services/git/worktree.ts";
import { discoverProjects } from "../src/services/projects/discovery.ts";
import { checkoutHost } from "../src/services/projects/hosts.ts";
import { findLost } from "../src/services/projects/lost.ts";
import { syncProjects } from "../src/services/projects/sync.ts";
import { buildTidyPlan } from "../src/services/projects/tidy-plan.ts";
import { executeTidyPlan } from "../src/services/projects/tidy-execute.ts";
import { formatProjectCard, formatProjects } from "../src/services/projects/view.ts";
import { readCloneStatus } from "../src/services/projects/status.ts";
import { run } from "../src/utils/exec.ts";
import { fixtureRoot, runFixture } from "./cli-fixture.ts";

let root: string;
let repo: string;
const config = () => ({ ...DEFAULT_CONFIG, project_roots: [repo], host_worktree_dirs: { t3: join(root, "home/.t3/worktrees") } });
const git = async (cwd: string, ...args: string[]) => (await run("git", args, { cwd, env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" } })).stdout.trim();
const inventory = async () => {
  const clone = (await discoverProjects({ config: config() })).clones[0];
  if (!clone) throw new Error("Missing fixture clone");
  return clone;
};
beforeEach(async () => {
  root = fixtureRoot("ggh-provenance-"); repo = join(root, "repo"); mkdirSync(repo);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Fixture"); await git(repo, "config", "user.email", "fixture@example.invalid");
  await git(repo, "config", "ggh.created", "true"); await git(repo, "commit", "--allow-empty", "-m", "published");
  const remote = join(root, "remote.git"); await git(repo, "init", "--bare", "-b", "main", remote);
  await git(repo, "remote", "add", "origin", remote); await git(repo, "push", "-u", "origin", "main"); await git(repo, "remote", "set-head", "origin", "main");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it("keeps Codex and Claude checkouts of a ggh clone host-manual, including explicit unknown approval", async () => {
  const codex = join(root, "home/.codex/worktrees/repo/thread");
  const claude = join(root, "home/.claude/worktrees/repo/control");
  for (const path of [codex, claude]) await git(repo, "worktree", "add", "--detach", path, "HEAD");
  const clone = await inventory();
  for (const [path, host] of [[codex, "codex"], [claude, "claude"]]) expect(clone.checkouts.find(checkout => checkout.path === path)).toMatchObject({ createdBy: host, hostClaims: [{ host }] });
  for (const options of [{}, { allowUnknown: [codex, claude] }]) {
    const plan = await buildTidyPlan([clone], options, config());
    expect(plan.clones[0]?.actions).toEqual([]);
    expect(plan.clones[0]?.hostManual).toEqual(expect.arrayContaining([expect.objectContaining({ target: codex, host: "codex" }), expect.objectContaining({ target: claude, host: "claude" })]));
    expect(await executeTidyPlan(plan, [clone], { approvedSnapshot: plan.snapshotId, config: config() })).toEqual([]);
    expect(existsSync(codex)).toBe(true); expect(existsSync(claude)).toBe(true);
  }
  const sync = await syncProjects([clone], { config: config(), dryRun: true });
  for (const path of [codex, claude]) expect(sync.clones[0]?.checkouts.find(row => row.path === path)).toMatchObject({ outcome: "skipped", reason: "host-owned" });
});

it("uses the same ownership for global Cursor, in-repo Claude, built-in T3 and custom host paths", async () => {
  const paths = [join(root, "home/.cursor/worktrees/repo/thread"), join(repo, ".claude/worktrees/thread"), join(root, "other/.t3/worktrees/thread"), join(root, "custom-host/thread")];
  for (const path of paths) await git(repo, "worktree", "add", "--detach", path, "HEAD");
  const cfg = { ...config(), host_worktree_dirs: { codex: join(root, "custom-host") } };
  const clones = (await discoverProjects({ config: cfg })).clones;
  const plan = await buildTidyPlan(clones, { allowUnknown: paths }, cfg);
  expect(plan.clones[0]?.hostManual.map(row => row.host)).toEqual(expect.arrayContaining(["cursor", "claude", "t3", "codex"]));
  expect(plan.clones[0]?.actions).toEqual([]);
  const sync = await syncProjects(clones, { config: cfg, dryRun: true });
  for (const path of paths) expect(sync.clones[0]?.checkouts.find(row => row.path === path)).toMatchObject({ outcome: "skipped", reason: "host-owned" });
});

it("requires exact unknown approval for raw Git worktrees without inheriting the clone marker", async () => {
  const foreign = join(root, "foreign"); const other = join(root, "other");
  // Even the new main-checkout marker must not authorize linked checkouts.
  writeFileSync(join(repo, ".git/ggh-created"), "ggh\n");
  for (const path of [foreign, other]) await git(repo, "worktree", "add", "--detach", path, "HEAD");
  const clone = await inventory();
  expect(clone.checkouts.find(checkout => checkout.path === repo)?.createdBy).toBe("ggh");
  for (const path of [foreign, other]) expect(clone.checkouts.find(checkout => checkout.path === path)?.createdBy).toBe("unknown");
  const guarded = await buildTidyPlan([clone], {}, config());
  expect(guarded.clones[0]?.actions).toEqual([]);
  expect(guarded.clones[0]?.kept).toContainEqual({ target: foreign, reason: expect.stringContaining("--allow-unknown") });
  const approved = await buildTidyPlan([clone], { allowUnknown: [foreign] }, config());
  expect(approved.clones[0]?.actions).toMatchObject([{ kind: "remove-checkout", checkout: { path: foreign } }]);
  expect(await executeTidyPlan(approved, [clone], { approvedSnapshot: approved.snapshotId, config: config() })).toMatchObject([{ state: "completed" }]);
  expect(existsSync(foreign)).toBe(false); expect(existsSync(other)).toBe(true);
});

it("records ggh worktree add provenance in the private gitdir without worktree config", async () => {
  const result = await runFixture(["worktree", "add", "owned", "--agent"], { root, cwd: repo });
  expect(result.exitCode, result.stderr).toBe(0);
  const path = join(repo, ".worktrees/owned");
  const checkout = (await inventory()).checkouts.find(checkout => checkout.path === path);
  expect(checkout?.createdBy).toBe("ggh");
  if (!checkout) throw new Error("Missing ggh checkout");
  expect(checkout.gitDir).not.toBe(join(repo, ".git"));
  expect(readFileSync(join(checkout.gitDir, "ggh-created"), "utf8")).toBe("ggh\n");
  expect(await git(repo, "config", "--get-regexp", "extensions.*").catch(() => "")).toBe("");
  expect((await buildTidyPlan([await inventory()], {}, config())).clones[0]?.actions).toMatchObject([{ kind: "remove-checkout", checkout: { path } }]);
});

it("marks newly created review checkouts but never adopts a reused foreign checkout", async () => {
  await git(repo, "config", "--unset", "ggh.created");
  const detached = join(root, "review"); const attached = join(root, "attached"); const foreign = join(root, "foreign-review");
  await checkoutForReview("HEAD", detached, { cwd: repo, detached: true });
  await checkoutForReview("review-branch", attached, { cwd: repo, baseBranch: "main" });
  await git(repo, "worktree", "add", "--detach", foreign, "HEAD");
  await checkoutForReview("HEAD", foreign, { cwd: repo, detached: true, reuse: true });
  const clone = await inventory();
  for (const path of [detached, attached]) expect(clone.checkouts.find(checkout => checkout.path === path)?.createdBy).toBe("ggh");
  expect(clone.checkouts.find(checkout => checkout.path === foreign)?.createdBy).toBe("unknown");
});

it("refuses an approved removal if its per-checkout creation evidence disappears", async () => {
  const path = join(root, "review-race");
  await checkoutForReview("HEAD", path, { cwd: repo, detached: true });
  const clone = await inventory();
  const checkout = clone.checkouts.find(checkout => checkout.path === path);
  if (!checkout) throw new Error("Missing review checkout");
  const plan = await buildTidyPlan([clone], {}, config());
  expect(plan.clones[0]?.actions).toMatchObject([{ kind: "remove-checkout", checkout: { path } }]);
  rmSync(join(checkout.gitDir, "ggh-created"));
  expect(await executeTidyPlan(plan, [clone], { approvedSnapshot: plan.snapshotId, config: config() })).toMatchObject([{ state: "refused" }]);
  expect(existsSync(path)).toBe(true);
});

it("keeps host ownership ahead of ggh markers and uses it in lost and projects views", async () => {
  const path = join(root, "home/.codex/worktrees/repo/owned");
  await worktreeAdd("hosted", path, "main", repo);
  const clone = await inventory();
  expect(clone.checkouts.find(checkout => checkout.path === path)?.createdBy).toBe("codex");
  writeFileSync(join(path, "work.txt"), "unfinished");
  expect((await findLost([clone], config())).items).toContainEqual(expect.objectContaining({ kind: "dirty-host-checkout", path, host: "codex", createdBy: "codex" }));
  // Old cached provenance must still display the host location.
  const cached = { ...clone, checkouts: clone.checkouts.map(checkout => checkout.path === path ? { ...checkout, createdBy: "ggh" as const, hostClaims: [] } : checkout) };
  const status = await readCloneStatus(clone);
  expect(formatProjects([{ clone: cached, status }], { wide: true }).join("\n")).toContain("1 codex");
  expect(formatProjectCard({ clone: cached, status }, undefined, false, { wide: true }).join("\n")).toContain("codex");
});

it("matches directory boundaries, preserves Cursor legacy paths and resolves symlink aliases", async () => {
  expect(DEFAULT_CONFIG.host_worktree_dirs).toMatchObject({ codex: "~/.codex/worktrees", cursor: "~/.cursor/worktrees" });
  expect(checkoutHost(join(root, ".codex/worktrees-old/session"), {})).toBeNull();
  expect(checkoutHost(join(root, ".cursor/worktrees-old/session"), {})).toBe("cursor");
  expect(checkoutHost(join(root, "custom-hostile/session"), { host_worktree_dirs: { claude: join(root, "custom-host") } })).toBeNull();
  if (process.platform === "win32") return;
  const path = join(root, "home/.codex/worktrees/repo/alias"); await git(repo, "worktree", "add", "--detach", path, "HEAD");
  const alias = join(root, "alias"); symlinkSync(path, alias);
  expect(checkoutHost(alias, {})).toBe("codex");
});
