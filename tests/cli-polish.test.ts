/**
 * First-run CLI polish regressions: piped browse output, single error
 * printing, `repo view`, repository-less GitHub commands, and the grouped
 * top-level help. Fixtures fake `gh` by argv prefix (see cli-fixture.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureRoot, runFixture } from "./cli-fixture.ts";
import { createProgram, HELP_GROUPS } from "../src/index.ts";

const root = fixtureRoot("ggh-cli-polish-");
const repo = join(root, "repo");

afterAll(() => rmSync(root, { recursive: true, force: true }));

beforeAll(() => {
  mkdirSync(repo);
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "ignore", stderr: "ignore" });
  git("init", "-b", "main");
  git("config", "user.email", "fixture@example.com");
  git("config", "user.name", "Fixture");
  writeFileSync(join(repo, "fixture.txt"), "fixture\n");
  git("add", "fixture.txt");
  git("commit", "-m", "fixture commit");
});

const prs = [
  { number: 101, title: "Fix table width", author: { login: "aisha" }, headRefName: "fix/width", state: "OPEN", url: "https://github.com/o/r/pull/101" },
  { number: 102, title: "Cache the status preview", author: { login: "ben" }, headRefName: "feat/cache", state: "OPEN", url: "https://github.com/o/r/pull/102" },
];
const prDetail = {
  number: 42, title: "Add cached header", author: { login: "carla" }, headRefName: "feat/cache", baseRefName: "main",
  state: "OPEN", url: "https://github.com/o/r/pull/42", body: "Explains the cache.", headRefOid: "abc123def", isDraft: false,
  additions: 120, deletions: 30, changedFiles: 7, mergeable: "MERGEABLE", reviewDecision: "APPROVED", labels: [{ name: "bug" }],
};
const issues = [
  { number: 7, title: "Broken table", state: "OPEN", url: "https://github.com/o/r/issues/7", author: { login: "dana" }, labels: [{ name: "bug" }], createdAt: "2026-02-01T00:00:00Z" },
  { number: 8, title: "Missing hint", state: "CLOSED", url: "https://github.com/o/r/issues/8", author: { login: "ela" }, labels: [], createdAt: "2026-02-02T00:00:00Z" },
];
const issueDetail = {
  number: 7, title: "Broken table", body: "It breaks.", state: "OPEN", url: "https://github.com/o/r/issues/7",
  author: { login: "dana" }, labels: [{ name: "bug" }], createdAt: "2026-02-01T00:00:00Z",
  comments: [{ author: { login: "frank" }, body: "repro", createdAt: "2026-02-03T00:00:00Z" }],
};
const runs = [
  { databaseId: 555001, displayTitle: "build", workflowName: "CI", status: "completed", conclusion: "success", headBranch: "main", event: "push", createdAt: "2026-02-01T00:00:00Z", url: "https://github.com/o/r/actions/runs/555001" },
  { databaseId: 555002, displayTitle: "test", workflowName: "CI", status: "in_progress", conclusion: "", headBranch: "main", event: "push", createdAt: "2026-02-02T00:00:00Z", url: "https://github.com/o/r/actions/runs/555002" },
];
const repository = {
  nameWithOwner: "octocat/hello", description: "A fixture repository", url: "https://github.com/octocat/hello",
  isPrivate: false, isFork: false, stargazerCount: 42, forkCount: 7,
  primaryLanguage: { name: "TypeScript" }, defaultBranchRef: { name: "main" }, licenseInfo: { name: "MIT" }, repositoryTopics: [{ name: "cli" }],
};

describe("piped browse commands print data instead of cancelling", () => {
  it("pr and pr list print the listing to stdout and exit 0", async () => {
    for (const args of [["pr", "-R", "o/r"], ["pr", "list", "-R", "o/r"]]) {
      const result = await runFixture(args, { root, responses: [{ prefix: ["pr", "list"], stdout: JSON.stringify(prs) }] });
      expect(result.exitCode, `ggh ${args.join(" ")}`).toBe(0);
      expect(result.stdout).toContain("#101 Fix table width");
      expect(result.stdout).toContain("fix/width");
      expect(result.stdout).toContain("@aisha");
      expect(result.stdout).toContain("#102 Cache the status preview");
      expect(result.stdout.trim().split("\n")).toHaveLength(2);
      expect(result.stderr).not.toContain("Cannot prompt");
      expect(result.stderr).not.toContain("Cancelled");
    }
  });

  it("pr <n> prints the summary to stdout and exits 0", async () => {
    const result = await runFixture(["pr", "42", "-R", "o/r"], {
      root,
      responses: [{ prefix: ["pr", "view"], stdout: JSON.stringify(prDetail) }],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("#42 Add cached header");
    expect(result.stdout).toContain("feat/cache → main");
    expect(result.stdout).toContain("+120 -30 across 7 file(s)");
    expect(result.stdout).toContain("https://github.com/o/r/pull/42");
    expect(result.stderr).not.toContain("Cannot prompt");
  });

  it("issue and issue <n> print listings and summaries to stdout", async () => {
    const list = await runFixture(["issue", "-R", "o/r"], {
      root,
      responses: [{ prefix: ["issue", "list"], stdout: JSON.stringify(issues) }],
    });
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain("#7 Broken table");
    expect(list.stdout).toContain("open by @dana");
    expect(list.stdout).toContain("[bug]");
    expect(list.stderr).not.toContain("Cannot prompt");

    const detail = await runFixture(["issue", "7", "-R", "o/r"], {
      root,
      responses: [
        { prefix: ["issue", "view"], stdout: JSON.stringify(issueDetail) },
        { prefix: ["issue", "artifact", "list"], stdout: "[]" },
      ],
    });
    expect(detail.exitCode).toBe(0);
    expect(detail.stdout).toContain("#7 Broken table");
    expect(detail.stdout).toContain("Comments: 1");
    expect(detail.stdout).toContain("https://github.com/o/r/issues/7");
    expect(detail.stderr).not.toContain("Cannot prompt");
  });

  it("run and switch list what they would pick from", async () => {
    const runList = await runFixture(["run", "--all-branches"], {
      root,
      cwd: repo,
      responses: [{ prefix: ["run", "list"], stdout: JSON.stringify(runs) }],
    });
    expect(runList.exitCode).toBe(0);
    expect(runList.stdout).toContain("555001 CI · build");
    expect(runList.stdout).toContain("success");
    expect(runList.stderr).not.toContain("Cannot prompt");

    const switched = await runFixture(["switch"], { root, cwd: repo });
    expect(switched.exitCode).toBe(0);
    expect(switched.stdout).toContain("main");
    expect(switched.stdout).toContain("current branch");
    expect(switched.stderr).not.toContain("Cannot prompt");
  });

  it("cannot-prompt hints name only flags the command actually has", async () => {
    const result = await runFixture(["rename"], { root, cwd: repo });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Cannot prompt");
    // `ggh rename` declares -y/--yes and nothing else that takes a value, so
    // the hint may name --yes but never the browse or AI flags it lacks.
    expect(result.stderr).toContain("(-y, --yes)");
    expect(result.stderr).not.toContain("--no-ai");
    expect(result.stderr).not.toContain("--search");
    expect(result.stderr).not.toContain("--from");
  });
});

describe("usage errors are reported exactly once", () => {
  it("prints a missing argument once", async () => {
    const result = await runFixture(["go"], { root });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("missing required argument");
    expect(result.stderr.match(/missing required argument/g)).toHaveLength(1);
    expect(result.stderr.match(/error:/g)).toHaveLength(1);
    expect(result.stdout).toBe("");
  });

  it("prints an unknown option once", async () => {
    const result = await runFixture(["projects", "--bogus"], { root });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("unknown option");
    expect(result.stderr.match(/unknown option/g)).toHaveLength(1);
    expect(result.stderr.match(/error:/g)).toHaveLength(1);
    expect(result.stdout).toBe("");
  });

  it("reports an unknown help target without commander's sentinel", async () => {
    const result = await runFixture(["help", "bogus"], { root });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Unknown command "bogus"');
    expect(result.stderr).not.toContain("(outputHelp)");
  });
});

describe("repository targeting", () => {
  it("repo view is an alias of the repository detail view", async () => {
    const detail = await runFixture(["repo", "view", "octocat/hello"], {
      root,
      responses: [{ prefix: ["repo", "view"], stdout: JSON.stringify(repository) }],
    });
    expect(detail.exitCode).toBe(0);
    expect(detail.stderr).toContain("octocat/hello");
    expect(detail.stderr).not.toContain("Repository 'view' not found");

    const current = await runFixture(["repo", "view"], {
      root,
      cwd: repo,
      responses: [{ prefix: ["repo", "view"], stdout: JSON.stringify(repository) }],
    });
    expect(current.exitCode).toBe(0);
    expect(current.stderr).toContain("octocat/hello");
    expect(current.stderr).not.toContain("Repository 'view' not found");
  });

  it("repo view outside a repository explains itself", async () => {
    const result = await runFixture(["repo", "view"], { root });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Not inside a GitHub repository. Pass -R owner/repo.");
    expect(result.stderr).not.toContain("Repository 'view' not found");
  });

  it("issue commands outside a repository say how to target one", async () => {
    for (const args of [["issue"], ["issue", "1"]]) {
      const result = await runFixture(args, { root });
      expect(result.exitCode, `ggh ${args.join(" ")}`).not.toBe(0);
      expect(result.stderr).toContain("Not in a GitHub repository; pass -R owner/repo.");
      // Fails fast: no repository or issue lookup is attempted.
      expect(result.calls.filter(call => call[0] !== "auth")).toHaveLength(0);
    }
  });
});

describe("top-level help", () => {
  const GROUP_ORDER = ["Projects", "Review & publish", "Branches & stacks", "CI", "Agents", "Native escapes"];
  let stdout = "";
  let commands: string[] = [];

  /** Command entries per group, in help order. */
  function groupsOf(text: string): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    let current: string | undefined;
    for (const line of text.split("\n")) {
      const heading = GROUP_ORDER.find(name => line === name);
      if (heading !== undefined) {
        current = heading;
        if (!groups.has(current)) groups.set(current, []);
        continue;
      }
      if (current === undefined) continue;
      // Any flush-left line (Options:, Examples:, a blank line) ends a group.
      if (!line.startsWith("  ")) { current = undefined; continue; }
      const entry = line.trim().split(/\s+/)[0] ?? "";
      if (/^[a-z][a-z|]*$/.test(entry)) groups.get(current)?.push(entry.split("|")[0] ?? entry);
    }
    return groups;
  }

  beforeAll(async () => {
    process.env.GGH_NO_PLUGINS = "1";
    const result = await runFixture(["--help"], { root });
    expect(result.exitCode).toBe(0);
    stdout = result.stdout;
    const program = await createProgram();
    commands = program.commands.map(command => command.name());
  });

  it("leads with the pitch", () => {
    expect(stdout).toContain("The GitHub CLI it should have been");
    expect(stdout).toContain("find the right checkout");
  });

  it("shows the groups in order with native escapes last", () => {
    const positions = GROUP_ORDER.map(name => stdout.indexOf(`\n${name}\n`));
    for (const [index, position] of positions.entries()) expect(position, GROUP_ORDER[index]).toBeGreaterThanOrEqual(0);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // Nothing is left in an ungrouped default section.
    expect(stdout).not.toContain("Commands:");
  });

  it("puts every command in a group, exactly once, in registration order", () => {
    const groups = groupsOf(stdout);
    expect([...groups.keys()]).toEqual(GROUP_ORDER);
    expect(groups.get("Projects")?.slice(0, 6)).toEqual(["projects", "go", "clone", "lost", "sync", "tidy"]);
    expect(groups.get("Native escapes")).toEqual(["git", "gh", "api"]);

    const seen = new Map<string, string>();
    for (const [group, entries] of groups) {
      for (const entry of entries) {
        expect(seen.has(entry), `${entry} appears in both ${seen.get(entry)} and ${group}`).toBe(false);
        seen.set(entry, group);
      }
    }
    const expected = new Map<string, string>();
    for (const name of commands) {
      expect(HELP_GROUPS[name], `ggh ${name} needs a help group`).toBeDefined();
      expected.set(name, HELP_GROUPS[name] ?? "");
    }
    expected.set("help", "Agents");
    expect(seen).toEqual(expected);
  });

  it("describes commands by what they do and shows three examples", () => {
    expect(stdout).toContain("Stage, commit, push, and open a pull request");
    expect(stdout).toContain("Examples:");
    expect(stdout).toContain("One table across local clones and agent worktrees");
    expect(stdout).toContain("Find work that never left this machine");
    expect(stdout).toContain("Review a pull request from the right checkout");
  });
});
