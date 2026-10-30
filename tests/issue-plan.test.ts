import { afterAll, describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureRoot, runFixture, type FixtureResponse } from "./cli-fixture.ts";

const root = fixtureRoot("ggh-issue-plan-");
afterAll(() => rmSync(root, { recursive: true, force: true }));

const repo = ["--repo", "fixture/repo"];
const planFile = join(root, "plan.md");
const planText = "# Plan\n\n1. Reproduce the bug.\n2. Fix it.\n";
writeFileSync(planFile, planText);

const list = (items: unknown[]): FixtureResponse => ({ prefix: ["issue", "artifact", "list", "42", "--type", "plan"], stdout: JSON.stringify(items) });
const existing = { number: 3, name: "Plan", type: "plan", url: "https://github.com/fixture/repo/issues/42/artifacts/3", updatedAt: "2026-10-20T00:00:00Z" };
const view = (body: string): FixtureResponse => ({ prefix: ["issue", "artifact", "view", "42", "3"], stdout: JSON.stringify({ ...existing, body }) });
const created: FixtureResponse = { prefix: ["issue", "artifact", "create", "42"], stdout: "https://github.com/fixture/repo/issues/42/artifacts/4\n" };
const edited: FixtureResponse = { prefix: ["issue", "artifact", "edit", "42", "3"], stdout: `${existing.url}\n` };
const mutations = (calls: string[][]) => calls.filter(call => call[1] === "artifact" && (call[2] === "create" || call[2] === "edit"));

