import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fixtureRoot, runFixture } from "./cli-fixture.ts";
import { publicationSnapshot } from "../src/services/publication-approval.ts";
import type { PullRequestPlan } from "../src/services/publication.ts";

const roots: string[] = [];
const service = join(import.meta.dir, "../src/services/publication.ts");
const exec = join(import.meta.dir, "../src/utils/exec.ts");
const entry = join(import.meta.dir, "../src/index.ts");
function git(args: string[], cwd: string): string {
  const result = Bun.spawnSync(["git", ...args], { cwd });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
function fixture() {
  const root = fixtureRoot("ggh-snapshot-"); roots.push(root);
  const repo = join(root, "project"), bare = join(root, "remote.git"); mkdirSync(repo);
  git(["init", "-b", "main"], repo); git(["config", "user.name", "Fixture"], repo); git(["config", "user.email", "fixture@example.test"], repo);
  writeFileSync(join(repo, "base"), "base"); git(["add", "."], repo); git(["commit", "-m", "base"], repo);
  const base = git(["rev-parse", "HEAD"], repo);
  git(["switch", "-c", "feature"], repo); writeFileSync(join(repo, "change"), "change"); git(["add", "."], repo); git(["commit", "-m", "feature"], repo);
  git(["init", "--bare", bare], root);
  return { root, repo, bare, base };
}
function rewrite(bare: string) { return `const {run}=await import(${JSON.stringify(exec)}); await run('git',['config','--global',${JSON.stringify(`url.${pathToFileURL(bare).href}.insteadOf`)},'https://github.com/fixture/project.git']);`; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("snapshot includes content, draft, browser mode, description and file bytes", async () => {
  const { repo } = fixture();
  const plan: PullRequestPlan = { kind: "pr", cwd: repo, root: repo, host: "github.com", target: "fixture/project", remote: "origin", remoteUrl: "https://github.com/fixture/project.git", pushUrl: "https://github.com/fixture/project.git", visibility: "private", createRepository: true, head: "feature", headTip: "a".repeat(40), base: "main", baseTip: "b".repeat(40), mergeBaseTip: "b".repeat(40), steps: ["create_pull_request"] };
  const content = { title: "Title", body: "Body" };
  const original = await publicationSnapshot(plan, content);
  for (const changed of [{ ...content, title: "Other" }, { ...content, body: "Other" }, { ...content, draft: true }, { ...content, web: true }]) expect(await publicationSnapshot(plan, changed)).not.toBe(original);
  const image = join(repo, "image.svg"); writeFileSync(image, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  const attached = { ...content, attachments: [image] };
  const before = await publicationSnapshot(plan, attached);
  writeFileSync(image, '<svg xmlns="http://www.w3.org/2000/svg">x</svg>');
  expect(await publicationSnapshot(plan, attached)).not.toBe(before);
  expect(await publicationSnapshot(plan, { ...content, attachments: [image + "#Alt"] })).not.toBe(await publicationSnapshot(plan, attached));
  const repository = { kind: "repo" as const, cwd: repo, host: plan.host, target: plan.target, remote: plan.remote, remoteUrl: plan.remoteUrl, pushUrl: plan.pushUrl, visibility: plan.visibility, push: false, steps: [] };
  expect(await publicationSnapshot({ ...repository, description: "A" })).not.toBe(await publicationSnapshot({ ...repository, description: "B" }));
});

test("live base comparison preserves the local branch and rejects subsequent remote movement", async () => {
  const { root, repo, bare, base } = fixture();
  git(["switch", "main"], repo); writeFileSync(join(repo, "upstream"), "remote"); git(["add", "."], repo); git(["commit", "-m", "remote"], repo);
  const remoteBase = git(["rev-parse", "HEAD"], repo);
  git(["push", bare, "main:main"], repo); git(["reset", "--hard", base], repo); git(["switch", "feature"], repo); git(["remote", "add", "origin", "https://github.com/fixture/project.git"], repo);
  const result = await runFixture([], { root, cwd: repo, responses: [{ prefix: ["api", "repos/fixture/project"], stdout: JSON.stringify({ html_url: "https://github.com/fixture/project", private: true, visibility: "private" }) }], invoke: `${rewrite(bare)} const {preparePublication,executePublication}=await import(${JSON.stringify(service)}); const prepared=await preparePublication({kind:'pr',base:'main'}); await run('git',['--git-dir',${JSON.stringify(bare)},'update-ref','refs/heads/main',${JSON.stringify(base)}]); const result=await executePublication(prepared.plan,{title:'T',body:'B'}); process.stdout.write(JSON.stringify({prepared,result}));` });
  const value = JSON.parse(result.stdout);
  expect(value.prepared.plan).toMatchObject({ baseTip: remoteBase, localBaseTip: base, remoteBaseTip: remoteBase });
  expect(value.result.status).toBe("failed"); expect(value.result.error).toContain("Remote base");
  expect(git(["rev-parse", "main"], repo)).toBe(base);
  expect(result.calls.some(args => args[1] === "create")).toBe(false);
});

test("unavailable live base requires an explicit fetch without changing refs", async () => {
  const { root, repo, bare, base } = fixture();
  git(["remote", "add", "origin", "https://github.com/fixture/project.git"], repo);
  const invoke = `${rewrite(bare)} const spawn=Bun.spawn.bind(Bun); Bun.spawn=(args,options)=>args[0]==='git'&&args[1]==='ls-remote'?{stdout:new Blob([args.at(-1)==='refs/heads/main'?${JSON.stringify("f".repeat(40) + "\trefs/heads/main\n")}: '']).stream(),stderr:new Blob([]).stream(),exited:Promise.resolve(0),kill(){},stdin:null}:spawn(args,options); const {preparePublication}=await import(${JSON.stringify(service)}); process.stdout.write(JSON.stringify(await preparePublication({kind:'pr',base:'main'})));`;
  const result = await runFixture([], { root, cwd: repo, invoke });
  expect(JSON.parse(result.stdout)).toMatchObject({ status: "needs_input", required: "base", message: expect.stringContaining("git fetch origin main") });
  expect(git(["rev-parse", "main"], repo)).toBe(base);
});

test("repo approval mismatch blocks creation and an exact snapshot confirms without yes", async () => {
  const { root, repo, bare } = fixture();
  const responses = [{ prefix: ["api", "repos/fixture/project"], exitCode: 1, stderr: "HTTP 404: Not Found" }, { prefix: ["repo", "create"], stdout: "https://github.com/fixture/project" }];
  const invoke = (args: string[]) => `${rewrite(bare)} const {runCli}=await import(${JSON.stringify(entry)}); await runCli(['bun','ggh',...${JSON.stringify(args)}]);`;
  const args = ["repo", "create", "fixture/project", "--no-push", "--json"];
  const preview = await runFixture([], { root, cwd: repo, responses, invoke: invoke([...args, "--dry-run"]) });
  const snapshotId = JSON.parse(preview.stdout).snapshotId;
  expect(snapshotId).toMatch(/^[a-f0-9]{64}$/);
  const mismatch = await runFixture([], { root, cwd: repo, responses, invoke: invoke([...args, "--approve-plan", "0".repeat(64), "--agent"]) });
  expect(mismatch.exitCode).toBe(1); expect(mismatch.calls.some(args => args[1] === "create")).toBe(false);
  expect(JSON.parse(mismatch.stdout)).toMatchObject({ status: "needs_input", error: { code: "confirmation_required" }, requiredInputs: [{ name: "--approve-plan" }] });
  const approved = await runFixture([], { root, cwd: repo, responses, invoke: invoke([...args, "--approve-plan", snapshotId]) });
  expect(approved.exitCode).toBe(0); expect(approved.calls.some(args => args[1] === "create")).toBe(true);
});

test("PR snapshot approval binds the supplied body before any creation", async () => {
  const { root, repo, bare } = fixture();
  const responses = [{ prefix: ["api", "repos/fixture/project"], exitCode: 1, stderr: "HTTP 404: Not Found" }, { prefix: ["repo", "create"], stdout: "https://github.com/fixture/project" }, { prefix: ["pr", "list"], stdout: "[]" }, { prefix: ["pr", "create"], stdout: "https://github.com/fixture/project/pull/1" }];
  const invoke = (args: string[]) => `${rewrite(bare)} const {runCli}=await import(${JSON.stringify(entry)}); await runCli(['bun','ggh',...${JSON.stringify(args)}]);`;
  const args = ["pr", "create", "--base", "main", "--title", "Title", "--body", "Body", "--no-ai", "--json"];
  const preview = await runFixture([], { root, cwd: repo, responses, invoke: invoke([...args, "--dry-run"]) });
  const snapshotId = JSON.parse(preview.stdout).snapshotId;
  expect(snapshotId).toMatch(/^[a-f0-9]{64}$/);
  const changed = [...args]; changed[changed.indexOf("Body")] = "Changed";
  const mismatch = await runFixture([], { root, cwd: repo, responses, invoke: invoke([...changed, "--approve-plan", snapshotId]) });
  expect(mismatch.exitCode).toBe(1); expect(mismatch.calls.some(args => args[1] === "create")).toBe(false); expect(git(["remote"], repo)).toBe("");
  const approved = await runFixture([], { root, cwd: repo, responses, invoke: invoke([...args, "--approve-plan", snapshotId]) });
  expect(approved.exitCode).toBe(0); expect(approved.calls.some(args => args[0] === "pr" && args[1] === "create")).toBe(true);
});

test("execution rechecks selected attachment bytes after approval", async () => {
  const { repo } = fixture();
  const image = join(repo, "image.svg"); writeFileSync(image, "<svg></svg>");
  const plan: PullRequestPlan = { kind: "pr", cwd: repo, root: repo, host: "github.com", target: "fixture/project", remote: "origin", remoteUrl: "https://github.com/fixture/project.git", pushUrl: "https://github.com/fixture/project.git", visibility: "private", createRepository: true, head: "feature", headTip: "a".repeat(40), base: "main", baseTip: "b".repeat(40), mergeBaseTip: "b".repeat(40), steps: ["create_repository"] };
  const content = { title: "Title", body: "Body", attachments: [image] };
  const approvedSnapshot = await publicationSnapshot(plan, content);
  writeFileSync(image, "<svg>changed</svg>");
  const { executePublication } = await import("../src/services/publication.ts");
  await expect(executePublication(plan, content, { approvedSnapshot })).rejects.toThrow("snapshot does not match");
  expect(git(["remote"], repo)).toBe("");
});

test("existing target visibility is authoritative and changes invalidate approval", async () => {
  const { root, repo, bare } = fixture();
  git(["remote", "add", "origin", "https://github.com/fixture/project.git"], repo);
  const responses = [{ prefix: ["api", "repos/fixture/project"], stdout: JSON.stringify({ html_url: "https://github.com/fixture/project", private: false, visibility: "public" }) }];
  const invoke = `${rewrite(bare)} const original=Bun.spawn.bind(Bun); let changed=false; Bun.spawn=(args,options)=>changed&&args[0]==='gh'&&args[1]==='api'&&args[2]==='repos/fixture/project'?{pid:0,stdout:new Blob([JSON.stringify({html_url:'https://github.com/fixture/project',private:true,visibility:'private'})]).stream(),stderr:new Blob([]).stream(),exited:Promise.resolve(0),kill(){},stdin:null}:original(args,options); const {preparePublication,executePublication}=await import(${JSON.stringify(service)}); const prepared=await preparePublication({kind:'pr',base:'main'}); changed=true; const result=prepared.status==='ready'?await executePublication(prepared.plan,{title:'T',body:'B'}):prepared; process.stdout.write(JSON.stringify({prepared,result}));`;
  const result = await runFixture([], { root, cwd: repo, responses, invoke });
  const value = JSON.parse(result.stdout);
  expect(value.prepared.plan.visibility).toBe("public");
  expect(value.result).toMatchObject({ status: "failed", error: expect.stringContaining("visibility") });
  expect(git(["--git-dir", bare, "for-each-ref", "--format=%(refname)"], root)).toBe("");
});

test("unavailable existing target cannot become an approved private default", async () => {
  const { root, repo, bare } = fixture();
  git(["remote", "add", "origin", "https://github.com/fixture/project.git"], repo);
  for (const response of [{ exitCode: 1, stderr: "HTTP 404: Not Found" }, { stdout: JSON.stringify({ html_url: "https://github.com/fixture/project" }) }]) {
    const result = await runFixture([], { root, cwd: repo, responses: [{ prefix: ["api", "repos/fixture/project"], ...response }], invoke: `${rewrite(bare)} const {preparePublication}=await import(${JSON.stringify(service)}); process.stdout.write(JSON.stringify(await preparePublication({kind:'pr',base:'main'})));` });
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "needs_input", required: "repository" });
    expect(result.calls.some(args => args[1] === "create")).toBe(false);
  }
  expect(git(["--git-dir", bare, "for-each-ref", "--format=%(refname)"], root)).toBe("");
});
