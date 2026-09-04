import { describe, expect, it } from "bun:test";
import {
  branchToWorktreeDirectoryName,
  sanitizeBranchName,
  validateBranchName,
} from "../src/utils/branch-name.ts";

describe("validateBranchName", () => {
  it("accepts ordinary names", () => {
    for (const name of ["main", "feat/login", "fix-123", "release/v1.2.3", "user/feat_x", "a.b"]) {
      expect(validateBranchName(name), name).toBeUndefined();
    }
  });

  it("rejects names git would misread or refuse", () => {
    const bad: Record<string, RegExp> = {
      "feat foo": /spaces/,
      "-x": /start with '-'/,
      "a..b": /'\.\.'/,
      "a//b": /'\/\/'/,
      "feat/.hidden": /start with '\.'/,
      "x.lock": /\.lock/,
      "a:b": /characters git rejects/,
      "a~1": /characters git rejects/,
      "a^b": /characters git rejects/,
      "a?b": /characters git rejects/,
      "a[b": /characters git rejects/,
      "a\\b": /characters git rejects/,
      "a\tb": /spaces/,
      "a\x01b": /characters git rejects/,
      "/lead": /'\/'/,
      "trail/": /'\/'/,
      "dot.": /'\.'/,
      "HEAD": /reserved/,
      "@": /reserved/,
      "a@{b": /'@\{'/,
      "": /required/,
      " padded ": /whitespace/,
    };
    for (const [name, pattern] of Object.entries(bad)) {
      const message = validateBranchName(name);
      expect(message, JSON.stringify(name)).toBeDefined();
      expect(message, JSON.stringify(name)).toMatch(pattern);
    }
  });
});

describe("branchToWorktreeDirectoryName", () => {
  it("creates one bounded directory segment without repeated regex passes", () => {
    expect(branchToWorktreeDirectoryName("feat///new---thing")).toBe("feat-new-thing");
    expect(branchToWorktreeDirectoryName(`${"-".repeat(20_000)}safe${"-".repeat(20_000)}`)).toBe("safe");
  });
});

describe("sanitizeBranchName", () => {
  it("turns free text into a legal, lowercase, hyphenated name", () => {
    expect(sanitizeBranchName("Add Dark Mode")).toBe("add-dark-mode");
    expect(sanitizeBranchName("`feat/login-form`\nsecond line ignored")).toBe("feat/login-form");
    expect(sanitizeBranchName("Fix: parser crashes on 'quotes'")).toBe("fix-parser-crashes-on-quotes");
  });

  it("neutralises output that would be read as a flag or a range", () => {
    expect(sanitizeBranchName("--force")).toBe("force");
    expect(sanitizeBranchName("-rf /")).toBe("rf");
    expect(sanitizeBranchName("a..b")).toBe("a.b");
    expect(sanitizeBranchName("feat/.hidden")).toBe("feat/hidden");
    expect(sanitizeBranchName("name.lock")).toBe("name");
  });

  it("returns an empty string when nothing usable is left", () => {
    expect(sanitizeBranchName("")).toBe("");
    expect(sanitizeBranchName("---")).toBe("");
    expect(sanitizeBranchName("...")).toBe("");
    expect(sanitizeBranchName("///")).toBe("");
  });

  it("caps the length without leaving a dangling separator", () => {
    const long = sanitizeBranchName("a".repeat(58) + "-bcdef");
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith("-")).toBe(false);
    expect(validateBranchName(long), long).toBeUndefined();
  });

  it("always produces something validateBranchName accepts", () => {
    for (const input of ["Hello World!!", "  @@ weird ##  ", "UPPER_snake_Case", "feat//double", "x.lock/y.lock"]) {
      const out = sanitizeBranchName(input);
      if (out) expect(validateBranchName(out), `${input} -> ${out}`).toBeUndefined();
    }
  });
});
