import { describe, expect, it } from "bun:test";
import {
  formatStagedSummary,
  isIgnoredDiffFile,
  redactSecrets,
  scanCodeHygiene,
  stripLockfilesFromDiff,
  truncateDiff,
  type ChangedFile,
} from "../src/utils/diff.ts";

describe("diff utility", () => {
  it("correctly identifies ignored assets", () => {
    expect(isIgnoredDiffFile("package-lock.json")).toBe(true);
    expect(isIgnoredDiffFile("bun.lockb")).toBe(true);
    expect(isIgnoredDiffFile("pnpm-lock.yaml")).toBe(true);
    expect(isIgnoredDiffFile("yarn.lock")).toBe(true);
    expect(isIgnoredDiffFile("Cargo.lock")).toBe(true);
    expect(isIgnoredDiffFile("src/index.ts")).toBe(false);

    expect(isIgnoredDiffFile("dist/bundle.min.js")).toBe(true);
    expect(isIgnoredDiffFile("dist/bundle.js.map")).toBe(true);
    expect(isIgnoredDiffFile("assets/hero.png")).toBe(true);
    expect(isIgnoredDiffFile("src/components/Hero.tsx")).toBe(false);
  });

  it("strips lockfile and binary chunks from unified diffs", () => {
    const sampleDiff = `diff --git a/src/app.ts b/src/app.ts
index 123..456 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-console.log("old");
+console.log("new");
diff --git a/bun.lockb b/bun.lockb
index abc..def 100644
Binary files a/bun.lockb and b/bun.lockb differ
diff --git a/logo.png b/logo.png
new file mode 100644
Binary files /dev/null and b/logo.png differ
diff --git a/dist/bundle.min.js b/dist/bundle.min.js
index 111..222 100644
--- a/dist/bundle.min.js
+++ b/dist/bundle.min.js
@@ -1 +1 @@
+var minified=1;
diff --git a/src/utils.ts b/src/utils.ts
index 789..012 100644
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -1 +1 @@
+export const x = 1;`;

    const result = stripLockfilesFromDiff(sampleDiff);
    expect(result).toContain("src/app.ts");
    expect(result).toContain("src/utils.ts");
    expect(result).not.toContain("bun.lockb");
    expect(result).not.toContain("logo.png");
    expect(result).not.toContain("bundle.min.js");
  });

  it("truncates large diffs cleanly", () => {
    const smallDiff = "diff --git a/a b/b\n+hello";
    expect(truncateDiff(smallDiff, 100)).toBe(smallDiff);

    const longDiff = "a".repeat(200);
    const truncated = truncateDiff(longDiff, 50);
    expect(truncated).toContain("[Diff truncated: exceeded 50 characters]");
    expect(truncated.startsWith("a".repeat(50))).toBe(true);
  });

  it("formats staged summary with status and path", () => {
    const files: ChangedFile[] = [
      { path: "src/index.ts", status: "modified", staged: true },
      { path: "README.md", status: "added", staged: true },
    ];
    const summary = formatStagedSummary(files);
    expect(summary).toContain("- src/index.ts (modified)");
    expect(summary).toContain("- README.md (added)");
  });

  it("redacts sensitive tokens, API keys, and environment files", () => {
    const sensitive = `const key = "sk-1234567890abcdef1234567890abcdef";
const gh = "ghp_123456789012345678901234567890123456";
const normal = "hello";`;

    const { text, redactedCount } = redactSecrets(sensitive);
    expect(redactedCount).toBeGreaterThanOrEqual(2);
    expect(text).not.toContain("sk-1234567890abcdef1234567890abcdef");
    expect(text).not.toContain("ghp_123456789012345678901234567890123456");
    expect(text).toContain("[REDACTED_SECRET]");
    expect(text).toContain("const normal = \"hello\";");
  });

  it("detects code hygiene issues in diffs (console.log, debugger, localhost)", () => {
    const diffWithIssues = `diff --git a/src/app.ts b/src/app.ts
index 123..456 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,5 @@
+console.log("debug value", x);
+debugger;
+const apiUrl = "http://localhost:3000/api";
 export const ready = true;`;

    const issues = scanCodeHygiene(diffWithIssues);
    expect(issues.length).toBe(3);
    expect(issues.some((i) => i.type === "console")).toBe(true);
    expect(issues.some((i) => i.type === "debugger")).toBe(true);
    expect(issues.some((i) => i.type === "localhost")).toBe(true);
  });
});
