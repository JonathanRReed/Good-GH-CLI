import { afterAll, beforeAll, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as worktrees from "../src/services/git/worktree.ts";
import { run } from "../src/utils/exec.ts";
import { fixtureRoot, runFixture } from "./cli-fixture.ts";

const root = fixtureRoot("ggh-p0-");
const repo = join(root, "repo");
const sha = "a".repeat(40);
const detail = { number: 42, title: "Fix", headRefName: "feature", headRefOid: sha, baseRefName: "main", state: "OPEN", url: "https://github.com/fixture/repo/pull/42" };
const git = (args: string[], cwd = repo) => run("git", args, { cwd });
beforeAll(async () => {
  await run("git", ["init", "-b", "main", repo], { cwd: root });
  await git(["config", "core.autocrlf", "false"]);
  await git(["config", "user.name", "Fixture"]);
  await git(["config", "user.email", "fixture@example.com"]);
  writeFileSync(join(repo, "tracked"), "base\n");
  writeFileSync(join(repo, ".gitignore"), ".env*\n.worktrees/\n");
  await git(["add", "."]);
  await git(["commit", "-m", "base"]);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

it("pins the preflight head and reports queued without deleting branches", async () => {
  const result = await runFixture(["pr", "merge", "42", "--squash", "--yes", "--json", "-R", "fixture/repo"], { root, cwd: repo, responses: [
    { prefix: ["pr", "view", "42", "--json", "state,mergedAt,autoMergeRequest,mergeStateStatus"], stdout: JSON.stringify({state:"OPEN",mergedAt:null,autoMergeRequest:null,mergeStateStatus:"BLOCKED"}) },
    { prefix: ["api", "graphql"], stdout: JSON.stringify({data:{repository:{pullRequest:{mergeQueueEntry:{id:"queue-1"}}}}}) },
    { prefix: ["pr", "view", "42"], stdout: JSON.stringify(detail) },
    { prefix: ["pr", "merge", "42"], stdout: "Added to merge queue" },
  ] });
  expect(result.exitCode).toBe(0);
  expect(result.calls.find(call => call[0] === "pr" && call[1] === "merge")).toContain("--match-head-commit");
  expect(result.calls.find(call => call[0] === "pr" && call[1] === "merge")).toContain(sha);
  expect(result.calls.some(call => call.includes("--delete-branch"))).toBe(false);
  expect(JSON.parse(result.stdout).outcome).toBe("queued");
});

it("accepts an explicit reviewed head and explains a moved-head rejection", async () => {
  const expected = "b".repeat(40);
  const result = await runFixture(["pr", "merge", "42", "--squash", "--yes", "--json", "--match-head-commit", expected], { root, cwd: repo, responses: [
    { prefix: ["pr", "view", "42"], stdout: JSON.stringify(detail) },
    { prefix: ["pr", "merge", "42"], stderr: "Head commit of pull request #42 does not match", exitCode: 1 },
  ] });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("head changed since review");
  expect(result.calls.find(call => call[1] === "merge")).toContain(expected);
});

for (const [state, outcome] of [
  [{state:"MERGED",mergedAt:"2026-10-22T12:00:00Z",autoMergeRequest:null}, "merged"],
  [{state:"OPEN",mergedAt:null,autoMergeRequest:{enabledAt:"now"}}, "auto_merge_enabled"],
  [{state:"OPEN",mergedAt:null,autoMergeRequest:null}, "unknown"],
] as const) {
  it(`reports ${outcome} from the state after the merge call`, async () => {
    const result = await runFixture(["pr", "merge", "42", "--squash", "--yes", "--json", "--no-delete-branch", "-R", "fixture/repo"], { root, cwd: repo, responses: [
      {prefix:["pr","view","42","--json","state,mergedAt,autoMergeRequest,mergeStateStatus"],stdout:JSON.stringify(state)},
      {prefix:["api","graphql"],stdout:JSON.stringify({data:{repository:{pullRequest:{mergeQueueEntry:null}}}})},
      {prefix:["pr","view","42"],stdout:JSON.stringify(detail)},
      {prefix:["pr","merge","42"]},
    ] });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).outcome).toBe(outcome);
  });
}

it("copies env files only with explicit opt-in", async () => {
  writeFileSync(join(repo, ".env"), "PRIVATE=fixture\n");
  const target = join(root, "no-env");
  await worktrees.worktreeAdd("no-env", target, "main", repo);
  expect(existsSync(join(target, ".env"))).toBe(false);
  const copied = join(root, "copy-env");
  await worktrees.worktreeAdd("copy-env", copied, "main", repo, {copyEnv:true});
  expect(readFileSync(join(copied, ".env"), "utf8")).toBe("PRIVATE=fixture\n");
});

it("creates review checkouts without env copies, submodules, or shared branch metadata", async () => {
  const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
  writeFileSync(join(repo, ".gitmodules"), `[submodule "trap"]\n path = trap\n url = ${repo.replaceAll("\\", "/")}\n`);
  await git(["config", "protocol.file.allow", "always"]);
  await git(["update-index", "--add", "--cacheinfo", `160000,${head},trap`]);
  await git(["add", ".gitmodules"]);
  await git(["commit", "-m", "submodule fixture"]);
  const configBefore = readFileSync(join(repo, ".git", "config"), "utf8");
  const excludeBefore = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
  const target = join(root, "review");
  await worktrees.checkoutForReview("review", target, {cwd:repo});
  expect(existsSync(join(target, ".env"))).toBe(false);
  expect(existsSync(join(target, "trap", ".git"))).toBe(false);
  expect(readFileSync(join(repo, ".git", "config"), "utf8")).toBe(configBefore);
  expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf8")).toBe(excludeBefore);
});

it.skipIf(process.platform === "win32")("preserves unusual paths, detached state, locks, and prune reasons", async () => {
  const target = join(root, ' trailing \n"\\ ');
  await git(["worktree", "add", "--detach", target]);
  await git(["worktree", "lock", "--reason", "review\nin progress", target]);
  const listed = await worktrees.worktreeList(repo);
  expect(listed.find(w => w.path === target)).toMatchObject({path:target,branch:null,detached:true,isBare:false,locked:true,lockReason:"review\nin progress",prunable:false});
  await git(["worktree", "unlock", target]);
  rmSync(target, {recursive:true,force:true});
  expect((await worktrees.worktreeList(repo)).find(w => w.path === target)).toMatchObject({prunable:true,pruneReason:expect.any(String)});
});

it("rechecks dirty, locked, current, and main worktrees before removal", async () => {
  const target = join(root, "remove");
  await git(["worktree", "add", "-b", "remove", target]);
  await git(["worktree", "lock", "--reason", "owner active", target]);
  await expect(worktrees.worktreeRemove(target, false, repo)).rejects.toThrow("locked");
  await git(["worktree", "unlock", target]);
  writeFileSync(join(target, "untracked"), "keep\n");
  await expect(worktrees.worktreeRemove(target, false, repo)).rejects.toThrow("uncommitted or untracked");
  rmSync(join(target, "untracked"));
  await expect(worktrees.worktreeRemove(target, false, target)).rejects.toThrow("current");
  await expect(worktrees.worktreeRemove(repo, false, target)).rejects.toThrow("main");
  await git(["worktree", "lock", target]);
  await worktrees.worktreeRemove(target, true, repo);
  expect(existsSync(target)).toBe(false);
});

it("supports an allowlisted child environment without ambient or caller secrets", async () => {
  process.env.GGH_P0_SECRET = "ambient";
  process.env.GGH_P0_ALLOWED = "allowed";
  try {
    const result = await run(process.execPath, ["--no-env-file", "-e", "console.log(JSON.stringify({secret:process.env.GGH_P0_SECRET,allowed:process.env.GGH_P0_ALLOWED,override:process.env.GGH_P0_OVERRIDE,denied:process.env.GGH_P0_DENIED,path:process.env.PATH,home:process.env.HOME}))"], {envAllowlist:["GGH_P0_ALLOWED","GGH_P0_OVERRIDE"],env:{GGH_P0_OVERRIDE:"override",GGH_P0_DENIED:"denied"}});
    expect(JSON.parse(result.stdout)).toEqual({allowed:"allowed",override:"override",path:process.env.PATH,home:process.env.HOME});
  } finally { delete process.env.GGH_P0_SECRET; delete process.env.GGH_P0_ALLOWED; }
});

it("keeps machine status local by default and returns upstream and operation state", async () => {
  for (const flag of ["--json", "--agent"]) {
    const result = await runFixture(["status", flag], {root,cwd:repo});
    expect(result.exitCode).toBe(0);
    expect(result.calls).toEqual([]);
    expect(result.providerCalls).toEqual([]);
    const parsed = JSON.parse(result.stdout);
    if (flag === "--agent") expect(parsed.result).toMatchObject({branch:"main",head:expect.any(String)});
    else expect(parsed.repository).toMatchObject({branch:"main",upstream:null,detached:false,operation:null,conflicts:0});
    if (flag === "--agent") expect(result.stdout.trim().split("\n")).toHaveLength(1);
  }
});

it("returns failed logs, one jobs array, and compact agent output", async () => {
  const job = {name:"test",status:"completed",conclusion:"failure",steps:[{name:"assert",number:1,status:"completed",conclusion:"failure"}]};
  for (const flag of ["--json", "--agent"]) {
    const result = await runFixture(["run", "42", flag], {root,cwd:repo,responses:[
      {prefix:["run","view","42","--log-failed"],stdout:"assertion failed\n"},
      {prefix:["run","view","42"],stdout:JSON.stringify({databaseId:42,status:"completed",conclusion:"failure",jobs:[job]})},
    ]});
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    const payload = flag === "--agent" ? parsed.result : parsed;
    expect(payload.run.jobs).toBeUndefined();
    expect(payload.jobs).toEqual([job]);
    expect(payload.log).toBe("assertion failed\n");
    expect(payload.logStatus).toBe("available");
    if (flag === "--agent") expect(result.stdout.trim().split("\n")).toHaveLength(1);
  }
});

it("cleans up only after a confirmed merge, including immediate --auto merges", async () => {
  const result = await runFixture(["pr", "merge", "42", "--squash", "--auto", "--yes", "--json"], {root,cwd:repo,responses:[
    {prefix:["pr","view","42","--json","state,mergedAt,autoMergeRequest,mergeStateStatus"],stdout:JSON.stringify({state:"MERGED",mergedAt:"now"})},
    {prefix:["pr","view","42"],stdout:JSON.stringify(detail)},
    {prefix:["pr","merge","42"]},
  ]});
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).outcome).toBe("merged");
  const calls = result.calls;
  const merges = calls.filter(call => call[0] === "pr" && call[1] === "merge");
  expect(merges).toHaveLength(2);
  expect(merges[0]).not.toContain("--delete-branch");
  expect(merges[1]).toContain("--delete-branch");
  expect(merges[1]).toContain(sha);
  expect(calls.findIndex(call => call[4] === "state,mergedAt,autoMergeRequest,mergeStateStatus")).toBeLessThan(calls.findIndex(call => call.includes("--delete-branch")));
});

