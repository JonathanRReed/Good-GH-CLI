import { describe, expect, it } from "bun:test";
import { CliAIProvider } from "../src/services/ai/base.ts";
import { AIGenerationError, type AIProviderId } from "../src/services/ai/provider.ts";
import { CODEX_MODEL_CHAIN, CodexProvider } from "../src/services/ai/codex.ts";
import { GrokProvider } from "../src/services/ai/grok.ts";
import { sanitizeDiffForAI } from "../src/utils/diff.ts";

class StubProvider extends CliAIProvider {
  lastPrompt = "";
  readonly id: AIProviderId = "codex";
  readonly displayName = "Stub";
  readonly defaultModel = "stub-1";
  readonly fallbackModels: readonly string[] = [];

  constructor(private readonly output: string) {
    super();
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  protected async invoke(prompt: string): Promise<string> {
    this.lastPrompt = prompt;
    return this.output;
  }
}

const COMMIT_INPUT = {
  branch: "main",
  stagedFiles: [{ path: "a.ts", status: "modified" as const, staged: true }],
  stagedDiff: "diff --git a/a.ts b/a.ts\n+x\n",
};

const PR_INPUT = { branch: "feat/x", baseBranch: "main", diff: "diff" };

describe("CliAIProvider response handling", () => {
  it("parses a clean JSON commit response and drops the trailing period", async () => {
    const provider = new StubProvider(JSON.stringify({ subject: "feat: add login.", body: "- why" }));
    const result = await provider.generateCommit(COMMIT_INPUT);
    expect(result).toEqual({ subject: "feat: add login", body: "- why" });
  });

  it("recovers a commit message from a fenced, chatty response", async () => {
    const provider = new StubProvider(
      'Sure! Here you go:\n```json\n{"subject": "fix: repair parser", "body": ""}\n```\nHope that helps.',
    );
    expect((await provider.generateCommit(COMMIT_INPUT)).subject).toBe("fix: repair parser");
  });

  it("falls back to the first line when the model ignores the JSON contract", async () => {
    const provider = new StubProvider("refactor: extract helper\n\n- moved code");
    const result = await provider.generateCommit(COMMIT_INPUT);
    expect(result.subject).toBe("refactor: extract helper");
    expect(result.body).toContain("moved code");
  });

  it("rejects a blank response rather than committing an empty message", async () => {
    const provider = new StubProvider("   \n  ");
    await expect(provider.generateCommit(COMMIT_INPUT)).rejects.toThrow(AIGenerationError);
  });

  it("rejects JSON that carries no subject", async () => {
    const provider = new StubProvider(JSON.stringify({ subject: "", body: "text" }));
    const err = await provider.generateCommit(COMMIT_INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AIGenerationError);
    expect((err as AIGenerationError).kind).toBe("empty_response");
  });

  it("rejects a PR response with no title", async () => {
    const provider = new StubProvider(JSON.stringify({ title: "  ", body: "body" }));
    await expect(provider.generatePr(PR_INPUT)).rejects.toThrow(AIGenerationError);
  });

  it("normalises a branch name to lowercase kebab-case", async () => {
    const provider = new StubProvider('`Feat/Add Dark Mode`\nsome trailing chatter');
    expect(await provider.generateBranchName("add dark mode")).toBe("feat/add-dark-mode");
  });

  it("strips a stray markdown fence from release notes", async () => {
    const provider = new StubProvider("```markdown\n### Features\n- thing\n```");
    expect(await provider.generateReleaseNotes({ tag: "v1.0.0", commits: ["abc thing"] })).toBe(
      "### Features\n- thing",
    );
  });
});

describe("provider configuration", () => {
  it("orders the Codex chain from the mini tier down to the nano tier", () => {
    expect([...CODEX_MODEL_CHAIN]).toEqual(["gpt-5.6-terra", "gpt-5.6-luna"]);
  });

  it("exposes a Codex fallback chain and a terminal Grok provider", () => {
    expect(new CodexProvider().fallbackModels.length).toBeGreaterThan(0);
    // Grok is last in the chain and its model list is account-specific, so it
    // must not guess at a second model slug.
    expect(new GrokProvider().fallbackModels).toEqual([]);
  });
});

describe("sanitizeDiffForAI", () => {
  // Assembled at runtime: a literal here matches GitHub's own scanner and blocks
  // the push, even though the value is invented.
  const fakeGitHubToken = `gh${"p"}_${"a".repeat(36)}`;

  const diff = [
    "diff --git a/src/app.ts b/src/app.ts",
    "@@ -1 +1 @@",
    `+const token = "${fakeGitHubToken}";`,
    "diff --git a/bun.lock b/bun.lock",
    "@@ -1 +1 @@",
    "+noise",
    "diff --git a/.env b/.env",
    "@@ -1 +1 @@",
    "+SECRET=hunter2",
    "",
  ].join("\n");

  it("reports how much was stripped and redacted in one pass", () => {
    const result = sanitizeDiffForAI(diff);
    expect(result.strippedBlocks).toBe(2);
    expect(result.redactedCount).toBeGreaterThan(0);
    expect(result.diff).not.toContain("bun.lock");
    expect(result.diff).not.toContain("hunter2");
    expect(result.diff).not.toContain(fakeGitHubToken);
    expect(result.diff).toContain("REDACTED_SECRET");
  });

  it("handles an empty diff without throwing", () => {
    expect(sanitizeDiffForAI("")).toEqual({ diff: "", redactedCount: 0, strippedBlocks: 0 });
  });
});

describe("secret redaction before anything leaves the machine", () => {
  /**
   * These fixtures are invented, but they match the real vendor patterns closely
   * enough that a literal in the source trips GitHub push protection. Assembling
   * each one at runtime keeps the test honest without committing a string that
   * secret scanners have to argue about.
   */
  const join = (...parts: string[]) => parts.join("");

  const cases: Array<[string, string]> = [
    ["GitHub fine-grained PAT", join("github", "_pat_", "11ABCDEFG0aBcDeFgHiJkLmNoPqRsTuVwXyZ012345")],
    ["Slack bot token", join("xo", "xb-", "123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx")],
    ["Google API key", join("AI", "za", "SyA1234567890abcdefghijklmnopqrstuvw")],
    ["GitLab PAT", join("gl", "pat-", "ABCDEFGHIJKLMNOPQRST")],
    ["npm token", join("npm", "_", "abcdefghijklmnopqrstuvwxyz0123456789")],
    ["JWT", join("eyJhbGciOiJIUzI1NiJ9", ".eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g")],
    ["AWS temporary key", join("AS", "IA", "ABCDEFGHIJKLMNOP")],
    ["Postgres URL with password", join("postgresql://", "admin:s3cr3tpw@", "db.example.com:5432/prod")],
  ];

  for (const [label, secret] of cases) {
    it(`redacts a ${label}`, () => {
      const diff = `diff --git a/src/x.ts b/src/x.ts\n@@ -1 +1 @@\n+const v = "${secret}";\n`;
      const { diff: safe, redactedCount } = sanitizeDiffForAI(diff);
      expect(redactedCount).toBeGreaterThan(0);
      expect(safe).not.toContain(secret);
    });
  }

  it("redacts an unquoted assignment, which quoted-only matching missed", () => {
    const diff = "diff --git a/run.sh b/run.sh\n@@ -1 +1 @@\n+export API_KEY=sup3rs3cretvalue123\n";
    const { diff: safe } = sanitizeDiffForAI(diff);
    expect(safe).not.toContain("sup3rs3cretvalue123");
  });

  it("leaves ordinary code untouched", () => {
    const diff = "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n+const total = price * quantity;\n";
    const { diff: safe, redactedCount } = sanitizeDiffForAI(diff);
    expect(redactedCount).toBe(0);
    expect(safe).toContain("price * quantity");
  });
});


describe("last shared prompt boundary", () => {
  it("redacts credentials in metadata as well as the diff", async () => {
    const provider = new StubProvider('{"subject":"fix: safe","body":""}');
    const token = "ghp_" + "a".repeat(36);
    await provider.generateCommit({ ...COMMIT_INPUT, customGuidance: `Recent commit: ${token}` });
    expect(provider.lastPrompt).not.toContain(token);
  });
  it("drops sensitive files even when a caller supplied the raw diff", async () => {
    const provider = new StubProvider('{"subject":"fix: safe","body":""}');
    await provider.generateCommit({ ...COMMIT_INPUT, stagedDiff: "diff --git a/.env b/.env\n+PRIVATE_FILE_CANARY" });
    expect(provider.lastPrompt).not.toContain("PRIVATE_FILE_CANARY");
  });
});


describe("reviewed split response contract", () => {
  it("normalizes an omitted optional body without dropping the commit", async () => {
    const provider = new StubProvider(JSON.stringify({ commits: [{ subject: "feat: one", files: ["a.ts"] }] }));
    expect((await provider.generateSplit(COMMIT_INPUT)).commits).toEqual([{ subject: "feat: one", body: "", files: ["a.ts"] }]);
  });
  for (const body of [null, 42, [], {}]) {
    it(`rejects invalid body ${JSON.stringify(body)}`, async () => {
      const provider = new StubProvider(JSON.stringify({ commits: [{ subject: "feat: one", body, files: ["a.ts"] }] }));
      await expect(provider.generateSplit(COMMIT_INPUT)).rejects.toThrow("invalid split plan");
    });
  }
});
