import { lostResultSchema, tidyResultSchema } from "./projects/tidy-schema.ts";
import { projectsResultSchema } from "./projects/schema.ts";
import { projectSyncResultSchema } from "./projects/sync-schema.ts";
import type { ProjectSyncResult } from "./projects/sync.ts";
import type { OperationRecord } from "./operations.ts";
import type { CommandIssue } from "./runtime.ts";
import type { CloneMode } from "./config.ts";
import type { CloneProtocol } from "./git/clone.ts";

export interface CloneResult {
  version: 1;
  destination: string;
  repo: string;
  mode: CloneMode;
  protocol: CloneProtocol;
  fallbackUsed: boolean;
  alreadyCloned: boolean;
}

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
  effects?: { completed: string[]; pending: string[]; uncertain: string[] };
  operationId?: string;
  resources?: string[];
}

export function agentEnvelope(input: { command: string[]; result?: unknown; issue?: CommandIssue; operation?: OperationRecord; failed: boolean; dryRun: boolean; preview: readonly string[]; completedEffects?: readonly string[]; uncertainEffects?: readonly string[] }): AgentEnvelope {
  const { operation, issue } = input;
  const path = input.command.join(" ");
  const result = typeof input.result === "object" && input.result !== null && !Array.isArray(input.result) ? input.result : undefined;
  const bulkSync = path === "sync" && isProjectSyncResult(input.result) ? input.result : undefined;
  const workflow = Boolean(bulkSync) || path === "tidy" || path === "commit" || path === "pr create" || path === "repo create" || path.startsWith("stack ");
  const noOp = ["clone", "worktree remove", "worktree prune", "rename", "draft", "draft create", "undo", "discard", "sync", "squash", "operation resume"].includes(path);
  const managedStatus = result && "status" in result && ((workflow && ["partially_completed", "needs_input", "cancelled", "failed", "succeeded", "no_op"].includes(String(result.status))) || (noOp && result.status === "no_op")) ? result.status : undefined;
  const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

  // Only journal state and explicit boundary metadata describe workflow outcomes.
  let status: AgentStatus = operation?.status.state === "running" ? "failed" : operation?.status.state ?? (issue?.status ?? (input.failed ? "failed" : input.dryRun ? "planned" : "succeeded"));
  if (managedStatus === "partially_completed" || managedStatus === "needs_input" || managedStatus === "cancelled" || managedStatus === "failed" || managedStatus === "no_op") status = managedStatus;
  if (input.dryRun && !issue && !input.failed) status = "planned";
  const effects = {
    completed: operation?.steps.filter(step => step.state === "completed").map(step => step.name) ?? (workflow && result && "completed" in result ? strings(result.completed) : []),
    pending: operation?.steps.filter(step => step.state === "pending").map(step => step.name) ?? (workflow && result && "remaining" in result ? strings(result.remaining) : input.preview.length ? ["command_effects"] : []),
    uncertain: operation?.steps.filter(step => step.state === "unknown" || step.state === "failed" || step.state === "uncertain").map(step => step.name) ?? (path === "tidy" && result && "uncertain" in result ? strings(result.uncertain) : []),
  };
  effects.completed = [...new Set([...effects.completed, ...input.completedEffects ?? []])];
  effects.uncertain = [...new Set([...effects.uncertain, ...input.uncertainEffects ?? []])];
  if (bulkSync) {
    for (const clone of bulkSync.clones) {
      for (const fetch of clone.fetches) {
        if (fetch.outcome === "updated") effects.completed.push(`fetch:${clone.commonDir}:${fetch.remote}`);
        else if (fetch.outcome === "uncertain") effects.uncertain.push(`fetch:${clone.commonDir}:${fetch.remote}`);
      }
      for (const checkout of clone.checkouts) {
        if (checkout.outcome === "updated") effects.completed.push(`ff:${checkout.path}`);
        else if (checkout.outcome === "uncertain") effects.uncertain.push(`ff:${checkout.path}`);
        else if (checkout.outcome === "skipped" && checkout.reason === "cancelled") effects.pending.push(`ff:${checkout.path}`);
      }
      if (clone.forkUpstream.outcome === "updated") effects.completed.push(`fork:${clone.forkUpstream.target}`);
      else if (clone.forkUpstream.outcome === "uncertain") effects.uncertain.push(`fork:${clone.forkUpstream.target}`);
      if (clone.outcome === "skipped" && clone.reason === "cancelled") effects.pending.push(`sync:${clone.commonDir}`);
    }
  }
  if (operation && !operation.steps.length && status === "succeeded") {
    if (input.command[0] === "api") effects.uncertain.push("command_effects");
    else if (!effects.completed.length && !effects.uncertain.length) effects.completed.push("command");
  }
  const code = status === "partially_completed" ? "partial_completion" : issue?.code ?? (status === "cancelled" ? "cancelled" : status === "needs_input" ? "missing_input" : "operation_failed");
  const failed = ["failed", "partially_completed", "cancelled", "needs_input"].includes(status);
  if (failed && !bulkSync && !effects.uncertain.length && !["invalid_arguments", "missing_input", "confirmation_required", "authentication_required", "provider_unavailable"].includes(code)) effects.uncertain.push("command_effects");
  return {
    contract: "ggh.agent", version: 1, command: input.command, status,
    ...(input.result !== undefined ? { result: input.result } : {}),
    ...(failed ? { error: { code, message: issue?.message ?? "Command did not complete.", retryability: ["invalid_arguments", "missing_input", "confirmation_required", "authentication_required"].includes(code) ? "after_input" : "after_inspection" } satisfies AgentEnvelope["error"] } : {}),
    ...(issue?.requiredInputs ? { requiredInputs: issue.requiredInputs } : {}),
    ...(path === "status" && !operation && !Object.values(effects).some(items => items.length) ? {} : { effects }),
    ...(operation ? { operationId: operation.id, resources: operation.resources } : workflow && result ? { ...("operationId" in result && typeof result.operationId === "string" ? { operationId: result.operationId } : {}), ...("resources" in result ? { resources: strings(result.resources) } : {}) } : {}),
  };
}

