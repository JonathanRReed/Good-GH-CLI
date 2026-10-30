import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parsePullRequestUrl, planNativeStack, stackMergeSet, type NativeStack } from "../src/services/github/stacks.ts";
import { run } from "../src/utils/exec.ts";
import { fixtureRoot, runFixture } from "./cli-fixture.ts";

const stackApi = ["api", "--hostname", "github.com", "-H", "X-GitHub-Api-Version: 2026-03-10"];
const sha = (char: string) => char.repeat(40);

function stack(number: number, members: Array<[number, string | null]>): NativeStack {
  return {
    number, open: true, baseRef: "main",
    pullRequests: members.map(([pr, mergedAt]) => ({ number: pr, state: mergedAt ? "closed" : "open", draft: false, mergedAt, headRef: `b${pr}`, headSha: sha(String(pr % 10)) })),
  };
}

function rawStack(number: number, members: Array<[number, string, string | null]>) {
  return { number, open: true, base: { ref: "main" }, pull_requests: members.map(([pr, head, merged]) => ({ number: pr, state: merged ? "closed" : "open", draft: false, merged_at: merged, head: { ref: `b${pr}`, sha: head } })) };
}

describe("native stack planning", () => {
  it("creates a stack when no PR is stacked", () => {
    expect(planNativeStack([1, 2, 3], new Map([[1, null], [2, null], [3, null]]))).toEqual({ action: "create", pullRequests: [1, 2, 3] });
  });

  it("extends a stack whose members are a prefix of the local order", () => {
    const existing = stack(7, [[1, null], [2, null]]);
    expect(planNativeStack([1, 2, 3], new Map([[1, existing], [2, existing], [3, null]]))).toEqual({ action: "add", number: 7, pullRequests: [3] });
  });

  it("ignores merged PRs at the bottom of an existing stack", () => {
    const existing = stack(7, [[9, "2026-10-01T00:00:00Z"], [1, null], [2, null]]);
    expect(planNativeStack([1, 2], new Map([[1, existing], [2, existing]]))).toEqual({ action: "unchanged", number: 7 });
  });

  it("refuses to reorder or merge someone else's stacks", () => {
    const reordered = stack(7, [[2, null], [1, null]]);
    expect(planNativeStack([1, 2], new Map([[1, reordered], [2, reordered]])).action).toBe("conflict");
    expect(planNativeStack([1, 2], new Map([[1, stack(7, [[1, null]])], [2, stack(8, [[2, null]])]])).action).toBe("conflict");
  });

  it("merges every unmerged PR below the target", () => {
    const existing = stack(7, [[9, "2026-10-01T00:00:00Z"], [1, null], [2, null], [3, null]]);
    expect(stackMergeSet(existing, 2).map(pr => pr.number)).toEqual([1, 2]);
    expect(stackMergeSet(existing, 4)).toEqual([]);
  });

  it("reads only HTTPS pull request URLs", () => {
    expect(parsePullRequestUrl("https://github.com/acme/demo/pull/42")).toEqual({ host: "github.com", nameWithOwner: "acme/demo", number: 42 });
    expect(parsePullRequestUrl("https://github.com/acme/demo/issues/42")).toBeNull();
    expect(parsePullRequestUrl("http://github.com/acme/demo/pull/42")).toBeNull();
  });
});

const root = fixtureRoot("ggh-native-stack-");
const repo = join(root, "repo");
const head = sha("a");
const detail = { number: 42, title: "Top", headRefName: "b42", headRefOid: head, baseRefName: "b41", state: "OPEN", url: "https://github.com/fixture/repo/pull/42" };
const lookup = { prefix: [...stackApi, "repos/fixture/repo/stacks?pull_request=42"], stdout: JSON.stringify([rawStack(5, [[41, sha("b"), null], [42, head, null], [43, sha("c"), null]])]) };