it("keeps branches and reports unknown when post-merge reads fail", async () => {
  const result = await runFixture(["pr", "merge", "42", "--squash", "--yes", "--json"], {root,cwd:repo,responses:[
    {prefix:["pr","view","42","--json","state,mergedAt,autoMergeRequest,mergeStateStatus"],stderr:"network unavailable",exitCode:1},
    {prefix:["pr","view","42"],stdout:JSON.stringify(detail)},
    {prefix:["pr","merge","42"]},
  ]});
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).outcome).toBe("unknown");
  expect(result.calls.some(call => call.includes("--delete-branch"))).toBe(false);
});

it("refuses missing head metadata before requesting a merge", async () => {
  const result = await runFixture(["pr", "merge", "42", "--squash", "--yes", "--json"], {root,cwd:repo,responses:[{prefix:["pr","view","42"],stdout:JSON.stringify({...detail,headRefOid:undefined})}]});
  expect(result.exitCode).toBe(1);
  expect(result.calls.some(call => call[1] === "merge")).toBe(false);
});

it("does not treat --yes as permission to force removal", async () => {
  const target = join(repo, ".worktrees", "dirty");
  await git(["worktree","add","-b","dirty",target]);
  writeFileSync(join(target,"local"),"keep\n");
  const result = await runFixture(["wt","remove",target,"--yes","--json"],{root,cwd:repo});
  expect(result.exitCode).toBe(1);
  expect(readFileSync(join(target,"local"),"utf8")).toBe("keep\n");
});

