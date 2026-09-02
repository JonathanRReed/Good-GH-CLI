import { describe, expect, it } from "bun:test";
import {
  buildBranchNamePrompt,
  buildCommitPrompt,
  buildPrPrompt,
  parseJsonResponse,
} from "../src/services/ai/prompt.ts";

describe("prompt builder", () => {
  it("builds conventional commit prompt matching T3 Code guidelines", () => {
    const prompt = buildCommitPrompt({
      branch: "feat/login",
      stagedFiles: [{ path: "src/auth.ts", status: "modified", staged: true }],
      stagedDiff: "diff --git a/src/auth.ts...",
      style: "conventional",
    });

    expect(prompt).toContain("subject must be imperative, <= 72 chars, and no trailing period");
    expect(prompt).toContain("Conventional Commits");
    expect(prompt).toContain("Branch: feat/login");
    expect(prompt).toContain("- src/auth.ts (modified)");
  });

  it("builds PR prompt with base branch, head branch, PR template, and issue linking", () => {
    const prompt = buildPrPrompt({
      branch: "feat/login",
      baseBranch: "main",
      diff: "diff --git...",
      commitSummary: "feat: add oauth login",
      template: "## Summary\n## Testing",
      issue: "42",
    });

    expect(prompt).toContain("Base Branch: main");
    expect(prompt).toContain("Head Branch: feat/login");
    expect(prompt).toContain("feat: add oauth login");
    expect(prompt).toContain("Link this Pull Request to issue #42");
    expect(prompt).toContain("## Summary\n## Testing");
  });

  it("builds commit prompt with issue linking and diffStat", () => {
    const prompt = buildCommitPrompt({
      branch: "feat/issue-test",
      stagedFiles: [{ path: "src/api.ts", status: "modified", staged: true }],
      stagedDiff: "+new code",
      diffStat: "src/api.ts | 2 +-",
      issue: "99",
      style: "conventional",
    });

    expect(prompt).toContain("Fixes #99");
    expect(prompt).toContain("Diff stat:");
    expect(prompt).toContain("src/api.ts | 2 +-");
  });

  it("builds branch name prompt", () => {
    const prompt = buildBranchNamePrompt("add dark mode toggle button");
    expect(prompt).toContain("Rules:");
    expect(prompt).toContain("Description: add dark mode toggle button");
  });

  it("parses valid JSON response", () => {
    const raw = '{"subject": "feat: add login", "body": "implement oauth"}';
    const parsed = parseJsonResponse(raw, { subject: "fallback", body: "" });
    expect(parsed.subject).toBe("feat: add login");
    expect(parsed.body).toBe("implement oauth");
  });

  it("parses markdown-fenced JSON response with trailing commas", () => {
    const raw = '```json\n{\n  "subject": "fix: resolve bug",\n  "body": "details",\n}\n```';
    const parsed = parseJsonResponse(raw, { subject: "fallback", body: "" });
    expect(parsed.subject).toBe("fix: resolve bug");
    expect(parsed.body).toBe("details");
  });

  it("extracts balanced JSON surrounded by conversational text with extraneous brackets", () => {
    const raw = `Here is your commit:
{
  "subject": "refactor: extract helper",
  "body": "- cleaner code"
}
Hope this was helpful! Remember to review {file} before pushing.`;
    const parsed = parseJsonResponse(raw, { subject: "fallback", body: "" });
    expect(parsed.subject).toBe("refactor: extract helper");
    expect(parsed.body).toBe("- cleaner code");
  });

  it("returns fallback on malformed JSON", () => {
    const raw = "not a json string at all";
    const parsed = parseJsonResponse(raw, { subject: "fallback", body: "none" });
    expect(parsed.subject).toBe("fallback");
    expect(parsed.body).toBe("none");
  });
});
