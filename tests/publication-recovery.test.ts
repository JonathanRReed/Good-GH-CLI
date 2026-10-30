import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fixtureRoot, runFixture, type FixtureResponse } from "./cli-fixture.ts";
import { readOperation } from "../src/services/operations.ts";

const roots: string[] = [];
const entry = join(import.meta.dir, "../src/index.ts");
const execPath = join(import.meta.dir, "../src/utils/exec.ts");
function git(args: string[], cwd: string): string {
  const result = Bun.spawnSync(["git", ...args], { cwd });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
function fixture() {
  const root = fixtureRoot("ggh-publication-recovery-"); roots.push(root);
  const repo = join(root, "project"), bare = join(root, "remote.git");
  mkdirSync(repo);
  git(["init", "-b", "main"], repo);
  git(["config", "user.name", "Recovery fixture"], repo);
  git(["config", "user.email", "fixture@example.invalid"], repo);
  writeFileSync(join(repo, "base"), "base\n");
  git(["add", "."], repo); git(["commit", "-m", "base"], repo);
  git(["switch", "-c", "feature"], repo);
  writeFileSync(join(repo, "feature"), "feature\n");
  git(["add", "."], repo); git(["commit", "-m", "feature"], repo);
  git(["init", "--bare", bare], root);
  return { root, repo, bare };
}
function invoke(args: string[], bare: string): string {
  return `const {run}=await import(${JSON.stringify(execPath)}); await run('git',['config','--global',${JSON.stringify(`url.${pathToFileURL(bare).href}.insteadOf`)},'https://github.com/fixture/project.git']); const {runCli}=await import(${JSON.stringify(entry)}); await runCli(['bun','ggh',...${JSON.stringify(args)}]);`;
}
function responses(succeed: boolean, repositoryExists = false): FixtureResponse[] {
  return [
    repositoryExists
      ? { prefix: ["api", "repos/fixture/project"], stdout: JSON.stringify({ html_url: "https://github.com/fixture/project", private: true, visibility: "private" }) }
      : { prefix: ["api", "repos/fixture/project"], stderr: "HTTP 404: Not Found", exitCode: 1 },
    { prefix: ["repo", "create"], stdout: "https://github.com/fixture/project\n" },
    { prefix: ["pr", "list"], stdout: "[]" },
    succeed ? { prefix: ["pr", "create"], stdout: "https://github.com/fixture/project/pull/7\n" } : { prefix: ["pr", "create"], stderr: "HTTP 503: temporary failure", exitCode: 1 },
  ];
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("publication recovery", () => {
  test("preserves local HEAD, confirmed pushes, and recovery metadata after rate limiting", async () => {
    const { root, repo, bare } = fixture();
    const head = git(["rev-parse", "HEAD"], repo);
    const limited = responses(false);
    limited[limited.length - 1] = { prefix: ["pr", "create"], stderr: "HTTP 429: API rate limit exceeded", exitCode: 1 };
    const first = await runFixture([], { root, cwd: repo, responses: limited, invoke: invoke(["pr", "create", "--title", "title", "--body", "body", "--yes", "--agent"], bare) });
    const report = JSON.parse(first.stdout);
    expect(report.status).toBe("partially_completed");
    expect(report.operationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(report.effects.completed).toEqual(expect.arrayContaining(["push_base", "push_head"]));
    expect(report.effects.pending).toContain("create_pull_request");
    expect(git(["rev-parse", "HEAD"], repo)).toBe(head);
    expect(git(["rev-parse", "refs/heads/feature"], bare)).toBe(head);
    const record = await readOperation(report.operationId, repo);
    expect(record.resume).toMatchObject({ kind: "publication", requiresPrContent: true });
  });

  test("reconciles a PR whose creation response was lost without creating it again", async () => {
    const { root, repo, bare } = fixture();
    const head = git(["rev-parse", "HEAD"], repo);
    const lost = responses(false);
    lost[lost.length - 1] = { prefix: ["pr", "create"], stderr: "connection reset while reading response", exitCode: 1 };
    const first = await runFixture([], { root, cwd: repo, responses: lost, invoke: invoke(["pr", "create", "--title", "title", "--body", "body", "--yes", "--agent"], bare) });
    const report = JSON.parse(first.stdout);
    expect(report.status).toBe("partially_completed");
    expect(first.calls.filter(call => call[0] === "pr" && call[1] === "create")).toHaveLength(1);
    const recovered = responses(true, true).map(response => response.prefix[0] === "pr" && response.prefix[1] === "list"
      ? { ...response, stdout: JSON.stringify([{ url: "https://github.com/fixture/project/pull/7" }]) }
      : response);
    const retry = await runFixture([], { root, cwd: repo, responses: recovered, invoke: invoke(["operation", "resume", report.operationId, "--title", "title", "--body", "body", "--yes", "--agent"], bare) });
    expect(JSON.parse(retry.stdout)).toMatchObject({ status: "succeeded", operationId: report.operationId, result: { url: "https://github.com/fixture/project/pull/7" } });
    expect(retry.calls.find(call => call[0] === "pr" && call[1] === "list")).toEqual(["pr", "list", "--state", "open", "--head", "feature", "--base", "main", "--json", "url"]);
    expect(retry.calls.some(call => call[1] === "create" || call[1] === "edit")).toBe(false);
    expect(git(["rev-parse", "HEAD"], repo)).toBe(head);
    expect(git(["rev-parse", "refs/heads/feature"], bare)).toBe(head);
    expect((await readOperation(report.operationId, repo)).status).toEqual({ state: "succeeded" });
  });

  test("keeps original execution exclusive until its journal is finalized", async () => {
    const { root, repo } = fixture();
    const module = (name: string) => JSON.stringify(join(import.meta.dir, "../src/services", name + ".ts"));
    const result = await runFixture([], { root, cwd: repo,
      responses: [{ prefix: ["api", "repos/fixture/project"], stdout: JSON.stringify({ html_url: "https://github.com/fixture/project", private: true, visibility: "private" }) }],
      invoke: `const {startOperation,claimOperationResume,readOperation}=await import(${module("operations")});
        const {setActiveOperation,rememberCommandResult}=await import(${module("runtime")});
        const {executePublication}=await import(${module("publication")});
        const {getRepoRoot}=await import(${JSON.stringify(join(import.meta.dir, "../src/services/git/branch.ts"))});
        const repositoryRoot=await getRepoRoot();
        const {finishCommandOperation}=await import(${module("command-operations")});
        const record=await startOperation({command:'repo create',cwd:process.cwd()});
        setActiveOperation({id:record.id,cwd:process.cwd(),command:record.command});
        try {
          const result=await executePublication({kind:'repo',cwd:process.cwd(),root:repositoryRoot,source:repositoryRoot,host:'github.com',target:'fixture/project',remote:'origin',remoteUrl:'https://github.com/fixture/project.git',pushUrl:'https://github.com/fixture/project.git',visibility:'private',push:false,steps:['add_remote']});
          let held='';
          try { const release=await claimOperationResume(record.id,process.cwd(),0);await release(); }
          catch(error) { held=error.message; }
          rememberCommandResult(result);await finishCommandOperation();
          const release=await claimOperationResume(record.id,process.cwd(),0);await release();
          process.stdout.write(JSON.stringify({result,held,status:(await readOperation(record.id,process.cwd())).status}));
        } finally {await finishCommandOperation();}`,
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ result: { status: "succeeded" }, held: expect.stringContaining("active"), status: { state: "succeeded" } });
    expect(git(["remote", "get-url", "origin"], repo)).toBe("https://github.com/fixture/project.git");
  });

  test("requires content resupply and resumes confirmed pushes without replaying commits", async () => {
    const { root, repo, bare } = fixture();
    const args = ["pr", "create", "--draft", "--title", "PRIVATE_TITLE_CANARY", "--body", "PRIVATE_BODY_CANARY", "--yes", "--agent"];
    const first = await runFixture([], { root, cwd: repo, responses: responses(false), invoke: invoke(args, bare) });
    const report = JSON.parse(first.stdout);
    expect(report.status).toBe("partially_completed");
    const id = report.operationId;
    const recordPath = join(repo, ".git", "ggh-operations", `${id}.json`);
    const stored = readFileSync(recordPath, "utf8");
    expect(stored).not.toContain("PRIVATE_TITLE_CANARY");
    expect(stored).not.toContain("PRIVATE_BODY_CANARY");
    expect(JSON.parse(stored).resume).toMatchObject({ kind: "publication", requiresPrContent: true, draft: true, creationMode: "direct" });
    const head = git(["rev-parse", "HEAD"], repo);
    const missing = await runFixture([], { root, cwd: repo, responses: responses(true, true), invoke: invoke(["operation", "resume", id, "--yes", "--agent"], bare) });
    expect(JSON.parse(missing.stdout)).toMatchObject({ status: "needs_input", requiredInputs: expect.arrayContaining([expect.objectContaining({ name: "--title" }), expect.objectContaining({ name: "body", alternatives: ["--body", "--body-file"] })]) });
    expect(missing.calls.some(call => call[0] === "pr" && call[1] === "create")).toBe(false);
    expect(readFileSync(recordPath, "utf8")).toBe(stored);
    const preview = await runFixture([], { root, cwd: repo, responses: responses(true, true), invoke: invoke(["operation", "resume", id, "--dry-run", "--agent"], bare) });
    expect(JSON.parse(preview.stdout)).toMatchObject({ status: "planned", result: { operationId: id, requiredInputs: expect.arrayContaining([expect.objectContaining({ name: "--title" })]) } });
    expect(preview.calls.some(call => call[0] === "pr" && call[1] === "create")).toBe(false);
    expect(readFileSync(recordPath, "utf8")).toBe(stored);
    const retry = await runFixture([], { root, cwd: repo, responses: responses(true, true), invoke: invoke(["operation", "resume", id, "--title", "resupplied title", "--body", "resupplied body", "--yes", "--agent"], bare) });
    expect(JSON.parse(retry.stdout)).toMatchObject({ status: "succeeded", operationId: id, result: { url: "https://github.com/fixture/project/pull/7" } });
    expect(retry.calls.filter(call => call[0] === "repo" && call[1] === "create")).toEqual([]);
    expect(retry.calls.find(call => call[0] === "pr" && call[1] === "create")).toContain("--draft");
    expect(git(["rev-parse", "HEAD"], repo)).toBe(head);
    expect(git(["rev-parse", "refs/heads/feature"], bare)).toBe(head);
    expect((await readOperation(id, repo)).status).toEqual({ state: "succeeded" });
    expect(readdirSync(join(repo, ".git", "ggh-operations")).filter(name => name.endsWith(".json"))).toHaveLength(1);
    const again = await runFixture([], { root, cwd: repo, invoke: invoke(["operation", "resume", id, "--agent"], bare) });
    expect(JSON.parse(again.stdout)).toMatchObject({ status: "no_op", result: { reason: "already_completed" } });
    expect(again.calls).toEqual([]);
  });

  test("refuses a changed head before replaying any publication effects", async () => {
    const { root, repo, bare } = fixture();
    const first = await runFixture([], { root, cwd: repo, responses: responses(false), invoke: invoke(["pr", "create", "--title", "title", "--body", "body", "--yes", "--agent"], bare) });
    const id = JSON.parse(first.stdout).operationId;
    const recordPath = join(repo, ".git", "ggh-operations", `${id}.json`);
    const before = readFileSync(recordPath, "utf8");
    writeFileSync(join(repo, "later"), "later work\n");
    git(["add", "later"], repo); git(["commit", "-m", "later work"], repo);
    const head = git(["rev-parse", "HEAD"], repo);
    const retry = await runFixture([], { root, cwd: repo, responses: responses(true, true), invoke: invoke(["operation", "resume", id, "--title", "title", "--body", "body", "--yes", "--agent"], bare) });
    expect(JSON.parse(retry.stdout)).toMatchObject({ status: "failed", error: { code: "precondition_failed", retryability: "after_inspection" } });
    expect(retry.calls.some(call => ["create", "edit"].includes(call[1] ?? ""))).toBe(false);
    expect(git(["rev-parse", "HEAD"], repo)).toBe(head);
    expect(readFileSync(recordPath, "utf8")).toBe(before);
  });

  test("preserves browser and draft intent instead of creating a ready PR", async () => {
    const { root, repo, bare } = fixture();
    const first = await runFixture([], { root, cwd: repo, responses: responses(false), invoke: invoke(["pr", "create", "--web", "--draft", "--title", "title", "--body", "body", "--yes", "--agent"], bare) });
    const report = JSON.parse(first.stdout);
    expect(report.status).toBe("partially_completed");
    const id = report.operationId;
    expect((await readOperation(id, repo)).resume).toMatchObject({ creationMode: "browser", draft: true });
    const retry = await runFixture([], { root, cwd: repo, responses: responses(true, true), invoke: invoke(["operation", "resume", id, "--title", "title", "--body", "body", "--yes", "--agent"], bare) });
    const result = JSON.parse(retry.stdout);
    expect(result.status).toBe("succeeded");
    const request = retry.calls.find(call => call[0] === "pr" && call[1] === "create");
    expect(request).toContain("--web");
    expect(request).toContain("--draft");
    expect(result.effects.completed).toContain("open_create_page");
    expect(result.effects.completed).not.toContain("create_pull_request");
  });

  test("resumes a failed repository push without recreating the repository or resupplying a saved description", async () => {
    const { root, repo, bare } = fixture();
    const hook = join(bare, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n"); chmodSync(hook, 0o700);
    const first = await runFixture([], { root, cwd: repo, responses: responses(true), invoke: invoke(["repo", "create", "--description", "PRIVATE_DESCRIPTION_CANARY", "--yes", "--agent"], bare) });
    const report = JSON.parse(first.stdout);
    expect(report.status).toBe("partially_completed");
    const id = report.operationId;
    expect(readFileSync(join(repo, ".git", "ggh-operations", `${id}.json`), "utf8")).not.toContain("PRIVATE_DESCRIPTION_CANARY");
    rmSync(hook);
    const retry = await runFixture([], { root, cwd: repo, responses: [{ prefix: ["api", "repos/fixture/project"], stdout: JSON.stringify({ html_url: "https://github.com/fixture/project", private: true, visibility: "private" }) }], invoke: invoke(["operation", "resume", id, "--yes", "--agent"], bare) });
    expect(JSON.parse(retry.stdout)).toMatchObject({ status: "succeeded", operationId: id });
    expect(retry.calls.some(call => call[0] === "repo" && call[1] === "create")).toBe(false);
    expect(git(["rev-parse", "refs/heads/feature"], bare)).toBe(git(["rev-parse", "HEAD"], repo));
  });
});
