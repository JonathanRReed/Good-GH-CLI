import { assertSupportedGit } from "./dependency-compatibility.ts";
import { finalizeJsonOutput } from "../utils/output.ts";
import type { Command } from "commander";
import { startOperation, updateOperation, readOperation, type OperationRecord, type OperationStep } from "./operations.ts";
import { getActiveOperation, getCommandIssue, getEmittedJson, getFlags, setActiveOperation, setCommandMutates, setFinishedOperation } from "./runtime.ts";
import { parseRepoFlag } from "./github/client.ts";
import { DRY_RUN_CAPABLE } from "../utils/flags.ts";
import { run } from "../utils/exec.ts";
import { fail, jsonOut } from "../utils/ui.ts";
import { getAIUsageReports } from "./ai/index.ts";

const MANAGED_GIT_DOMAINS = new Set(["commit", "stack", "worktree", "stash", "discard", "undo", "resolve", "squash", "rename", "sync", "switch", "clone", "hook", "ignore", "operation"]);
const READ_ACTIONS = new Set(["list", "view", "get", "doctor", "diff", "status", "log", "show", "inspect", "download", "threads"]);
const LOCAL_MUTATIONS = new Set(["commit", "discard", "sync", "squash", "undo", "rename", "resolve", "switch", "clone"]);
const READ_DOMAINS = new Set(["status", "log", "checks", "mcp", "completion", "operation", "review"]);

function commandParts(command: Command): string[] {
  const names: string[] = [];
  for (let current: Command | null = command; current?.parent; current = current.parent) names.unshift(current.name());
  return names;
}

function shouldRecord(command: Command, names: string[]): boolean {
  if (process.env.GGH_NO_RECORDS === "1") return false;
  return wouldRecord(command, names);
}

function wouldRecord(command: Command, names: string[]): boolean {
  const domain = names[0] ?? "";
  const action = names.at(-1) ?? "";
  if (getFlags().dryRun || READ_DOMAINS.has(domain)) return false;
  if (!getFlags().aiDisabled && (action === "review" || action === "summarize")) return true;
  if (!DRY_RUN_CAPABLE.has(domain)) return false;
  const options = command.opts();
  if (domain === "config" && action === "doctor") return options.fix === true;
  if (names.length > 1) return !READ_ACTIONS.has(action) || action === "download";
  if (LOCAL_MUTATIONS.has(domain)) return true;
  if (domain === "pr") return options.checkout === true || options.worktree === true;
  if (domain === "config") return true;
  if (domain === "alias") return Boolean(options.remove || command.processedArgs[1]?.length);
  if (domain === "ignore") return Boolean(options.remove || command.processedArgs[0]?.length);
  if (domain === "plugin") return ["install", "remove"].includes(String(command.processedArgs[0]));
  if (domain === "stash") return !getFlags().json;
  if (domain === "api") return (typeof options.method === "string" && options.method.toUpperCase() !== "GET") || command.processedArgs.some(arg => Array.isArray(arg) && arg.some(value => ["-X", "--method", "-f", "-F", "--field", "--raw-field"].includes(value)));
  return false;
}

/**
 * Whether this run can change local or remote state. A failed read reports no
 * uncertain effects, so this errs toward mutating for anything not known to read.
 */
