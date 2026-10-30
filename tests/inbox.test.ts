import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { authoredFirst, classifyAuthored, findLocalClone, inboxQuery, nextSteps, validInboxFilter, type InboxPullRequestData } from "../src/services/inbox.ts";
import type { IndexedClone } from "../src/services/projects/types.ts";
import { run } from "../src/utils/exec.ts";
import { fixtureRoot, runFixture } from "./cli-fixture.ts";

function pr(overrides: Partial<InboxPullRequestData> = {}): InboxPullRequestData {
  return {
    repo: "fixture/example", number: 7, title: "Fix", url: "https://github.com/fixture/example/pull/7", draft: false, author: "fixture",
    updatedAt: "2026-10-28T00:00:00Z", headRefName: "fix-ci", baseRefName: "main", defaultBranch: "main", checks: "SUCCESS", reviewDecision: "APPROVED", mergeable: "MERGEABLE", mergeQueue: null,
    ...overrides,
  };
}

describe("inbox classification", () => {
  it("puts failing checks, requested changes, and conflicts in needs-fix, ahead of readiness", () => {
    expect(classifyAuthored(pr({ checks: "FAILURE" }))).toEqual({ section: "needsFix", reasons: ["checks_failing"] });
    expect(classifyAuthored(pr({ checks: "ERROR" })).reasons).toEqual(["checks_failing"]);
    expect(classifyAuthored(pr({ reviewDecision: "CHANGES_REQUESTED", mergeable: "CONFLICTING" }))).toEqual({ section: "needsFix", reasons: ["changes_requested", "conflicts"] });
    expect(classifyAuthored(pr({ checks: "FAILURE", mergeQueue: { position: 1 } })).section).toBe("needsFix");
    expect(classifyAuthored(pr({ checks: "FAILURE", draft: true })).section).toBe("needsFix");
  });

  it("calls a PR ready only when review, checks, and mergeability all allow it, or it is queued", () => {
    expect(classifyAuthored(pr())).toEqual({ section: "readyToMerge", reasons: ["approved", "checks_passing", "mergeable"] });
    expect(classifyAuthored(pr({ reviewDecision: null, checks: null }))).toEqual({ section: "readyToMerge", reasons: ["no_review_required", "no_checks", "mergeable"] });
    expect(classifyAuthored(pr({ reviewDecision: "REVIEW_REQUIRED", checks: "PENDING", mergeQueue: { position: 2 } }))).toEqual({ section: "readyToMerge", reasons: ["merge_queue"] });
    for (const waiting of [{ reviewDecision: "REVIEW_REQUIRED" }, { checks: "PENDING" }, { checks: "EXPECTED" }, { checks: "UNKNOWN" }, { mergeable: "UNKNOWN" }, { draft: true }]) {
      expect(classifyAuthored(pr(waiting))).toEqual({ section: null, reasons: [] });
    }
  });

  it("builds bounded, read-only search queries with an owner or repo filter", () => {
    const query = inboxQuery(10, "acme/demo");
    expect(query).toContain("review-requested:@me");
    expect(query).toContain("author:@me");
    expect(query).toContain("repo:acme/demo");
    expect(query).toContain("first: 10");
    expect(query).toContain(`first: ${authoredFirst(10)}`);
    expect(query).not.toContain("mutation");
    expect(inboxQuery(10, "acme")).toContain("user:acme");
    expect([authoredFirst(1), authoredFirst(30), authoredFirst(50)]).toEqual([50, 100, 100]);
    for (const good of ["acme", "acme/demo", "a-b/c.d_e"]) expect(validInboxFilter(good)).toBe(true);
    for (const bad of ["", "acme/", "-acme", "a b", "acme/demo/x", "acme\" is:closed"]) expect(validInboxFilter(bad)).toBe(false);
  });
});

