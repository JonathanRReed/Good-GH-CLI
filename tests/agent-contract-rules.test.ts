import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentEnvelope, type AgentEnvelope } from "../src/services/agent-contract.ts";
import { classifyGitHubError } from "../src/services/github/client.ts";
import { refreshProjectIndex } from "../src/services/projects/index-store.ts";
import { getCompletedEffects, resetCommandOutput } from "../src/services/runtime.ts";
import { fixtureRoot, runFixture, type FixtureResponse } from "./cli-fixture.ts";

const root = fixtureRoot("ggh-agent-rules-");
const outside = join(root, "outside");
const repo = join(root, "repo");
const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
};
function repository(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q", "-b", "main");
  git(path, "config", "user.name", "Fixture");
  git(path, "config", "user.email", "fixture@example.com");
  git(path, "config", "commit.gpgsign", "false");
  writeFileSync(join(path, "a.txt"), "a\n");
  git(path, "add", "a.txt");
  git(path, "commit", "-q", "-m", "initial");
}

beforeAll(() => {
  mkdirSync(outside);
  repository(repo);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function envelope(args: string[], options: { cwd?: string; responses?: FixtureResponse[] } = {}): Promise<AgentEnvelope & { exitCode: number }> {
  const result = await runFixture([...args, "--agent"], { root, cwd: options.cwd ?? repo, responses: options.responses });
  return { ...JSON.parse(result.stdout), exitCode: result.exitCode };
}

const schemaInputs = new Map<string, { options: Array<{ short?: string; long?: string }>; arguments: Array<{ name: string }> }>();
/** The published contract rule every envelope must satisfy. */
async function assertContractRule(value: AgentEnvelope): Promise<void> {
  const key = value.command.join(" ");
  if (!schemaInputs.has(key)) {
    const discovery = JSON.parse((await runFixture(["agent", "schema", ...value.command, "--agent"], { root })).stdout);
    const entry = discovery.result.inputs.find((input: { path: string[] }) => input.path.join(" ") === key);
    schemaInputs.set(key, entry);
  }
  const inputs = schemaInputs.get(key);
  if (value.status === "needs_input") {
    expect(["missing_input", "confirmation_required"]).toContain(value.error?.code ?? "");
    expect(value.requiredInputs?.length).toBeGreaterThan(0);
    for (const input of value.requiredInputs ?? []) {
      const names = [input.name, ...input.alternatives ?? []];
      const real = names.every(name => inputs?.options.some(option => option.long === name || option.short === name) || inputs?.arguments.some(argument => argument.name === name) || (name === "body" && input.alternatives?.length));
      expect(real, `${key}: ${JSON.stringify(input)}`).toBe(true);
    }
  } else {
    expect(value.requiredInputs).toBeUndefined();
    if (value.error) expect(["missing_input", "confirmation_required"]).not.toContain(value.error.code);
  }
  if (value.status === "no_op" && value.result && typeof value.result === "object" && "status" in value.result) expect(value.result.status).toBe("no_op");
}

describe("GitHub error classification", () => {
  test("separates network, rate limit, not found and forbidden, keeping gh's words and no raw JSON", () => {
    const offline = classifyGitHubError({ stdout: "", stderr: 'Get "https://api.github.com/": proxyconnect tcp: dial tcp 127.0.0.1:9: connect: connection refused' }, "pull request");
    expect(offline.kind).toBe("network");
    expect(offline.message).toContain("connection refused");

    const graphql = classifyGitHubError({
      stdout: JSON.stringify({ data: { repository: { pullRequest: null } }, errors: [{ type: "NOT_FOUND", path: ["repository", "pullRequest"], message: "Could not resolve to a PullRequest with the number of 9." }] }),
      stderr: "gh: Could not resolve to a PullRequest with the number of 9.",
    }, "review threads");
    expect(graphql.kind).toBe("not_found");
    expect(graphql.message).toBe("review threads: Could not resolve to a PullRequest with the number of 9.");
    expect(graphql.message).not.toContain("{");

    const unknown = classifyGitHubError({ stdout: JSON.stringify({ errors: [{ type: "SOMETHING", message: "Odd failure." }] }), stderr: "" }, "stack lookup");
    expect(unknown).toMatchObject({ kind: "unknown", message: "stack lookup failed: Odd failure." });

    const limited = classifyGitHubError({ stdout: "", stderr: "HTTP 429: Too Many Requests\nRetry-After: 30" });
    expect(limited).toMatchObject({ kind: "rate_limit", retryAfterSeconds: 30 });
    expect(classifyGitHubError({ stdout: "", stderr: "HTTP 403: API rate limit exceeded for user ID 1." }).kind).toBe("rate_limit");
    expect(classifyGitHubError({ stdout: "", stderr: "HTTP 403: Resource not accessible by integration" }).kind).toBe("forbidden");
    // A number that contains 429 or 403 is not a status code.
    expect(classifyGitHubError(new Error("PR #4291 not found")).kind).toBe("not_found");
    expect(classifyGitHubError(new Error("issue 14030 exploded")).kind).toBe("unknown");
  });
});

describe("agent error codes", () => {
  test("an unreachable host is a network failure, not a login problem", async () => {
    const offline = { prefix: ["auth", "status"], stdout: JSON.stringify({ hosts: { "github.com": [{ state: "error", error: 'Get "https://api.github.com/": proxyconnect tcp: dial tcp 127.0.0.1:9: connect: connection refused', active: true, host: "github.com", login: "fixture" }] } }) };
    const value = await envelope(["ci", "why", "1", "-R", "fixture/repo"], { responses: [offline] });
    expect(value.error?.message).toContain("proxyconnect tcp");
    expect(value).toMatchObject({ status: "failed", error: { code: "network", retryability: "after_delay" }, effects: { uncertain: [] } });
    const invalid = { prefix: ["auth", "status"], stdout: JSON.stringify({ hosts: { "github.com": [{ state: "error", error: "HTTP 401: Bad credentials", active: true, host: "github.com", login: "fixture" }] } }) };
    expect(await envelope(["ci", "why", "1", "-R", "fixture/repo"], { responses: [invalid] })).toMatchObject({ error: { code: "authentication_required" } });
  });

  test("failed reads report not_found without uncertain effects or raw GraphQL", async () => {
    const missing = JSON.stringify({ data: { repository: { pullRequest: null } }, errors: [{ type: "NOT_FOUND", path: ["repository", "pullRequest"], message: "Could not resolve to a PullRequest with the number of 999999." }] });
    const threads = await envelope(["pr", "threads", "999999", "-R", "fixture/repo"], { responses: [{ prefix: ["api", "graphql"], stdout: missing, stderr: "gh: Could not resolve to a PullRequest with the number of 999999.", exitCode: 1 }] });
    expect(threads.error?.message).not.toContain("{");
    expect(threads).toMatchObject({ status: "failed", error: { code: "not_found", retryability: "after_input" }, effects: { completed: [], pending: [], uncertain: [] } });

    const view = await envelope(["pr", "view", "999999", "-R", "fixture/repo"], { responses: [{ prefix: ["pr", "view", "999999"], stderr: "GraphQL: Could not resolve to a PullRequest with the number of 999999. (repository.pullRequest)", exitCode: 1 }] });
    expect(view).toMatchObject({ status: "failed", error: { code: "not_found", message: "PR #999999 not found." }, effects: { uncertain: [] } });

    const issue = await envelope(["issue", "999999", "-R", "fixture/repo"], { responses: [
      { prefix: ["issue", "view", "999999"], stderr: "GraphQL: Could not resolve to an issue or pull request with the number of 999999. (repository.issue)", exitCode: 1 },
      { prefix: ["issue", "artifact", "list"], stdout: "[]" },
    ] });
    expect(issue).toMatchObject({ status: "failed", error: { code: "not_found", message: "Issue #999999 not found." }, effects: { uncertain: [] } });
  });

  test("rate limits wait, forbidden reads never retry, and offline reads are not not-found", async () => {
    const limited = await envelope(["pr", "view", "7", "-R", "fixture/repo"], { responses: [{ prefix: ["pr", "view", "7"], stderr: "HTTP 429: Too Many Requests\nRetry-After: 30", exitCode: 1 }] });
    expect(limited).toMatchObject({ status: "failed", error: { code: "rate_limited", retryability: "after_delay", retryAfterSeconds: 30 }, effects: { uncertain: [] } });
    const forbidden = await envelope(["pr", "view", "7", "-R", "fixture/repo"], { responses: [{ prefix: ["pr", "view", "7"], stderr: "HTTP 403: Resource not accessible by integration", exitCode: 1 }] });
    expect(forbidden).toMatchObject({ status: "failed", error: { code: "forbidden", retryability: "never" }, effects: { uncertain: [] } });
    const offline = await envelope(["issue", "7", "-R", "fixture/repo"], { responses: [
      { prefix: ["issue", "view", "7"], stderr: 'Post "https://api.github.com/graphql": dial tcp: lookup api.github.com: no such host', exitCode: 1 },
      { prefix: ["issue", "artifact", "list"], stdout: "[]" },
    ] });
    expect(offline).toMatchObject({ status: "failed", error: { code: "network", retryability: "after_delay" } });
  });

  test("failed mutations keep uncertain effects and inspect before any retry", async () => {
    const broken = await envelope(["issue", "close", "1", "--yes", "-R", "fixture/repo"], { responses: [{ prefix: ["issue", "close", "1"], stderr: "unexpected server failure", exitCode: 1 }] });
    expect(broken).toMatchObject({ status: "failed", error: { code: "operation_failed", retryability: "after_inspection" }, effects: { uncertain: ["command_effects"] } });
    const offline = await envelope(["issue", "close", "1", "--yes", "-R", "fixture/repo"], { responses: [{ prefix: ["issue", "close", "1"], stderr: 'Post "https://api.github.com/graphql": read tcp: connection reset by peer', exitCode: 1 }] });
    expect(offline).toMatchObject({ status: "failed", error: { code: "network", retryability: "after_inspection" }, effects: { uncertain: ["command_effects"] } });
  });

  test("agentEnvelope keeps uncertainty for unknown commands and drops it for reads", () => {
    const issue = { status: "failed" as const, message: "boom" };
    expect(agentEnvelope({ command: ["pr", "view"], issue, failed: true, dryRun: false, preview: [], mutating: false }).effects?.uncertain).toEqual([]);
    expect(agentEnvelope({ command: ["issue", "close"], issue, failed: true, dryRun: false, preview: [], mutating: true }).effects?.uncertain).toEqual(["command_effects"]);
    expect(agentEnvelope({ command: ["issue", "close"], issue, failed: true, dryRun: false, preview: [] }).effects?.uncertain).toEqual(["command_effects"]);
  });

  test("every checkout command outside a repository fails with one code and message", async () => {
    // Commands that accept -R name it; checkout-only commands suggest a checkout. The code is always the same.
    const cases: Array<[string[], string]> = [
      [["status"], "Not a git repository. Run from inside a checkout, or run `git init`."],
      [["agent", "brief"], "Not a git repository. Run from inside a checkout, or run `git init`."],
      [["commit", "-m", "x"], "Not a git repository. Run from inside a checkout, or run `git init`."],
      [["ci", "why"], "Not in a GitHub repository; pass -R owner/repo."],
      [["pr"], "Not in a GitHub repository; pass -R owner/repo."],
    ];
    const results = await Promise.all(cases.map(([args]) => envelope(args, { cwd: outside })));
    for (const [index, value] of results.entries()) {
      expect(value.exitCode).toBe(1);
      expect(value).toMatchObject({ status: "failed", error: { code: "invalid_arguments", retryability: "after_input", message: cases[index]?.[1] } });
      expect(value.effects?.uncertain ?? []).toEqual([]);
    }
  });
});

describe("needs_input rule", () => {
  test("needs_input names real inputs, nothing-to-do is no_op, and state problems fail", async () => {
    const work = join(root, "rule-repo");
    repository(work);
    const clean = await envelope(["commit", "-m", "nothing"], { cwd: work });
    expect(clean).toMatchObject({ status: "no_op", result: { status: "no_op" } });

    writeFileSync(join(work, "a.txt"), "changed\n");
    const unstaged = await envelope(["commit", "-m", "x"], { cwd: work });
    expect(unstaged.error?.message).toContain("git add <paths>");
    expect(unstaged.error?.message).not.toContain("--all");
    expect(unstaged).toMatchObject({ status: "failed", error: { code: "precondition_failed", retryability: "after_inspection" }, effects: { uncertain: [] } });

    git(work, "add", "a.txt");
    const noMessage = await envelope(["commit", "--no-ai"], { cwd: work });
    expect(noMessage).toMatchObject({ status: "needs_input", error: { code: "missing_input" }, requiredInputs: [{ name: "-m" }] });
    expect(git(work, "rev-list", "--count", "HEAD")).toBe("1");

    const envelopes = [
      clean, unstaged, noMessage,
      await envelope(["issue", "close", "1", "-R", "fixture/repo"]),
      await envelope(["discard", "--all"], { cwd: work }),
      await envelope(["pr", "create", "--editor"], { cwd: work }),
      await envelope(["config", "get"]),
    ];
    // No candidate at all is a missing target, not a request for input.
    expect(await envelope(["go", "no-such-project"])).toMatchObject({ status: "failed", error: { code: "not_found" } });
    for (const value of envelopes) await assertContractRule(value);
    expect(envelopes.filter(value => value.status === "needs_input").length).toBeGreaterThanOrEqual(4);
  });

  test("agentEnvelope enforces the rule for issues recorded with the wrong status", () => {
    const required = [{ name: "file", description: "Pass a plan file." }];
    expect(agentEnvelope({ command: ["issue", "plan"], issue: { status: "failed", code: "missing_input", message: "Pass a plan file.", requiredInputs: required }, failed: true, dryRun: false, preview: [] }))
      .toMatchObject({ status: "needs_input", error: { code: "missing_input", retryability: "after_input" }, requiredInputs: required, effects: { uncertain: [] } });
    const nameless = agentEnvelope({ command: ["commit"], issue: { status: "needs_input", message: "Something is needed." }, failed: true, dryRun: false, preview: [] });
    expect(nameless).toMatchObject({ status: "failed", error: { code: "invalid_arguments" } });
    expect(nameless.requiredInputs).toBeUndefined();
  });
});

describe("agent brief local state", () => {
  test("reports unpublished work without an upstream and points at a plan", async () => {
    const work = join(root, "brief-repo");
    repository(work);
    git(work, "switch", "-q", "-c", "feature");
    writeFileSync(join(work, "b.txt"), "b\n");
    git(work, "add", "b.txt");
    git(work, "commit", "-q", "-m", "feature");
    const local = await envelope(["agent", "brief", "--local"], { cwd: work });
    expect(local.result).toMatchObject({ checkout: { branch: "feature", upstream: null, ahead: null, behind: null, unpublished: 2, aheadOfDefault: null }, next: ["ggh pr create --dry-run --agent"] });

    const bare = join(root, "brief-remote.git");
    git(root, "init", "-q", "--bare", "-b", "main", bare);
    git(work, "remote", "add", "origin", bare);
    git(work, "push", "-q", "origin", "main");
    git(work, "remote", "set-head", "origin", "main");
    const tracked = await envelope(["agent", "brief", "--local"], { cwd: work });
    expect(tracked.result).toMatchObject({ checkout: { upstream: null, ahead: null, unpublished: 1, aheadOfDefault: 1 } });

    git(work, "switch", "-q", "--detach");
    writeFileSync(join(work, "c.txt"), "c\n");
    git(work, "add", "c.txt");
    git(work, "commit", "-q", "-m", "detached");
    const detached = await envelope(["agent", "brief", "--local"], { cwd: work });
    expect(detached.result).toMatchObject({ checkout: { branch: null, unpublished: 2, aheadOfDefault: 2 }, next: ["git switch -c <branch>"] });
  });
});

describe("scoped schema", () => {
  test("returns one command's inputs and result schema, resolving aliases", async () => {
    const result = await runFixture(["agent", "schema", "pr", "create", "--agent"], { root });
    expect(result.stdout.length).toBeLessThan(20_000);
    const value = JSON.parse(result.stdout);
    expect(value).toMatchObject({ status: "succeeded", result: { command: ["pr", "create"], envelope: { properties: { contract: { const: "ggh.agent" } } } } });
    expect(value.result.inputs.map((input: { path: string[] }) => input.path)).toEqual([["pr", "create"]]);
    expect(Object.keys(value.result.resultSchemas)).toEqual(["publication"]);
    expect(JSON.parse((await runFixture(["agent", "schema", "st", "--agent"], { root })).stdout).result.command).toEqual(["status"]);
    const unknown = await runFixture(["agent", "schema", "nope", "--agent"], { root });
    expect(unknown.exitCode).toBe(1);
    expect(JSON.parse(unknown.stdout)).toMatchObject({ status: "failed", error: { code: "invalid_arguments" } });
  });
});

describe("projects index effect", () => {
  test("reports projects_index_updated only when the scan changed the index", async () => {
    const configDir = join(root, "projects-config");
    const scanRoot = join(root, "projects-root");
    repository(join(scanRoot, "one"));
    const config = { project_roots: [scanRoot] };
    resetCommandOutput();
    await refreshProjectIndex({ configDir, config });
    expect(getCompletedEffects()).toEqual(["projects_index_updated"]);
    resetCommandOutput();
    await refreshProjectIndex({ configDir, config });
    expect(getCompletedEffects()).toEqual([]);
    repository(join(scanRoot, "two"));
    resetCommandOutput();
    await refreshProjectIndex({ configDir, config });
    expect(getCompletedEffects()).toEqual(["projects_index_updated"]);
  });
});
