import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkoutForReview } from "../src/services/git/worktree.ts";
import { detectReviewEditor, editorInvocation, materializeReviewPairs } from "../src/services/review/editors.ts";
import { detectReviewPager } from "../src/services/review/pager.ts";
import { markReview, readReviewMark } from "../src/services/review/ledger.ts";
import { run } from "../src/utils/exec.ts";
import { fixtureRoot, runFixture } from "./cli-fixture.ts";

const root = fixtureRoot("ggh-review-");
const temporary: string[] = [];
afterAll(() => { rmSync(root, { recursive: true, force: true }); for (const path of temporary) rmSync(path, { recursive: true, force: true }); });
const git = (cwd: string, args: string[]) => run("git", args, { cwd });
async function repository() {
  const parent = fixtureRoot("ggh-review-repo-");
  temporary.push(parent);
  const repo = join(parent, "repo");
  await git(parent, ["init", "-b", "main", repo]);
  await git(repo, ["config", "user.name", "Fixture"]);
  await git(repo, ["config", "user.email", "fixture@example.com"]);
  writeFileSync(join(repo, "file.ts"), "base\n");
  writeFileSync(join(repo, ".gitignore"), ".env*\n.worktrees/\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "base"]);
  const base = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
  await git(repo, ["remote", "add", "origin", "https://github.com/fixture/repo.git"]);
  await git(repo, ["config", `url.file://${repo}.insteadOf`, "https://github.com/fixture/repo.git"]);
  return { parent, repo, base };
}
async function commit(repo: string, text: string, subject = "change") {
  writeFileSync(join(repo, "file.ts"), text);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", subject]);
  return (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
}
function threads(head: string, base: string) {
  const comment = (id: string, createdAt: string, updatedAt = createdAt) => ({ id, databaseId: 1, author: { login: "reviewer" }, body: id, createdAt, updatedAt, url: "https://github.com/fixture/repo/pull/42", outdated: false });
  const thread = (id: string, comments: ReturnType<typeof comment>[]) => ({ id, isResolved: false, isOutdated: false, viewerCanResolve: true, viewerCanUnresolve: false, path: "file.ts", line: 1, originalLine: 1, startLine: null, diffSide: "RIGHT", comments: { nodes: comments, pageInfo: { hasNextPage: false, endCursor: null } } });
  return { data: { repository: { pullRequest: { headRefOid: head, baseRefOid: base, reviewThreads: {
    nodes: [thread("old", [comment("old", "2000-01-01T00:00:00Z")]), thread("edited", [comment("edited", "2000-01-01T00:00:00Z", "2099-01-01T00:00:00Z")]), thread("new", [comment("new", "2099-01-01T00:00:00Z")])],
    pageInfo: { hasNextPage: false, endCursor: null },
  } } } } };
}
async function review(input: { parent: string; repo: string; base: string; head: string; unsafeText?: string }, args: string[]) {
  const command = ["review", "42", ...args];
  const discussion = threads(input.head, input.base);
  if (input.unsafeText) for (const thread of discussion.data.repository.pullRequest.reviewThreads.nodes) for (const comment of thread.comments.nodes) {
    comment.body = input.unsafeText; comment.author.login = input.unsafeText;
  }
  return runFixture(command, { root, cwd: input.repo, responses: [
    { prefix: ["pr", "view", "42"], stdout: JSON.stringify({ number: 42, url: "https://github.com/fixture/repo/pull/42", headRefOid: input.head, baseRefOid: input.base }) },
    { prefix: ["api", "graphql"], stdout: JSON.stringify(discussion) },
  ], invoke: `
    process.env.XDG_CONFIG_HOME = ${JSON.stringify(input.parent)};
    process.env.GGH_REVIEW_EDITOR = 'missing-editor --wait';
    const { mock } = await import('bun:test');
    if (${Boolean(input.unsafeText)}) mock.module(${JSON.stringify(new URL("../src/services/review/pager.ts", import.meta.url).href)}, () => ({detectReviewPager:()=> 'renderer',showReviewPager:async()=>{}}));
    const childProcess = await import('node:child_process');
    mock.module('node:child_process', () => ({ ...childProcess, spawn() { throw new Error('GUI launch forbidden'); }, execFile() { throw new Error('Editor materialization forbidden'); } }));
    const originalSpawn = Bun.spawn;
    Bun.spawn = (argv, options) => {
      if (!['git', 'gh'].includes(argv[0])) throw new Error('Unexpected process: ' + argv[0]);
      return originalSpawn(argv, options);
    };
    const { runCli } = await import(${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)});
    await runCli(['bun', 'ggh', ...${JSON.stringify(command)}]);
  ` });
}

describe("review checkout", () => {
  test("reuses a clean detached checkout, follows new heads and refuses tracked or untracked dirt", async () => {
    const { repo, base } = await repository();
    const path = join(repo, ".worktrees", "review-42");
    const config = readFileSync(join(repo, ".git", "config"), "utf8");
    const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
    writeFileSync(join(repo, ".env"), "SECRET=private\n");
    await checkoutForReview(base, path, { cwd: repo, detached: true, reuse: true });
    expect(existsSync(join(path, ".env"))).toBe(false);
    expect(readFileSync(join(repo, ".git", "config"), "utf8")).toBe(config);
    expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf8")).toBe(exclude);
    const head = await commit(repo, "next\n");
    await checkoutForReview(head, path, { cwd: repo, detached: true, reuse: true });
    expect((await git(path, ["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
    writeFileSync(join(path, "file.ts"), "dirty\n");
    await expect(checkoutForReview(base, path, { cwd: repo, detached: true, reuse: true })).rejects.toThrow("dirty");
    expect(readFileSync(join(path, "file.ts"), "utf8")).toBe("dirty\n");
    await git(path, ["restore", "file.ts"]);
    writeFileSync(join(path, "untracked"), "keep");
    await expect(checkoutForReview(base, path, { cwd: repo, detached: true, reuse: true })).rejects.toThrow("dirty");
  });

  test("refuses an existing directory and a branch worktree", async () => {
    const { repo, base } = await repository();
    const path = join(repo, ".worktrees", "review-42");
    mkdirSync(path, { recursive: true });
    await expect(checkoutForReview(base, path, { cwd: repo, detached: true, reuse: true })).rejects.toThrow("Refusing");
    rmSync(path, { recursive: true });
    await git(repo, ["worktree", "add", "-b", "user-branch", path]);
    await expect(checkoutForReview(base, path, { cwd: repo, detached: true, reuse: true })).rejects.toThrow("Refusing");
  });
});

describe("review editors", () => {
  for (const [env, available, expected] of [
    [{ GGH_REVIEW_EDITOR: 'cursor --wait', VISUAL: "zed", EDITOR: "code" }, ["cursor", "zed", "code"], "cursor"],
    [{ VISUAL: "zed", EDITOR: "code" }, ["zed", "code"], "zed"],
    [{ VISUAL: "vim", EDITOR: "cursor" }, ["vim", "cursor", "code"], "cursor"],
    [{ EDITOR: "nano" }, ["nano", "code", "cursor"], "code"],
    [{}, ["cursor", "zed", "idea"], "cursor"],
    [{}, ["zed", "idea"], "zed"],
    [{}, ["idea"], "difftool"],
    [{}, [], undefined],
  ] as const) {
    test(`detects ${expected ?? "no editor"} with ${JSON.stringify(env)} and ${available.join(",")}`, () => {
      const editor = detectReviewEditor(env, command => available.some(candidate => candidate === command));
      expect(editor?.kind).toBe(expected);
      expect(editor?.args ?? []).not.toContain("--wait");
    });
  }
  test("rejects a broken explicit editor rather than silently choosing another", () => {
    expect(() => detectReviewEditor({ GGH_REVIEW_EDITOR: "missing" }, () => false)).toThrow("not executable");
  });
  test("builds one Zed invocation with repeated diff pairs", () => {
    expect(editorInvocation({ kind: "zed", command: "zed", args: [] }, "/checkout", [["/old/a", "/new/a"], ["/old/b", "/new/b"]], true)).toEqual(["zed", "--diff", "/old/a", "/new/a", "--diff", "/old/b", "/new/b"]);
  });
  test("materializes exact base/head bytes, added/deleted files and unusual names", async () => {
    const { repo, base } = await repository();
    const name = "quote ' and space.ts";
    const bytes = Buffer.from([0, 128, 255, 10]);
    writeFileSync(join(repo, name), bytes);
    rmSync(join(repo, "file.ts"));
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "add binary, delete file"]);
    const head = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
    const pairs = await materializeReviewPairs(repo, base, head, [name, "file.ts"]);
    expect(pairs).toHaveLength(2);
    expect(readFileSync(pairs[0]![0])).toEqual(Buffer.alloc(0));
    expect(readFileSync(pairs[0]![1])).toEqual(bytes);
    expect(readFileSync(pairs[1]![0], "utf8")).toBe("base\n");
    expect(readFileSync(pairs[1]![1])).toEqual(Buffer.alloc(0));
    rmSync(join(pairs[0]![0], "..", "..", ".."), { recursive: true, force: true });
  });
  test("uses the old path for renamed file pairs", async () => {
    const { repo, base } = await repository();
    await git(repo, ["mv", "file.ts", "renamed.ts"]);
    await git(repo, ["commit", "-m", "rename file"]);
    const head = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
    const pairs = await materializeReviewPairs(repo, base, head, ["renamed.ts"]);
    try {
      expect(readFileSync(pairs[0]![0], "utf8")).toBe("base\n");
      expect(readFileSync(pairs[0]![1], "utf8")).toBe("base\n");
    } finally { rmSync(join(pairs[0]![0], "..", "..", ".."), { recursive: true, force: true }); }
  });
  test("shows gitlink changes without initializing a submodule", async () => {
    const { repo, base } = await repository();
    await git(repo, ["update-index", "--add", "--cacheinfo", `160000,${base},dependency`]);
    await git(repo, ["commit", "-m", "add gitlink"]);
    const head = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
    const pairs = await materializeReviewPairs(repo, base, head, ["dependency"]);
    try {
      expect(readFileSync(pairs[0]![0], "utf8")).toBe("");
      expect(readFileSync(pairs[0]![1], "utf8")).toBe(`Subproject commit ${base}\n`);
      expect(existsSync(join(repo, "dependency", ".git"))).toBe(false);
    } finally { rmSync(join(pairs[0]![0], "..", "..", ".."), { recursive: true, force: true }); }
  });
  test("selects pager fallbacks and keeps incremental reviews out of tuicr's full PR view", () => {
    expect(detectReviewPager(false, () => true)).toBe("tuicr");
    expect(detectReviewPager(true, () => true)).toBe("delta");
    expect(detectReviewPager(false, command => command === "delta")).toBe("delta");
    expect(detectReviewPager(false, () => false)).toBe("renderer");
  });
});

test("stores explicit private ledger entries by repository and host", () => {
  const config = join(root, "ledger");
  const key = "github.com/owner/repo/42";
  expect(readReviewMark(key, config)).toBeUndefined();
  const first = { reviewedHead: "a".repeat(40), reviewedBase: "b".repeat(40), mergeBase: "c".repeat(40), at: "2026-10-22T10:00:00Z", scope: "inspected" as const };
  markReview(key, first, config);
  const last = { ...first, reviewedHead: "d".repeat(40), scope: "decided" as const, note: "follow up" };
  markReview(key, last, config);
  expect(readReviewMark(key, config)).toEqual(last);
  expect(readReviewMark("enterprise.example/owner/repo/42", config)).toBeUndefined();
  const file = join(config, "reviews", readdirSync(join(config, "reviews"))[0]!);
  expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
});

describe("review CLI", () => {
  test("JSON and agent modes fetch and reuse checkout, never launch presentation processes or infer a mark", async () => {
    const fixture = await repository();
    const head = await commit(fixture.repo, "head\n");
    let first = true;
    for (const args of [["--agent", "--editor"], ["--agent", "--pager"], ["--json"]]) {
      const output = await review({ ...fixture, head }, args);
      expect(output.exitCode).toBe(0);
      const document = JSON.parse(output.stdout);
      const payload = document.result ?? document;
      expect(payload).toMatchObject({ schemaVersion: 1, headSha: head, baseSha: fixture.base, surface: "data", checkoutPath: join(fixture.repo, ".worktrees", "review-42") });
      expect(payload.marked).toBeUndefined();
      if (args.includes("--agent")) {
        expect(document.effects.completed).toEqual(first ? ["review_objects_fetched", "review_checkout_created"] : ["review_objects_fetched"]);
      }
      first = false;
      expect(output.providerCalls).toEqual([]);
      expect(output.calls.every(call => ["pr", "auth"].includes(call[0]!))).toBe(true);
    }
    expect(existsSync(join(fixture.parent, "good-gh", "reviews"))).toBe(false);
  });

  test("marks then compares a fast-forward and returns only new or edited threads", async () => {
    const fixture = await repository();
    const first = await commit(fixture.repo, "first\n", "first change");
    const marked = await review({ ...fixture, head: first }, ["--agent", "--mark"]);
    expect(marked.exitCode).toBe(0);
    expect(JSON.parse(marked.stdout).effects.completed).toEqual(["review_objects_fetched", "review_checkout_created", "review_refs_updated", "review_ledger_marked"]);
    const head = await commit(fixture.repo, "second\n", "second change");
    const output = await review({ ...fixture, head }, ["--agent", "--since", "last", "--editor"]);
    expect(output.exitCode).toBe(0);
    expect(JSON.parse(output.stdout).effects.completed).toEqual(["review_objects_fetched", "review_checkout_updated"]);
    expect(JSON.parse(output.stdout).result.since).toMatchObject({ fromHead: first, rewritten: false, commits: [{ sha: head, subject: "second change" }], files: ["file.ts"], threadsChanged: { threads: [{ id: "edited" }, { id: "new" }] } });
    expect((await git(join(fixture.repo, ".worktrees", "review-42"), ["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
  });

  test("detects rebased or force-pushed history and includes range-diff ambiguity", async () => {
    const fixture = await repository();
    const first = await commit(fixture.repo, "first\n");
    await review({ ...fixture, head: first }, ["--json", "--mark"]);
    await git(fixture.repo, ["reset", "--hard", fixture.base]);
    const head = await commit(fixture.repo, "rewritten\n", "replacement");
    const output = await review({ ...fixture, head }, ["--agent", "--since", "last", "--pager"]);
    expect(output.exitCode).toBe(0);
    expect(JSON.parse(output.stdout).result.since).toMatchObject({ fromHead: first, rewritten: true, commits: [{ sha: head, subject: "replacement" }], files: ["file.ts"], rangeDiff: expect.any(String), ambiguity: expect.stringContaining("heuristically") });
    expect((await git(join(fixture.repo, ".worktrees", "review-42"), ["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
  });

  test("refuses --since last without a mark and leaves the checkout absent", async () => {
    const fixture = await repository();
    const output = await review({ ...fixture, head: fixture.base }, ["--agent", "--since", "last"]);
    expect(output.exitCode).toBe(1);
    expect(JSON.parse(output.stdout).error.message).toContain("No local review mark");
    expect(existsSync(join(fixture.repo, ".worktrees", "review-42"))).toBe(false);
  });

  test("retains checkout and ref effects when the ledger write fails", async () => {
    const fixture = await repository();
    const reviews = join(fixture.parent, "good-gh", "reviews");
    mkdirSync(join(fixture.parent, "good-gh"), { recursive: true });
    writeFileSync(reviews, "blocks ledger directory");
    const output = await review({ ...fixture, head: fixture.base }, ["--agent", "--mark"]);
    expect(output.exitCode).toBe(1);
    expect(JSON.parse(output.stdout).effects.completed).toEqual(["review_objects_fetched", "review_checkout_created", "review_refs_updated"]);
    expect(existsSync(join(fixture.repo, ".worktrees", "review-42"))).toBe(true);
  });

  test("accepts an explicit SHA without a mark", async () => {
    const fixture = await repository();
    const head = await commit(fixture.repo, "head\n");
    const output = await review({ ...fixture, head }, ["--json", "--since", fixture.base]);
    expect(output.exitCode).toBe(0);
    expect(JSON.parse(output.stdout).since).toMatchObject({ fromHead: fixture.base, rewritten: false, files: ["file.ts"] });
  });

  test("rejects invalid arguments before accessing GitHub or Git", async () => {
    for (const args of [["review", "0", "--agent"], ["review", "42", "--editor", "--pager", "--agent"], ["review", "42", "--since", "--bad", "--agent"]]) {
      const output = await runFixture(args, { root });
      expect(output.exitCode).toBe(1);
      expect(output.calls).toEqual([]);
    }
  });

  test("exposes the review schema, command flags, and help distinction from approval", async () => {
    const output = await runFixture(["agent", "schema"], { root });
    const value = JSON.parse(output.stdout);
    expect(value.supportedCommandPaths).toContainEqual(["review"]);
    expect(value.coreResultSchemas.review.schema.required).toContain("checkoutPath");
    const help = await runFixture(["review", "--help"], { root });
    expect(help.stdout).toContain("never GitHub approvals");
    expect(help.stdout).toContain("--mark");
  });
});

test("launches Zed once for multiple diffs with detached ignored stdio", async () => {
  const fixture = await repository();
  writeFileSync(join(fixture.repo, "second.ts"), "second\n");
  const head = await commit(fixture.repo, "changed\n");
  const output = await runFixture([], { root, cwd: fixture.repo, invoke: `
    const calls = [];
    const originalSpawn = Bun.spawn;
    Bun.spawn = (argv, options) => {
      if (argv[0] !== 'zed') return originalSpawn(argv, options);
      calls.push({ command: argv[0], args: argv.slice(1), options });
      return { unref(){} };
    };
    const { openReviewEditor } = await import(${JSON.stringify(new URL("../src/services/review/editors.ts", import.meta.url).href)});
    await openReviewEditor({ editor: {kind:'zed',command:'zed',args:[]}, cwd: ${JSON.stringify(fixture.repo)}, from: ${JSON.stringify(fixture.base)}, head: ${JSON.stringify(head)}, files: ['file.ts','second.ts'], incremental: true });
    console.log(JSON.stringify(calls));
  ` });
  expect(output.exitCode).toBe(0);
  const calls = JSON.parse(output.stdout);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ command: "zed", options: { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" } });
  expect(calls[0].args.filter((arg: string) => arg === "--diff")).toHaveLength(2);
  expect(readFileSync(calls[0].args[1], "utf8")).toBe("base\n");
  expect(readFileSync(calls[0].args[2], "utf8")).toBe("changed\n");
  rmSync(join(calls[0].args[1], "..", "..", ".."), { recursive: true, force: true });
});

for (const installed of [false, true]) {
  test(`opens the VS Code folder and ${installed ? "omits" : "prints"} the missing-extension hint`, async () => {
    const output = await runFixture([], { root, invoke: `
      const calls = [];
      const originalSpawn = Bun.spawn;
      Bun.spawn = (argv, options) => {
        if (argv[0] !== 'code') return originalSpawn(argv, options);
        if (argv.includes('--list-extensions')) return { pid:0, stdout:new Blob([${JSON.stringify(installed ? "GitHub.vscode-pull-request-github\n" : "other.extension\n")}]).stream(), stderr:new Blob([]).stream(), exited:Promise.resolve(0), kill(){}, stdin:null };
        calls.push({command:argv[0],args:argv.slice(1),options}); return {unref(){}};
      };
      const { openReviewEditor } = await import(${JSON.stringify(new URL("../src/services/review/editors.ts", import.meta.url).href)});
      const hint = await openReviewEditor({editor:{kind:'code',command:'code',args:[]},cwd:${JSON.stringify(root)},from:'a'.repeat(40),head:'b'.repeat(40),files:[],incremental:false});
      console.log(JSON.stringify({hint,calls}));
    ` });
    expect(output.exitCode).toBe(0);
    const value = JSON.parse(output.stdout);
    expect(value.calls).toMatchObject([{ command: "code", args: [root], options: { detached: true } }]);
    expect(value.hint).toBe(installed ? undefined : "Install GitHub Pull Requests in code for PR diffs and comments.");
  });
}

test("pipes a diff to inherited pager stdin", async () => {
  const output = await runFixture([], { root, invoke: `
    const { run } = await import(${JSON.stringify(new URL("../src/utils/exec.ts", import.meta.url).href)});
    await run(process.execPath, ['--no-env-file','-e', 'process.stdout.write(await new Response(Bun.stdin.stream()).text())'], {input:'diff for pager\\n',stdio:'inherit'});
  ` });
  expect(output.exitCode).toBe(0);
  expect(output.stdout).toBe("diff for pager\n");
});

test("incremental review human output strips commit and thread terminal controls", async () => {
  const fixture = await repository();
  const unsafeText = "visible\x1b[2J\x1b]0;forged\x07";
  const head = await commit(fixture.repo, "change\n", unsafeText);
  const output = await review({ ...fixture, head, unsafeText }, ["--pager", "--since", fixture.base]);
  expect(output.exitCode, output.stderr).toBe(0);
  expect(output.stdout).toContain("visible"); expect(output.stdout).not.toContain("\x1b"); expect(output.stdout).not.toContain("forged");
  const raw = await review({ ...fixture, head, unsafeText }, ["--json", "--since", fixture.base]);
  expect(JSON.parse(raw.stdout).since.commits[0].subject).toBe(unsafeText);
  expect(JSON.parse(raw.stdout).since.threadsChanged.threads[0].comments[0]).toMatchObject({ body: unsafeText, author: { login: unsafeText } });
});