function isProjectSyncResult(value: unknown): value is ProjectSyncResult {
  function object(row: unknown): row is Record<string, unknown> { return !!row && typeof row === "object" && !Array.isArray(row); }
  function outcome(row: Record<string, unknown>): boolean {
    return row.outcome === "up-to-date" || row.outcome === "updated" && typeof row.old === "string" && typeof row.new === "string"
      || row.outcome === "skipped" && typeof row.reason === "string" || ["failed", "uncertain"].includes(String(row.outcome)) && typeof row.message === "string";
  }
  return object(value) && value.schemaVersion === 1 && typeof value.cancelled === "boolean"
    && ["succeeded", "partially_completed", "failed", "cancelled", "no_op"].includes(String(value.status))
    && Array.isArray(value.clones) && value.clones.every((clone: unknown) => {
      if (!object(clone) || typeof clone.commonDir !== "string" || typeof clone.name !== "string") return false;
      if (!["updated", "up-to-date"].includes(String(clone.outcome)) && !outcome(clone)) return false;
      if (!Array.isArray(clone.fetches) || !clone.fetches.every((fetch: unknown) => object(fetch) && typeof fetch.remote === "string" && (fetch.outcome === "updated" || ["failed", "uncertain"].includes(String(fetch.outcome)) && typeof fetch.message === "string"))) return false;
      if (!Array.isArray(clone.checkouts) || !clone.checkouts.every((checkout: unknown) => object(checkout) && typeof checkout.path === "string" && (checkout.branch === null || typeof checkout.branch === "string") && outcome(checkout))) return false;
      const fork = clone.forkUpstream;
      return object(fork) && (fork.outcome === "skipped" && typeof fork.reason === "string" || typeof fork.target === "string" && (fork.outcome === "updated" || fork.outcome === "uncertain" && typeof fork.message === "string"));
    });
}

