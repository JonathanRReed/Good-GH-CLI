import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, realpath, rename, stat, lstat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { AIUsageReport } from "./ai/index.ts";
import { run } from "../utils/exec.ts";
import { acquireProcessLock, inspectProcessLock, recoverProcessLock } from "./process-lock.ts";
import { parsePublicationIntent, type PublicationIntent } from "./publication-intent.ts";

export type OperationId = string & { readonly __brand: "OperationId" };
export type StepState = "pending" | "completed" | "failed" | "unknown";
export type OperationStatus =
  | { state: "running" }
  | { state: "succeeded" }
  | { state: "partially_completed" }
  | { state: "failed" }
  | { state: "needs_input" }
  | { state: "no_op" }
  | { state: "cancelled" };

export interface OperationStep {
  name: string;
  state: StepState;
}

export interface OperationEvidence {
  path: string;
  addedAt: string;
  revision: string;
}

export interface OperationRecord {
  schemaVersion: 1;
  id: OperationId;
  startedAt: string;
  updatedAt: string;
  command: string;
  target?: string;
  revision?: string;
  beforeRevision?: string;
  ai?: AIUsageReport[];
  status: OperationStatus;
  steps: OperationStep[];
  resources: string[];
  evidence: OperationEvidence[];
  resume?: PublicationIntent;
}

export interface StartOperationInput {
  command: string;
  target?: string;
  revision?: string;
  steps?: string[];
  cwd?: string;
}

export interface OperationUpdate {
  status?: OperationStatus;
  steps?: OperationStep[];
  resources?: string[];
  revision?: string;
  target?: string;
  ai?: AIUsageReport[];
  resume?: PublicationIntent;
}

const MAX_RECORD_BYTES = 64 * 1024;
const MAX_LIST_RESULTS = 100;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMAND_PATTERN = /^[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*){0,5}$/i;
const NAME_PATTERN = /^[^\0\r\n]{1,512}$/u;
const STEP_STATES: readonly StepState[] = ["pending", "completed", "failed", "unknown"];
const AI_PROVIDERS: readonly AIUsageReport["provider"][] = ["codex", "grok", "claude", "ollama"];
const AI_USAGE_SCALARS = ["inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteInputTokens", "costUsd"] as const;
const AI_USAGE_SCALAR_KEYS = new Set<string>(AI_USAGE_SCALARS);

function validateId(id: string): OperationId {
  if (!ID_PATTERN.test(id)) throw new Error("Invalid operation id.");
  return id as OperationId;
}

function validateText(value: string, field: string, max = 512): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) {
    throw new Error(`Invalid operation ${field}.`);
  }
  return value.trim();
}

