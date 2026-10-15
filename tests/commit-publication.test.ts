import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fixtureRoot, runFixture } from "./cli-fixture.ts";

const roots: string[] = [];

function tempRoot(): string {
  const root = fixtureRoot("ggh-commit-publication-");
  roots.push(root);
  return root;
}

function git(args: string[], cwd: string): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function makeRepository(root: string): { repo: string; baseTip: string } {
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(["init", "--initial-branch=main"], repo);
  git(["config", "user.name", "Fixture"], repo);
  git(["config", "user.email", "fixture@example.test"], repo);
  writeFileSync(join(repo, "README.md"), "base\n");
  git(["add", "README.md"], repo);
  git(["commit", "-m", "base"], repo);
  return { repo, baseTip: git(["rev-parse", "HEAD"], repo) };
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("commit publication", () => {
  test("requires protected push approval before staging, even with records disabled", async () => {
    const root = tempRoot();
    const { repo, baseTip } = makeRepository(root);
    writeFileSync(join(repo, "README.md"), "new content\n");
    const entry = join(import.meta.dir, "../src/index.ts");
    const args = ["commit", "--push", "-a", "-m", "update main", "--json"];
    const result = await runFixture([], { root, cwd: repo, invoke: `process.env.GGH_NO_RECORDS='1';const {runCli}=await import(${JSON.stringify(entry)});await runCli(['bun','ggh',...${JSON.stringify(args)}]);` });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).status).toBe("needs_input");
    expect(git(["rev-parse", "HEAD"], repo)).toBe(baseTip);
    expect(git(["diff", "--cached", "--name-only"], repo)).toBe("");
    expect(result.providerCalls).toHaveLength(0);
  });
  test("commits from a feature-only subdirectory while switching to an existing branch", async () => {
    const root = tempRoot();
    const { repo } = makeRepository(root);
    git(["switch", "-c", "feature"], repo);
    const nested = join(repo, "feature-only"); mkdirSync(nested);
    writeFileSync(join(nested, "file.txt"), "feature folder\n");
    git(["add", "."], repo); git(["commit", "-m", "feature folder"], repo);
    const featureTip = git(["rev-parse", "HEAD"], repo);
    writeFileSync(join(repo, "README.md"), "new content\n");
    const result = await runFixture(["commit", "--branch", "main", "-a", "-m", "update main", "--json"], { root, cwd: nested });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "succeeded", branch: "main" });
    expect(git(["log", "-1", "--format=%s"], repo)).toBe("update main");
    expect(git(["rev-parse", "feature"], repo)).toBe(featureTip);
    expect(result.providerCalls).toHaveLength(0);
  });
  test("creates the requested branch before staging and leaves main unchanged", async () => {
    const { repo, baseTip } = makeRepository(tempRoot());
    writeFileSync(join(repo, "feature.txt"), "feature\n");

    const result = await runFixture(
      [
        "commit",
        "--all",
        "--message",
        "feat: add feature",
        "--branch",
        "feat/explicit",
        "--no-verify",
        "--json",
      ],
      { root: roots.at(-1)!, cwd: repo },
    );

    expect(result.exitCode).toBe(0);
    expect(git(["branch", "--show-current"], repo)).toBe("feat/explicit");
    expect(git(["rev-parse", "main"], repo)).toBe(baseTip);
    expect(git(["rev-parse", "HEAD"], repo)).not.toBe(baseTip);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "succeeded",
      branch: "feat/explicit",
    });
  });

  test("creates the requested branch, pushes it to a local remote, and opens a PR", async () => {
    const root = tempRoot();
    const { repo, baseTip } = makeRepository(root);
    const bare = join(root, "remote.git");
    git(["init", "--bare", bare], root);
    git(
      ["remote", "add", "origin", "https://github.com/fixture/project.git"],
      repo,
    );
    git(
      [
        "config",
        `url.${pathToFileURL(bare).href}.insteadOf`,
        "https://github.com/fixture/project.git",
      ],
      repo,
    );
    git(["push", "origin", "main"], repo);
    writeFileSync(join(repo, "feature.txt"), "feature\n");

    const result = await runFixture(
      [
        "commit",
        "--all",
        "--message",
        "feat: add feature",
        "--branch",
        "feature",
        "--pr",
        "--base",
        "main",
        "--yes",
        "--no-ai",
        "--no-verify",
        "--json",
      ],
      {
        root,
        cwd: repo,
        responses: [
          { prefix: ["repo", "view", "fixture/project", "--json", "url,isPrivate,visibility"], stdout: '{"url":"https://github.com/fixture/project","isPrivate":true,"visibility":"PRIVATE"}' },
          { prefix: ["pr", "list"], stdout: "[]" },
          {
            prefix: ["pr", "create"],
            stdout: "https://github.com/fixture/project/pull/8\n",
          },
        ],
      },
    );

    expect(result.exitCode).toBe(0);
    expect(git(["branch", "--show-current"], repo)).toBe("feature");
    expect(git(["rev-parse", "main"], repo)).toBe(baseTip);
    expect(git(["--git-dir", bare, "rev-parse", "refs/heads/main"], root)).toBe(
      baseTip,
    );
    expect(
      git(["--git-dir", bare, "rev-parse", "refs/heads/feature"], root),
    ).toBe(git(["rev-parse", "HEAD"], repo));
    expect(
      result.calls.some((args) => args[0] === "pr" && args[1] === "create"),
    ).toBe(true);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "succeeded",
      head: "feature",
      base: "main",
    });
  });

  test("rejects an invalid branch before staging", async () => {
    const { repo } = makeRepository(tempRoot());
    writeFileSync(join(repo, "feature.txt"), "feature\n");

    const result = await runFixture(
      [
        "commit",
        "--all",
        "--message",
        "feat: add feature",
        "--branch",
        "bad branch",
        "--json",
      ],
      { root: roots.at(-1)!, cwd: repo },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Invalid branch name");
    expect(git(["branch", "--show-current"], repo)).toBe("main");
    expect(git(["diff", "--cached", "--name-only"], repo)).toBe("");
    expect(git(["status", "--porcelain"], repo)).toContain("feature.txt");
  });

  test("rejects a base equal to head before staging", async () => {
    const { repo } = makeRepository(tempRoot());
    writeFileSync(join(repo, "feature.txt"), "feature\n");

    const result = await runFixture(
      [
        "commit",
        "--all",
        "--message",
        "feat: add feature",
        "--pr",
        "--base",
        "main",
        "--yes",
        "--json",
      ],
      { root: roots.at(-1)!, cwd: repo },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("must differ from the commit branch");
    expect(git(["diff", "--cached", "--name-only"], repo)).toBe("");
    expect(git(["status", "--porcelain"], repo)).toContain("feature.txt");
  });

  test("requires explicit no-input publication approval before switching or staging", async () => {
    const { repo } = makeRepository(tempRoot());
    writeFileSync(join(repo, "feature.txt"), "feature\n");

    const result = await runFixture(
      [
        "commit",
        "--all",
        "--message",
        "feat: add feature",
        "--pr",
        "--base",
        "main",
        "--branch",
        "feat/explicit",
        "--no-input",
        "--json",
      ],
      { root: roots.at(-1)!, cwd: repo },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Pass --yes with --pr");
    expect(git(["branch", "--show-current"], repo)).toBe("main");
    expect(git(["diff", "--cached", "--name-only"], repo)).toBe("");
    expect(git(["status", "--porcelain"], repo)).toContain("feature.txt");
  });

  test("retries PR publication from a clean feature branch with existing commits", async () => {
    const root = tempRoot();
    const { repo } = makeRepository(root);
    const bare = join(root, "remote.git");
    git(["init", "--bare", bare], root);
    git(
      ["remote", "add", "origin", "https://github.com/fixture/project.git"],
      repo,
    );
    git(
      [
        "config",
        `url.${pathToFileURL(bare).href}.insteadOf`,
        "https://github.com/fixture/project.git",
      ],
      repo,
    );
    git(["push", "origin", "main"], repo);
    git(["switch", "-c", "feature"], repo);
    writeFileSync(join(repo, "feature.txt"), "feature\n");
    git(["add", "feature.txt"], repo);
    git(["commit", "-m", "feat: existing feature"], repo);
    git(["push", "-u", "origin", "feature"], repo);

    const result = await runFixture(
      ["commit", "--pr", "--base", "main", "--yes", "--no-ai", "--json"],
      {
        root,
        cwd: repo,
        responses: [
          { prefix: ["repo", "view", "fixture/project", "--json", "url,isPrivate,visibility"], stdout: '{"url":"https://github.com/fixture/project","isPrivate":true,"visibility":"PRIVATE"}' },
          { prefix: ["pr", "list"], stdout: "[]" },
          {
            prefix: ["pr", "create"],
            stdout: "https://github.com/fixture/project/pull/7\n",
          },
        ],
      },
    );

    expect(result.exitCode).toBe(0);
    expect(
      result.calls.some((args) => args[0] === "pr" && args[1] === "create"),
    ).toBe(true);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "succeeded",
      head: "feature",
      base: "main",
    });
  });

  test("reports a missing remote as a partial push and preserves the local revision", async () => {
    const { repo } = makeRepository(tempRoot());
    writeFileSync(join(repo, "feature.txt"), "feature\n");

    const result = await runFixture(
      [
        "commit",
        "--all",
        "--message",
        "feat: add feature",
        "--push",
        "--yes",
        "--no-verify",
        "--json",
      ],
      { root: roots.at(-1)!, cwd: repo },
    );

    const value = JSON.parse(result.stdout);
    expect(result.exitCode).not.toBe(0);
    expect(value).toMatchObject({
      status: "partially_completed",
      completed: ["commit"],
      remaining: ["push"],
      branch: "main",
    });
    expect(value.revision).toBe(git(["rev-parse", "HEAD"], repo));
  });

  test("emits JSON for a clean no-op commit", async () => {
    const { repo } = makeRepository(tempRoot());

    const result = await runFixture(
      ["commit", "--no-input", "--no-ai", "--json"],
      { root: roots.at(-1)!, cwd: repo },
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "succeeded",
      action: "commit",
      noOp: true,
      branch: "main",
    });
  });
});
