import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureRoot, runFixture } from "./cli-fixture.ts";

const root = fixtureRoot("ggh-json-empty-success-");
const repo = join(root, "repo");
const emptyRepo = join(root, "empty-repo");

beforeAll(async () => {
  const git = async (args: string[]) => {
    const child = Bun.spawn(["git", ...args], { cwd: root, stdout: "ignore", stderr: "pipe" });
    expect(await child.exited).toBe(0);
  };
  await git(["init", "-b", "main", repo]);
  await git(["-C", repo, "config", "user.name", "Fixture"]);
  await git(["-C", repo, "config", "user.email", "fixture@example.com"]);
  writeFileSync(join(repo, "tracked.txt"), "base\n");
  await git(["-C", repo, "add", "."]);
  await git(["-C", repo, "commit", "-m", "base"]);
  await git(["init", "-b", "main", emptyRepo]);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("JSON for successful actions and no-ops", () => {
  it("returns compact results for repo actions and keeps clone output parseable", async () => {
    const fork = await runFixture(["repo", "fork", "owner/project", "--yes", "--json"], {
      root,
      responses: [{ prefix: ["repo", "fork", "owner/project"], stdout: "https://github.com/fixture/project\n" }],
    });
    expect(fork.exitCode).toBe(0);
    expect(JSON.parse(fork.stdout)).toMatchObject({ action: "fork", nameWithOwner: "owner/project" });

    const setDefault = await runFixture(["repo", "set-default", "owner/project", "--json"], {
      root,
      responses: [{ prefix: ["repo", "set-default", "owner/project"] }],
    });
    expect(setDefault.exitCode).toBe(0);
    expect(JSON.parse(setDefault.stdout)).toMatchObject({ action: "set-default", nameWithOwner: "owner/project" });

    const clone = await runFixture(["repo", "clone", "owner/project", "--json"], {
      root,
      responses: [{ prefix: ["repo", "clone", "owner/project"], stdout: "Cloning into 'project'...\n" }],
    });
    expect(clone.exitCode).toBe(0);
    expect(JSON.parse(clone.stdout)).toMatchObject({ action: "clone", nameWithOwner: "owner/project" });
  });

  it("returns JSON for label and gist mutations", async () => {
    for (const [action, args] of [
      ["create", ["label", "create", "bug", "--yes", "--json"]],
      ["edit", ["label", "edit", "bug", "--description", "Fixed", "--yes", "--json"]],
      ["delete", ["label", "delete", "bug", "--yes", "--json"]],
    ] as const) {
      const result = await runFixture([...args], {
        root,
        cwd: repo,
        responses: [{ prefix: ["label", action, "bug"] }],
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ action, name: "bug" });
    }

    for (const action of ["edit", "delete"] as const) {
      const result = await runFixture(["gist", action, "fixture-gist", "--yes", "--json"], {
        root,
        responses: [{ prefix: ["gist", action, "fixture-gist"] }],
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ action, id: "fixture-gist" });
    }
  });

  it("returns JSON after opening a pull request in the browser", async () => {
    const result = await runFixture(["pr", "42", "--web", "--json"], {
      root,
      cwd: repo,
      responses: [{ prefix: ["pr", "view", "--web", "42"] }],
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ action: "open", number: 42 });
  });

  it("requires explicit yes for team publish in JSON mode and keeps dry-runs local", async () => {
    const missingYes = await runFixture(["team", "publish", "--json"], { root, cwd: repo });
    expect(missingYes.exitCode).not.toBe(0);
    expect(JSON.parse(missingYes.stdout)).toMatchObject({ status: "needs_input" });
    expect(missingYes.calls.filter((args) => args[0] === "gist" && args[1] === "create")).toHaveLength(0);

    const dryRun = await runFixture(["team", "publish", "--yes", "--dry-run", "--json"], { root, cwd: repo });
    expect(dryRun.exitCode).toBe(0);
    expect(JSON.parse(dryRun.stdout)).toMatchObject({ dryRun: true, gistUrl: null });
    expect(dryRun.calls.filter((args) => args[0] === "gist" && args[1] === "create")).toHaveLength(0);

    const published = await runFixture(["team", "publish", "--yes", "--json"], {
      root,
      cwd: repo,
      responses: [{ prefix: ["gist", "create"], stdout: "https://gist.github.com/fixture/stack\n" }],
    });
    expect(published.exitCode).toBe(0);
    expect(JSON.parse(published.stdout)).toMatchObject({ gistUrl: "https://gist.github.com/fixture/stack" });
    const input = published.inputs.find((entry) => entry.args[0] === "gist" && entry.args[1] === "create");
    expect(JSON.parse(input?.text ?? "{}")).toMatchObject({ user: "fixture", branch: "main" });
  });

  it("returns action results for workflow rerun and cancel", async () => {
    for (const [action, runId] of [["rerun", "41"], ["cancel", "42"]] as const) {
      const result = await runFixture(["run", action, runId, "--yes", "--json"], {
        root,
        cwd: repo,
        responses: [{ prefix: ["run", action, runId] }],
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ action, runId:  Number(runId) });
    }
  });

  it("returns worktree add and remove results", async () => {
    const added = await runFixture(["worktree", "add", "feature/json-result", "--json"], { root, cwd: repo });
    expect(added.exitCode).toBe(0);
    const addResult = JSON.parse(added.stdout);
    expect(addResult).toMatchObject({ action: "add", branch: "feature/json-result", base: "main", copiedEnvFiles: [] });

    const removed = await runFixture(["worktree", "remove", "feature/json-result", "--yes", "--json"], { root, cwd: repo });
    expect(removed.exitCode).toBe(0);
    expect(JSON.parse(removed.stdout)).toMatchObject({ action: "remove", path: addResult.path, forced: false });
  });

  it("returns reasoned no-op results instead of empty stdout", async () => {
    const cases = [
      { args: ["draft", "create", "--json"], cwd: repo, expected: { status: "no_op", reason: "no_uncommitted_changes" } },
      { args: ["sync", "--json"], cwd: repo, expected: { status: "no_op", reason: "no_remotes" } },
      { args: ["undo", "--json"], cwd: emptyRepo, expected: { status: "no_op", reason: "no_commits" } },
      { args: ["rename", "main", "--yes", "--json"], cwd: repo, expected: { status: "no_op", reason: "already_named" } },
      { args: ["discard", "--all", "--json"], cwd: repo, expected: { status: "no_op", reason: "no_changes" } },
      { args: ["squash", "--json"], cwd: repo, expected: { status: "no_op", reason: "fewer_than_two_commits" } },
      { args: ["worktree", "remove", "--json"], cwd: repo, expected: { status: "no_op", reason: "no_secondary_worktrees" } },
    ];

    for (const { args, cwd, expected } of cases) {
      const result = await runFixture(args, { root, cwd });
      expect(result.exitCode, `${args.join(" ")}: ${result.stderr}\n${result.stdout}`).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject(expected);
    }
  });

  it("returns a no-op for requested files without tracked changes", async () => {
    writeFileSync(join(repo, "tracked.txt"), "changed\n");
    const result = await runFixture(["discard", "missing.txt", "--json"], { root, cwd: repo });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "no_op", reason: "no_matching_changes" });
    writeFileSync(join(repo, "tracked.txt"), "base\n");
  });

  it("reports untracked files as excluded no-ops without deleting them", async () => {
    const untracked = join(repo, "untracked.txt");
    writeFileSync(untracked, "keep\n");

    const explicit = await runFixture(["discard", "untracked.txt", "--json"], { root, cwd: repo });
    expect(explicit.exitCode).toBe(0);
    expect(JSON.parse(explicit.stdout)).toMatchObject({ status: "no_op", reason: "untracked_files_excluded" });

    const all = await runFixture(["discard", "--all", "--json"], { root, cwd: repo });
    expect(all.exitCode).toBe(0);
    expect(JSON.parse(all.stdout)).toMatchObject({ status: "no_op", reason: "no_eligible_changes" });
    expect(await Bun.file(untracked).exists()).toBe(true);
    rmSync(untracked, { force: true });
  });
});