export const envelopeSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object", required: ["contract", "version", "command", "status"],
  allOf: [{ if: { properties: { command: { const: ["status"] } } }, else: { required: ["effects"] } }],
  properties: {
    contract: { const: "ggh.agent" }, version: { const: 1 }, command: { type: "array", items: { type: "string" } },
    status: { enum: ["succeeded", "planned", "no_op", "needs_input", "cancelled", "failed", "partially_completed"] },
    result: { description: "Command-specific payload. Detailed result schemas are not yet guaranteed." },
    error: { type: "object", required: ["code", "message", "retryability"], properties: { code: { enum: ["invalid_arguments", "missing_input", "confirmation_required", "authentication_required", "provider_unavailable", "cancelled", "partial_completion", "operation_failed", "outcome_uncertain"] }, message: { type: "string" }, retryability: { enum: ["after_input", "after_inspection", "never"] } } },
    requiredInputs: { type: "array", items: { type: "object", required: ["name", "description"], properties: { name: { type: "string" }, description: { type: "string" }, alternatives: { type: "array", items: { type: "string" } } } } },
    effects: { description: "Completed effects include explicit local mutations and launches, even when a later step fails. Review uses review_checkout_created/updated, review_objects_fetched, review_refs_updated and review_ledger_marked. Clone uses repository_cloned. Projects use projects_index_updated and projects_roots_updated/projects_exclusions_updated. Go launches use editor_opened/t3_opened. Single-repo sync uses refs_fetched_pruned and branch_deleted:<name>. Omitted only for read-only status when all arrays are empty; defaults to completed: [], pending: [], uncertain: [].", type: "object", required: ["completed", "pending", "uncertain"], properties: Object.fromEntries(["completed", "pending", "uncertain"].map(key => [key, { type: "array", items: { type: "string" } }])) },
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
  steps: { type: "array", items: { type: "object", properties: { name: { type: "string" }, state: { enum: ["pending", "completed", "failed", "unknown", "skipped", "refused", "uncertain"] } } } },
  resources: stringArraySchema,
} };
const nullableIntegerSchema = { type: ["integer", "null"] };
const reviewCommentSchema = {
  type: "object", additionalProperties: false,
  required: ["id", "databaseId", "author", "body", "createdAt", "updatedAt", "url", "outdated"],
  properties: {
    id: { type: "string" }, databaseId: nullableIntegerSchema,
    author: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false, required: ["login"], properties: { login: { type: "string" } } }] },
    body: { type: "string" }, createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" },
    url: { type: "string" }, outdated: { type: "boolean" }, bodyTruncated: { const: true },
  },
};
export const reviewThreadsResultSchema = {
  type: "object", additionalProperties: false,
  required: ["schemaVersion", "number", "headSha", "baseSha", "threads", "cursor", "pagination"],
  properties: {
    schemaVersion: { const: 1 }, number: { type: "integer", minimum: 1 }, headSha: { type: "string" }, baseSha: { type: "string" },
    threads: { type: "array", items: {
      type: "object", additionalProperties: false,
      required: ["id", "isResolved", "isOutdated", "viewerCanResolve", "viewerCanUnresolve", "path", "line", "originalLine", "startLine", "diffSide", "comments"],
      properties: {
        id: { type: "string" }, isResolved: { type: "boolean" }, isOutdated: { type: "boolean" },
        viewerCanResolve: { type: "boolean" }, viewerCanUnresolve: { type: "boolean" }, path: { type: "string" },
        line: nullableIntegerSchema, originalLine: nullableIntegerSchema, startLine: nullableIntegerSchema,
        diffSide: { enum: ["LEFT", "RIGHT"] }, comments: { type: "array", items: reviewCommentSchema },
      },
    } },
    cursor: { type: ["string", "null"], description: "Maximum comment updatedAt read, including filtered threads. Reuse as --since only when pagination.complete is true." },
    pagination: { type: "object", additionalProperties: false, required: ["complete", "threads", "comments"], properties: {
      complete: { type: "boolean", description: "False when the 200-request cap or a repeated cursor stops pagination." },
      threads: { type: "integer", minimum: 0, description: "Threads fetched before filters." },
      comments: { type: "integer", minimum: 0, description: "Comments fetched before filters." },
    } },
  },
};
const truncationSchema = { type: "object", additionalProperties: false, required: ["bytesTotal", "bytesShown"], properties: {
  bytesTotal: { type: "integer", minimum: 0 }, bytesShown: { type: "integer", minimum: 0 },
} };
export const ciEvidenceResultSchema = {
  type: "object", additionalProperties: false,
  required: ["schemaVersion", "headSha", "runs", "failures", "unavailable"],
  properties: {
    schemaVersion: { const: 1 }, headSha: { type: "string" },
    pr: { type: "object", additionalProperties: false, required: ["number", "url"], properties: { number: { type: "integer" }, url: { type: "string" } } },
    runs: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "url", "workflow", "conclusion", "sha", "stale"], properties: {
      id: { type: "integer" }, url: { type: "string" }, workflow: { type: "string" }, conclusion: { type: "string" }, sha: { type: "string" }, stale: { type: "boolean" },
    } } },
    failures: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["job", "step", "url", "annotations", "evidence", "logSource", "truncated", "annotationsTruncated"], properties: {
        job: { type: "string" }, step: { type: "string" }, url: { type: "string" },
        logSource: { enum: ["failed-step", "full-job"] }, truncated: truncationSchema, annotationsTruncated: truncationSchema,
        annotations: { type: "array", items: { type: "object", additionalProperties: false, required: ["path", "startLine", "endLine", "level", "title", "message", "rawDetails"], properties: {
          path: { type: "string" }, startLine: { type: "integer" }, endLine: { type: "integer" }, level: { type: "string" }, title: { type: "string" }, message: { type: "string" }, rawDetails: { type: "string" },
        } } },
        evidence: { type: "array", items: { type: "object", additionalProperties: false, required: ["line", "text"], properties: { line: { type: "integer", minimum: 1 }, text: { type: "string" } } } },
      },
    } },
    unavailable: { type: "array", items: { type: "object", additionalProperties: false, required: ["source", "reason"], properties: {
      source: { type: "string" }, reason: { type: "string" }, runId: { type: "integer" }, job: { type: "string" },
    } } },
  },
};
export const reviewResultSchema = {
  type: "object", additionalProperties: false,
  required: ["schemaVersion", "pr", "headSha", "baseSha", "checkoutPath", "surface"],
  properties: {
    schemaVersion: { const: 1 },
    pr: { type: "object", additionalProperties: false, required: ["number", "url", "host", "owner", "repo"], properties: {
      number: { type: "integer", minimum: 1 }, url: { type: "string" }, host: { type: "string" }, owner: { type: "string" }, repo: { type: "string" },
    } },
    headSha: { type: "string" }, baseSha: { type: "string" }, checkoutPath: { type: "string" },
    surface: { enum: ["editor", "tuicr", "delta", "renderer", "data"] }, marked: { const: true },
    since: { type: "object", additionalProperties: false, required: ["fromHead", "rewritten", "commits", "files", "threadsChanged"], properties: {
      fromHead: { type: "string" }, rewritten: { type: "boolean" }, files: stringArraySchema,
      commits: { type: "array", items: { type: "object", additionalProperties: false, required: ["sha", "subject"], properties: { sha: { type: "string" }, subject: { type: "string" } } } },
      threadsChanged: reviewThreadsResultSchema, rangeDiff: { type: "string" }, ambiguity: { type: "string" },
    } },
  },
};
export const coreResultSchemas = {
  agentSkill: { commandPaths: [["agent", "skill"]], schema: { type: "object", required: ["schemaVersion"], properties: {
    schemaVersion: { const: 1 }, skill: { type: "string", description: "Skill Markdown when printing." },
    guidance: { type: "string", description: "T3 provider-directory instructions. No files are installed." },
    target: { type: "string", description: "Absolute destination skill directory." },
    files: stringArraySchema, writes: { ...stringArraySchema, description: "Files that would change during a dry run." },
    unchanged: { const: true, description: "All bundled files already match; no writes performed." },
  } } },
  tidy: { commandPaths: [["tidy"]], schema: tidyResultSchema },
  lost: { commandPaths: [["lost"]], schema: lostResultSchema },
  review: { commandPaths: [["review"]], schema: reviewResultSchema },
  sync: { commandPaths: [["sync"]], schema: { anyOf: [projectSyncResultSchema,
    { type: "object", required: ["schemaVersion", "query", "candidates"], properties: { schemaVersion: { const: 1 }, query: { type: "string" }, candidates: { type: "array", items: { type: "object", required: ["name", "paths"], properties: { name: { type: "string" }, paths: stringArraySchema } } } } },
    { type: "object", required: ["currentBranch", "goneBranches", "deletedCount"], properties: { currentBranch: { type: "string" }, goneBranches: stringArraySchema, deletedCount: { type: "integer", minimum: 0 } } },
    { type: "object", required: ["status", "reason"], properties: { status: { const: "no_op" }, reason: { const: "no_remotes" } } },
  ] } },
  ciWhy: { commandPaths: [["ci", "why"]], schema: ciEvidenceResultSchema },
  projects: { commandPaths: [["projects"]], includesSubcommands: true, schema: projectsResultSchema },
  go: { commandPaths: [["go"]], schema: { type: "object", required: ["schemaVersion"], properties: { schemaVersion: { const: 1 }, path: { type: "string" }, target: { enum: ["cd", "editor", "t3"] }, query: { type: "string" }, candidates: { type: "array", items: { type: "object" } } }, anyOf: [{ required: ["path", "target"] }, { required: ["query", "candidates"] }] } },
  coverage: "Partial field schemas. Optional fields vary by outcome. Other command result payloads are not yet specified.",
  status: { commandPaths: [["status"]], schema: { type: ["object", "null"], description: "Agent result only. Null outside a repository. Legacy --json retains result.repository with explicit counts.", required: ["branch", "head"], properties: {
    root: { type: "string", description: "Absolute checkout root. Omitted only when equal to the invocation cwd." },
    branch: { type: ["string", "null"], description: "Null means detached HEAD." },
    head: { type: ["string", "null"], description: "Full HEAD object ID; null for an unborn branch." },
    upstream: { type: ["string", "null"], default: null },
    ...Object.fromEntries(["ahead", "behind", "staged", "unstaged", "untracked", "conflicts"].map(key => [key, { type: "integer", minimum: 0, default: 0 }])),
    operation: { enum: [null, "rebase", "merge", "cherry-pick", "revert", "sequencer", "bisect"], default: null },
    changes: { type: "array", items: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 3 }, default: [], description: "[xy, path], or [xy, path, origPath] for renames/copies. XY uses porcelain-v2 index/worktree codes, dots mean unchanged, ?? means untracked. Unmerged codes DD/AU/UD/UA/DU/AA/UU flag conflicts. Paths are unquoted and relative to root." },
    submodules: { type: "array", items: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 }, default: [], description: "[path, S<c><m><u>] for changed submodules. C means changed commit, M tracked modifications, U untracked content; dots mean unchanged." },
    rawChanges: { type: "array", items: { type: "string" }, description: "Only with --full: lossless porcelain-v2 -z records without headers or trailing NUL. Rename source is the next element. Includes modes, object IDs and conflict stages." },
    base: { type: ["string", "null"], default: null, description: "Explicit gh-merge-base, or null when none is recorded." },
    push: { type: ["string", "null"], description: "Publish target. Omitted when equal to upstream; null means no destination." },
    fetchedAt: { type: ["string", "null"], default: null, description: "Local FETCH_HEAD mtime in ISO 8601; not proof of remote freshness. No network probe." },
    pullRequest: { type: ["object", "null"] }, github: { type: "object" }, ai: { type: "object" },
  } } },
  run: { commandPaths: [["run"]], schema: { anyOf: [{ type: "array", items: { type: "object" } }, { type: "object", required: ["run", "jobs", "log", "logStatus"], properties: {
    run: { type: "object", not: { required: ["jobs"] } }, jobs: { type: "array", items: { type: "object" } }, log: { type: ["string", "null"] },
    logStatus: { enum: ["available", "unavailable", "not_applicable"] }, logError: { type: "string" },
  } }] } },
  merge: { commandPaths: [["pr", "merge"]], schema: { type: "object", required: ["number", "action", "outcome"], properties: {
    number: { type: "integer" }, action: { const: "merge" }, outcome: { enum: ["merged", "queued", "auto_merge_enabled", "unknown"] },
    url: { type: "string" }, cleanupError: { type: "string" },
  } } },
  publication: { commandPaths: [["repo", "create"], ["pr", "create"], ["commit"]], schema: workflowResultSchema },
  stack: { commandPaths: [["stack"]], includesSubcommands: true, schema: { anyOf: [workflowResultSchema, { type: "array", items: { type: "object", additionalProperties: true, properties: { branch: { type: "string" }, parent: { type: ["string", "null"] }, ahead: { type: "number" }, behind: { type: "number" } } } }] } },
  operationList: { commandPaths: [["operation", "list"]], schema: { type: "array", items: operationResultSchema } },
  operationView: { commandPaths: [["operation", "view"]], schema: operationResultSchema },
  reviewThreads: { commandPaths: [["pr", "threads"]], schema: reviewThreadsResultSchema },
  clone: { commandPaths: [["clone"]], version: 1, schema: {
    anyOf: [
      { type: "object", required: ["version", "destination", "repo", "mode", "protocol", "fallbackUsed", "alreadyCloned"], properties: {
        version: { const: 1 }, destination: { type: "string" }, repo: { type: "string" },
        mode: { enum: ["standard", "blobless", "shallow"] }, protocol: { enum: ["ssh", "https", "http", "git", "file"] },
        fallbackUsed: { type: "boolean" }, alreadyCloned: { type: "boolean" }, status: { enum: ["no_op", "failed", "cancelled"] },
      } },
      { type: "object", required: ["version", "candidates"], properties: {
        version: { const: 1 }, candidates: { type: "array", items: { type: "object", required: ["repo", "destination"], properties: { repo: { type: "string" }, destination: { type: "string" } } } },
      } },
    ],
  } },
};
