import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fixtureRoot, runFixture, type FixtureResponse } from "./cli-fixture.ts";

const roots: string[] = [];
const entry = join(import.meta.dir, "../src/index.ts");
const execPath = join(import.meta.dir, "../src/utils/exec.ts");
function git(args: string[], cwd: string): string {
  const result = Bun.spawnSync(["git", ...args], { cwd });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
function fixture(feature = false) {
  const root = fixtureRoot("ggh-publication-cli-"); roots.push(root);
  const repo = join(root, "project"), bare = join(root, "remote.git");
  mkdirSync(repo);
  git(["init", "-b", "main"], repo);
  git(["config", "user.name", "Fixture"], repo);
  git(["config", "user.email", "fixture@example.test"], repo);
  writeFileSync(join(repo, "base"), "local source marker");
  git(["add", "."], repo); git(["commit", "-m", "base"], repo);
  if (feature) {
    git(["switch", "-c", "feature"], repo);
    writeFileSync(join(repo, "change"), "change");
    git(["add", "."], repo); git(["commit", "-m", "Add feature"], repo);
  }
  git(["init", "--bare", bare], root);
  return { root, repo, bare };
}
function invoke(args: string[], bare: string): string {
  return `const {run}=await import(${JSON.stringify(execPath)}); await run('git',['config','--global',${JSON.stringify(`url.${pathToFileURL(bare).href}.insteadOf`)},'https://github.com/fixture/project.git']); const {runCli}=await import(${JSON.stringify(entry)}); await runCli(['bun','ggh',...${JSON.stringify(args)}]);`;
}
const responses: FixtureResponse[] = [
  { prefix: ["api", "repos/fixture/project"], stderr: "HTTP 404: Not Found", exitCode: 1 },
  { prefix: ["repo", "create"], stdout: "https://github.com/fixture/project\n" },
  { prefix: ["pr", "list"], stdout: "[]" },
  { prefix: ["pr", "create"], stdout: "https://github.com/fixture/project/pull/7\n" },
];
function records(repo: string): string[] {
  const dir = join(repo, ".git/ggh-operations");
  return readdirSync(dir).filter(name => name.endsWith(".json")).map(name => readFileSync(join(dir, name), "utf8"));
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("publication command integration", () => {
  test("editor preflight requires a terminal without provider or GitHub calls", async () => {
    const root = fixtureRoot("ggh-editor-preflight-"); roots.push(root);
    const result = await runFixture(["pr", "create", "--editor", "--json"], { root, cwd: root, responses: [] });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "needs_input" });
    expect(result.calls).toHaveLength(0);
    expect(result.providerCalls).toHaveLength(0);
  });
  test("dry-run previews an explicit editor draft without running its editor", async () => {
    const { root, repo, bare } = fixture(true);
    const file = join(repo, "draft.md"); writeFileSync(file, "Résumé preview\n\n## Body\n\nLine two\n");
    const result = await runFixture([], { root, cwd: repo, responses, invoke: invoke(["pr", "create", "--editor", file, "--base", "main", "--dry-run", "--json", "--no-ai"], bare) });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "planned", title: "Résumé preview", body: "## Body\n\nLine two\n", editorRun: false, snapshotProvisional: true });
    expect(result.calls.some(args => args[0] === "repo" && args[1] === "create")).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("Résumé preview\n\n## Body\n\nLine two\n");
    expect(result.providerCalls).toHaveLength(0);
  });
  test("requires confirmation before inferred repository creation", async () => {
    const { root, repo, bare } = fixture();
    const result = await runFixture([], { root, cwd: repo, responses, invoke: invoke(["repo", "create", "--json"], bare) });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "needs_input", operationId: expect.any(String) });
    expect(result.calls.some(args => args[0] === "repo" && args[1] === "create")).toBe(false);
    expect(git(["remote"], repo)).toBe("");
    expect(JSON.parse(records(repo)[0]!)).toMatchObject({ status: { state: "needs_input" } });
  });
  test("honors user fast mode and pushes the inferred root with tracking", async () => {
    const { root, repo, bare } = fixture();
    const nested = join(repo, "nested"); mkdirSync(nested);
    const result = await runFixture([], { root, cwd: nested, responses, config: { repo_create_confirm: false }, invoke: invoke(["repo", "create", "--json"], bare) });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "succeeded", target: "fixture/project", visibility: "private" });
    expect(result.calls.find(args => args[0] === "repo" && args[1] === "create")).toContain("--private");
    expect(git(["--git-dir", bare, "rev-parse", "refs/heads/main"], root)).toBe(git(["rev-parse", "HEAD"], repo));
    expect(git(["rev-parse", "--abbrev-ref", "@{u}"], repo)).toBe("origin/main");
    expect(result.providerCalls).toHaveLength(0);
  });
  test("explicit confirm overrides user fast mode", async () => {
    const { root, repo, bare } = fixture();
    const result = await runFixture([], { root, cwd: repo, responses, config: { repo_create_confirm: false }, invoke: invoke(["repo", "create", "--confirm", "--json"], bare) });
    expect(JSON.parse(result.stdout).status).toBe("needs_input");
    expect(result.calls.some(args => args[0] === "repo" && args[1] === "create")).toBe(false);
  });
  test("resolves attachments and Markdown references from the invocation directory", async () => {
    const { root, repo, bare } = fixture(true);
    const nested = join(repo, "nested"); mkdirSync(nested);
    const image = join(nested, "proof.png"); writeFileSync(image, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const cwdTrace = join(root, "github-cwd.txt");
    const body = "![Proof](./proof.png)";
    const observeCwd = `const spawnBefore=Bun.spawn.bind(Bun);Bun.spawn=(args,options)=>{if(args[0]==='gh'&&args[1]==='pr'&&args[2]==='create'&&!args.includes('--help'))appendFileSync(${JSON.stringify(cwdTrace)},options.cwd);return spawnBefore(args,options);};`;
    const result = await runFixture([], { root, cwd: nested, responses: [{ prefix: ["pr", "create", "--help"], stdout: "--attach <file>" }, ...responses], invoke: observeCwd + invoke(["pr", "create", "--attach", "proof.png", "--body", body, "-y", "--json"], bare) });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(cwdTrace, "utf8")).toBe(nested);
    const create = result.calls.find(args => args[0] === "pr" && args[1] === "create" && !args.includes("--help"));
    expect(create).toContain(image);
    expect(result.inputs.find(input => input.args[0] === "pr" && input.args[1] === "create")?.text).toBe(body);
    expect(git(["ls-files", "nested/proof.png"], repo)).toBe("");
  });
  test("bootstraps a PR once and journals metadata without its body", async () => {
    const { root, repo, bare } = fixture(true);
    const body = "private PR body marker";
    const result = await runFixture([], { root, cwd: repo, responses, invoke: invoke(["pr", "create", "-t", "Feature title", "-b", body, "-y", "--json"], bare) });
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ status: "succeeded", base: "main", head: "feature", url: "https://github.com/fixture/project/pull/7", operationId: expect.any(String) });
    expect(report.completed).toEqual(["create_repository", "add_remote", "push_base", "push_head", "create_pull_request"]);
    expect(result.inputs.find(input => input.args[0] === "pr" && input.args[1] === "create")?.text).toBe(body);
    expect(git(["--git-dir", bare, "rev-parse", "refs/heads/main"], root)).toBe(git(["rev-parse", "main"], repo));
    const journal = records(repo);
    expect(journal).toHaveLength(1);
    expect(JSON.parse(journal[0]!)).toMatchObject({ command: "pr create", target: "github.com/fixture/project", status: { state: "succeeded" }, beforeRevision: git(["rev-parse", "HEAD"], repo) });
    expect(journal.join("")).not.toContain(body);
    expect(journal.join("")).not.toContain("local source marker");
    expect(result.providerCalls).toHaveLength(0);
  });
  test("invalid bases and dry-run do not mutate repository state", async () => {
    const { root, repo, bare } = fixture(true);
    const before = git(["rev-parse", "HEAD"], repo);
    for (const extra of [["--base", "missing"], ["--dry-run"]]) {
      const result = await runFixture([], { root, cwd: repo, responses, invoke: invoke(["pr", "create", "-y", "--json", ...extra], bare) });
      expect(JSON.parse(result.stdout).status).toBe(extra[0] === "--base" ? "needs_input" : "planned");
      expect(result.calls.some(args => args[0] === "repo" && args[1] === "create")).toBe(false);
      expect(result.providerCalls).toHaveLength(0);
      expect(git(["remote"], repo)).toBe("");
      expect(git(["rev-parse", "HEAD"], repo)).toBe(before);
    }
  });
  test("keeps publication resources in records during a manual run", async () => {
    const { root, repo, bare } = fixture(true);
    const result = await runFixture([], { root, cwd: repo, responses, invoke: invoke(["pr", "create", "-y"], bare) });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(records(repo)[0]!)).toMatchObject({ status: { state: "succeeded" }, resources: ["https://github.com/fixture/project/pull/7"] });
  });
  test("reports opening a create page without claiming a PR was created", async () => {
    const { root, repo, bare } = fixture(true);
    const webResponses = responses.map(response => response.prefix.join(" ") === "pr create" ? { ...response, stdout: "" } : response);
    const result = await runFixture([], { root, cwd: repo, responses: webResponses, invoke: invoke(["pr", "create", "--web", "-y", "--json"], bare) });
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.action).toBe("open_create_page");
    expect(report.completed).toContain("open_create_page");
    expect(report.completed).not.toContain("create_pull_request");
    expect(report.url).toBeUndefined();
    expect(result.calls.find(args => args[0] === "pr" && args[1] === "create")).toContain("--web");
  });
  test("reports durable completed steps when interrupted during PR creation", async () => {
    const { root, repo, bare } = fixture(true);
    const bin = join(import.meta.dir, "../bin/ggh.ts");
    const args = ["pr", "create", "-y", "--json"];
    const signalInvoke = `const {run}=await import(${JSON.stringify(execPath)}); await run('git',['config','--global',${JSON.stringify(`url.${pathToFileURL(bare).href}.insteadOf`)},'https://github.com/fixture/project.git']); const priorSpawn=Bun.spawn.bind(Bun); Bun.spawn=(args,options)=>{const child=priorSpawn(args,options);if(args[0]==='gh'&&args[1]==='pr'&&args[2]==='create'){setTimeout(()=>process.emit('SIGINT','SIGINT'),20);return {...child,pid:2147483647,exited:new Promise(()=>{})};}return child;}; process.argv=['bun','ggh',...${JSON.stringify(args)}];await import(${JSON.stringify(bin)});`;
    const result = await runFixture([], { root, cwd: repo, responses, invoke: signalInvoke });
    expect(result.exitCode).toBe(130);
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe("partially_completed");
    expect(report.completed).toEqual(["create_repository", "add_remote", "push_base", "push_head"]);
    expect(report.remaining).toEqual(["create_pull_request"]);
    expect(report.recovery).toContain("operation view");
    expect(JSON.parse(records(repo)[0]!)).toMatchObject({ status: { state: "partially_completed" }, steps: expect.arrayContaining([{ name: "create_pull_request", state: "unknown" }]) });
  });
});