describe("inbox local cross-reference", () => {
  const clone = (path: string, owner: string, name: string, branch: string): IndexedClone => ({
    commonDir: `${path}/.git`, displayName: name, primary: { host: "github.com", owner, name },
    remotes: [{ name: "origin", url: `https://github.com/${owner}/${name}.git`, repo: { host: "github.com", owner, name } }],
    checkouts: [{ path, gitDir: `${path}/.git`, branch, head: null, bare: false, locked: null, prunable: null, createdBy: "unknown", hostClaims: [] }],
    sources: ["root-scan"], lastSeen: "2026-10-28T00:00:00Z",
  });
  const clones = [clone("/w/example", "fixture", "example", "main"), clone("/w/example-fix", "fixture", "example", "fix-ci"), clone("/w/lib", "other", "lib", "main")];

  it("prefers the checkout on your PR head branch and names it by path", () => {
    expect(findLocalClone("github.com", pr(), clones, true)).toEqual({ name: "/w/example-fix", path: "/w/example-fix", branchCheckedOut: true, clones: 2 });
    expect(findLocalClone("github.com", pr(), clones, false)).toMatchObject({ path: "/w/example", branchCheckedOut: false, clones: 2 });
    expect(findLocalClone("github.com", pr({ repo: "OTHER/LIB" }), clones, false)).toEqual({ name: "OTHER/LIB", path: "/w/lib", branchCheckedOut: false, clones: 1 });
    expect(findLocalClone("github.com", pr({ repo: "nobody/here" }), clones, true)).toBeNull();
    expect(findLocalClone("ghe.example.com", pr({ repo: "other/lib" }), clones, true)).toBeNull();
    expect(findLocalClone("github.com", pr({ repo: "other/lib" }), [{ ...clone("/w/lib", "other", "lib", "main"), missing: true }], true)).toBeNull();
  });

  it("suggests one self-contained command per PR, runnable from any directory", () => {
    const local = { name: "fixture/example", path: "/w/example", branchCheckedOut: false, clones: 1 };
    // `go` cannot move the caller's shell, so local work is behind cd "$(ggh go ... --print)",
    // and remote commands carry -R rather than trusting the current directory.
    expect(nextSteps("reviewRequested", "github.com", pr(), ["requested_directly"], local)).toEqual([`cd "$(ggh go fixture/example --print)" && ggh review 7`]);
    expect(nextSteps("reviewRequested", "github.com", pr(), ["requested_via_team"], null)).toEqual([`ggh clone fixture/example && cd "$(ggh go fixture/example --print)" && ggh review 7`]);
    expect(nextSteps("needsFix", "github.com", pr(), ["checks_failing", "conflicts"], local)).toEqual(["ggh ci why 7 -R fixture/example"]);
    expect(nextSteps("needsFix", "github.com", pr(), ["checks_failing"], null)).toEqual(["ggh ci why 7 -R fixture/example"]);
    expect(nextSteps("needsFix", "github.com", pr(), ["changes_requested"], local)).toEqual(["ggh pr threads 7 -R fixture/example"]);
    expect(nextSteps("needsFix", "github.com", pr(), ["conflicts"], local)).toEqual([`cd "$(ggh go fixture/example --print)" && ggh switch fix-ci`]);
    expect(nextSteps("needsFix", "github.com", pr(), ["conflicts"], { ...local, branchCheckedOut: true })).toEqual([`cd "$(ggh go fixture/example --print)"`]);
    expect(nextSteps("needsFix", "github.com", pr(), ["conflicts"], null)).toEqual(["ggh clone fixture/example"]);
    expect(nextSteps("readyToMerge", "github.com", pr(), ["approved", "checks_passing", "mergeable"], local)).toEqual(["ggh pr merge 7 -R fixture/example"]);
    expect(nextSteps("readyToMerge", "ghe.example.com", pr(), ["merge_queue"], null)).toEqual(["ggh pr view 7 -R ghe.example.com/fixture/example"]);
    // clone accepts OWNER/REPO or a URL, so enterprise suggestions use the repository URL.
    expect(nextSteps("needsFix", "ghe.example.com", pr(), ["conflicts"], null)).toEqual(["ggh clone https://ghe.example.com/fixture/example"]);
    expect(nextSteps("reviewRequested", "ghe.example.com", pr(), [], null)[0]).toStartWith("ggh clone https://ghe.example.com/fixture/example && ");
    // Quoting: safe words stay readable, hostile ones are single-quoted for pasting.
    expect(nextSteps("needsFix", "github.com", pr({ repo: "acme/we ird" }), ["changes_requested"], null)).toEqual(["ggh pr threads 7 -R 'acme/we ird'"]);
    expect(nextSteps("needsFix", "github.com", pr({ repo: "acme/it's" }), ["changes_requested"], null)).toEqual([`ggh pr threads 7 -R 'acme/it'"'"'s'`]);
    expect(nextSteps("needsFix", "github.com", pr({ headRefName: "fix feature" }), ["conflicts"], local)).toEqual([`cd "$(ggh go fixture/example --print)" && ggh switch 'fix feature'`]);
  });
});

