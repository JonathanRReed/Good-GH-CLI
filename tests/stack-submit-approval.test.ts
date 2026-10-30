import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runFixture, type FixtureResponse } from "./cli-fixture.ts";

let root: string;
let bare: string;
setDefaultTimeout(60_000);

const stackApi = ["api", "--hostname", "github.com", "-H", "X-GitHub-Api-Version: 2026-03-10"];

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function commit(path: string): void {
  writeFileSync(join(root, path), path + "\n");
  git("add", "--", path);
  git("commit", "-m", path);
}

function stackOn(child: string, parent: string): void {
  git("switch", "-c", child);
  git("config", "branch." + child + ".gh-merge-base", parent);
  git("config", "branch." + child + ".gh-merge-base-sha", git("rev-parse", parent));
  commit(child + ".txt");
}

function remoteHeads(): string {
  return execFileSync("git", ["--git-dir", bare, "for-each-ref", "--format=%(refname)", "refs/heads/"], { encoding: "utf8" }).trim();
}

let runs = 0;
async function submit(args: string[], responses: FixtureResponse[] = []) {
  const fixture = join(root, "fixture-" + runs++ + "-");
  mkdirSync(fixture, { recursive: true });
  const result = await runFixture(["stack", "submit", ...args], { root: fixture, cwd: root, responses });
  return { ...result, json: result.stdout.trim() ? JSON.parse(result.stdout) : undefined };
}

