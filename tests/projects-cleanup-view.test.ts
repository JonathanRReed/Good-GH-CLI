import { describe, expect, it } from "bun:test";
import { formatLost, formatTidyPlan } from "../src/services/projects/cleanup-view.ts";
import type { LostItem, LostResult } from "../src/services/projects/lost.ts";
import type { TidyPlan } from "../src/services/projects/tidy-plan.ts";
import { fixtureRoot, runFixture } from "./cli-fixture.ts";
import { rmSync } from "node:fs";

function tidyFixture(): TidyPlan {
  return { schemaVersion: 1, snapshotId: "preview", options: {}, clones: Array.from({ length: 73 }, (_, i) => ({
    commonDir: `/repos/clone-${i}/.git`, name: `clone-${i}`, fetchedAt: null,
    actions: i < 2 ? Array.from({ length: 10 }, (_, j) => ({ kind: "delete-local-branch", branch: `merged-${j}`, tip: "a".repeat(40), integration: { ref: "refs/remotes/origin/main", oid: "b".repeat(40) }, id: `${i}-${j}`, proof: { commonDir: `/repos/clone-${i}/.git`, cloneIdentity: "identity", refs: [], remoteRefs: [], stash: "none" } })) : [],
    kept: [{ target: "main", reason: "Checked out" }, { target: "unpublished", reason: "Not merged" }],
    hostManual: i < 9 ? Array.from({ length: i ? 20 : 25 }, (_, j) => ({ target: `/hosts/clone-${i}/${j}`, host: "t3", reason: "Host-owned" })) : [], hints: [],
  })) };
}
function unpublished(commonDir: string, branch: string, uniqueCommits: number, newestDate: string): Extract<LostItem, { kind: "unpublished" }> {
  return { commonDir, branch, uniqueCommits, newestDate, kind: "unpublished", path: null, createdBy: "unknown", head: "a".repeat(40), commits: uniqueCommits + 5, sharedCommits: 5, newestSubject: `subject ${branch}`, oldestDate: "2020-01-01", nextSteps: [["git", "show", branch]] };
}
function lostFixture(count = 49): LostResult {
  const clones = Array.from({ length: count }, (_, i) => ({ commonDir: `/repos/clone-${i}/.git`, name: `clone-${i}`, uniqueCommits: 100 - i, branches: 10, detachedHeads: 0, fetchedAt: null }));
  return { schemaVersion: 1, clones, warnings: [], items: clones.flatMap(clone => Array.from({ length: 10 }, (_, j) => unpublished(clone.commonDir, `branch-${j}`, j < 3 ? 3 - j : 0, `2026-10-${String(j + 1).padStart(2, "0")}T00:00:00Z`))) };
}

