import type { AgentErrorCode, RequiredInput } from "./agent-contract.ts";
import type { OperationRecord } from "./operations.ts";
/**
 * Process-wide flags that cut across every command. Commander writes them here
 * once, before the action runs, so deep helpers (output, prompts, the gh service)
 * can honour them without threading options through every signature.
 */
export interface RuntimeFlags {
  /** Emit machine-readable JSON on stdout and suppress all chrome. */
  json: boolean;
  agent: boolean;
  /** Explicit --no-ai or a supplied commit message denies provider invocation. */
  aiDisabled: boolean;
  /** Suppress chrome, but not errors. */
  quiet: boolean;
  /** Never prompt; fail with instructions instead. */
  noInput: boolean;
  /** Describe what would happen without changing anything. */
  dryRun: boolean;
  /** Operate on `owner/name` instead of the repository in the working directory. */
  repo?: string;
}

const defaults: RuntimeFlags = {
  json: false,
  agent: false,
  aiDisabled: false,
  quiet: false,
  noInput: false,
  dryRun: false,
  repo: undefined,
};

let flags: RuntimeFlags = { ...defaults };
let aiExplicitlyDisabled = false;

export type CommandIssue = { status: "failed" | "needs_input" | "cancelled"; message: string; code?: AgentErrorCode; requiredInputs?: RequiredInput[] };
let commandPath: string[] = [];
let finishedOperation: OperationRecord | undefined;
export function setCommandPath(value: string[]): void { commandPath = value; }
export function getCommandPath(): string[] { return commandPath; }
export function setFinishedOperation(value: OperationRecord): void { finishedOperation = value; }
export function getFinishedOperation(): OperationRecord | undefined { return finishedOperation; }
let jsonEmitted = false;
let issue: CommandIssue | undefined;
let preview: string[] = [];
let completedEffects = new Set<string>();
let uncertainEffects = new Set<string>();
let deferJson = false;
let pendingJson: { value: unknown } | undefined;
let emittedJson: { value: unknown } | undefined;
export interface ActiveOperation { id: string; cwd: string; command?: string; releaseClaim?: () => Promise<void> }
let activeOperation: ActiveOperation | undefined;

export function resetCommandOutput(): void {
  commandPath = [];
  finishedOperation = undefined;
  jsonEmitted = false;
  issue = undefined;
  preview = [];
  completedEffects = new Set();
  uncertainEffects = new Set();
  deferJson = false;
  pendingJson = undefined;
  emittedJson = undefined;
  activeOperation = undefined;
}

export function beginCommandOutput(): void { resetCommandOutput(); deferJson = true; }
export function stageJson(value: unknown): boolean {
  jsonEmitted = true;
  emittedJson = { value };
  if (!deferJson || !flags.json) return false;
  pendingJson = { value };
  return true;
}
export function takePendingJson(): { value: unknown } | undefined {
  const pending = pendingJson;
  pendingJson = undefined;
  deferJson = false;
  return pending;
}
export function getEmittedJson(): { value: unknown } | undefined { return emittedJson; }
export function rememberCommandResult(value: unknown): void { emittedJson = { value }; }
export function getActiveOperation(): ActiveOperation | undefined { return activeOperation; }
export function setActiveOperation(value: ActiveOperation | undefined): void { activeOperation = value; }

export function hasJsonOutput(): boolean { return jsonEmitted; }
export function recordCommandIssue(value: CommandIssue): void {
  if (!issue || value.code || value.status === "cancelled") issue = value;
}
export function getCommandIssue(): CommandIssue | undefined { return issue; }
export function recordCompletedEffect(effect: string): void { completedEffects.add(effect); }
export function getCompletedEffects(): string[] { return [...completedEffects]; }
export function recordUncertainEffect(effect: string): void { uncertainEffects.add(effect); }
export function getUncertainEffects(): string[] { return [...uncertainEffects]; }
export function recordPreview(action: string): void { preview.push(action); }
export function getPreview(): readonly string[] { return preview; }

export function getFlags(): RuntimeFlags {
  return flags;
}

export function setFlags(partial: Partial<RuntimeFlags>): void {
  flags = { ...flags, ...partial };
}

export function setAIExplicitlyDisabled(value: boolean): void {
  aiExplicitlyDisabled = value;
}

export function isAIExplicitlyDisabled(): boolean {
  return aiExplicitlyDisabled;
}

export function resetFlags(): void {
  flags = { ...defaults };
  aiExplicitlyDisabled = false;
  resetCommandOutput();
}

/**
 * True when the process must not prompt: an explicit --no-input, a --json run
 * whose stdout is being parsed, or simply no terminal attached.
 */
export function isNonInteractive(): boolean {
  return flags.noInput || flags.json || !process.stdin.isTTY;
}