const created: FixtureResponse[] = [
  { prefix: ["pr", "view"], stdout: "" },
  { prefix: ["pr", "create", "--title", "first"], stdout: "https://github.com/test/repo/pull/1" },
  { prefix: ["pr", "create", "--title", "second"], stdout: "https://github.com/test/repo/pull/2" },
  ...[1, 2].map(number => ({ prefix: [...stackApi, `repos/test/repo/stacks?pull_request=${number}`], stdout: "[]" })),
  { prefix: [...stackApi, "-X", "POST", "repos/test/repo/stacks"], stdout: JSON.stringify({ number: 7, open: true, base: { ref: "main" }, pull_requests: [1, 2].map(number => ({ number, state: "open", head: { ref: "b", sha: "c".repeat(40) } })) }) },
];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ggh-stack-submit-")));
  git("init", "-b", "main");
  git("config", "user.name", "Stack tests");
  git("config", "user.email", "stack-tests@example.invalid");
  git("config", "commit.gpgsign", "false");
  commit("base.txt");
  bare = join(root, "remote.git");
  execFileSync("git", ["init", "--bare", "--initial-branch=main", bare], { stdio: "ignore" });
  git("remote", "add", "origin", "https://github.com/test/repo.git");
  git("config", "url." + pathToFileURL(bare).href + ".insteadOf", "https://github.com/test/repo.git");
  git("push", "-u", "origin", "main");
  stackOn("first", "main");
  stackOn("second", "first");
  git("switch", "main");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("stack submit approval", () => {
  it("plans a snapshot bound to the repository, push URL, tips, parents and choices, with per-step effects", async () => {
    const preview = await submit(["second", "--dry-run", "--agent"]);
    expect(preview.exitCode, preview.stderr).toBe(0);
    const snapshot: string = preview.json.result.snapshotId;
    expect(preview.json).toMatchObject({
      status: "planned",
      result: {
        snapshotId: expect.stringMatching(/^[a-f0-9]{64}$/),
        plan: {
          host: "github.com", repository: "test/repo", draft: false, nativeStack: true, allowStale: false,
          entries: [
            { branch: "first", parent: "main", tip: git("rev-parse", "first"), parentTip: git("rev-parse", "main"), behind: 0, remote: "origin", pushUrl: pathToFileURL(bare).href },
            { branch: "second", parent: "first", tip: git("rev-parse", "second"), parentTip: git("rev-parse", "first"), behind: 0, remote: "origin", pushUrl: pathToFileURL(bare).href },
          ],
        },
      },
      effects: { completed: [], pending: ["push:first", "create_pr:first", "push:second", "create_pr:second", "link_native_stack"], uncertain: [] },
    });
    expect(preview.calls.filter(call => call[0] !== "auth")).toEqual([]);
    expect(remoteHeads()).toBe("refs/heads/main");
    const again = await submit(["second", "--dry-run", "--agent"]);
    expect(again.json.result.snapshotId).toBe(snapshot);
    const draft = await submit(["second", "--draft", "--dry-run", "--agent"]);
    const unlinked = await submit(["second", "--no-native-stack", "--dry-run", "--agent"]);
    expect(new Set([snapshot, draft.json.result.snapshotId, unlinked.json.result.snapshotId]).size).toBe(3);
  });

  it("does not treat an agent's --yes as approval", async () => {
    const result = await submit(["second", "--yes", "--agent"], created);
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({ status: "needs_input", error: { code: "confirmation_required" }, requiredInputs: [{ name: "--approve-plan" }] });
    expect(result.calls.filter(call => call[0] === "pr")).toEqual([]);
    expect(remoteHeads()).toBe("refs/heads/main");
  });

  it("executes only the approved snapshot and opens Pull Requests in the planned repository", async () => {
    const preview = await submit(["second", "--dry-run", "--agent"]);
    const snapshot = preview.json.result.snapshotId;
    const applied = await submit(["second", "--agent", "--approve-plan", snapshot], created);
    expect(applied.exitCode, applied.stderr).toBe(0);
    expect(applied.json).toMatchObject({
      status: "succeeded",
      result: { snapshotId: snapshot, nativeStack: { state: "created", number: 7 } },
      effects: { completed: ["push:first", "create_pr:first", "push:second", "create_pr:second", "link_native_stack"], pending: [], uncertain: [] },
    });
    const creates = applied.calls.filter(call => call[0] === "pr" && call[1] === "create");
    expect(creates).toHaveLength(2);
    for (const call of creates) expect(call[call.indexOf("--repo") + 1]).toMatch(/test\/repo$/);
    expect(remoteHeads().split("\n").sort()).toEqual(["refs/heads/first", "refs/heads/main", "refs/heads/second"]);
  });

  it("refuses approval after a branch tip or the push URL changes, before pushing anything", async () => {
    const snapshot = (await submit(["second", "--dry-run", "--agent"])).json.result.snapshotId;
    git("switch", "second"); commit("late.txt"); git("switch", "main");
    const moved = await submit(["second", "--agent", "--approve-plan", snapshot], created);
    expect(moved.exitCode).toBe(1);
    expect(moved.json).toMatchObject({ status: "needs_input", error: { code: "confirmation_required" } });

    const fresh = (await submit(["second", "--dry-run", "--agent"])).json.result.snapshotId;
    const elsewhere = join(root, "elsewhere.git");
    execFileSync("git", ["init", "--bare", "--initial-branch=main", elsewhere], { stdio: "ignore" });
    git("remote", "set-url", "--push", "origin", elsewhere);
    const redirected = await submit(["second", "--agent", "--approve-plan", fresh], created);
    expect(redirected.exitCode).toBe(1);
    expect(redirected.json).toMatchObject({ status: "needs_input", error: { code: "confirmation_required" } });
    expect(redirected.calls.filter(call => call[0] === "pr")).toEqual([]);
    expect(remoteHeads()).toBe("refs/heads/main");
    expect(execFileSync("git", ["--git-dir", elsewhere, "for-each-ref", "refs/heads/"], { encoding: "utf8" }).trim()).toBe("");
  });

  it("refuses a branch that is behind its parent unless --allow-stale is given", async () => {
    git("switch", "first"); commit("parent-moved.txt"); git("switch", "main");
    const stale = await submit(["second", "--dry-run", "--agent"]);
    expect(stale.exitCode).toBe(1);
    expect(stale.json).toMatchObject({
      status: "needs_input",
      error: { code: "missing_input", message: expect.stringContaining("second is 1 behind first") },
      requiredInputs: [{ name: "--allow-stale", alternatives: ["ggh stack restack second"] }],
      result: { stale: [{ branch: "second", parent: "first", behind: 1 }] },
    });
    const allowed = await submit(["second", "--allow-stale", "--dry-run", "--agent"]);
    expect(allowed.exitCode, allowed.stderr).toBe(0);
    expect(allowed.json.result.plan).toMatchObject({ allowStale: true, entries: [{ behind: 0 }, { behind: 1 }] });
  });

  it("refuses a push remote that is not GitHub, and more than one push URL", async () => {
    git("remote", "set-url", "origin", bare);
    git("config", "--unset", "url." + pathToFileURL(bare).href + ".insteadOf");
    const local = await submit(["second", "--dry-run", "--agent"]);
    expect(local.exitCode).toBe(1);
    expect(local.json.error.message).toContain("is not a GitHub repository URL");

    git("remote", "set-url", "origin", "https://github.com/test/repo.git");
    git("remote", "set-url", "--add", "--push", "origin", bare);
    git("remote", "set-url", "--add", "--push", "origin", join(root, "second.git"));
    const fanout = await submit(["second", "--dry-run", "--agent"]);
    expect(fanout.exitCode).toBe(1);
    expect(fanout.json.error.message).toContain("exactly one push URL");
  });
});