const root = fixtureRoot("ggh-inbox-");
const repos = join(root, "repos");
const repo = join(repos, "example");
beforeAll(async () => {
  mkdirSync(repo, { recursive: true });
  for (const args of [["init", "-b", "main"], ["config", "user.name", "Fixture"], ["config", "user.email", "fixture@example.invalid"], ["commit", "--allow-empty", "-m", "initial"], ["remote", "add", "origin", "https://github.com/fixture/example.git"], ["switch", "-c", "fix-ci"]]) await run("git", args, { cwd: repo });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function node(number: number, repo: string, fields: Record<string, unknown> = {}) {
  const { checks = "SUCCESS", ...rest } = fields;
  return {
    number, title: `PR ${number}`, url: `https://github.com/${repo}/pull/${number}`, isDraft: false, updatedAt: "2026-10-28T00:00:00Z",
    headRefName: `b${number}`, baseRefName: "main", repository: { nameWithOwner: repo, defaultBranchRef: { name: "main" } }, author: { login: "fixture" },
    reviewDecision: null, mergeable: "MERGEABLE", mergeQueueEntry: null, commits: { nodes: [{ commit: { statusCheckRollup: checks === null ? null : { state: checks } } }] },
    ...rest,
  };
}
const review = { issueCount: 2, nodes: [
  node(5, "fixture/example", { author: { login: "teammate" }, reviewRequests: { nodes: [{ requestedReviewer: { __typename: "User", login: "fixture" } }] } }),
  node(6, "other/lib", { isDraft: true, author: null, reviewRequests: { nodes: [{ requestedReviewer: { __typename: "Team", combinedSlug: "other/core" } }, { requestedReviewer: null }] } }),
] };
const authored = { issueCount: 10, nodes: [
  node(7, "fixture/example", { checks: "FAILURE", headRefName: "fix-ci" }),
  node(8, "fixture/example", { reviewDecision: "CHANGES_REQUESTED", mergeable: "CONFLICTING" }),
  node(9, "other/lib", { reviewDecision: "APPROVED" }),
  node(10, "other/lib", { reviewDecision: "REVIEW_REQUIRED", checks: "PENDING", mergeQueueEntry: { position: 2 } }),
  node(11, "other/lib", { checks: null }),
  node(12, "other/lib", { reviewDecision: "REVIEW_REQUIRED" }),
  node(13, "other/lib", { isDraft: true }),
  node(14, "other/lib", { checks: "PENDING" }),
  null,
  // A field error nulls the rollup; it must not read as "no checks".
  node(16, "other/lib", { checks: null }),
] };
const nodeErrors = [
  { message: "Resource protected by organization SAML enforcement.", path: ["authored", "nodes", 8] },
  { message: "Something went wrong while executing your query.", path: ["authored", "nodes", 9, "commits", "nodes", 0, "commit", "statusCheckRollup"] },
  { message: "Your token has not been granted the required scopes to read teams.", path: ["review", "nodes", 1, "reviewRequests", "nodes", 1, "requestedReviewer"] },
];
const rateLimit = { remaining: 4999, resetAt: "2099-01-01T00:00:00Z", cost: 1 };
const fullResponse = { data: { viewer: { login: "fixture" }, review, authored, rateLimit }, errors: nodeErrors };

const entry = join(import.meta.dir, "..", "src", "index.ts");
const indexStore = join(import.meta.dir, "..", "src", "services", "projects", "index-store.ts");
// Inbox reads the projects index without refreshing it, so build it first in the same process.
function inbox(args: string[], body: unknown, extra: { stdout?: string; exitCode?: number; stderr?: string } = {}) {
  return runFixture([], {
    root, config: { project_roots: [repos], host_worktree_dirs: {} },
    responses: [{ prefix: ["api", "graphql"], stdout: extra.stdout ?? JSON.stringify(body), ...(extra.exitCode !== undefined ? { exitCode: extra.exitCode } : {}), ...(extra.stderr ? { stderr: extra.stderr } : {}) }],
    invoke: `
      const { refreshProjectIndex } = await import(${JSON.stringify(indexStore)});
      await refreshProjectIndex();
      const { runCli } = await import(${JSON.stringify(entry)});
      await runCli(['bun', 'ggh', 'inbox', ...${JSON.stringify(args)}]);
    `,
  });
}

describe("ggh inbox", () => {
  it("returns three classified sections tied to local clones in one read-only request", async () => {
    const receipt = await inbox(["--json"], fullResponse);
    expect(receipt.exitCode, receipt.stderr).toBe(0);
    const result = JSON.parse(receipt.stdout);
    expect(result).toMatchObject({ schemaVersion: 1, host: "github.com", login: "fixture", filter: null, limit: 10, waiting: 4, requests: 1, cost: 1, local: { clones: 1 } });
    const { reviewRequested, needsFix, readyToMerge } = result.sections;
    expect(reviewRequested).toMatchObject({ state: "available", total: 2, complete: true, skipped: 0 });
    expect(reviewRequested.items[0]).toMatchObject({ number: 5, defaultBranch: "main", reasons: ["requested_directly"], request: { direct: true, teams: [] }, local: { name: "fixture/example", path: repo, branchCheckedOut: false }, next: [`cd "$(ggh go fixture/example --print)" && ggh review 5`] });
    expect(reviewRequested.items[1]).toMatchObject({ number: 6, draft: true, author: null, reasons: ["requested_via_team"], request: { direct: false, teams: ["other/core"] }, local: null, next: [`ggh clone other/lib && cd "$(ggh go other/lib --print)" && ggh review 6`] });
    expect(needsFix).toMatchObject({ state: "available", total: 2, complete: false, skipped: 1, skippedReason: "Resource protected by organization SAML enforcement." });
    expect(needsFix.items.map((item: { number: number; reasons: string[] }) => [item.number, item.reasons])).toEqual([[7, ["checks_failing"]], [8, ["changes_requested", "conflicts"]]]);
    expect(needsFix.items[0]).toMatchObject({ checks: "FAILURE", local: { name: repo, path: repo, branchCheckedOut: true }, next: ["ggh ci why 7 -R fixture/example"] });
    expect(needsFix.items[1].next).toEqual(["ggh pr threads 8 -R fixture/example"]);
    expect(readyToMerge.items.map((item: { number: number; reasons: string[] }) => [item.number, item.reasons])).toEqual([[9, ["approved", "checks_passing", "mergeable"]], [10, ["merge_queue"]], [11, ["no_review_required", "no_checks", "mergeable"]]]);
    expect(readyToMerge.items[1]).toMatchObject({ mergeQueue: { position: 2 }, next: ["ggh pr view 10 -R other/lib"] });
    expect(readyToMerge.items[0].next).toEqual(["ggh pr merge 9 -R other/lib"]);
    expect(Object.keys(readyToMerge.items[0]).sort()).toEqual(["author", "baseRefName", "checks", "defaultBranch", "draft", "headRefName", "local", "mergeQueue", "mergeable", "next", "number", "reasons", "repo", "reviewDecision", "title", "updatedAt", "url"]);
    // Only auth and one GraphQL query; nothing that writes.
    expect(receipt.calls.filter(call => call[0] !== "auth")).toEqual([["api", "graphql", "--hostname", "github.com", "--include", "--input", "-"]]);
    expect(receipt.inputs).toHaveLength(1);
    expect(receipt.inputs[0]?.text).not.toContain("mutation");
  });

  it("applies --limit per section and an owner/repo filter", async () => {
    const receipt = await inbox(["acme/demo", "--limit", "1", "--agent"], fullResponse);
    expect(receipt.exitCode, receipt.stderr).toBe(0);
    const envelope = JSON.parse(receipt.stdout);
    expect(envelope).toMatchObject({ contract: "ggh.agent", command: ["inbox"], status: "succeeded", effects: { completed: [], pending: [], uncertain: [] } });
    expect(envelope.result).toMatchObject({ filter: "acme/demo", limit: 1, sections: { reviewRequested: { total: 2 }, needsFix: { total: 2 }, readyToMerge: { total: 3 } } });
    for (const name of ["reviewRequested", "needsFix", "readyToMerge"]) expect(envelope.result.sections[name].items).toHaveLength(1);
    const query = JSON.parse(receipt.inputs[0]?.text ?? "{}").query as string;
    expect(query).toContain("repo:acme/demo");
    expect(query).toContain("first: 1)");
  });

  it("reports one failed section and keeps the others", async () => {
    const receipt = await inbox(["--json"], { data: { viewer: { login: "fixture" }, review: null, authored, rateLimit }, errors: [{ message: "Something went wrong while executing your query.", path: ["review"] }] });
    expect(receipt.exitCode, receipt.stderr).toBe(0);
    const { sections } = JSON.parse(receipt.stdout);
    expect(sections.reviewRequested).toEqual({ state: "unavailable", reason: "Something went wrong while executing your query." });
    expect(sections.needsFix.state).toBe("available");
    expect(sections.readyToMerge.state).toBe("available");
  });

  it("fails with every section unavailable when GitHub cannot answer", async () => {
    const receipt = await inbox(["--agent"], null, { stdout: "", stderr: "HTTP 502: Bad Gateway", exitCode: 1 });
    expect(receipt.exitCode).toBe(1);
    const envelope = JSON.parse(receipt.stdout);
    expect(envelope).toMatchObject({ status: "failed", error: { code: "provider_unavailable" } });
    expect(envelope.error.message).toContain("502");
    for (const name of ["reviewRequested", "needsFix", "readyToMerge"]) expect(envelope.result.sections[name].state).toBe("unavailable");
  });

  it("renders a compact grouped list on stderr with drafts and next commands", async () => {
    const receipt = await inbox([], fullResponse);
    expect(receipt.exitCode, receipt.stderr).toBe(0);
    expect(receipt.stdout).toBe("");
    for (const text of ["Review requested  2", "#6 other/lib PR 6 [draft]", "via other/core · no local clone", `→ cd "$(ggh go fixture/example --print)" && ggh review 5`, "Needs your fix  2+", "checks failing · on fix-ci · ", "→ ggh ci why 7 -R fixture/example", "Ready to merge  3+", "→ ggh pr merge 9 -R other/lib", "in merge queue", "no checks (unverified)", "1 of your PRs hidden: Resource protected", "4 more of your open PRs are waiting"]) expect(receipt.stderr).toContain(text);
  });

  it("flags stacked PRs and shows a non-default base, without calling them green", async () => {
    const body = { data: { viewer: { login: "fixture" }, review: { issueCount: 0, nodes: [] }, authored: { issueCount: 3, nodes: [
      node(17, "fixture/example", { headRefName: "feat/universe" }),
      node(18, "fixture/example", { headRefName: "feat/inbox", baseRefName: "feat/universe" }),
      node(19, "fixture/example", { checks: null, repository: { nameWithOwner: "fixture/example", defaultBranchRef: null } }),
    ] }, rateLimit } };
    const receipt = await inbox([], body);
    expect(receipt.exitCode, receipt.stderr).toBe(0);
    expect(receipt.stdout).toBe("");
    for (const text of ["Ready to merge  3", "#17", "no review required · checks pass · mergeable", "stacked on #17", "base feat/universe", "#19", "no checks (unverified)"]) expect(receipt.stderr).toContain(text);
    // The plainly green PR shows no base (it targets the default branch), and the
    // stacked one names both the PR below it and its base branch.
    expect(receipt.stderr).not.toContain("base main");
    expect(receipt.stderr).toContain("#18 fixture/example PR 18");
    expect(receipt.stderr).toContain("no review required · checks pass · mergeable · stacked on #17 · base feat/universe");
    const json = await inbox(["--json"], body);
    const { readyToMerge } = JSON.parse(json.stdout).sections;
    expect(readyToMerge.items.map((item: { number: number }) => item.number)).toEqual([17, 18, 19]);
    expect(readyToMerge.items[0]).toMatchObject({ reasons: ["no_review_required", "checks_passing", "mergeable"], defaultBranch: "main" });
    expect(readyToMerge.items[0].stackedOn).toBeUndefined();
    expect(readyToMerge.items[1]).toMatchObject({ reasons: ["no_review_required", "checks_passing", "mergeable", "stacked"], stackedOn: 17, baseRefName: "feat/universe", defaultBranch: "main" });
    expect(readyToMerge.items[2]).toMatchObject({ reasons: ["no_review_required", "no_checks", "mergeable"], defaultBranch: null });
  });

  it("keeps the inbox when the projects index is unreadable", async () => {
    const receipt = await runFixture([], {
      root, responses: [{ prefix: ["api", "graphql"], stdout: JSON.stringify(fullResponse) }],
      invoke: `
        const { mkdirSync, writeFileSync } = await import("node:fs");
        mkdirSync(process.env.XDG_CONFIG_HOME + "/good-gh", { recursive: true, mode: 0o700 });
        writeFileSync(process.env.XDG_CONFIG_HOME + "/good-gh/projects.json", "{", { mode: 0o600 });
        const { runCli } = await import(${JSON.stringify(entry)});
        await runCli(["bun", "ggh", "inbox", "--json"]);
      `,
    });
    expect(receipt.exitCode, receipt.stderr).toBe(0);
    const result = JSON.parse(receipt.stdout);
    expect(result.local.clones).toBe(0);
    expect(result.sections.reviewRequested.items[0].local).toBeNull();
  });

  it("preserves the foreground rate-limit reserve without calling GraphQL", async () => {
    const remote = join(import.meta.dir, "..", "src", "services", "projects", "remote.ts");
    const cache = join(import.meta.dir, "..", "src", "services", "cache.ts");
    const receipt = await runFixture([], {
      root, responses: [{ prefix: ["api", "graphql"], stdout: JSON.stringify(fullResponse) }],
      invoke: `
        const { remoteBudgetKey } = await import(${JSON.stringify(remote)});
        const { writeCacheValue } = await import(${JSON.stringify(cache)});
        writeCacheValue(remoteBudgetKey("github.com", "fixture"), { remaining: 10, resetAt: "2099-01-01T00:00:00.000Z", cost: 1 });
        const { runCli } = await import(${JSON.stringify(entry)});
        await runCli(["bun", "ggh", "inbox", "--json"]);
      `,
    });
    expect(receipt.exitCode).toBe(1);
    expect(receipt.calls.filter(call => call[0] === "api")).toEqual([]);
    const result = JSON.parse(receipt.stdout);
    for (const name of ["reviewRequested", "needsFix", "readyToMerge"]) expect(result.sections[name]).toEqual({ state: "unavailable", reason: "Foreground rate-limit reserve", retryAt: "2099-01-01T00:00:00.000Z" });
  });

  it("rejects a malformed filter before calling GitHub", async () => {
    const receipt = await runFixture(["inbox", "acme/demo is:closed", "--json"], { root });
    expect(receipt.exitCode).toBe(1);
    expect(receipt.calls).toEqual([]);
  });

  it("rejects an invalid --limit instead of silently defaulting, and says when it clamps", async () => {
    for (const value of ["0", "abc", "-3", "1.5", ""]) {
      const receipt = await runFixture(["inbox", "--limit", value, "--json"], { root });
      expect(receipt.exitCode, value).toBe(1);
      expect(receipt.stderr).toContain(`Invalid --limit ${JSON.stringify(value)}. Use a whole number from 1 to 50.`);
      expect(receipt.calls).toEqual([]);
    }
    const clamped = await runFixture(["inbox", "--limit", "500", "--json"], { root, responses: [{ prefix: ["api", "graphql"], stdout: JSON.stringify(fullResponse) }] });
    expect(clamped.exitCode, clamped.stderr).toBe(0);
    const clampedResult = JSON.parse(clamped.stdout);
    expect(clampedResult.limit).toBe(50);
    // The JSON payload says it too: the request was adjusted.
    expect(clampedResult.requestedLimit).toBe(500);
    const clampedHuman = await runFixture(["inbox", "--limit", "500"], { root, responses: [{ prefix: ["api", "graphql"], stdout: JSON.stringify(fullResponse) }] });
    expect(clampedHuman.exitCode, clampedHuman.stderr).toBe(0);
    expect(clampedHuman.stderr).toContain("--limit 500 is above the maximum of 50; showing 50 per section.");
    const exact = await runFixture(["inbox", "--limit", "3", "--json"], { root, responses: [{ prefix: ["api", "graphql"], stdout: JSON.stringify(fullResponse) }] });
    expect(exact.exitCode, exact.stderr).toBe(0);
    const exactResult = JSON.parse(exact.stdout);
    expect(exactResult.limit).toBe(3);
    expect(exactResult.requestedLimit).toBeUndefined();
    expect(exact.stderr).not.toContain("maximum");
  });

  it("advertises its result schema to agents", async () => {
    const receipt = await runFixture(["agent", "schema"], { root });
    expect(receipt.exitCode, receipt.stderr).toBe(0);
    const schema = JSON.parse(receipt.stdout);
    expect(schema.coreResultSchemas.inbox.commandPaths).toEqual([["inbox"]]);
    expect(schema.coreResultSchemas.inbox.schema.properties.sections.required).toEqual(["reviewRequested", "needsFix", "readyToMerge"]);
  });
});

// Every suggestion inbox prints is one self-contained command that works from
// any directory. Each form below runs against the gh fixture from a directory
// that is not a repository: the cd forms simulate the shell cd.
describe("inbox suggestions work from any directory", () => {
  it("ggh ci why <n> -R <repo> answers outside any repository", async () => {
    const sha = "a".repeat(40);
    const receipt = await runFixture(["ci", "why", "7", "-R", "fixture/example"], { root, responses: [
      { prefix: ["pr", "view", "7"], stdout: JSON.stringify({ number: 7, url: "https://github.com/fixture/example/pull/7", headRefOid: sha }) },
      { prefix: ["api"], stdout: '{"total_count":0,"workflow_runs":[]}' },
    ] });
    expect(receipt.exitCode, receipt.stderr).toBe(0);
    // Answered from the explicit repo: the PR head was read through --repo.
    expect(receipt.stdout).toContain(`PR #7 · ${sha}`);
    expect(receipt.calls).toContainEqual(["pr", "view", "7", "--json", "number,url,headRefOid,statusCheckRollup", "--repo", "fixture/example"]);
    expect(receipt.calls).toContainEqual(["api", `repos/{owner}/{repo}/actions/runs?head_sha=${sha}&per_page=100&page=1`]);
  });

  it("ggh pr threads <n> -R <repo> reads threads without a local fallback", async () => {
    const receipt = await runFixture(["pr", "threads", "8", "-R", "fixture/example"], { root, responses: [
      { prefix: ["api", "graphql"], stdout: JSON.stringify({ data: { repository: { pullRequest: { headRefOid: "a".repeat(40), baseRefOid: "b".repeat(40), reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } }) },
    ] });
    expect(receipt.exitCode, receipt.stderr).toBe(0);
    expect(receipt.stdout).toContain("No matching review threads.");
    expect(receipt.calls.some(call => call[0] === "api" && call[1] === "graphql")).toBe(true);
    expect(receipt.calls.some(call => call[0] === "repo" || call[0] === "pr" && call[1] === "view")).toBe(false);
  });

  it("ggh pr view <n> -R <repo> shows the PR outside any repository", async () => {
    const detail = { number: 10, title: "Queued", body: "", author: { login: "fixture" }, headRefName: "b10", headRefOid: "c".repeat(40), baseRefName: "main", state: "OPEN", url: "https://github.com/other/lib/pull/10", isDraft: false, additions: 1, deletions: 1, changedFiles: 1, mergeable: "MERGEABLE", reviewDecision: "APPROVED", labels: [] };
    const receipt = await runFixture(["pr", "view", "10", "-R", "other/lib"], { root, responses: [
      { prefix: ["pr", "view", "10"], stdout: JSON.stringify(detail) },
    ] });
    expect(receipt.exitCode, receipt.stderr).toBe(0);
    expect(receipt.stdout).toBe("");
    expect(receipt.stderr).toContain("Pull Request #10");
    expect(receipt.calls.some(call => call.at(0) === "pr" && call.at(1) === "view" && call.at(2) === "10" && call.at(-2) === "--repo" && call.at(-1) === "other/lib")).toBe(true);
  });

  it("ggh pr merge <n> -R <repo> preflights remotely and still asks the human", async () => {
    const detail = { number: 9, title: "Nine", body: "", author: { login: "fixture" }, headRefName: "b9", headRefOid: "d".repeat(40), baseRefName: "main", state: "OPEN", url: "https://github.com/other/lib/pull/9", isDraft: false, additions: 1, deletions: 1, changedFiles: 1, mergeable: "MERGEABLE", reviewDecision: "APPROVED", labels: [] };
    const receipt = await runFixture(["pr", "merge", "9", "-R", "other/lib"], { root, responses: [
      { prefix: ["pr", "view", "9", "--json", "number,title,body,author,headRefName,headRefOid,baseRefName,state,url,isDraft,additions,deletions,changedFiles,mergeable,reviewDecision,labels"], stdout: JSON.stringify(detail) },
    ] });
    expect(receipt.exitCode).toBe(1);
    expect(receipt.stderr).toContain("Cannot prompt");
    expect(receipt.calls.some(call => call.at(0) === "pr" && call.at(1) === "view" && call.at(-2) === "--repo" && call.at(-1) === "other/lib")).toBe(true);
    expect(receipt.calls.some(call => call[0] === "pr" && call[1] === "merge")).toBe(false);
  });

  it("ggh pr merge <n> -R <repo> merges and cleans up outside any repository", async () => {
    const detail = { number: 9, title: "Nine", body: "", author: { login: "fixture" }, headRefName: "b9", headRefOid: "e".repeat(40), baseRefName: "main", state: "OPEN", url: "https://github.com/other/lib/pull/9", isDraft: false, additions: 1, deletions: 1, changedFiles: 1, mergeable: "MERGEABLE", reviewDecision: "APPROVED", labels: [] };
    const receipt = await runFixture(["pr", "merge", "9", "-R", "other/lib", "--squash", "--yes"], { root, responses: [
      { prefix: ["pr", "view", "9", "--json", "number,title,body,author,headRefName,headRefOid,baseRefName,state,url,isDraft,additions,deletions,changedFiles,mergeable,reviewDecision,labels"], stdout: JSON.stringify(detail) },
      { prefix: ["pr", "view", "9", "--json", "state,mergedAt,autoMergeRequest,mergeStateStatus"], stdout: '{"state":"MERGED","mergedAt":"2026-10-28T00:00:00Z"}' },
      { prefix: ["pr", "merge", "9"], stdout: "" },
    ] });
    expect(receipt.exitCode, receipt.stderr).toBe(0);
    expect(receipt.stderr).toContain("#9: merged");
    expect(receipt.calls.some(call => call[0] === "pr" && call[1] === "merge" && call.at(-2) === "--repo" && call.at(-1) === "other/lib" && call.includes("--delete-branch"))).toBe(true);
  });

  it(`cd "$(ggh go <repo> --print)" && ggh review <n> reviews inside the clone`, async () => {
    const cloneDir = join(repos, "pr-five");
    mkdirSync(cloneDir, { recursive: true });
    for (const args of [["init", "-b", "main"], ["config", "user.name", "Fixture"], ["config", "user.email", "fixture@example.invalid"], ["commit", "--allow-empty", "-m", "base"]]) await run("git", args, { cwd: cloneDir });
    const base = (await run("git", ["rev-parse", "HEAD"], { cwd: cloneDir })).stdout.trim();
    await run("git", ["commit", "--allow-empty", "-m", "head"], { cwd: cloneDir });
    const head = (await run("git", ["rev-parse", "HEAD"], { cwd: cloneDir })).stdout.trim();
    await run("git", ["remote", "add", "origin", "https://github.com/fixture/pr-five.git"], { cwd: cloneDir });
    // The review fetch goes through origin; resolve it to this repository's objects.
    await run("git", ["config", `url.file://${cloneDir}.insteadOf`, "https://github.com/fixture/pr-five.git"], { cwd: cloneDir });
    const receipt = await runFixture([], { root, cwd: cloneDir, config: { project_roots: [repos], host_worktree_dirs: {} }, responses: [
      { prefix: ["pr", "view", "5"], stdout: JSON.stringify({ number: 5, url: "https://github.com/fixture/pr-five/pull/5", headRefOid: head, baseRefOid: base }) },
    ], invoke: `
      const { refreshProjectIndex } = await import(${JSON.stringify(indexStore)});
      await refreshProjectIndex();
      const { runCli } = await import(${JSON.stringify(entry)});
      await runCli(['bun', 'ggh', 'go', 'fixture/pr-five', '--print']);
      // The suggestion's cd: run review from the checkout go printed.
      await runCli(['bun', 'ggh', 'review', '5', '--json']);
    ` });
    expect(receipt.exitCode, receipt.stderr).toBe(0);
    expect(receipt.stdout).toContain(cloneDir);
    // The review result is the pretty-printed JSON at the end of stdout.
    const review = JSON.parse(receipt.stdout.slice(receipt.stdout.indexOf('{\n  "schemaVersion"')));
    expect(review).toMatchObject({ schemaVersion: 1, pr: { number: 5, repo: "pr-five" }, headSha: head, checkoutPath: join(cloneDir, ".worktrees", "review-5") });
  });

  it(`cd "$(ggh go <repo> --print)" && ggh switch <branch> switches the clone's checkout`, async () => {
    const cloneDir = join(repos, "switchy");
    mkdirSync(cloneDir, { recursive: true });
    for (const args of [["init", "-b", "main"], ["config", "user.name", "Fixture"], ["config", "user.email", "fixture@example.invalid"], ["commit", "--allow-empty", "-m", "initial"], ["switch", "-c", "fix-ci"], ["switch", "main"]]) await run("git", args, { cwd: cloneDir });
    const receipt = await runFixture([], { root, cwd: cloneDir, config: { project_roots: [repos], host_worktree_dirs: {} }, invoke: `
      const { refreshProjectIndex } = await import(${JSON.stringify(indexStore)});
      await refreshProjectIndex();
      const { runCli } = await import(${JSON.stringify(entry)});
      await runCli(['bun', 'ggh', 'go', 'switchy', '--print']);
      await runCli(['bun', 'ggh', 'switch', 'fix-ci']);
    ` });
    expect(receipt.exitCode, receipt.stderr).toBe(0);
    expect(receipt.stdout).toContain(cloneDir);
    expect((await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: cloneDir })).stdout.trim()).toBe("fix-ci");
  });
});
