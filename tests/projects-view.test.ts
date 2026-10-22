import { describe, expect, it } from "bun:test";
import { formatProjectCard, formatProjects, type ProjectRow } from "../src/services/projects/view.ts";
import type { FieldState } from "../src/services/projects/types.ts";

function ok<T>(value: T): FieldState<T> { return { state: "ok", value, observedAt: "2026-10-22T00:00:00Z" }; }
function fixture(count = 1): ProjectRow {
  const checkouts = Array.from({ length: count }, (_, index) => ({ path: `/repo/${index}`, gitDir: index ? `/repo/.git/worktrees/${index}` : "/repo/.git", branch: index ? `feature/${index}` : "main", head: "abcdef0123", bare: false, locked: null, prunable: null, createdBy: "t3" as const, hostClaims: [] }));
  return {
    clone: { commonDir: "/repo/.git", displayName: "project", checkouts, remotes: [], primary: null, sources: [], lastSeen: "2026-10-22T00:00:00Z" },
    status: { commonDir: "/repo/.git", checkouts: checkouts.map(checkout => ({ path: checkout.path, dirty: ok({ staged: 1, unstaged: 0, untracked: 0, conflicted: 0 }), upstream: ok({ name: "origin/main", ahead: 2, behind: 1, fetchedAt: null }), operation: ok(null) })), unpublished: ok(Array.from({ length: 5 }, (_, index) => ({ ref: `refs/heads/feature${index}`, commits: index ? 4 : 5 }))), stashes: ok(2), newestStash: ok(null), mergedBranches: ok([]), lastCommit: ok(null) },
  };
}

describe("project views", () => {
  for (const width of [80, 100, 160]) it(`keeps rows within ${width} columns including the log prefix`, () => {
    const row = fixture(40);
    const before = JSON.stringify(row);
    formatProjects([row], { width });
    formatProjectCard(row, undefined, false, { width });
    expect(JSON.stringify(row)).toBe(before);
    row.clone.displayName = "長い名前👩‍💻".repeat(20);
    for (const lines of [formatProjects([row], { width }), formatProjectCard(row, undefined, false, { width })]) {
      expect(lines.every(line => Bun.stringWidth(line) + 3 <= width)).toBe(true);
      expect(lines.some(line => line.includes("…"))).toBe(true);
    }
    expect(formatProjects([row], { width })).toHaveLength(2);
    expect(formatProjects([fixture(11)], { width })).toMatchSnapshot();
  });
  it("summarizes clone work and preserves primary checkout drift", () => {
    const lines = formatProjects([fixture(3)], { wide: true });
    expect(formatProjects([fixture()], { wide: true })).toMatchInlineSnapshot(`
      [
        "Name     Branch  State    ↑/↓    Unpublished        Stashes  Worktrees  Age",
        "project  main    1 dirty  ↑2 ↓1  5 br / 21 commits  2        -          -",
      ]
    `);
    expect(lines[0]).toContain("Name");
    expect(lines[1]).toContain("main");
    expect(lines[1]).toContain("3 dirty");
    expect(lines[1]).toContain("↑2 ↓1");
    expect(lines[1]).toContain("5 br / 21 commits");
    expect(lines[1]).toContain("2 t3");
    expect(lines[1]).not.toContain("feature/1");
    expect(lines[1]).not.toContain("/repo");
  });
  it("shows stale, conflicts, operations and unknown status", () => {
    const row = fixture();
    row.stale = true;
    const checkout = row.status.checkouts[0];
    if (!checkout) throw new Error("missing fixture checkout");
    checkout.dirty = ok({ staged: 0, unstaged: 0, untracked: 0, conflicted: 1 });
    checkout.operation = ok("rebase");
    checkout.upstream = { state: "unknown", reason: "no tracking branch" };
    expect(formatProjects([row], { wide: true })[1]).toContain("stale, 1 dirty, conflicts, rebase, unknown");
    expect(formatProjectCard(row, undefined, false, { wide: true }).join("\n")).toContain("upstream: no tracking branch");
  });
  it("wide output preserves details and separate unpublished refs and history", () => {
    const row = fixture(2);
    row.clone.displayName = "project".repeat(40);
    expect(Bun.stringWidth(formatProjects([row], { width: 80, wide: true })[1] ?? "")).toBeGreaterThan(80);
    const lines = formatProjectCard(row, { recent: ok([{ oid: "123456789", subject: "fix checkout rendering", committedAt: "2026-10-22" }]), unpublished: ok([]) }, false, { wide: true });
    expect(lines).toContain("feature0  5 commits");
    expect(lines).toContain("1234567  fix checkout rendering");
    expect(lines.filter(line => line.startsWith("/repo/"))).toHaveLength(2);
  });
  it("removes terminal commands, styling and line controls from cells", () => {
    const row = fixture();
    row.clone.displayName = "safe\u001b[31mred\u001b[0m\u001b]0;attack\u0007\n\t\rname";
    const lines = formatProjects([row], { wide: true });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("safered  name");
    for (const control of ["\u001b", "\r", "\n", "\t"]) expect(lines.join("")).not.toContain(control);
  });
});

it("renders remote counts, failing checks, age, unavailable reasons and width limits", () => {
  const row = fixture();
  row.remote = [{
    repo: {host:"github.com",owner:"fixture",name:"project"}, login:"fixture",
    defaultBranch:ok({name:"main",oid:"abcdef0123456"}),defaultCi:ok("SUCCESS"),archived:ok(true),fork:ok({isFork:true,parent:"upstream/project"}),permission:ok("WRITE"),reviewRequested:ok(1),
    authored:ok({count:2,pullRequests:[{number:7,title:"Fix checks\u001b[31m\n",headRefName:"fix-ci",statusCheckRollup:"FAILURE",reviewDecision:"REVIEW_REQUIRED"}]}),
  }];
  const lines = formatProjects([row],{wide:true,remote:true});
  expect(lines[1]).toContain("PR 2 ✗ review 1 archived fork");
  expect(lines[0]).toContain("Seen");
  const card = formatProjectCard(row,undefined,false,{wide:true,remote:true}).join("\n");
  expect(card).toContain("CI: SUCCESS"); expect(card).toContain("#7 Fix checks"); expect(card).toContain("Fork: upstream/project");
  expect(card).not.toContain("\u001b");
  for (const width of [40,80,100,160]) for (const formatted of [formatProjects([row],{width,remote:true}),formatProjectCard(row,undefined,false,{width,remote:true})]) expect(formatted.every(line=>Bun.stringWidth(line)+3<=width)).toBe(true);
  const remote = row.remote[0]; if (!remote) throw new Error("fixture"); remote.defaultCi = {state:"unavailable",reason:"Reserve reached"};
  expect(formatProjects([row],{wide:true,remote:true})[1]).toContain("unavailable");
  expect(formatProjectCard(row,undefined,false,{wide:true,remote:true})).toContain("defaultCi: Reserve reached");
  expect(formatProjects([fixture()],{wide:true,remote:true})[1]).toContain("pending");
  expect(formatProjects([fixture()],{wide:true})[0]).not.toContain("Remote");
});
