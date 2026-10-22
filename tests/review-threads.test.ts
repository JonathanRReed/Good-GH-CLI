import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { fixtureRoot, runFixture, type FixtureResponse } from "./cli-fixture.ts";
import type { ReviewThreadComment, ReviewThreadsOptions } from "../src/services/github/review-threads.ts";

const root = fixtureRoot("ggh-review-threads-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const head = "a".repeat(40);
const base = "b".repeat(40);
const old = "2026-10-20T10:00:00Z";
const edited = "2026-10-22T10:00:00Z";
const since = "2026-10-21T10:00:00Z";
const body = "  Keep this verbatim.\n\n```ts\nconst value = '<&>';\n```\n  ";
function comment(id: string, overrides: Partial<ReviewThreadComment> = {}) {
  return { id, databaseId: 123, author: { login: "reviewer" }, body, createdAt: old, updatedAt: old, url: `https://github.com/fixture/repo/pull/42#${id}`, outdated: false, ...overrides };
}
function connection<T>(nodes: T[], next: string | null = null) {
  return { nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } };
}
function thread(id: string, options: { resolved?: boolean; outdated?: boolean; comments?: ReturnType<typeof connection<ReviewThreadComment>>; path?: string } = {}) {
  return { id, isResolved: options.resolved ?? false, isOutdated: options.outdated ?? false,
    viewerCanResolve: true, viewerCanUnresolve: false, path: options.path ?? "src/example.ts", line: 12, originalLine: 10, startLine: null, diffSide: "RIGHT",
    comments: options.comments ?? connection([comment(`comment-${id}`)]) };
}
function response(threads: ReturnType<typeof thread>[], next: string | null = null, node?: unknown) {
  return { data: { repository: { pullRequest: { headRefOid: head, baseRefOid: base, reviewThreads: connection(threads, next) } }, ...(node === undefined ? {} : { node }) } };
}
function graphql(stdout: unknown, threadsCursor = "null", commentsCursor = "null", threadId = "unused"): FixtureResponse {
  return { prefix: ["api", "graphql", "-F", `threadsCursor=${threadsCursor}`, "-F", `commentsCursor=${commentsCursor}`, "-f", `threadId=${threadId}`], stdout: JSON.stringify(stdout) };
}
async function cli(args: string[], responses: FixtureResponse[] = [graphql(response([thread("T1")]))]) {
  return runFixture(["pr", "threads", ...args, "-R", "fixture/repo"], { root, responses });
}
async function service(options: ReviewThreadsOptions, responses: FixtureResponse[]) {
  return runFixture([], { root, responses, invoke: `
    const { setFlags } = await import(${JSON.stringify(new URL("../src/services/runtime.ts", import.meta.url).href)});
    const { getReviewThreads } = await import(${JSON.stringify(new URL("../src/services/github/review-threads.ts", import.meta.url).href)});
    setFlags({ repo: 'fixture/repo' });
    console.log(JSON.stringify(await getReviewThreads(42, ${JSON.stringify(options)})));
  ` });
}