beforeAll(async () => {
  await run("git", ["init", "-b", "main", repo], { cwd: root });
  await run("git", ["config", "user.name", "Fixture"], { cwd: repo });
  await run("git", ["config", "user.email", "fixture@example.com"], { cwd: repo });
  writeFileSync(join(repo, "tracked"), "base\n");
  await run("git", ["add", "."], { cwd: repo });
  await run("git", ["-c", "commit.gpgsign=false", "commit", "-m", "base"], { cwd: repo });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("stacked merges", () => {
  it("discloses the PRs below, pins the head, and merges through the async API", async () => {
    const result = await runFixture(["pr", "merge", "42", "--squash", "--yes", "--json"], { root, cwd: repo, responses: [
      { prefix: ["pr", "view", "42"], stdout: JSON.stringify(detail) },
      lookup,
      { prefix: [...stackApi, "-X", "PUT", "repos/fixture/repo/pulls/42/merge-async"], stdout: JSON.stringify({ status: "pending", details: { uuid: "req-1", message: "pending" } }) },
      { prefix: [...stackApi, "repos/fixture/repo/pulls/42/merge-async/req-1"], stdout: JSON.stringify({ status: "merged", details: { message: "merged", sha: sha("d") } }) },
    ] });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.calls.some(call => call[0] === "pr" && call[1] === "merge")).toBe(false);
    expect(JSON.parse(result.inputs.find(input => input.args.includes("PUT"))?.text ?? "{}")).toEqual({ sha: head, merge_method: "squash" });
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({ number: 42, outcome: "merged", mergeRequestId: "req-1", stack: { number: 5, pullRequests: [{ number: 41 }, { number: 42 }] } });
    expect(payload.cleanupSkipped).toContain("ggh sync");
  });

  it("names the PRs below in the terminal preview", async () => {
    const result = await runFixture(["pr", "merge", "42", "--squash", "--dry-run"], { root, cwd: repo, responses: [
      { prefix: ["pr", "view", "42"], stdout: JSON.stringify(detail) }, lookup,
    ] });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toContain("also merges #41 in one atomic step");
    expect(result.calls.some(call => call.includes("PUT"))).toBe(false);
  });

  it("previews the whole merge set without merging", async () => {
    const result = await runFixture(["pr", "merge", "42", "--squash", "--dry-run", "--json"], { root, cwd: repo, responses: [
      { prefix: ["pr", "view", "42"], stdout: JSON.stringify(detail) }, lookup,
    ] });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "planned", stack: { number: 5, pullRequests: [{ number: 41, headSha: sha("b") }, { number: 42 }] } });
    expect(result.calls.some(call => call.includes("PUT"))).toBe(false);
  });

  it("refuses --auto on a stacked PR", async () => {
    const result = await runFixture(["pr", "merge", "42", "--squash", "--auto", "--yes", "--json"], { root, cwd: repo, responses: [
      { prefix: ["pr", "view", "42"], stdout: JSON.stringify(detail) }, lookup,
    ] });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("auto-merge");
    expect(result.calls.some(call => call.includes("PUT") || call[1] === "merge")).toBe(false);
  });

  it("reports a failed async merge as a failure", async () => {
    const result = await runFixture(["pr", "merge", "42", "--squash", "--yes", "--json"], { root, cwd: repo, responses: [
      { prefix: ["pr", "view", "42"], stdout: JSON.stringify(detail) }, lookup,
      { prefix: [...stackApi, "-X", "PUT"], stdout: JSON.stringify({ status: "failed", details: { message: "Required status check is failing" } }) },
    ] });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Required status check is failing");
  });

  it("keeps the single-PR merge for unstacked PRs", async () => {
    const result = await runFixture(["pr", "merge", "42", "--squash", "--yes", "--json", "--no-delete-branch"], { root, cwd: repo, responses: [
      { prefix: ["pr", "view", "42", "--json", "state,mergedAt,autoMergeRequest,mergeStateStatus"], stdout: JSON.stringify({ state: "MERGED", mergedAt: "now" }) },
      { prefix: ["pr", "view", "42"], stdout: JSON.stringify(detail) },
      { prefix: lookup.prefix, stdout: "[]" },
      { prefix: ["pr", "merge", "42"] },
    ] });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).outcome).toBe("merged");
    expect(result.calls.some(call => call.includes("PUT"))).toBe(false);
  });
});

describe("issue artifacts", () => {
  const issue = { number: 7, title: "Plan", state: "OPEN", url: "https://github.com/fixture/repo/issues/7", author: { login: "fixture" } };

  it("lists artifacts with the issue", async () => {
    const artifacts = [{ number: 1, name: "Implementation plan", type: "plan", url: "https://github.com/fixture/repo/issues/7/artifacts/1" }];
    const result = await runFixture(["issue", "7", "--json"], { root, cwd: repo, responses: [
      { prefix: ["issue", "view", "7"], stdout: JSON.stringify(issue) },
      { prefix: ["issue", "artifact", "list", "7"], stdout: JSON.stringify(artifacts) },
    ] });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).artifacts).toEqual({ state: "available", items: artifacts });
  });

  it("explains an older GitHub CLI without failing the issue view", async () => {
    const result = await runFixture(["issue", "7", "--json"], { root, cwd: repo, responses: [
      { prefix: ["issue", "view", "7"], stdout: JSON.stringify(issue) },
      { prefix: ["issue", "artifact"], stderr: 'unknown command "artifact" for "gh issue"', exitCode: 1 },
    ] });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).artifacts).toEqual({ state: "unavailable", reason: "Issue artifacts need GitHub CLI 2.103 or later." });
  });
});
