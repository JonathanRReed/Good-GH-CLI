import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";

const { selectReleaseNotes } = createRequire(import.meta.url)("../scripts/release-notes.cjs") as {
  selectReleaseNotes: (changelog: string, version: string) => string;
};

describe("published release notes", () => {
  it("extracts the exact requested version and not a prefix match", () => {
    expect(selectReleaseNotes("## 0.4.0-beta.30\nwrong\n## 0.4.0-beta.3\n\n### Fixed\n- staged snapshots\n## 0.4.0-beta.2\nold", "0.4.0-beta.3"))
      .toBe("### Fixed\n- staged snapshots\n");
  });
  it("accepts bracketed versions and date suffixes", () => {
    expect(selectReleaseNotes("## [0.4.0-beta.3] - 2026-09-04\n- fixed\n", "v0.4.0-beta.3")).toBe("- fixed\n");
  });
  it("falls back to Unreleased for an existing candidate tag", () => {
    expect(selectReleaseNotes("## Unreleased\n\n- candidate fixes\n## 0.4.0-beta.2\n- old fixes", "0.4.0-beta.3"))
      .toBe("- candidate fixes\n");
  });
  it("does not publish empty notes or another version's notes", () => {
    expect(() => selectReleaseNotes("## Unreleased\n\n## 0.4.0-beta.2\n- old fixes", "0.4.0-beta.3")).toThrow("No release notes");
  });
});