it("lists bare repositories explicitly", async () => {
  const bare = join(root,"bare.git");
  await run("git",["init","--bare",bare],{cwd:root});
  expect(await worktrees.worktreeList(bare)).toEqual([{path:bare,head:"",branch:null,detached:false,isBare:true,locked:false,lockReason:null,prunable:false,pruneReason:null}]);
});

it("reports exact local counts, upstream drift, detached HEAD, and linked-worktree operations", async () => {
  const target = join(root,"status");
  await git(["worktree","add","-b","status",target]);
  await git(["config","branch.status.remote","."]);
  await git(["config","branch.status.merge","refs/heads/main"]);
  await git(["commit","--allow-empty","-m","ahead"],target);
  writeFileSync(join(target,"tracked"),"staged\n");
  await git(["add","tracked"],target);
  writeFileSync(join(target,"tracked"),"unstaged\n");
  writeFileSync(join(target,"untracked"),"new\n");
  let result = await runFixture(["status","--json"],{root,cwd:target});
  expect(JSON.parse(result.stdout).repository).toMatchObject({branch:"status",upstream:"main",ahead:1,behind:0,staged:1,unstaged:1,untracked:1,conflicts:0,operation:null});
  const head = (await git(["rev-parse","HEAD"],target)).stdout.trim();
  await git(["checkout","--detach"],target);
  const operationPath = (await git(["rev-parse","--path-format=absolute","--git-path","MERGE_HEAD"],target)).stdout.trim();
  writeFileSync(operationPath,head+"\n");
  result = await runFixture(["status","--agent"],{root,cwd:target});
  expect(JSON.parse(result.stdout).result).toMatchObject({branch:null,head,operation:"merge"});
  expect(result.calls).toEqual([]);
  rmSync(operationPath);
});