describe("ggh issue plan", () => {
  it("creates a plan only with the approved dry-run snapshot", async () => {
    const responses = [list([]), created];
    const preview = await runFixture(["issue", "plan", "42", planFile, "--dry-run", "--agent", ...repo], { root, responses });
    expect(preview.exitCode, preview.stderr).toBe(0);
    const planned = JSON.parse(preview.stdout);
    expect(planned).toMatchObject({ status: "planned", result: { action: "create", issue: 42, name: "Plan", target: "github.com/fixture/repo#42", artifact: null, content: { bytes: Buffer.byteLength(planText) } } });
    expect(planned.result.snapshotId).toMatch(/^[a-f0-9]{64}$/);
    expect(mutations(preview.calls)).toEqual([]);

    const applied = await runFixture(["issue", "plan", "42", planFile, "--agent", "--approve-plan", planned.result.snapshotId, ...repo], { root, responses });
    expect(applied.exitCode, applied.stderr).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({ status: "succeeded", result: { action: "create", url: "https://github.com/fixture/repo/issues/42/artifacts/4" }, effects: { completed: expect.arrayContaining(["issue_plan_created"]) } });
    expect(mutations(applied.calls)).toEqual([["issue", "artifact", "create", "42", "--type", "plan", "--name", "Plan", "--body-file", "-", "--repo", "fixture/repo"]]);
    expect(applied.inputs.find(input => input.args[2] === "create")?.text).toBe(planText);
  });

  it("refuses to execute in agent mode without --approve-plan, even with --yes", async () => {
    const result = await runFixture(["issue", "plan", "42", planFile, "--agent", "--yes", ...repo], { root, responses: [list([]), created] });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "needs_input", error: { code: "confirmation_required" }, requiredInputs: [{ name: "--approve-plan" }] });
    expect(mutations(result.calls)).toEqual([]);
  });

  it("refuses an approval whose content changed after the dry run", async () => {
    const file = join(root, "changing.md");
    writeFileSync(file, "first draft\n");
    const responses = [list([]), created];
    const preview = await runFixture(["issue", "plan", "42", file, "--dry-run", "--agent", ...repo], { root, responses });
    const snapshotId = JSON.parse(preview.stdout).result.snapshotId;
    writeFileSync(file, "second draft\n");
    const result = await runFixture(["issue", "plan", "42", file, "--agent", "--approve-plan", snapshotId, ...repo], { root, responses });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "needs_input", error: { code: "confirmation_required" }, requiredInputs: [{ name: "--approve-plan" }] });
    expect(mutations(result.calls)).toEqual([]);
  });

  it("refuses an approval when the existing plan changed after the dry run", async () => {
    const preview = await runFixture(["issue", "plan", "42", planFile, "--dry-run", "--agent", ...repo], { root, responses: [list([existing]), view("old plan\n"), edited] });
    const snapshotId = JSON.parse(preview.stdout).result.snapshotId;
    const result = await runFixture(["issue", "plan", "42", planFile, "--agent", "--approve-plan", snapshotId, ...repo], { root, responses: [list([existing]), view("someone else's plan\n"), edited] });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "needs_input", error: { code: "confirmation_required" } });
    expect(mutations(result.calls)).toEqual([]);
  });

  it("saves a new version of an existing plan with the same name", async () => {
    const result = await runFixture(["issue", "plan", "42", planFile, "--yes", "--json", ...repo], { root, responses: [list([existing]), view("old plan\n"), edited] });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "succeeded", action: "edit", artifact: { number: 3 }, url: existing.url });
    expect(mutations(result.calls)).toEqual([["issue", "artifact", "edit", "42", "3", "--body-file", "-", "--repo", "fixture/repo"]]);
    expect(result.inputs.find(input => input.args[2] === "edit")?.text).toBe(planText);
  });

  it("matches the plan name exactly and creates a separately named plan", async () => {
    const result = await runFixture(["issue", "plan", "42", planFile, "--name", "Rollout", "--yes", "--json", ...repo], { root, responses: [list([existing]), created] });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ action: "create", name: "Rollout" });
    expect(mutations(result.calls)[0]).toEqual(["issue", "artifact", "create", "42", "--type", "plan", "--name", "Rollout", "--body-file", "-", "--repo", "fixture/repo"]);
  });

  it("reports no_op when the content already matches", async () => {
    const result = await runFixture(["issue", "plan", "42", planFile, "--agent", ...repo], { root, responses: [list([existing]), view(planText.trimEnd()), edited] });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "no_op", result: { status: "no_op", action: "no_op", artifact: { number: 3 } } });
    expect(mutations(result.calls)).toEqual([]);
  });

  it("refuses an ambiguous name and lists the matches", async () => {
    const twin = { ...existing, number: 5, url: "https://github.com/fixture/repo/issues/42/artifacts/5" };
    const result = await runFixture(["issue", "plan", "42", planFile, "--yes", "--json", ...repo], { root, responses: [list([existing, twin]), edited] });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("2 plans named \"Plan\"");
    expect(result.stderr).toContain("#3");
    expect(result.stderr).toContain("#5");
    expect(JSON.parse(result.stdout)).toMatchObject({ reason: "ambiguous_name", candidates: [{ number: 3 }, { number: 5 }] });
    expect(result.calls.some(call => call[2] === "view")).toBe(false);
    expect(mutations(result.calls)).toEqual([]);
  });

  it("prints the current plan body to stdout with --show", async () => {
    const result = await runFixture(["issue", "plan", "42", "--show", ...repo], { root, responses: [list([existing]), view(planText)] });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe(planText);

    const agent = await runFixture(["issue", "plan", "42", "--show", "--agent", ...repo], { root, responses: [list([existing]), view(planText)] });
    expect(agent.exitCode, agent.stderr).toBe(0);
    expect(JSON.parse(agent.stdout)).toMatchObject({ status: "succeeded", result: { issue: 42, number: 3, name: "Plan", body: planText } });
  });

  it("fails --show when no plan has that name", async () => {
    const result = await runFixture(["issue", "plan", "42", "--show", "--name", "Rollout", ...repo], { root, responses: [list([existing])] });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("no plan named \"Rollout\"");
  });

  it("explains how to upgrade an old gh", async () => {
    const result = await runFixture(["issue", "plan", "42", "--show", "--agent", ...repo], { root, responses: [
      { prefix: ["issue", "artifact"], stderr: "unknown command \"artifact\" for \"gh issue\"", exitCode: 1 },
    ] });
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope).toMatchObject({ status: "failed", error: { code: "provider_unavailable" } });
    expect(envelope.error.message).toContain("GitHub CLI 2.103 or later");
  });

  it("names the problem when the number is a pull request", async () => {
    const result = await runFixture(["issue", "plan", "42", planFile, "--yes", ...repo], { root, responses: [
      { prefix: ["issue", "artifact", "list", "42"], stderr: "#42 is a pull request; artifacts are only supported on issues", exitCode: 1 },
    ] });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("#42 is a pull request. Plans attach to issues only");
    expect(mutations(result.calls)).toEqual([]);
  });

  it("rejects empty plans, unusable names, and a file with --show before calling GitHub", async () => {
    const empty = join(root, "empty.md");
    writeFileSync(empty, "\n  \n");
    for (const args of [[empty, "--yes"], [planFile, "--name", "Plan (v2)", "--yes"], [planFile, "--show"]]) {
      const result = await runFixture(["issue", "plan", "42", ...args, ...repo], { root });
      expect(result.exitCode).toBe(1);
      expect(result.calls.some(call => call[0] === "issue")).toBe(false);
    }
  });
});