export function commandCanMutate(command: Command, names: string[]): boolean {
  const domain = names[0] ?? "";
  const action = names.at(-1) ?? "";
  const options = command.opts();
  if (getFlags().dryRun) return false;
  if (domain === "review" || (domain === "operation" && action === "resume")) return true;
  if (domain === "agent") return action === "skill" && options.install !== undefined;
  if (domain === "projects") return names.length > 1 && action !== "list";
  if (domain === "lost") return options.fetch === true;
  if (domain === "go") return options.editor === true || options.t3 === true;
  return wouldRecord(command, names);
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resourceUrls(value: unknown, depth = 0): string[] {
  if (depth > 4) return [];
  if (Array.isArray(value)) return value.slice(0, 100).flatMap(item => resourceUrls(item, depth + 1));
  if (!object(value)) return [];
  const resources: string[] = [];
  if (typeof value.url === "string") {
    try {
      const url = new URL(value.url);
      if (url.protocol === "https:" || url.protocol === "http:") {
        url.username = ""; url.password = ""; url.search = ""; url.hash = "";
        resources.push(url.toString());
      }
    } catch { /* resource is not a URL */ }
  }
  for (const key of ["result", "opened", "results", "attachments", "uploaded"] as const) {
    if (key in value) resources.push(...resourceUrls(value[key], depth + 1));
  }
  return [...new Set(resources)].slice(0, 100);
}

async function revision(cwd: string): Promise<string | undefined> {
  try {
    const result = await run("git", ["rev-parse", "--verify", "HEAD"], { cwd, reject: false });
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  } catch { return undefined; }
}

export async function finishCommandOperation(): Promise<void> {
  const active = getActiveOperation();
  if (!active) return;
  const result = getEmittedJson()?.value;
  const status = object(result) && active.command !== "api" ? result.status : undefined;
  const issue = getCommandIssue();
  const prior = await readOperation(active.id, active.cwd).catch(() => undefined);
  const afterRevision = await revision(active.cwd);
  const changedRevision = prior && afterRevision && prior.beforeRevision !== afterRevision;
  const state: OperationRecord["status"] = status === "partially_completed" || (process.exitCode && (changedRevision || prior?.steps.some(step => step.state === "completed"))) ? { state: "partially_completed" }
    : issue?.status === "cancelled" ? { state: "cancelled" }
      : issue?.status === "needs_input" ? { state: "needs_input" }
        : status === "no_op" || (active.command !== "api" && object(result) && result.noOp === true) ? { state: "no_op" }
      : process.exitCode && process.exitCode !== 0 ? { state: "failed" } : { state: "succeeded" };
  const workflowResult = /^(?:stack |repo create$|pr create$|commit$)/.test(active.command ?? "");
  const completed = workflowResult && object(result) && Array.isArray(result.completed) ? result.completed.filter((step): step is string => typeof step === "string") : [];
  const remaining = workflowResult && object(result) && Array.isArray(result.remaining) ? result.remaining.filter((step): step is string => typeof step === "string") : [];
  const steps: OperationStep[] = [
    ...completed.map(name => ({ name, state: "completed" as const })),
    ...remaining.map(name => ({ name, state: "pending" as const })),
  ];
  if (!steps.length && issue?.status === "cancelled" && prior?.steps.length) {
    let markedUnknown = false;
    steps.push(...prior.steps.map(step => {
      if (!markedUnknown && step.state === "pending") { markedUnknown = true; return { ...step, state: "unknown" as const }; }
      return step;
    }));
  }
  try {
    const ai = getAIUsageReports();
    const resources = active.command === "api" ? [] : [...new Set([...(prior?.resources ?? []), ...resourceUrls(result)])];
    await updateOperation(active.id, { status: state, resources, revision: afterRevision, ...(steps.length ? { steps } : {}), ...(ai.length ? { ai } : {}) }, active.cwd);
    const finished = await readOperation(active.id, active.cwd);
    setFinishedOperation(finished);
    if (getFlags().json && object(result) && active.command !== "api") jsonOut({ ...result, ...(typeof result.operationId === "string" && result.operationId !== active.id ? { recoveryOperationId: result.operationId } : {}), operationId: active.id, ...(ai.length ? { ai } : {}) });
    else if (getFlags().json && issue) jsonOut({ status: state.state === "partially_completed" ? state.state : issue.status, operationId: active.id, ...(steps.length ? { completed: steps.filter(step => step.state === "completed").map(step => step.name), remaining: steps.filter(step => step.state !== "completed").map(step => step.name) } : {}), ...(resources.length ? { resources } : {}), error: { message: issue.message }, ...(issue.status === "cancelled" ? { recovery: `Inspect ggh operation view ${active.id} and the target before retrying.` } : {}) });
  } catch (error) {
    const message = `Could not finish operation record ${active.id}. Inspect the target before retrying. ${error instanceof Error ? error.message : String(error)}`;
    fail(message, { code: "outcome_uncertain" });
    if (getFlags().json) jsonOut({ status: "partially_completed", operationId: active.id, result, error: { message } });
  } finally { setActiveOperation(undefined); await active.releaseClaim?.(); }
}

export function registerCommandOperations(program: Command): void {
  program.hook("preAction", async (_program, command) => {
    const names = commandParts(command);
    const domain = names[0] ?? "";
    setCommandMutates(commandCanMutate(command, names));
    if (wouldRecord(command, names) || MANAGED_GIT_DOMAINS.has(domain)) await assertSupportedGit();
    if (!shouldRecord(command, names)) return;
    const cwd = process.cwd();
    const record = await startOperation({ command: names.join(" "), target: parseRepoFlag()?.nameWithOwner, revision: await revision(cwd), cwd });
    setActiveOperation({ id: record.id, cwd, command: names.join(" ") });
  });
  program.hook("postAction", async () => { await finishCommandOperation(); finalizeJsonOutput(); });
}