it("runs remote and provider status probes only when requested", async () => {
  const result = await runFixture(["status","--remote","--providers","--agent"],{root,cwd:repo,responses:[{prefix:["pr","view"],stdout:""}]});
  expect(result.exitCode).toBe(0);
  expect(result.calls.some(call => call[0] === "auth")).toBe(true);
  expect(JSON.parse(result.stdout).result).toMatchObject({github:{authenticated:true},pullRequest:null,ai:{enabled:false}});
});

it("marks failed log downloads unavailable without dropping run details", async () => {
  const result = await runFixture(["run","42","--agent"],{root,cwd:repo,responses:[
    {prefix:["run","view","42","--log-failed"],stderr:"logs expired",exitCode:1},
    {prefix:["run","view","42"],stdout:JSON.stringify({databaseId:42,status:"completed",conclusion:"failure",jobs:[]})},
  ]});
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).result).toMatchObject({run:{databaseId:42},jobs:[],log:null,logStatus:"unavailable",logError:expect.stringContaining("logs expired")});
});

it("publishes the machine status, run, merge, and opt-in flag contracts", async () => {
  const result = await runFixture(["agent","schema"],{root,cwd:repo});
  expect(result.exitCode).toBe(0);
  const schema = JSON.parse(result.stdout);
  expect(schema.coreResultSchemas.status.schema.properties.operation.default).toBeNull();
  expect(schema.coreResultSchemas.run.schema.anyOf[1].required).toContain("logStatus");
  expect(schema.coreResultSchemas.merge.schema.properties.outcome.enum).toEqual(["merged","queued","auto_merge_enabled","unknown"]);
  expect(schema.inputs).toContainEqual(expect.objectContaining({path:["worktree","add"],options:expect.arrayContaining([expect.objectContaining({long:"--copy-env"})])}));
});
