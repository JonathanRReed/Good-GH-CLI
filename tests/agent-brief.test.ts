import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentBriefResultSchema } from "../src/services/agent-contract.ts";
import { buildAgentBrief, type BriefCheckout, type BriefReaders } from "../src/services/agent-brief.ts";
import { run } from "../src/utils/exec.ts";
import { fixtureRoot, runFixture, type FixtureResponse } from "./cli-fixture.ts";

const root = fixtureRoot("ggh-agent-brief-");
const repo = join(root, "repo");
const stackApi = ["api", "--hostname", "github.com", "-H", "X-GitHub-Api-Version: 2026-03-10", "repos/fixture/repo/stacks?pull_request=42"];
let head = "";

const prJson = () => JSON.stringify({
  number: 42, url: "https://github.com/fixture/repo/pull/42", state: "OPEN", isDraft: true, headRefOid: head, baseRefName: "main",
  reviewDecision: "CHANGES_REQUESTED", mergeable: "MERGEABLE",
  closingIssuesReferences: [
    { number: 7, url: "https://github.com/fixture/repo/issues/7", repository: { name: "repo", owner: { login: "fixture" } } },
    { number: 3, url: "https://github.com/other/lib/issues/3", repository: { name: "lib", owner: { login: "other" } } },
  ],
});
const comment = (id: string) => ({ id, databaseId: 1, author: { login: "reviewer" }, body: "A long review body that the brief must not echo.", createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z", url: `https://github.com/fixture/repo/pull/42#${id}`, outdated: false });
const thread = (id: string, isResolved: boolean) => ({
  id, isResolved, isOutdated: false, viewerCanResolve: true, viewerCanUnresolve: false, path: "src/a.ts", line: 1, originalLine: 1, startLine: null, diffSide: "RIGHT",
  comments: { nodes: [comment(`${id}-c`)], pageInfo: { hasNextPage: false, endCursor: null } },
});
const threadsJson = () => JSON.stringify({ data: { repository: { pullRequest: { headRefOid: head, baseRefOid: "b".repeat(40), reviewThreads: {
  nodes: [thread("T1", false), thread("T2", true), thread("T3", false)], pageInfo: { hasNextPage: false, endCursor: null },
} } } } });
const stackJson = JSON.stringify([{ number: 5, open: true, base: { ref: "main" }, pull_requests: [
  { number: 40, state: "closed", draft: false, merged_at: "2026-10-01T00:00:00Z", head: { ref: "b40", sha: "c".repeat(40) } },
  { number: 41, state: "open", draft: false, merged_at: null, head: { ref: "b41", sha: "d".repeat(40) } },
  { number: 42, state: "open", draft: true, merged_at: null, head: { ref: "b42", sha: "e".repeat(40) } },
  { number: 43, state: "open", draft: false, merged_at: null, head: { ref: "b43", sha: "f".repeat(40) } },
] }]);

function responses(overrides: Partial<Record<"pr" | "checks" | "threads" | "artifacts" | "stack", FixtureResponse>> = {}): FixtureResponse[] {
  return [
    overrides.pr ?? { prefix: ["pr", "view", "--json"], stdout: prJson() },
    overrides.checks ?? { prefix: ["pr", "checks", "42", "--json", "name,bucket"], exitCode: 1, stdout: JSON.stringify([
      { name: "lint", bucket: "fail" }, { name: "test", bucket: "pass" }, { name: "build", bucket: "pass" }, { name: "e2e", bucket: "pending" }, { name: "deploy", bucket: "cancel" },
    ]) },
    { prefix: ["repo", "view", "--json", "nameWithOwner,url"], stdout: JSON.stringify({ nameWithOwner: "fixture/repo", url: "https://github.com/fixture/repo" }) },
    overrides.threads ?? { prefix: ["api", "graphql"], stdout: threadsJson() },
    overrides.artifacts ?? { prefix: ["issue", "artifact", "list", "7"], stdout: JSON.stringify([{ number: 1, name: "plan.md", type: "plan", url: "https://github.com/fixture/repo/issues/7/artifacts/1", updatedAt: "2026-10-20T00:00:00Z" }]) },
    overrides.stack ?? { prefix: stackApi, stdout: stackJson },
  ];
}

async function brief(args: string[], fixtureResponses: FixtureResponse[]) {
  const result = await runFixture(["agent", "brief", ...args, "--agent"], { root, cwd: repo, responses: fixtureResponses });
  return { ...result, envelope: JSON.parse(result.stdout) };
}

/** Enough JSON Schema to hold the published brief schema to the actual output. */
function conforms(schema: Record<string, unknown>, value: unknown, path = "result"): string[] {
  if (Array.isArray(schema.anyOf)) {
    const branches = (schema.anyOf as Array<Record<string, unknown>>).map(branch => conforms(branch, value, path));
    return branches.some(errors => !errors.length) ? [] : [`${path}: no anyOf branch matched (${branches.map(errors => errors[0]).join(" | ")})`];
  }
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) return [`${path}: expected ${JSON.stringify(schema.const)}`];
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return [`${path}: not in enum`];
  const types = schema.type === undefined ? [] : [schema.type].flat();
  const kind = value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
  if (types.length && !types.includes(kind) && !(kind === "integer" && types.includes("number"))) return [`${path}: ${kind} is not ${types.join("|")}`];
  const errors: string[] = [];
  if (Array.isArray(value) && schema.items) value.forEach((item, index) => errors.push(...conforms(schema.items as Record<string, unknown>, item, `${path}[${index}]`)));
  if (kind === "object" && value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const key of (schema.required ?? []) as string[]) if (!(key in record)) errors.push(`${path}.${key}: missing`);
    for (const [key, item] of Object.entries(record)) {
      const property = properties[key] ?? (typeof schema.additionalProperties === "object" ? schema.additionalProperties as Record<string, unknown> : undefined);
      if (property) errors.push(...conforms(property, item, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: not allowed`);
    }
  }
  return errors;
}

beforeAll(async () => {
  await run("git", ["init", "-b", "feature", repo], { cwd: root });
  await run("git", ["config", "user.name", "Fixture"], { cwd: repo });
  await run("git", ["config", "user.email", "fixture@example.com"], { cwd: repo });
  writeFileSync(join(repo, "tracked"), "base\n");
  await run("git", ["add", "."], { cwd: repo });
  await run("git", ["-c", "commit.gpgsign=false", "commit", "-m", "base"], { cwd: repo });
  head = (await run("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  writeFileSync(join(repo, "tracked"), "changed\n");
  writeFileSync(join(repo, "staged"), "new\n");
  await run("git", ["add", "staged"], { cwd: repo });
  writeFileSync(join(repo, "untracked"), "new\n");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("ggh agent brief", () => {
  it("summarizes checkout, PR, CI, threads, linked issues and stack in one envelope", async () => {
    const { exitCode, stderr, envelope, calls } = await brief([], responses());
    expect(exitCode, stderr).toBe(0);
    expect(envelope).toMatchObject({ contract: "ggh.agent", command: ["agent", "brief"], status: "succeeded" });
    expect(envelope.effects).toBeUndefined();
    expect(envelope.result).toEqual({
      schemaVersion: 1,
      checkout: { root: repo, branch: "feature", head, upstream: null, ahead: 0, behind: 0, staged: 1, unstaged: 1, untracked: 1, conflicts: 0 },
      pullRequest: { state: "available", number: 42, url: "https://github.com/fixture/repo/pull/42", prState: "OPEN", draft: true, headSha: head, base: "main", reviewDecision: "CHANGES_REQUESTED", mergeable: "MERGEABLE", headMatchesLocal: true },
      ci: { state: "available", total: 5, counts: { fail: 1, pass: 2, pending: 1, cancel: 1 }, failing: ["lint", "deploy"] },
      reviewThreads: { state: "available", unresolved: 2 },
      linkedIssues: { state: "available", items: [
        { number: 7, artifacts: { state: "available", items: [{ number: 1, name: "plan.md", type: "plan" }] } },
        { number: 3, repo: "other/lib", artifacts: { state: "skipped", reason: "Issue is in another repository." } },
      ] },
      stack: { state: "available", number: 5, position: 3, size: 4, below: [{ number: 40, prState: "MERGED" }, { number: 41, prState: "OPEN" }] },
      next: ["ggh ci why 42 --agent", "ggh pr threads 42 --agent", "ggh issue 7 --agent"],
    });
    expect(conforms(agentBriefResultSchema, envelope.result)).toEqual([]);
    expect(JSON.stringify(envelope)).not.toContain("review body");
    // Linked issues in other repositories are never read through the current one.
    expect(calls.some(call => call[0] === "issue" && call.includes("3"))).toBe(false);
  });

  it("makes zero gh calls with --local", async () => {
    const { exitCode, envelope, calls } = await brief(["--local"], []);
    expect(exitCode).toBe(0);
    expect(calls).toEqual([]);
    expect(envelope.result.checkout).toMatchObject({ branch: "feature", head, staged: 1, unstaged: 1, untracked: 1 });
    for (const section of ["pullRequest", "ci", "reviewThreads", "linkedIssues", "stack"]) {
      expect(envelope.result[section]).toEqual({ state: "skipped", reason: "Skipped by --local." });
    }
    expect(conforms(agentBriefResultSchema, envelope.result)).toEqual([]);
  });

  it("reports no PR without reading anything that depends on one", async () => {
    const { exitCode, envelope, calls } = await brief([], [{ prefix: ["pr", "view"], exitCode: 1, stderr: 'no pull requests found for branch "feature"' }]);
    expect(exitCode).toBe(0);
    expect(envelope.status).toBe("succeeded");
    expect(envelope.result.pullRequest).toEqual({ state: "none" });
    for (const section of ["ci", "reviewThreads", "linkedIssues", "stack"]) {
      expect(envelope.result[section]).toEqual({ state: "skipped", reason: "No pull request for this branch." });
    }
    expect(calls.map(call => call.slice(0, 2))).toEqual([["pr", "view"]]);
    expect(conforms(agentBriefResultSchema, envelope.result)).toEqual([]);
  });

  it("keeps the checkout when the PR read fails", async () => {
    const { exitCode, envelope } = await brief([], [{ prefix: ["pr", "view"], exitCode: 4, stderr: "To get started with GitHub CLI, please run:  gh auth login" }]);
    expect(exitCode).toBe(0);
    expect(envelope.result.checkout.head).toBe(head);
    expect(envelope.result.pullRequest).toEqual({ state: "unavailable", reason: "GitHub CLI is not authenticated. Run `gh auth login`." });
    expect(envelope.result.ci).toEqual({ state: "skipped", reason: "The branch pull request could not be read." });
  });

  const failures: Array<[string, Partial<Record<"checks" | "threads" | "artifacts" | "stack", FixtureResponse>>, (result: Record<string, { state: string; reason?: string; items?: Array<{ artifacts: { state: string; reason?: string } }> }>) => void]> = [
    ["CI", { checks: { prefix: ["pr", "checks"], exitCode: 1, stderr: "HTTP 502: Bad Gateway" } }, result => {
      expect(result.ci).toMatchObject({ state: "unavailable", reason: expect.stringContaining("pull request checks failed") });
    }],
    ["review threads", { threads: { prefix: ["api", "graphql"], exitCode: 1, stderr: "HTTP 403: Resource not accessible" } }, result => {
      expect(result.reviewThreads).toMatchObject({ state: "unavailable" });
    }],
    ["issue artifacts", { artifacts: { prefix: ["issue", "artifact"], exitCode: 1, stderr: 'unknown command "artifact" for "gh issue"' } }, result => {
      expect(result.linkedIssues).toMatchObject({ state: "available" });
      expect(result.linkedIssues?.items?.[0]?.artifacts).toEqual({ state: "unavailable", reason: "Issue artifacts need GitHub CLI 2.103 or later." });
    }],
    ["stack", { stack: { prefix: ["api", "--hostname"], exitCode: 1, stderr: "gh: Not Found (HTTP 404)" } }, result => {
      expect(result.stack).toEqual({ state: "unavailable", reason: "Stacked pull requests are not available for this repository." });
    }],
  ];
  for (const [name, override, check] of failures) {
    it(`isolates a failed ${name} read`, async () => {
      const { exitCode, envelope } = await brief([], responses(override));
      expect(exitCode).toBe(0);
      expect(envelope.status).toBe("succeeded");
      const result = envelope.result;
      expect(conforms(agentBriefResultSchema, result)).toEqual([]);
      check(result);
      for (const section of ["pullRequest", "ci", "reviewThreads", "linkedIssues", "stack"]) {
        const failed = (name === "CI" && section === "ci") || (name === "review threads" && section === "reviewThreads") || (name === "stack" && section === "stack");
        if (!failed) expect(result[section].state).toBe("available");
      }
    });
  }

  it("fails outside a repository with a next step", async () => {
    const outside = fixtureRoot("ggh-agent-brief-outside-");
    try {
      const result = await runFixture(["agent", "brief", "--agent"], { root, cwd: outside });
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: "failed", error: { code: "invalid_arguments", message: expect.stringContaining("Run ggh agent brief from a checkout") } });
      expect(result.calls).toEqual([]);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });

  it("is published by agent schema", async () => {
    const result = await runFixture(["agent", "schema"], { root });
    const discovery = JSON.parse(result.stdout);
    expect(discovery.coreResultSchemas.agentBrief.commandPaths).toEqual([["agent", "brief"]]);
    expect(discovery.supportedCommandPaths).toContainEqual(["agent", "brief"]);
  });
});

describe("agent brief deadline", () => {
  const checkout: BriefCheckout = { root: "/r", branch: "feature", head: "a".repeat(40), upstream: null, ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 };
  const pr = { number: 9, url: "https://github.com/o/r/pull/9", state: "OPEN", isDraft: false, headRefOid: "b".repeat(40), baseRefName: "main", reviewDecision: null, mergeable: "UNKNOWN", closingIssuesReferences: [] };
  const never = <T>() => new Promise<T>(() => {});

  it("turns slow sections unavailable under one deadline and stops their reads", async () => {
    let cancelled = 0;
    const readers: BriefReaders = {
      pullRequest: async () => pr,
      checks: async () => ({ total: 1, counts: { pass: 1 }, failing: [] }),
      threads: never,
      artifacts: never,
      stack: never,
      cancel: async () => { cancelled++; },
    };
    const started = performance.now();
    const result = await buildAgentBrief(checkout, { deadlineMs: 100, readers });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(result.ci).toEqual({ state: "available", total: 1, counts: { pass: 1 }, failing: [] });
    expect(result.pullRequest).toMatchObject({ state: "available", headMatchesLocal: false });
    const late = { state: "unavailable" as const, reason: "Remote reads exceeded the 0.1s deadline." };
    expect(result.reviewThreads).toEqual(late);
    expect(result.stack).toEqual(late);
    expect(result.linkedIssues).toEqual({ state: "available", items: [] });
    expect(cancelled).toBe(1);
  });

  it("bounds the PR read itself", async () => {
    const result = await buildAgentBrief(checkout, { deadlineMs: 50, readers: { pullRequest: never, checks: never, threads: never, artifacts: never, stack: never } });
    expect(result.pullRequest.state).toBe("unavailable");
    expect(result.ci).toEqual({ state: "skipped", reason: "The branch pull request could not be read." });
  });

  it("skips remote reads on a detached HEAD", async () => {
    const result = await buildAgentBrief({ ...checkout, branch: null }, { readers: { pullRequest: never, checks: never, threads: never, artifacts: never, stack: never } });
    expect(result.pullRequest).toEqual({ state: "skipped", reason: "Detached HEAD has no branch pull request." });
  });
});