describe("compact cleanup views", () => {
  it("lists only actionable clones and aggregates keeps and host ownership across all clones", () => {
    const plan = tidyFixture();
    const before = JSON.stringify(plan);
    const coverage = { roots: ["/repos"], truncated: false, skipped: Array.from({ length: 14 }, (_, i) => ({ path: `/repos/clone-3/.claude/worktrees/broken-${i}`, reason: "Broken checkout: missing gitdir" })) };
    const lines = formatTidyPlan(plan, { coverage, width: 100 });
    expect(lines.length).toBeLessThanOrEqual(60);
    expect(lines.filter(line => /^clone-\d+ {2}/.test(line))).toHaveLength(2);
    expect(lines).toContain("KEEP 73: Checked out");
    expect(lines).toContain("KEEP 73: Not merged");
    expect(lines).toContain("185 T3 worktrees across 9 clones; clean up in T3 Code");
    expect(lines.filter(line => line.includes("broken checkout dirs; e.g."))).toHaveLength(1);
    expect(lines.some(line => line.includes("broken-1"))).toBe(false);
    const verbose = formatTidyPlan(plan, { coverage, verbose: true, wide: true });
    expect(verbose.filter(line => /^clone-\d+ {2}/.test(line))).toHaveLength(73);
    expect(verbose.some(line => line.includes("/hosts/clone-8/19"))).toBe(true);
    expect(verbose.some(line => line.includes("broken-13"))).toBe(true);
    expect(JSON.stringify(plan)).toBe(before);
  });

  it("keeps every affected clone visible and expands top clones within 80 lines", () => {
    const result = lostFixture();
    const before = JSON.stringify(result);
    const lines = formatLost(result, { width: 140 });
    const summaries = lines.filter(line => /^clone-\d+ ·/.test(line));
    expect(summaries).toHaveLength(49);
    expect(summaries.map(line => line.split(" · ")[0])).toEqual(result.clones.map(clone => clone.name));
    expect(summaries.every(line => line.includes("branches · 0 stashes · fetch unknown · branch-0"))).toBe(true);
    expect(lines.length).toBeLessThanOrEqual(80);
    expect(lines.slice(1, 4).map(line => line.trim().split("  ")[0])).toEqual(["branch-0", "branch-1", "branch-2"]);
    expect(lines).toContain("  … 7 more branches (7 with 0 unique commits)");
    expect(lines.at(-1)).toBe("Branch detail shown for 7 of 49 clones; run ggh lost <name> or --verbose for the rest.");
    const full = formatLost(result, { verbose: true, wide: true });
    expect(full.filter(line => line.startsWith("  branch-"))).toHaveLength(490);
    expect(full.some(line => line.includes("subject branch-9"))).toBe(true);
    expect(full.some(line => line.includes('next: "git" "show" "branch-9"'))).toBe(true);
    expect(JSON.stringify(result)).toBe(before);
  });

  it("orders clones and branches by unique commits then newest commit", () => {
    const result = lostFixture(2);
    const [first, second] = result.clones;
    if (!first || !second) throw new Error("Missing fixture clone");
    first.uniqueCommits = second.uniqueCommits;
    result.items = [unpublished(first.commonDir, "old", 2, "2026-01-01"), unpublished(second.commonDir, "recent", 2, "2026-10-01"), unpublished(second.commonDir, "older", 2, "2026-09-01"), unpublished(second.commonDir, "exclusive", 3, "2026-08-01")];
    const lines = formatLost(result, { wide: true });
    expect(lines[0]).toStartWith("clone-1 ·");
    expect(lines.slice(1, 4).map(line => line.trim().split("  ")[0])).toEqual(["exclusive", "recent", "older"]);
  });

  it("preserves every clone even when the summaries alone exceed the detail budget", () => {
    const result = lostFixture(85);
    const lines = formatLost(result, { wide: true });
    expect(lines.filter(line => /^clone-\d+ ·/.test(line))).toHaveLength(85);
    expect(lines.filter(line => line.startsWith("  branch-"))).toHaveLength(0);
    expect(lines.at(-1)).toBe("Branch detail shown for 0 of 85 clones; run ggh lost <name> or --verbose for the rest.");
  });

  it("aggregates stashes, broken paths and dirty hosts with three examples and full verbose detail", () => {
    const result = lostFixture(1);
    const commonDir = result.clones[0]?.commonDir ?? "";
    result.items.push({ commonDir, path: null, createdBy: "unknown", kind: "stash", count: 5, oldestDate: "2026-01-01", nextSteps: [], stashes: Array.from({ length: 5 }, (_, i) => ({ ref: `stash@{${i}}`, oid: "a".repeat(40), date: `2026-10-0${i + 1}`, message: `message-${i}` })) });
    for (let i = 0; i < 5; i++) {
      result.items.push({ commonDir, path: `/hosts/dirty-${i}`, createdBy: "t3", kind: "dirty-host-checkout", host: "t3", reason: "Host work", nextSteps: [] });
      result.items.push({ commonDir, path: `/hosts/broken-${i}`, createdBy: "t3", kind: "broken-gitdir", reason: "Broken gitdir", nextSteps: [] });
    }
    const lines = formatLost(result, { wide: true });
    expect(lines[0]).toContain("5 stashes");
    expect(lines).toContain("  STASH 5");
    expect(lines.filter(line => line.includes("stash@"))).toHaveLength(3);
    expect(lines.find(line => line.includes("stash@"))).toContain("stash@{4}");
    expect(lines).toContain("  DIRTY HOST 5");
    expect(lines.filter(line => line.includes("/hosts/dirty-"))).toHaveLength(3);
    expect(lines).toContain("  BROKEN 5");
    expect(lines.filter(line => line.includes("/hosts/broken-"))).toHaveLength(3);
    const full = formatLost(result, { verbose: true, wide: true });
    expect(full.filter(line => line.includes("stash@"))).toHaveLength(5);
    expect(full.filter(line => line.includes("/hosts/dirty-"))).toHaveLength(5);
    expect(full.filter(line => line.includes("/hosts/broken-"))).toHaveLength(5);
  });

  for (const width of [80, 100, 140]) it(`bounds complete log lines at ${width} columns, including COLUMNS in pipes`, async () => {
    const plan = tidyFixture();
    const result = lostFixture();
    const clone = result.clones[0];
    if (clone) clone.name = "project長👩‍💻".repeat(30);
    for (const verbose of [false, true]) for (const lines of [formatTidyPlan(plan, { width, verbose }), formatLost(result, { width, verbose })]) {
      expect(lines.every(line => Bun.stringWidth(`│  ${line}`) <= width)).toBe(true);
    }
    const root = fixtureRoot("ggh-cleanup-width-");
    try {
      const cleanupView = new URL("../src/services/projects/cleanup-view.ts", import.meta.url).href;
      const ui = new URL("../src/utils/ui.ts", import.meta.url).href;
      const output = await runFixture([], { root, invoke: `process.env.COLUMNS = '${width}'; const { formatLost, formatTidyPlan } = await import(${JSON.stringify(cleanupView)}); const { p } = await import(${JSON.stringify(ui)}); for (const line of [...formatTidyPlan(${JSON.stringify(plan)}), ...formatLost(${JSON.stringify(result)})]) p.log.message(line);` });
      expect(output.exitCode, output.stderr).toBe(0);
      const lines = output.stderr.trimEnd().split("\n");
      expect(lines.every(line => Bun.stringWidth(line) <= width)).toBe(true);
      expect(Math.max(...lines.map(line => Bun.stringWidth(line)))).toBeGreaterThanOrEqual(width - 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
