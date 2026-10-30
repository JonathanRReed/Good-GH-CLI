import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { executePublication, type PullRequestPlan } from "../src/services/publication.ts";
import { fixtureRoot, runFixture, type FixtureResponse } from "./cli-fixture.ts";

const roots: string[] = [];
const entry = join(import.meta.dir, "../src/index.ts");
const execPath = join(import.meta.dir, "../src/utils/exec.ts");
function git(args: string[], cwd: string): string {
  const result = Bun.spawnSync(["git", ...args], { cwd });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
/** Origin fetches from one local bare repository and pushes to another, as `set-url --push` allows. */
function fixture() {
  const root = fixtureRoot("ggh-push-url-"); roots.push(root);
  const repo = join(root, "project"), fetchBare = join(root, "fetch.git"), pushBare = join(root, "push.git");
  mkdirSync(repo);
  git(["init", "-b", "main"], repo);
  git(["config", "user.name", "Fixture"], repo);
  git(["config", "user.email", "fixture@example.test"], repo);
  writeFileSync(join(repo, "base"), "base"); git(["add", "."], repo); git(["commit", "-m", "base"], repo);
  git(["switch", "-c", "feature"], repo);
  writeFileSync(join(repo, "change"), "change"); git(["add", "."], repo); git(["commit", "-m", "Add feature"], repo);
  for (const bare of [fetchBare, pushBare]) git(["init", "--bare", "-b", "main", bare], root);
  git(["push", fetchBare, "main:main"], repo);
  git(["remote", "add", "origin", "https://github.com/fixture/project.git"], repo);
  git(["remote", "set-url", "--push", "origin", pushBare], repo);
  return { root, repo, fetchBare, pushBare };
}
function invoke(args: string[], fetchBare: string): string {
  return `const {run}=await import(${JSON.stringify(execPath)}); await run('git',['config','--global',${JSON.stringify(`url.${pathToFileURL(fetchBare).href}.insteadOf`)},'https://github.com/fixture/project.git']); const {runCli}=await import(${JSON.stringify(entry)}); await runCli(['bun','ggh',...${JSON.stringify(args)}]);`;
}
const responses: FixtureResponse[] = [
  { prefix: ["api", "repos/fixture/project"], stdout: JSON.stringify({ html_url: "https://github.com/fixture/project", private: true, visibility: "private" }) },
];
const args = ["pr", "create", "--base", "main", "--title", "Feature", "--body", "Body", "--no-ai"];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("pull request push destination", () => {
  test("plans, shows and binds the exact push URL, not the fetch URL", async () => {
    const { root, repo, fetchBare, pushBare } = fixture();
    const preview = await runFixture([], { root, cwd: repo, responses, invoke: invoke([...args, "--dry-run", "--json"], fetchBare) });
    expect(preview.exitCode, preview.stderr).toBe(0);
    const planned = JSON.parse(preview.stdout);
    expect(planned.plan).toMatchObject({ remote: "origin", remoteUrl: "https://github.com/fixture/project.git", pushUrl: pushBare });
    const human = await runFixture([], { root, cwd: repo, responses, invoke: invoke([...args, "--dry-run"], fetchBare) });
    expect(human.exitCode, human.stderr).toBe(0);
    expect(human.stderr).toContain("push: " + pushBare);

    const elsewhere = join(root, "elsewhere.git"); git(["init", "--bare", elsewhere], root);
    git(["remote", "set-url", "--push", "origin", elsewhere], repo);
    const changed = await runFixture([], { root, cwd: repo, responses, invoke: invoke([...args, "--approve-plan", planned.snapshotId, "--json"], fetchBare) });
    expect(changed.exitCode).toBe(1);
    expect(changed.stderr).toContain("does not match --approve-plan");
    expect(changed.calls.some(call => call[0] === "pr" && call[1] === "create")).toBe(false);
    expect(git(["for-each-ref", "refs/heads/"], elsewhere)).toBe("");
    expect(git(["for-each-ref", "refs/heads/"], pushBare)).toBe("");
  });

  test("refuses several push URLs and credential-bearing push URLs at planning", async () => {
    const { root, repo, fetchBare } = fixture();
    git(["remote", "set-url", "--add", "--push", "origin", join(root, "second.git")], repo);
    const fanout = await runFixture([], { root, cwd: repo, responses, invoke: invoke([...args, "--dry-run", "--json"], fetchBare) });
    expect(fanout.exitCode).toBe(1);
    expect(JSON.parse(fanout.stdout)).toMatchObject({ status: "needs_input", message: expect.stringContaining("exactly one push URL") });

    git(["config", "--unset-all", "remote.origin.pushurl"], repo);
    git(["remote", "set-url", "--push", "origin", "https://fixture:not-a-token@example.test/project.git"], repo);
    const credential = await runFixture([], { root, cwd: repo, responses, invoke: invoke([...args, "--dry-run", "--json"], fetchBare) });
    expect(credential.exitCode).toBe(1);
    expect(credential.stdout).not.toContain("not-a-token");
    expect(JSON.parse(credential.stdout)).toMatchObject({ status: "needs_input", message: expect.stringContaining("embeds credentials") });
  });

  test("execution refuses a push URL changed after the plan was prepared, before any push", async () => {
    const { repo, pushBare } = fixture();
    const headTip = git(["rev-parse", "HEAD"], repo), baseTip = git(["rev-parse", "main"], repo);
    const plan: PullRequestPlan = { kind: "pr", cwd: repo, root: repo, source: repo, host: "github.com", target: "fixture/project", remote: "origin", remoteUrl: "https://github.com/fixture/project.git", pushUrl: join(repo, "..", "approved.git"), visibility: "private", remoteAtPrepare: "https://github.com/fixture/project.git", createRepository: false, head: "feature", headTip, base: "main", baseTip, localBaseTip: baseTip, mergeBaseTip: baseTip, steps: ["push_base", "push_head", "create_pull_request"] };
    const result = await executePublication(plan, { title: "Feature", body: "Body" });
    expect(result).toMatchObject({ status: "failed", completed: [], error: expect.stringContaining("push URL for remote \"origin\" changed") });
    expect(git(["for-each-ref", "refs/heads/"], pushBare)).toBe("");
  });
});
