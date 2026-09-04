import { describe, expect, it } from "bun:test";
import { parseJsonResponse } from "../src/services/ai/prompt.ts";
import {
  clampLimit,
  filterReviewComments,
  parseGitHubRepositoryNameWithOwnerFromRemoteUrl,
  type ReviewComment,
} from "../src/services/github.ts";
import { sanitizeForAI } from "../src/utils/diff.ts";
import { createProgram } from "../src/index.ts";

describe("github surface", () => {
  it("parses owner/repo from common remote URL shapes", () => {
    expect(parseGitHubRepositoryNameWithOwnerFromRemoteUrl("git@github.com:owner/repo.git")).toBe("owner/repo");
    expect(parseGitHubRepositoryNameWithOwnerFromRemoteUrl("ssh://git@github.com:22/vercel/next.js.git")).toBe(
      "vercel/next.js",
    );
    expect(parseGitHubRepositoryNameWithOwnerFromRemoteUrl("https://github.com/torvalds/linux")).toBe("torvalds/linux");
    expect(parseGitHubRepositoryNameWithOwnerFromRemoteUrl("git://github.com/torvalds/linux")).toBe("torvalds/linux");
  });

  it("keeps a GHES hostname when parsing a non-github.com remote", () => {
    const parsed = parseGitHubRepositoryNameWithOwnerFromRemoteUrl("git@ghe.corp.com:org/repo.git");
    expect(parsed).toEqual({
      host: "ghe.corp.com",
      nameWithOwner: "org/repo",
      toString: (parsed as { toString: () => string }).toString,
    });
    expect(String(parsed)).toBe("ghe.corp.com/org/repo");
  });

  it("clamps --limit between the default and a maximum of 1000", () => {
    expect(clampLimit(-1)).toBe(30);
    expect(clampLimit(0)).toBe(30);
    expect(clampLimit(5, 1000, 30)).toBe(5);
    expect(clampLimit(100, 1000, 30)).toBe(100);
    expect(clampLimit(2000, 1000, 30)).toBe(1000);
    expect(clampLimit(Number.NaN, 1000, 30)).toBe(30);
  });

  it("parseJsonResponse does not strip commas inside JSON strings", () => {
    const raw = '{\n  "title": "hello, world",\n}';
    const parsed = parseJsonResponse<{ title: string }>(raw, { title: "" });
    expect(parsed.title).toBe("hello, world");
  });

  it("sanitizeForAI redacts secrets and caps the size", () => {
    const raw = "Build output:\nghp_" + "a".repeat(40) + "\n" + "x".repeat(50_000);
    const { text, redactedCount } = sanitizeForAI(raw, 1000);
    expect(redactedCount).toBeGreaterThanOrEqual(1);
    expect(text).not.toContain("ghp_" + "a".repeat(40));
    expect(text.length).toBeLessThanOrEqual(1050);
  });

  it("filterReviewComments drops @mentions, URLs not in the diff, and long bodies", () => {
    const diff = "+++ b/readme.md\n@@ -1,1 +1,1 @@\n- old\n+ new https://example.com/diff";
    const comments: ReviewComment[] = [
      { path: "readme.md", line: 1, body: "Looks good." },
      { path: "readme.md", line: 1, body: "Ask @alice about this." },
      { path: "readme.md", line: 1, body: "See https://example.com/other for context." },
      { path: "readme.md", line: 1, body: "See https://example.com/diff for context." },
      { path: "readme.md", line: 1, body: "x".repeat(2001) },
    ];
    const { comments: kept, dropped } = filterReviewComments(comments, diff);
    const expectedFirst = comments.at(0);
    const expectedFourth = comments.at(3);
    if (!expectedFirst || !expectedFourth) throw new Error("test setup broken");
    expect(kept).toEqual([expectedFirst, expectedFourth]);
    expect(dropped).toHaveLength(3);
    expect(dropped.at(0)?.reasons).toContain("contains a @mention");
    expect(dropped.at(1)?.reasons).toContain("contains URL not in the diff: https://example.com/other");
    expect(dropped.at(2)?.reasons).toContain("exceeds 2000 characters");
  });

  for (const name of ["workflow", "label", "gist", "search", "secret", "variable", "notifications", "browse"]) {
    it(`\`ggh ${name} --help\` is available`, async () => {
      const program = await createProgram();
      const command = program.commands.find((c) => c.name() === name);
      expect(command).toBeDefined();
      const help = command!.helpInformation();
      expect(help).toContain(name);
    });
  }

  it("`repo delete` requires a --yes flag and a confirmation prompt", async () => {
    const program = await createProgram();
    const repo = program.commands.find((c) => c.name() === "repo");
    expect(repo).toBeDefined();
    const deleteCmd = repo!.commands.find((c) => c.name() === "delete");
    expect(deleteCmd).toBeDefined();
    const help = deleteCmd!.helpInformation();
    expect(help).toContain("--yes");
    expect(help).toContain("delete");
  });

  it("plugin help advertises only the local install path it supports", async () => {
    const program = await createProgram();
    const plugin = program.commands.find((command) => command.name() === "plugin");
    expect(plugin).toBeDefined();
    const help = plugin!.helpInformation();
    expect(help).toContain("--from <path>");
    expect(help.toLowerCase()).not.toContain("url");
  });

  for (const name of ["release", "workflow"]) {
    it(`\`ggh ${name}\` keeps its default list action reachable`, async () => {
      const program = await createProgram();
      const command = program.commands.find((candidate) => candidate.name() === name);
      expect(command).toBeDefined();
      expect(command!.usage()).toContain("[action]");
      expect(command!.usage()).not.toContain("<action>");
    });
  }
});
