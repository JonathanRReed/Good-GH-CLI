import type { OperationRecord } from "./operations.ts";
import type { CommandIssue } from "./runtime.ts";

export type AgentErrorCode = "invalid_arguments" | "missing_input" | "confirmation_required" | "authentication_required" | "provider_unavailable" | "cancelled" | "partial_completion" | "operation_failed" | "outcome_uncertain";
export type RequiredInput = { name: string; description: string; alternatives?: string[] };
export type AgentStatus = "succeeded" | "planned" | "no_op" | "needs_input" | "cancelled" | "failed" | "partially_completed";
export interface AgentEnvelope {
  contract: "ggh.agent";
  version: 1;
  command: string[];
  status: AgentStatus;
  result?: unknown;
  error?: { code: AgentErrorCode; message: string; retryability: "after_input" | "after_inspection" | "never" };
  requiredInputs?: RequiredInput[];
  effects: { completed: string[]; pending: string[]; uncertain: string[] };
  operationId?: string;
  resources?: string[];
}

export function agentEnvelope(input: { command: string[]; result?: unknown; issue?: CommandIssue; operation?: OperationRecord; failed: boolean; dryRun: boolean; preview: readonly string[] }): AgentEnvelope {
  const { operation, issue } = input;
  const path = input.command.join(" ");
  const result = typeof input.result === "object" && input.result !== null && !Array.isArray(input.result) ? input.result : undefined;
  const workflow = path === "commit" || path === "pr create" || path === "repo create" || path.startsWith("stack ");
  const noOp = ["worktree remove", "worktree prune", "rename", "draft", "draft create", "undo", "discard", "sync", "squash", "operation resume"].includes(path);
  const managedStatus = result && "status" in result && ((workflow && ["partially_completed", "needs_input", "cancelled", "failed", "succeeded", "no_op"].includes(String(result.status))) || (noOp && result.status === "no_op")) ? result.status : undefined;
  const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

  // Only journal state and explicit boundary metadata describe workflow outcomes.
  let status: AgentStatus = operation?.status.state === "running" ? "failed" : operation?.status.state ?? (issue?.status ?? (input.failed ? "failed" : input.dryRun ? "planned" : "succeeded"));
  if (managedStatus === "partially_completed" || managedStatus === "needs_input" || managedStatus === "cancelled" || managedStatus === "failed" || managedStatus === "no_op") status = managedStatus;
  if (input.dryRun && !issue && !input.failed) status = "planned";
  const effects = {
    completed: operation?.steps.filter(step => step.state === "completed").map(step => step.name) ?? (workflow && result && "completed" in result ? strings(result.completed) : []),
    pending: operation?.steps.filter(step => step.state === "pending").map(step => step.name) ?? (workflow && result && "remaining" in result ? strings(result.remaining) : input.preview.length ? ["command_effects"] : []),
    uncertain: operation?.steps.filter(step => step.state === "unknown" || step.state === "failed").map(step => step.name) ?? [],
  };
  if (operation && !operation.steps.length && status === "succeeded") {
    if (input.command[0] === "api") effects.uncertain.push("command_effects");
    else effects.completed.push("command");
  }
  const code = status === "partially_completed" ? "partial_completion" : issue?.code ?? (status === "cancelled" ? "cancelled" : status === "needs_input" ? "missing_input" : "operation_failed");
  const failed = ["failed", "partially_completed", "cancelled", "needs_input"].includes(status);
  if (failed && !effects.uncertain.length && !["invalid_arguments", "missing_input", "confirmation_required", "authentication_required", "provider_unavailable"].includes(code)) effects.uncertain.push("command_effects");
  return {
    contract: "ggh.agent", version: 1, command: input.command, status,
    ...(input.result !== undefined ? { result: input.result } : {}),
    ...(failed ? { error: { code, message: issue?.message ?? "Command did not complete.", retryability: ["invalid_arguments", "missing_input", "confirmation_required", "authentication_required"].includes(code) ? "after_input" : "after_inspection" } satisfies AgentEnvelope["error"] } : {}),
    ...(issue?.requiredInputs ? { requiredInputs: issue.requiredInputs } : {}), effects,
    ...(operation ? { operationId: operation.id, resources: operation.resources } : workflow && result ? { ...("operationId" in result && typeof result.operationId === "string" ? { operationId: result.operationId } : {}), ...("resources" in result ? { resources: strings(result.resources) } : {}) } : {}),
  };
}

export const envelopeSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object", required: ["contract", "version", "command", "status", "effects"],
  properties: {
    contract: { const: "ggh.agent" }, version: { const: 1 }, command: { type: "array", items: { type: "string" } },
    status: { enum: ["succeeded", "planned", "no_op", "needs_input", "cancelled", "failed", "partially_completed"] },
    result: { description: "Command-specific payload. Detailed result schemas are not yet guaranteed." },
    error: { type: "object", required: ["code", "message", "retryability"], properties: { code: { enum: ["invalid_arguments", "missing_input", "confirmation_required", "authentication_required", "provider_unavailable", "cancelled", "partial_completion", "operation_failed", "outcome_uncertain"] }, message: { type: "string" }, retryability: { enum: ["after_input", "after_inspection", "never"] } } },
    requiredInputs: { type: "array", items: { type: "object", required: ["name", "description"], properties: { name: { type: "string" }, description: { type: "string" }, alternatives: { type: "array", items: { type: "string" } } } } },
    effects: { type: "object", required: ["completed", "pending", "uncertain"], properties: Object.fromEntries(["completed", "pending", "uncertain"].map(key => [key, { type: "array", items: { type: "string" } }])) },
    operationId: { type: "string" }, resources: { type: "array", items: { type: "string" } },
  },
};


const stringArraySchema = { type: "array", items: { type: "string" } };
const workflowResultSchema = { type: "object", additionalProperties: true, properties: {
  status: { type: "string" }, target: { type: "string" }, completed: stringArraySchema, remaining: stringArraySchema,
  url: { type: "string" }, operationId: { type: "string" }, resources: stringArraySchema,
} };
const operationResultSchema = { type: "object", additionalProperties: true, properties: {
  schemaVersion: { const: 1 }, id: { type: "string" }, command: { type: "string" },
  status: { type: "object", properties: { state: { type: "string" } } },
  steps: { type: "array", items: { type: "object", properties: { name: { type: "string" }, state: { enum: ["pending", "completed", "failed", "unknown"] } } } },
  resources: stringArraySchema,
} };
export const coreResultSchemas = {
  coverage: "Partial field schemas. Optional fields vary by outcome. Other command result payloads are not yet specified.",
  publication: { commandPaths: [["repo", "create"], ["pr", "create"], ["commit"]], schema: workflowResultSchema },
  stack: { commandPaths: [["stack"]], includesSubcommands: true, schema: { anyOf: [workflowResultSchema, { type: "array", items: { type: "object", additionalProperties: true, properties: { branch: { type: "string" }, parent: { type: ["string", "null"] }, ahead: { type: "number" }, behind: { type: "number" } } } }] } },
  operationList: { commandPaths: [["operation", "list"]], schema: { type: "array", items: operationResultSchema } },
  operationView: { commandPaths: [["operation", "view"]], schema: operationResultSchema },
};