describe("review threads", () => {
  test("paginates over 100 threads and over 100 comments in one thread using one query document", async () => {
    const first = Array.from({ length: 100 }, (_, i) => thread(`T${i}`, i === 0 ? {
      comments: connection(Array.from({ length: 100 }, (_, i) => comment(`C${i}`)), "comments-100"),
    } : {}));
    const result = await cli(["42", "--agent"], [
      graphql(response(first, "threads-100")),
      graphql(response([], null, { id: "T0", comments: connection([comment("C100")]) }), "null", "comments-100", "T0"),
      graphql(response([thread("T100")]), "threads-100"),
    ]);
    expect(result.exitCode).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value.result.pagination).toEqual({ complete: true, threads: 101, comments: 201 });
    expect(value.result.threads).toHaveLength(101);
    expect(value.result.threads[0].comments).toHaveLength(101);
    expect(value.result.threads[0].comments[100].id).toBe("C100");
    expect(value.result.headSha).toBe(head);
    expect(value.result.baseSha).toBe(base);
    expect(result.calls).toHaveLength(3);
    const queries = result.calls.map(call => call.find(arg => arg.startsWith("query=")));
    expect(new Set(queries).size).toBe(1);
    expect(queries[0]).toContain("reviewThreads(first: 100, after: $threadsCursor)");
    expect(queries[0]).toContain("comments(first: 100, after: $commentsCursor)");
    expect(queries[0]).not.toContain("mutation");
    expect(result.providerCalls).toEqual([]);
  });

  test("filters resolved threads, keeps outdated threads, and lets --all override the agent default", async () => {
    const replies = [graphql(response([thread("open"), thread("outdated", { outdated: true }), thread("resolved", { resolved: true })]))];
    for (const args of [["42", "--agent"], ["42", "--json", "--unresolved"]]) {
      const result = await cli(args, replies);
      expect(result.exitCode).toBe(0);
      const value = JSON.parse(result.stdout);
      const payload = value.result ?? value;
      expect(value.operationId).toBeUndefined();
      expect(payload.operationId).toBeUndefined();
      expect(payload.threads.map((item: { id: string }) => item.id)).toEqual(["open", "outdated"]);
      expect(payload.pagination.threads).toBe(3);
    }
    for (const args of [["42", "--agent", "--all"], ["42", "--json"]]) {
      const result = await cli(args, replies);
      const value = JSON.parse(result.stdout);
      expect((value.result ?? value).threads).toHaveLength(3);
    }
  });

  test("--since finds edited comments on later pages and returns full conversations", async () => {
    const replies = [
      graphql(response([thread("edited", { comments: connection([comment("old")], "more") }), thread("unchanged")])),
      graphql(response([], null, { id: "edited", comments: connection([comment("edit", { updatedAt: edited })]) }), "null", "more", "edited"),
    ];
    const result = await cli(["42", "--agent", "--since", since], replies);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout).result;
    expect(payload.threads.map((item: { id: string }) => item.id)).toEqual(["edited"]);
    expect(payload.threads[0].comments.map((item: { id: string }) => item.id)).toEqual(["old", "edit"]);
    expect(payload.cursor).toBe(edited);
    const unchanged = await cli(["42", "--json", "--since", edited], replies);
    expect(JSON.parse(unchanged.stdout).threads).toEqual([]);
    expect(JSON.parse(unchanged.stdout).cursor).toBe(edited);
  });

  test("--since includes newly created comments and advances over filtered threads", async () => {
    const result = await cli(["42", "--agent", "--since", since], [graphql(response([
      thread("new", { comments: connection([comment("new", { createdAt: edited, updatedAt: edited })]) }),
      thread("resolved", { resolved: true, comments: connection([comment("hidden", { updatedAt: "2026-10-23T10:00:00Z" })]) }),
    ]))]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).result).toMatchObject({ cursor: "2026-10-23T10:00:00Z", threads: [{ id: "new" }], pagination: { threads: 2, comments: 2 } });
  });

  test("preserves body bytes and metadata, emits compact agent and JSON documents", async () => {
    for (const mode of ["--agent", "--json"]) {
      const result = await cli(["42", mode]);
      expect(result.exitCode).toBe(0);
      const value = JSON.parse(result.stdout);
      expect(result.stdout).toBe(JSON.stringify(value) + "\n");
      const payload = value.result ?? value;
      expect(payload.threads[0].comments[0]).toEqual(comment("comment-T1"));
      expect(payload.threads[0]).toMatchObject({ id: "T1", viewerCanResolve: true, viewerCanUnresolve: false, originalLine: 10, startLine: null, diffSide: "RIGHT" });
      expect(result.stderr).toBe("");
    }
  });

  test("truncates only when requested, flags each affected comment, and keeps Unicode intact", async () => {
    const replies = [graphql(response([thread("T1", { comments: connection([comment("long", { body: "😀abc" }), comment("short", { body: "ok" })]) })]))];
    const result = await cli(["42", "--agent", "--max-body", "2"], replies);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).result.threads[0].comments).toEqual([
      comment("long", { body: "😀a", bodyTruncated: true }), comment("short", { body: "ok" }),
    ]);
    const zero = await cli(["42", "--json", "--max-body", "0"], replies);
    expect(JSON.parse(zero.stdout).threads[0].comments[0]).toMatchObject({ body: "", bodyTruncated: true });
  });

  test("groups human output by file, preserves bodies, and shows line and state badges", async () => {
    const result = await cli(["42"], [graphql(response([
      thread("T1"), thread("T2", { path: "README.md" }), thread("T3", { resolved: true, outdated: true }),
    ]))]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.split("\nsrc/example.ts\n")).toHaveLength(2);
    expect(result.stdout).toContain("12 [resolved] [outdated] T3");
    expect(result.stdout).toContain(`@reviewer\n${body}`);
    expect(result.stdout.indexOf("T3")).toBeLessThan(result.stdout.indexOf("README.md"));
  });

  test("reports both thread and nested comment cap exhaustion honestly", async () => {
    for (const replies of [
      [graphql(response([thread("T1")], "more"))],
      [graphql(response([thread("T1", { comments: connection([comment("C1")], "more") })]))],
    ]) {
      const result = await service({ maxPages: 1 }, replies);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).pagination).toEqual({ complete: false, threads: 1, comments: 1 });
      expect(result.calls).toHaveLength(1);
    }
  });

  test("stops repeated thread and comment cursors and deduplicates overlapping pages", async () => {
    const result = await service({}, [
      graphql(response([thread("T1")], "repeat")),
      graphql(response([thread("T1"), thread("T2")], "repeat"), "repeat"),
    ]);
    expect(JSON.parse(result.stdout).pagination).toEqual({ complete: false, threads: 2, comments: 2 });
    expect(result.calls).toHaveLength(2);
    const comments = await service({}, [
      graphql(response([thread("T1", { comments: connection([comment("C1")], "repeat") })])),
      graphql(response([], null, { id: "T1", comments: connection([comment("C1"), comment("C2")], "repeat") }), "null", "repeat", "T1"),
    ]);
    expect(JSON.parse(comments.stdout).pagination).toEqual({ complete: false, threads: 1, comments: 2 });
    expect(comments.calls).toHaveLength(2);
  });

  test("rejects revision movement during pagination", async () => {
    const moved = response([thread("T2")]);
    moved.data.repository.pullRequest.headRefOid = "c".repeat(40);
    const result = await cli(["42", "--agent"], [graphql(response([thread("T1")], "next")), graphql(moved, "next")]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "failed", error: { message: expect.stringContaining("changed during pagination") } });
  });

  test("reports missing PRs and preserves authentication error classification", async () => {
    const missing = await cli(["42", "--agent"], [graphql({ data: { repository: { pullRequest: null } } })]);
    expect(missing.exitCode).toBe(1);
    expect(JSON.parse(missing.stdout)).toMatchObject({ status: "failed", error: { message: "PR #42 not found." } });
    for (const stderr of ["HTTP 401: Unauthorized", "HTTP 401: Bad credentials", "To get started with GitHub CLI, please run:  gh auth login"]) {
      const auth = await cli(["42", "--agent"], [{ prefix: ["api", "graphql"], stderr, exitCode: 1 }]);
      expect(auth.exitCode).toBe(1);
      expect(JSON.parse(auth.stdout)).toMatchObject({ status: "failed", error: { code: "authentication_required" } });
    }
    const gqlAuth = await cli(["42", "--agent"], [graphql({ errors: [{ message: "Not authenticated" }] })]);
    expect(JSON.parse(gqlAuth.stdout)).toMatchObject({ status: "failed", error: { code: "authentication_required" } });
  });

  test("resolves an omitted number and classifies failures without hiding auth errors", async () => {
    const active = { prefix: ["pr", "view", "--json", "number"], stdout: '{"number":42}' };
    const result = await cli(["--agent"], [active, graphql(response([]))]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).result).toMatchObject({ number: 42, threads: [], cursor: null, pagination: { complete: true, threads: 0, comments: 0 } });
    const missing = await cli(["--agent"], [{ ...active, stdout: "", stderr: "no pull requests found for branch", exitCode: 1 }]);
    expect(missing.exitCode).toBe(1);
    expect(JSON.parse(missing.stdout).error.message).toContain("No PR found for the current branch");
    const auth = await cli(["--agent"], [{ ...active, stdout: "", stderr: "not authenticated", exitCode: 1 }]);
    expect(JSON.parse(auth.stdout).error.code).toBe("authentication_required");
  });

  test("infers repository host without requiring a new authentication flow", async () => {
    const result = await runFixture(["pr", "threads", "42", "--agent"], { root, responses: [
      { prefix: ["repo", "view", "--json", "nameWithOwner,url"], stdout: JSON.stringify({ nameWithOwner: "org/repo", url: "https://ghe.example.com/org/repo" }) },
      graphql(response([])),
    ] });
    expect(result.exitCode).toBe(0);
    expect(result.calls[1]).toContain("owner=org");
    expect(result.calls[1]).toContain("name=repo");
    expect(result.calls[1]?.slice(-2)).toEqual(["--hostname", "ghe.example.com"]);
  });

  test("rejects malformed GraphQL rather than claiming a complete read", async () => {
    for (const output of [
      { data: { repository: null } },
      { errors: [{ message: "rate limit reached" }], ...response([thread("T1")]) },
      response([thread("T1", { comments: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } })]),
    ]) {
      const result = await cli(["42", "--agent"], [graphql(output)]);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).status).toBe("failed");
      expect(JSON.parse(result.stdout).result).toBeUndefined();
    }
  });

  test("validates options before making any GitHub call", async () => {
    for (const args of [["0"], ["42", "--since", "yesterday"], ["42", "--max-body", "1.5"], ["42", "--max-body", "-1"], ["42", "--all", "--unresolved"]]) {
      const result = await cli([...args, "--agent"]);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).error.code).toBe("invalid_arguments");
      expect(result.calls).toEqual([]);
    }
  });

  test("registers command capabilities and the versioned result schema", async () => {
    const result = await runFixture(["agent", "schema"], { root });
    expect(result.exitCode).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value.supportedCommandPaths).toContainEqual(["pr", "threads"]);
    expect(value.inputs).toContainEqual(expect.objectContaining({ path: ["pr", "threads"], options: expect.arrayContaining([expect.objectContaining({ long: "--since", takesValue: true }), expect.objectContaining({ long: "--all" })]) }));
    expect(value.coreResultSchemas.reviewThreads).toMatchObject({ commandPaths: [["pr", "threads"]], schema: { properties: { schemaVersion: { const: 1 }, pagination: { required: ["complete", "threads", "comments"] } } } });
  });

  test("exposes a read-only MCP tool with the same paginated data", async () => {
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ggh_pr_threads", arguments: { number: 42, state: "all" } } },
    ];
    const result = await runFixture([], { root, responses: [graphql(response([thread("T1", { resolved: true })]))], invoke: `
      const { Readable } = await import('node:stream');
      const input = Readable.from([${JSON.stringify(requests.map(request => JSON.stringify(request)).join("\n") + "\n")}]);
      Object.defineProperty(process, 'stdin', { value: input });
      const { runCli } = await import(${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)});
      process.env.GH_REPO = 'fixture/repo';
      await runCli(['bun', 'ggh', 'mcp']);
    ` });
    expect(result.exitCode).toBe(0);
    const messages = result.stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(messages.find(message => message.id === 2).result.tools).toContainEqual(expect.objectContaining({ name: "ggh_pr_threads", annotations: { readOnlyHint: true } }));
    const toolResult = messages.find(message => message.id === 3).result;
    expect(toolResult.isError).toBeUndefined();
    expect(JSON.parse(toolResult.content[0].text)).toMatchObject({ schemaVersion: 1, threads: [{ id: "T1", isResolved: true }], pagination: { complete: true } });
    expect(result.calls).toHaveLength(1);
  });
});