function validateNames(values: string[], field: string): string[] {
  if (!Array.isArray(values) || values.length > 100) throw new Error(`Invalid operation ${field}.`);
  return values.map((value) => {
    const checked = validateText(value, field, 512);
    if (!NAME_PATTERN.test(checked)) throw new Error(`Invalid operation ${field}.`);
    return checked;
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSteps(raw: unknown): OperationStep[] {
  if (!Array.isArray(raw) || raw.length > 100) throw new Error("Invalid operation steps.");
  return raw.map((step) => {
    if (!isObject(step) || typeof step.name !== "string" || typeof step.state !== "string" || !STEP_STATES.includes(step.state as StepState)) {
      throw new Error("Invalid operation step.");
    }
    const [name] = validateNames([step.name], "step");
    if (!name) throw new Error("Invalid operation step name.");
    return { name, state: step.state as StepState };
  });
}

function parseStatus(raw: unknown): OperationStatus {
  if (!isObject(raw) || typeof raw.state !== "string" || Object.keys(raw).some((key) => key !== "state")) {
    throw new Error("Invalid operation status.");
  }
  switch (raw.state) {
    case "running": return { state: "running" };
    case "succeeded": return { state: "succeeded" };
    case "partially_completed": return { state: "partially_completed" };
    case "failed": return { state: "failed" };
    case "needs_input": return { state: "needs_input" };
    case "no_op": return { state: "no_op" };
    case "cancelled": return { state: "cancelled" };
    default: throw new Error("Invalid operation status.");
  }
}

function isAIProvider(value: string): value is AIUsageReport["provider"] {
  return AI_PROVIDERS.some((provider) => provider === value);
}

function isAIOutcome(value: string): value is AIUsageReport["outcome"] {
  return value === "succeeded" || value === "failed";
}

function parseAIUsageReports(raw: unknown): AIUsageReport[] {
  if (!Array.isArray(raw) || raw.length > 100) throw new Error("Invalid operation AI usage reports.");
  return raw.map((item) => {
    if (!isObject(item) || Object.keys(item).some((key) => !["provider", "model", "outcome", "usage"].includes(key))) {
      throw new Error("Invalid operation AI usage report.");
    }
    if (typeof item.provider !== "string" || !isAIProvider(item.provider)) {
      throw new Error("Invalid operation AI provider.");
    }
    if (typeof item.model !== "string" || typeof item.outcome !== "string" || !isAIOutcome(item.outcome)) {
      throw new Error("Invalid operation AI usage report.");
    }
    const report: AIUsageReport = {
      provider: item.provider,
      model: validateText(item.model, "AI model", 256),
      outcome: item.outcome,
    };
    if (item.usage !== undefined) {
      if (!isObject(item.usage) || Object.keys(item.usage).some((key) => !AI_USAGE_SCALAR_KEYS.has(key))) {
        throw new Error("Invalid operation AI usage values.");
      }
      const usage: NonNullable<AIUsageReport["usage"]> = {};
      for (const key of AI_USAGE_SCALARS) {
        const value = item.usage[key];
        if (value !== undefined) {
          if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
            throw new Error("AI usage values must be finite, nonnegative numbers.");
          }
          usage[key] = value;
        }
      }
      report.usage = usage;
    }
    return report;
  });
}

function parseRecord(raw: unknown): OperationRecord {
  if (!isObject(raw) || raw.schemaVersion !== 1) throw new Error("Unsupported or invalid operation record.");
  const allowed = new Set(["schemaVersion", "id", "startedAt", "updatedAt", "command", "target", "revision", "beforeRevision", "ai", "status", "steps", "resources", "evidence", "resume"]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) throw new Error("Operation record contains unsupported fields.");
  if (typeof raw.id !== "string" || typeof raw.startedAt !== "string" || typeof raw.updatedAt !== "string" || typeof raw.command !== "string") {
    throw new Error("Invalid operation record fields.");
  }
  const date = (value: string) => !Number.isNaN(Date.parse(value));
  if (!date(raw.startedAt) || !date(raw.updatedAt)) throw new Error("Invalid operation timestamps.");
  if (!Array.isArray(raw.resources) || raw.resources.length > 100 || !raw.resources.every((item) => typeof item === "string" && item.length <= 2048 && URL.canParse(item))) {
    throw new Error("Invalid operation resource URLs.");
  }
  if (!Array.isArray(raw.evidence) || raw.evidence.length > 100 || !raw.evidence.every((item) =>
    isObject(item) && typeof item.path === "string" && item.path.length <= 4096 && isAbsolute(item.path) &&
    typeof item.addedAt === "string" && date(item.addedAt) && typeof item.revision === "string" && item.revision.length <= 512)) {
    throw new Error("Invalid operation evidence references.");
  }
  const record: OperationRecord = {
    schemaVersion: 1,
    id: validateId(raw.id),
    startedAt: raw.startedAt,
    updatedAt: raw.updatedAt,
    command: validateCommand(raw.command),
    status: parseStatus(raw.status),
    steps: parseSteps(raw.steps),
    resources: [...raw.resources] as string[],
    evidence: raw.evidence.map((item) => ({
      path: item.path as string,
      addedAt: item.addedAt as string,
      revision: item.revision as string,
    })),
  };
  if (raw.target !== undefined) {
    if (typeof raw.target !== "string") throw new Error("Invalid operation target.");
    record.target = validateText(raw.target, "target");
  }
  if (raw.revision !== undefined) {
    if (typeof raw.revision !== "string") throw new Error("Invalid operation revision.");
    record.revision = validateText(raw.revision, "revision");
  }
  if (raw.beforeRevision !== undefined) {
    if (typeof raw.beforeRevision !== "string") throw new Error("Invalid operation original revision.");
    record.beforeRevision = validateText(raw.beforeRevision, "original revision");
  }
  if (raw.ai !== undefined) record.ai = parseAIUsageReports(raw.ai);
  if (raw.resume !== undefined) record.resume = parsePublicationIntent(raw.resume);
  return record;
}

function validateCommand(command: string): string {
  const checked = validateText(command, "command", 256);
  if (!COMMAND_PATTERN.test(checked)) throw new Error("Operation command must be a command name without arguments.");
  return checked;
}

async function operationsDirectory(cwd = process.cwd(), create = true): Promise<string> {
  const git = await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, reject: false });
  const common = git.exitCode === 0 ? git.stdout.trim() : "";
  const base = common
    ? resolve(cwd, common, "ggh-operations")
    : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "good-gh", "operations");
  if (create) await mkdir(base, { recursive: true, mode: 0o700 });
  const info = await lstat(base).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" && !create ? undefined : Promise.reject(error));
  if (!info) return base;
  const hasPrivateUnixMode = process.platform === "win32" || (info.mode & 0o077) === 0;
  if (!info.isDirectory() || info.isSymbolicLink() || !hasPrivateUnixMode || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
    throw new Error("Operation storage directory has unsafe ownership or type.");
  }
  if (create) await mkdir(join(base, "locks"), { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const lockInfo = await lstat(join(base, "locks")).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" && !create ? undefined : Promise.reject(error));
  if (!lockInfo) return base;
  const hasPrivateLockMode = process.platform === "win32" || (lockInfo.mode & 0o077) === 0;
  if (!lockInfo.isDirectory() || lockInfo.isSymbolicLink() || !hasPrivateLockMode || (typeof process.getuid === "function" && lockInfo.uid !== process.getuid())) {
    throw new Error("Operation lock directory has unsafe ownership or type.");
  }
  return base;
}

function recordPath(directory: string, id: string): string {
  return join(directory, `${validateId(id)}.json`);
}

async function readAt(directory: string, id: string): Promise<OperationRecord> {
  const path = recordPath(directory, id);
  const info = await lstat(path);
  const hasPrivateUnixMode = process.platform === "win32" || (info.mode & 0o077) === 0;
  if (!info.isFile() || info.isSymbolicLink() || !hasPrivateUnixMode || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
    throw new Error("Operation record has unsafe ownership or type.");
  }
  if (info.size > MAX_RECORD_BYTES) throw new Error("Operation record is too large.");
  const data = await readFile(path, "utf8");
  let parsed: unknown;
  try { parsed = JSON.parse(data); } catch { throw new Error("Operation record is corrupt."); }
  const record = parseRecord(parsed);
  if (record.id !== id) throw new Error("Operation record id does not match its file.");
  return record;
}

async function writeAt(directory: string, record: OperationRecord): Promise<void> {
  const path = recordPath(directory, record.id);
  const json = `${JSON.stringify(record, null, 2)}\n`;
  if (Buffer.byteLength(json) > MAX_RECORD_BYTES) throw new Error("Operation record is too large.");
  const temp = join(directory, `.${record.id}.${randomUUID()}.tmp`);
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(json, "utf8");
    await file.sync();
  } finally { await file.close(); }
  try {
    const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    const hasPrivateUnixMode = !existing || process.platform === "win32" || (existing.mode & 0o077) === 0;
    if (existing && (!existing.isFile() || existing.isSymbolicLink() || !hasPrivateUnixMode || (typeof process.getuid === "function" && existing.uid !== process.getuid()))) {
      throw new Error("Operation record has unsafe ownership or type.");
    }
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

async function withLock<T>(directory: string, id: OperationId, action: () => Promise<T>): Promise<T> {
  const release = await acquireProcessLock(join(directory, "locks", `${id}.lock`));
  try { return await action(); }
  finally { await release(); }
}

export async function operationLockStatus(id: string, cwd?: string) {
  const directory = await operationsDirectory(cwd, false);
  return inspectProcessLock(join(directory, "locks", `${validateId(id)}.lock`));
}

export async function unlockOperation(id: string, options: { authorized: boolean; allowUnknown?: boolean; cwd?: string }) {
  if (!options.authorized) throw new Error("Unlocking requires explicit authorization.");
  const directory = await operationsDirectory(options.cwd, false);
  const path = join(directory, "locks", `${validateId(id)}.lock`);
  if ((await inspectProcessLock(path)).state !== "unlocked") await recoverProcessLock(path, options);
  return { operationId: id, unlocked: true };
}

export async function claimOperationResume(id: string, cwd?: string, waitMs = 5000): Promise<() => Promise<void>> {
  const directory = await operationsDirectory(cwd, false);
  const checked = validateId(id);
  await readAt(directory, checked);
  return acquireProcessLock(join(directory, "locks", `${checked}.resume.lock`), waitMs);
}

export async function startOperation(input: StartOperationInput): Promise<OperationRecord> {
  const directory = await operationsDirectory(input.cwd);
  const now = new Date().toISOString();
  const record: OperationRecord = {
    schemaVersion: 1,
    id: randomUUID() as OperationId,
    startedAt: now,
    updatedAt: now,
    command: validateCommand(input.command),
    ...(input.target === undefined ? {} : { target: validateText(input.target, "target") }),
    ...(input.revision === undefined ? {} : { revision: validateText(input.revision, "revision"), beforeRevision: validateText(input.revision, "original revision") }),
    status: { state: "running" },
    steps: validateNames(input.steps ?? [], "step").map((name) => ({ name, state: "pending" })),
    resources: [],
    evidence: [],
  };
  await withLock(directory, record.id, () => writeAt(directory, record));
  return record;
}

export async function updateOperation(id: string, update: OperationUpdate, cwd?: string): Promise<OperationRecord> {
  const checkedId = validateId(id);
  const directory = await operationsDirectory(cwd, false);
  return withLock(directory, checkedId, async () => {
    const current = await readAt(directory, checkedId);
    const next: OperationRecord = {
      ...current,
      updatedAt: new Date().toISOString(),
      ...(update.status === undefined ? {} : { status: parseStatus(update.status) }),
      ...(update.steps === undefined ? {} : { steps: parseSteps(update.steps) }),
      ...(update.resources === undefined ? {} : { resources: update.resources.map((url) => {
        const checked = validateText(url, "resource URL", 2048);
        if (!URL.canParse(checked)) throw new Error("Invalid operation resource URL.");
        return checked;
      }) }),
      ...(update.target === undefined ? {} : { target: validateText(update.target, "target") }),
      ...(update.resume === undefined ? {} : { resume: parsePublicationIntent(update.resume) }),
      ...(update.revision === undefined ? {} : { revision: validateText(update.revision, "revision") }),
      ...(update.ai === undefined ? {} : { ai: parseAIUsageReports(update.ai) }),
    };
    await writeAt(directory, next);
    return next;
  });
}

export async function readOperation(id: string, cwd?: string): Promise<OperationRecord> {
  return readAt(await operationsDirectory(cwd, false), id);
}

export async function listOperations(cwd?: string): Promise<OperationRecord[]> {
  const directory = await operationsDirectory(cwd, false);
  const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
  const candidates = await Promise.all(entries
    .filter((name) => name.endsWith(".json") && ID_PATTERN.test(name.slice(0, -5)))
    .map(async (name) => ({ name, info: await lstat(join(directory, name)) })));
  const names = candidates.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs || b.name.localeCompare(a.name)).slice(0, MAX_LIST_RESULTS);
  const records = await Promise.all(names.map(({ name }) => readAt(directory, name.slice(0, -5))));
  return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function evidenceReference(record: OperationRecord, file: string, cwd?: string): Promise<OperationEvidence> {
  if (!record.revision) throw new Error("Set the operation revision before associating evidence.");
  const absolute = resolve(cwd ?? process.cwd(), file);
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink() || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
    throw new Error("Evidence must be a regular file owned by the current user.");
  }
  const canonical = await realpath(absolute);
  const canonicalInfo = await stat(canonical);
  if (!canonicalInfo.isFile()) throw new Error("Evidence must be a regular file.");
  return { path: canonical, addedAt: new Date().toISOString(), revision: record.revision };
}

export interface OperationEvidencePreview {
  operationId: OperationId;
  path: string;
  revision: string;
}

export async function previewOperationEvidence(id: string, file: string, cwd?: string): Promise<OperationEvidencePreview> {
  const checkedId = validateId(id);
  const record = await readOperation(checkedId, cwd);
  const evidence = await evidenceReference(record, file, cwd);
  return { operationId: checkedId, path: evidence.path, revision: evidence.revision };
}

export async function addOperationEvidence(id: string, file: string, cwd?: string): Promise<OperationRecord> {
  const checkedId = validateId(id);
  const directory = await operationsDirectory(cwd, false);
  return withLock(directory, checkedId, async () => {
    const current = await readAt(directory, checkedId);
    const evidence = await evidenceReference(current, file, cwd);
    const next = { ...current, updatedAt: evidence.addedAt, evidence: [...current.evidence, evidence] };
    await writeAt(directory, next);
    return next;
  });
}

export async function pruneOperations(options: { before: Date; authorized: boolean; cwd?: string }): Promise<OperationId[]> {
  if (options.authorized !== true) throw new Error("Pruning operation records requires explicit authorization.");
  const directory = await operationsDirectory(options.cwd, false);
  const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
  const names = entries.filter((name) => name.endsWith(".json") && ID_PATTERN.test(name.slice(0, -5)));
  const removed: OperationId[] = [];
  for (const name of names) {
    if (removed.length >= MAX_LIST_RESULTS) break;
    const id = validateId(name.slice(0, -5));
    const path = recordPath(directory, id);
    const record = await readAt(directory, id);
    if (Date.parse(record.updatedAt) >= options.before.getTime()) continue;
    await withLock(directory, id, async () => {
      const latest = await readAt(directory, id);
      if (Date.parse(latest.updatedAt) < options.before.getTime()) {
        await unlink(path);
        removed.push(id);
      }
    });
  }
  return removed;
}

// POSIX file modes restrict access on Unix systems. On Windows, Node's mode
// argument does not guarantee restrictive ACLs. Privacy depends on the parent
// directory ACL there, and Windows behavior has not been verified here.
