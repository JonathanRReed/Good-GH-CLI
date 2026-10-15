import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { Command } from "commander";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { run } from "../src/utils/exec.ts";
import { addOperationEvidence, listOperations, pruneOperations, readOperation, startOperation, updateOperation } from "../src/services/operations.ts";
import { registerOperationCommand } from "../src/commands/operation.ts";
import { resetFlags, setFlags } from "../src/services/runtime.ts";

const roots: string[] = [];

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ggh-operations-"));
  roots.push(root);
  await mkdir(root, { recursive: true });
  await run("git", ["init", "--quiet"], { cwd: root });
  return root;
}

async function recordsDirectory(root: string): Promise<string> {
  const result = await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root });
  return join(result.stdout.trim(), "ggh-operations");
}

async function invokeOperation(args: string[], options: { cwd?: string; dryRun?: boolean } = {}): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  const program = new Command();
  program.exitOverride();
  registerOperationCommand(program);
  resetFlags();
  setFlags({ json: true, dryRun: options.dryRun ?? false });
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  const priorExitCode = process.exitCode;
  const priorCwd = process.cwd();
  let stdout = "";
  let stderr = "";
  process.exitCode = undefined;
  if (options.cwd) process.chdir(options.cwd);
  process.stdout.write = ((chunk: string | Uint8Array) => { stdout += chunk.toString(); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += chunk.toString(); return true; }) as typeof process.stderr.write;
  let parseError: unknown;
  let actionExitCode: number | undefined;
  try {
    await program.parseAsync(["node", "ggh", "operation", ...args]);
  } catch (error) {
    parseError = error;
  } finally {
    actionExitCode = typeof process.exitCode === "number" ? process.exitCode : undefined;
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    process.chdir(priorCwd);
    process.exitCode = priorExitCode ?? 0;
    resetFlags();
  }
  if (parseError) throw parseError;
  return { stdout, stderr, exitCode: actionExitCode };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local operation records", () => {
  test("persists only structured operation metadata and reopens it", async () => {
    const cwd = await repository();
    const record = await startOperation({ command: "ggh pr create", target: "owner/repo", revision: "abc123", steps: ["checks"], cwd });
    const stored = await readFile(join(await recordsDirectory(cwd), `${record.id}.json`), "utf8");
    expect(stored).not.toContain("authorization");
    expect(stored).not.toContain("SECRET_TOKEN");
    expect(stored).not.toContain("private prompt transcript");
    expect(await readOperation(record.id, cwd)).toEqual(record);
    expect((await listOperations(cwd)).map((item) => item.id)).toEqual([record.id]);
  });

  test("persists strict AI usage summaries without prompt or transcript content", async () => {
    const cwd = await repository();
    const record = await startOperation({ command: "ggh pr create", cwd });
    const reports = [{
      provider: "codex",
      model: "gpt-5.6-luna",
      outcome: "succeeded",
      usage: { inputTokens: 125, outputTokens: 30, cachedInputTokens: 20, cacheWriteInputTokens: 5, costUsd: 0.004 },
    }] satisfies NonNullable<import("../src/services/operations.ts").OperationUpdate["ai"]>;
    await updateOperation(record.id, { ai: reports }, cwd);
    expect((await readOperation(record.id, cwd)).ai).toEqual(reports);
    const stored = await readFile(join(await recordsDirectory(cwd), `${record.id}.json`), "utf8");
    expect(stored).not.toContain("prompt");
    expect(stored).not.toContain("transcript");
    expect(stored).not.toContain("private source content");
  });

  test("rejects invalid AI usage scalars and extra content fields", async () => {
    const cwd = await repository();
    const record = await startOperation({ command: "ggh status", cwd });
    const infinite = [{ provider: "codex", model: "model", outcome: "failed", usage: { inputTokens: Number.POSITIVE_INFINITY } }] satisfies NonNullable<import("../src/services/operations.ts").OperationUpdate["ai"]>;
    const negative = [{ provider: "codex", model: "model", outcome: "failed", usage: { costUsd: -0.01 } }] satisfies NonNullable<import("../src/services/operations.ts").OperationUpdate["ai"]>;
    const extendedUsage = { inputTokens: 1, transcript: "private prompt transcript" };
    const extraUsage = [{ provider: "codex" as const, model: "model", outcome: "failed" as const, usage: extendedUsage }];
    const reportWithPrompt = [{ provider: "codex" as const, model: "model", outcome: "failed" as const, prompt: "private source content" }];
    await expect(updateOperation(record.id, { ai: infinite }, cwd)).rejects.toThrow("finite, nonnegative");
    await expect(updateOperation(record.id, { ai: negative }, cwd)).rejects.toThrow("finite, nonnegative");
    await expect(updateOperation(record.id, { ai: extraUsage }, cwd)).rejects.toThrow("usage values");
    await expect(updateOperation(record.id, { ai: reportWithPrompt }, cwd)).rejects.toThrow("usage report");
    expect(await readOperation(record.id, cwd)).toEqual(record);
  });

  test("rejects more than 100 AI usage reports and corrupt persisted metadata", async () => {
    const cwd = await repository();
    const record = await startOperation({ command: "ggh status", cwd });
    const reports = Array.from({ length: 101 }, () => ({ provider: "ollama" as const, model: "qwen", outcome: "succeeded" as const }));
    await expect(updateOperation(record.id, { ai: reports }, cwd)).rejects.toThrow("Invalid operation AI usage reports");
    await updateOperation(record.id, { ai: [{ provider: "codex", model: "model", outcome: "succeeded" }] }, cwd);
    const path = join(await recordsDirectory(cwd), `${record.id}.json`);
    const saved = await readFile(path, "utf8");
    await writeFile(path, saved.replace('"provider": "codex"', '"provider": "unknown"'));
    await expect(readOperation(record.id, cwd)).rejects.toThrow("Invalid operation AI provider");
  });

  test("listing an empty repository does not create operation storage", async () => {
    const cwd = await repository();
    expect(await listOperations(cwd)).toEqual([]);
    await expect(readdir(await recordsDirectory(cwd))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects command text that could carry arguments or content", async () => {
    const cwd = await repository();
    await expect(startOperation({ command: "ggh pr create --body secret", cwd })).rejects.toThrow("without arguments");
  });

  test("serializes concurrent updates without dropping either update", async () => {
    const cwd = await repository();
    const record = await startOperation({ command: "ggh release create", cwd });
    await Promise.all([
      updateOperation(record.id, { status: { state: "partially_completed" } }, cwd),
      updateOperation(record.id, { resources: ["https://example.com/run/123"] }, cwd),
    ]);
    const saved = await readOperation(record.id, cwd);
    expect(saved.status).toEqual({ state: "partially_completed" });
    expect(saved.resources).toEqual(["https://example.com/run/123"]);
  });

  test("rejects invalid identifiers and corrupt records", async () => {
    const cwd = await repository();
    await expect(readOperation("../../outside", cwd)).rejects.toThrow("Invalid operation id");
    const record = await startOperation({ command: "ggh status", cwd });
    await writeFile(join(await recordsDirectory(cwd), `${record.id}.json`), "{");
    await expect(readOperation(record.id, cwd)).rejects.toThrow("corrupt");
  });

  test("rejects symlink records and leaves list reads untouched", async () => {
    const cwd = await repository();
    const record = await startOperation({ command: "ggh status", cwd });
    const directory = await recordsDirectory(cwd);
    const path = join(directory, `${record.id}.json`);
    const contentsBefore = await readdir(directory);
    await listOperations(cwd);
    expect(await readdir(directory)).toEqual(contentsBefore);
    await rm(path);
    const external = join(cwd, "outside.json");
    await writeFile(external, JSON.stringify(record));
    await symlink(external, path);
    await expect(readOperation(record.id, cwd)).rejects.toThrow("unsafe ownership or type");
  });

  test("associates a regular evidence file with the operation revision without copying it", async () => {
    const cwd = await repository();
    const record = await startOperation({ command: "ggh checks", revision: "deadbeef", cwd });
    const evidenceFile = join(cwd, "receipt.txt");
    await writeFile(evidenceFile, "receipt content remains in its original file");
    const saved = await addOperationEvidence(record.id, evidenceFile, cwd);
    expect(saved.evidence).toHaveLength(1);
    expect(saved.evidence[0]?.path).toBe(await realpath(evidenceFile));
    expect(saved.evidence[0]?.revision).toBe("deadbeef");
    expect(await readFile(evidenceFile, "utf8")).toBe("receipt content remains in its original file");
    expect(await readFile(join(await recordsDirectory(cwd), `${record.id}.json`), "utf8")).not.toContain("receipt content remains");
  });

  test("evidence dry-run validates and previews without changing the record", async () => {
    const cwd = await repository();
    const record = await startOperation({ command: "ggh checks", revision: "deadbeef", cwd });
    const evidenceFile = join(cwd, "receipt.txt");
    await writeFile(evidenceFile, "receipt content");
    const before = await readOperation(record.id, cwd);
    const result = await invokeOperation(["evidence", record.id, evidenceFile], { cwd, dryRun: true });
    expect(result.exitCode ?? 0).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      dryRun: true,
      operationId: record.id,
      evidence: { path: await realpath(evidenceFile), revision: "deadbeef" },
    });
    expect(await readOperation(record.id, cwd)).toEqual(before);
  });

  test("rejects trailing junk in list and prune numeric options", async () => {
    const cwd = await repository();
    const list = await invokeOperation(["list", "--limit", "1record"], { cwd });
    expect(list.exitCode).toBe(1);
    expect(list.stderr).toContain("Limit must be an integer");
    const prune = await invokeOperation(["prune", "--older-than", "1day", "--yes"], { cwd });
    expect(prune.exitCode).toBe(1);
    expect(prune.stderr).toContain("Age must be an integer");
    expect(await listOperations(cwd)).toEqual([]);
  });

  test("selects the newest records by file recency rather than UUID order", async () => {
    const cwd = await repository();
    const directory = await recordsDirectory(cwd);
    const template = await startOperation({ command: "ggh status", cwd });
    const baseTime = Date.now() - 200_000;
    for (let index = 0; index < 105; index++) {
      const reverseId = String(104 - index).padStart(12, "0");
      const id = `00000000-0000-4000-8000-${reverseId}`;
      const timestamp = new Date(baseTime + index * 1_000).toISOString();
      await writeFile(join(directory, `${id}.json`), JSON.stringify({ ...template, id, startedAt: timestamp, updatedAt: timestamp }), { mode: 0o600 });
      const mtime = new Date(baseTime + index * 1_000);
      await utimes(join(directory, `${id}.json`), mtime, mtime);
    }
    const listed = await listOperations(cwd);
    expect(listed).toHaveLength(100);
    expect(listed.some((item) => item.id.endsWith("000000000000"))).toBe(true);
    expect(listed.some((item) => item.id.endsWith("000000000104"))).toBe(false);
  });

  test("prune searches past recent records and caps removals", async () => {
    const cwd = await repository();
    const directory = await recordsDirectory(cwd);
    const template = await startOperation({ command: "ggh status", cwd });
    const now = Date.now();
    for (let index = 0; index < 101; index++) {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      const timestamp = new Date(now).toISOString();
      await writeFile(join(directory, `${id}.json`), JSON.stringify({ ...template, id, startedAt: timestamp, updatedAt: timestamp }), { mode: 0o600 });
    }
    const candidates = (await readdir(directory)).filter((name) => name.endsWith(".json"));
    const staleName = candidates[100];
    if (!staleName) throw new Error("Expected a record beyond the first 100 candidates.");
    const stalePath = join(directory, staleName);
    const staleRecord = JSON.parse(await readFile(stalePath, "utf8")) as { updatedAt: string };
    const staleTimestamp = new Date(now - 10_000).toISOString();
    await writeFile(stalePath, JSON.stringify({ ...staleRecord, startedAt: staleTimestamp, updatedAt: staleTimestamp }));
    const removed = await pruneOperations({ before: new Date(now - 5_000), authorized: true, cwd });
    expect(removed.map((id) => String(id))).toEqual([staleName.slice(0, -5)]);
    expect((await readdir(directory)).filter((name) => name.endsWith(".json"))).toHaveLength(101);
  });

  test("prunes only explicitly authorized old records", async () => {
    const cwd = await repository();
    const record = await startOperation({ command: "ggh status", cwd });
    const unrelated = join(await recordsDirectory(cwd), "keep.txt");
    await writeFile(unrelated, "keep");
    const before = new Date(Date.now() + 1_000);
    await expect(pruneOperations({ before, authorized: false, cwd })).rejects.toThrow("explicit authorization");
    expect(await readOperation(record.id, cwd)).toEqual(record);
    expect(await readdir(await recordsDirectory(cwd))).toContain("keep.txt");
    expect(await pruneOperations({ before, authorized: true, cwd })).toEqual([record.id]);
    expect(await readdir(await recordsDirectory(cwd))).toContain("keep.txt");
  });
});
