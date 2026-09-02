import { describe, expect, it } from "bun:test";
import { detectCommitConvention } from "../src/utils/conventions.ts";

describe("commit convention detector", () => {
  it("detects conventional commits with git oneline hashes", () => {
    const history = [
      "a1b2c3d feat(auth): add google oauth provider",
      "e4f5a6b fix: correct null pointer on empty input",
      "c7d8e9f chore: update dependencies",
      "1234567 refactor: extract helper methods",
    ];
    expect(detectCommitConvention(history)).toBe("conventional");
  });

  it("detects conventional commits without hashes", () => {
    const history = [
      "feat: add feature",
      "fix: correct bug",
      "docs: update readme",
    ];
    expect(detectCommitConvention(history)).toBe("conventional");
  });

  it("detects gitmoji style", () => {
    const history = [
      "a1b2c3d :sparkles: add google oauth provider",
      "e4f5a6b :bug: fix null pointer",
      "c7d8e9f :recycle: refactor code",
      "1234567 update readme",
    ];
    expect(detectCommitConvention(history)).toBe("gitmoji");
  });

  it("falls back to concise style when non-conventional", () => {
    const history = [
      "a1b2c3d update readme",
      "e4f5a6b changed button color",
      "c7d8e9f another commit",
      "1234567 quick tweak",
    ];
    expect(detectCommitConvention(history)).toBe("concise");
  });

  it("defaults to conventional when history is empty", () => {
    expect(detectCommitConvention([])).toBe("conventional");
  });
});
