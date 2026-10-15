import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { fixtureRoot, runFixture } from "./cli-fixture.ts";
import { agentEnvelope } from "../src/services/agent-contract.ts";
import { startOperation, updateOperation, readOperation } from "../src/services/operations.ts";

const root = fixtureRoot("ggh-agent-");
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("agent contract", () => {
  test("wraps help and version in one agent document", async () => {
    for (const args of [["--agent", "--help"], ["config", "--help", "--agent"], ["--agent", "--version"]]) {
      const result = await runFixture(args, { root });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ contract: "ggh.agent", version: 1, status: "succeeded", result: { output: expect.any(String) } });
    }
  });

  test("discovers required command arguments and nested option shapes without scraping prose", async () => {
    const result = await runFixture(["agent", "schema"], { root });
    const schema = JSON.parse(result.stdout);
    expect(result.exitCode).toBe(0);
    expect(schema.inputs).toContainEqual(expect.objectContaining({ path: ["pr", "create"], options: expect.arrayContaining([expect.objectContaining({ long: "--base", takesValue: true }), expect.objectContaining({ long: "--yes", takesValue: false })]) }));
    expect(schema.inputs).toContainEqual(expect.objectContaining({ path: ["operation", "view"], arguments: [{ name: "id", required: true, variadic: false }] }));
  });

  test("does not let arbitrary API mutation payloads determine operation status", async () => {
    const result = await runFixture(["api", "repos/fixture/repo", "-X", "POST", "--agent"], { root, responses: [{ prefix: ["api"], stdout: '{"status":"failed","noOp":true}' }] });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "succeeded", result: { status: "failed", noOp: true } });
  });
  test("wraps successful data and preserves legacy JSON", async () => {
    const agent = await runFixture(["config", "get", "ai_enabled", "--agent"], { root });
    expect(agent.exitCode).toBe(0);
    expect(JSON.parse(agent.stdout)).toMatchObject({ contract: "ggh.agent", version: 1, command: ["config", "get"], status: "succeeded", result: false });
    expect(agent.providerCalls).toEqual([]);
    const legacy = await runFixture(["config", "get", "ai_enabled", "--json"], { root });
    expect(JSON.parse(legacy.stdout)).toBe(false);
  });

  test("wraps read arrays without interpreting payload statuses", async () => {
    const result = await runFixture(["api", "repos/fixture/repo", "--agent"], { root, responses: [{ prefix: ["api"], stdout: '{"status":"partially_completed"}' }] });
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "succeeded", result: { status: "partially_completed" } });
    const array = await runFixture(["issue", "--agent", "-R", "fixture/repo"], { root, responses: [{ prefix: ["issue", "list"], stdout: '[]' }] });
    expect(JSON.parse(array.stdout)).toMatchObject({ status: "succeeded", result: [] });
  });

  test("returns stable codes for parse and config validation errors", async () => {
    for (const args of [["config", "get", "--agent"], ["config", "set", "ai_enabled", "invalid", "--agent"], ["bogus", "--agent"]]) {
      const result = await runFixture(args, { root });
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: "failed", error: { code: "invalid_arguments" }, effects: { completed: [], uncertain: [] } });
    }
  });

  test("reports confirmation requirements without authorizing an action", async () => {
    const result = await runFixture(["issue", "close", "1", "--agent", "-R", "fixture/repo"], { root });
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "needs_input", error: { code: "confirmation_required" }, requiredInputs: [{ name: "--yes" }] });
    expect(result.providerCalls).toEqual([]);
    const envelope = agentEnvelope({ command: ["discard"], failed: true, dryRun: false, preview: [], issue: { status: "needs_input", code: "confirmation_required", message: "Authorize discard", requiredInputs: [{ name: "--yes", description: "Authorize discard" }] } });
    expect(envelope).toMatchObject({ status: "needs_input", error: { code: "confirmation_required", retryability: "after_input" }, requiredInputs: [{ name: "--yes" }], effects: { uncertain: [] } });
  });

  test("carries journal partial effects and resources", async () => {
    const operation = await startOperation({ command: "repo create", steps: ["create", "push"], cwd: root });
    await updateOperation(operation.id, { status: { state: "partially_completed" }, steps: [{ name: "create", state: "completed" }, { name: "push", state: "pending" }], resources: ["https://github.com/fixture/repo"] }, root);
    const envelope = agentEnvelope({ command: ["repo", "create"], operation: await readOperation(operation.id, root), failed: true, dryRun: false, preview: [] });
    expect(envelope).toMatchObject({ status: "partially_completed", operationId: operation.id, resources: ["https://github.com/fixture/repo"], error: { code: "partial_completion", retryability: "after_inspection" }, effects: { completed: ["create"], pending: ["push"] } });
  });

  test("keeps explicit workflow outcomes when operation recording is disabled", async () => {
    const local = fixtureRoot("ggh-agent-no-records-");
    try {
      expect(Bun.spawnSync(["git", "init", local]).exitCode).toBe(0);
      const args = ["discard", "--all", "--agent"];
      const result = await runFixture([], { root, cwd: local, invoke: `process.env.GGH_NO_RECORDS = '1'; const { runCli } = await import(${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)}); await runCli(['bun', 'ggh', ...${JSON.stringify(args)}]);` });
      expect(JSON.parse(result.stdout)).toMatchObject({ status: "no_op", effects: { completed: [], pending: [], uncertain: [] } });
      const partial = agentEnvelope({ command: ["pr", "create"], result: { status: "partially_completed", completed: ["push_head"], remaining: ["create_pull_request"] }, failed: true, dryRun: false, preview: [] });
      expect(partial).toMatchObject({ status: "partially_completed", effects: { completed: ["push_head"], pending: ["create_pull_request"], uncertain: ["command_effects"] } });
      expect(agentEnvelope({ command: ["repo", "create"], result: { status: "needs_input", required: "name" }, issue: { status: "needs_input", code: "missing_input", message: "Name required", requiredInputs: [{ name: "name", description: "Name required" }] }, failed: true, dryRun: false, preview: [] })).toMatchObject({ status: "needs_input", requiredInputs: [{ name: "name" }] });
    } finally { rmSync(local, { recursive: true, force: true }); }
  });

  test("rejects unsupported protocols before emitting their output", async () => {
    for (const args of [["mcp", "--agent"], ["--agent", "completion", "bash"]]) {
      const result = await runFixture(args, { root });
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: "failed", error: { code: "invalid_arguments" } });
      expect(result.providerCalls).toEqual([]);
    }
  });

  test("preserves explicit AI permission and --no-ai precedence", async () => {
    const local = fixtureRoot("ggh-agent-ai-");
    try {
      for (const args of [["init", "-b", "main", local], ["-C", local, "config", "user.name", "Fixture"], ["-C", local, "config", "user.email", "fixture@example.com"], ["-C", local, "commit", "--allow-empty", "-m", "initial"]]) expect(Bun.spawnSync(["git", ...args]).exitCode).toBe(0);
      const explicit = await runFixture(["worktree", "add", "Create Profile Page", "--agent", "--ai"], { root, cwd: local, config: { ai_enabled: false, hosted_ai_consent: true } });
      expect(explicit.exitCode).toBe(0);
      expect(explicit.providerCalls.some(([provider]) => provider === "codex")).toBe(true);
      expect(JSON.parse(explicit.stdout).contract).toBe("ggh.agent");
      const denied = await runFixture(["worktree", "add", "Create Reports Page", "--agent", "--no-ai"], { root, cwd: local, config: { ai_enabled: true, hosted_ai_consent: true } });
      expect(denied.exitCode).toBe(0);
      expect(denied.providerCalls).toEqual([]);
    } finally { rmSync(local, { recursive: true, force: true }); }
  });

  test("returns dry-run and cancellation outcomes", async () => {
    const result = await runFixture(["config", "set", "ai_enabled", "true", "--dry-run", "--agent"], { root });
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "planned", result: { key: "ai_enabled", value: true, dryRun: true }, effects: { completed: [], pending: ["command_effects"], uncertain: [] } });
    expect(agentEnvelope({ command: ["commit"], failed: true, dryRun: false, preview: [], issue: { status: "cancelled", message: "Cancelled." } })).toMatchObject({ status: "cancelled", error: { code: "cancelled", retryability: "after_inspection" }, effects: { uncertain: ["command_effects"] } });
  });

  test("unknown failures retain uncertainty even with raw result data", () => {
    expect(agentEnvelope({ command: ["api"], result: { status: "succeeded" }, failed: true, dryRun: false, preview: [] }).effects.uncertain).not.toEqual([]);
  });

  test("discovers actual command paths and keeps native escapes unmanaged", async () => {
    const schema = await runFixture(["agent", "schema"], { root });
    const discovery = JSON.parse(schema.stdout);
    expect(discovery.envelope.properties.contract.const).toBe("ggh.agent");
    expect(discovery.coreResultSchemas.publication.schema.properties.completed.type).toBe("array");
    expect(discovery.coreResultSchemas.operationView.schema.properties.steps.type).toBe("array");
    expect(discovery.supportedCommandPaths).toContainEqual(["config", "get"]);
    expect(discovery.unmanagedEscapes).toEqual(["ggh git", "ggh gh", "ggh --"]);
    const native = await runFixture(["gh", "--agent"], { root, responses: [{ prefix: ["--agent"], stdout: "native-output" }] });
    expect(native.stdout).toBe("native-output");
    expect(native.calls).toEqual([["--agent"]]);
  });
});
