import { describe, expect, it } from "bun:test";
import { closestMatch, editDistance } from "../src/utils/suggest.ts";

describe("editDistance", () => {
  it("scores identical words zero", () => {
    expect(editDistance("pr", "pr")).toBe(0);
  });

  it("counts insertions, deletions, substitutions", () => {
    expect(editDistance("prr", "pr")).toBe(1);
    expect(editDistance("chekout", "checkout")).toBe(1);
    // transpositions cost 2 in classic Levenshtein — still within tolerance
    expect(editDistance("sttaus", "status")).toBe(2);
    expect(editDistance("abc", "xyz")).toBe(3);
  });
});

describe("closestMatch", () => {
  const ggh = ["pr", "status", "commit", "checkout", "triage", "stack"];
  const git = ["prune", "checkout", "commit", "status"];

  it("finds near misses", () => {
    expect(closestMatch("prr", ggh)).toBe("pr");
    expect(closestMatch("sttaus", ggh)).toBe("status");
    expect(closestMatch("traige", ggh)).toBe("triage");
  });

  it("returns null when nothing is close", () => {
    expect(closestMatch("xyzzy", ggh)).toBeNull();
    expect(closestMatch("rev-parse", ggh)).toBeNull();
  });

  it("ignores single letters and case", () => {
    expect(closestMatch("s", ggh)).toBeNull();
    expect(closestMatch("PRR", ggh)).toBe("pr");
  });

  it("gives short words less slack", () => {
    // distance 2 on a 3-letter word is a different word, not a typo
    expect(closestMatch("pxz", ["pr", "ps", "am"])).toBeNull();
  });

  it("mirrors the runCli policy cases", () => {
    // typo of a ggh command, far from git's vocabulary
    expect(closestMatch("prr", git)).not.toBe("prune");
    // typo shared with git stays git's (git wins ties at distance <= 1)
    expect(editDistance("chekout", "checkout")).toBe(1);
  });
});

describe("closestMatch properties", () => {
  const words = ["pr", "status", "commit", "stack", "triage", "stash", "alias", "hook"];

  it("is symmetric in distance and never negative", () => {
    for (const a of words) {
      for (const b of words) {
        expect(editDistance(a, b)).toBe(editDistance(b, a));
        expect(editDistance(a, b)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("matches every command name exactly", () => {
    for (const w of words) {
      expect(closestMatch(w, words)).toBe(w);
    }
  });

  it("single-edit typos of long names always resolve", () => {
    const cases: Array<[string, string]> = [
      ["stauts", "status"],
      ["statu", "status"],
      ["tatus", "status"],
      ["commti", "commit"],
      ["triag", "triage"],
      ["stask", "stack"],
    ];
    for (const [typo, want] of cases) {
      expect(closestMatch(typo, words), typo).toBe(want);
    }
  });
});
