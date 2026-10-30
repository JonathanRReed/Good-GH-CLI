import { lostResultSchema, tidyResultSchema } from "./projects/tidy-schema.ts";
import { projectsResultSchema } from "./projects/schema.ts";
import { inboxResultSchema } from "./inbox-schema.ts";
import { projectSyncResultSchema } from "./projects/sync-schema.ts";
import type { ProjectSyncResult } from "./projects/sync.ts";
import type { OperationRecord } from "./operations.ts";
import type { CommandIssue } from "./runtime.ts";
import type { CloneMode } from "./config.ts";
import type { CloneProtocol } from "./git/clone.ts";
import type { PushProtectionDetails } from "./git/push-protection.ts";

export interface CloneResult {
  version: 1;
  destination: string;
  repo: string;
  mode: CloneMode;
  protocol: CloneProtocol;
  fallbackUsed: boolean;
  alreadyCloned: boolean;
}

export type Retryability = "after_input" | "after_delay" | "after_inspection" | "never";
/**
 * One row per error code. `definitive` codes prove nothing changed, so a failed
 * mutation reports no uncertain effects. Add new codes here, one per line.
 */
export const AGENT_ERRORS = {
  invalid_arguments: { retryability: "after_input", definitive: true },
  missing_input: { retryability: "after_input", definitive: true },
  confirmation_required: { retryability: "after_input", definitive: true },
  authentication_required: { retryability: "after_input", definitive: true },
  not_found: { retryability: "after_input", definitive: false },
  forbidden: { retryability: "never", definitive: false },
  rate_limited: { retryability: "after_delay", definitive: false },
  network: { retryability: "after_delay", definitive: false },
  precondition_failed: { retryability: "after_inspection", definitive: true },
  provider_unavailable: { retryability: "after_inspection", definitive: true },
  cancelled: { retryability: "after_inspection", definitive: false },
  partial_completion: { retryability: "after_inspection", definitive: false },
  operation_failed: { retryability: "after_inspection", definitive: false },
  outcome_uncertain: { retryability: "after_inspection", definitive: false },
  push_protection_blocked: { retryability: "never", definitive: true },
} as const satisfies Record<string, { retryability: Retryability; definitive: boolean }>;
export type AgentErrorCode = keyof typeof AGENT_ERRORS;
export type RequiredInput = { name: string; description: string; alternatives?: string[] };
export type AgentStatus = "succeeded" | "planned" | "no_op" | "needs_input" | "cancelled" | "failed" | "partially_completed";
export interface AgentEnvelope {
  contract: "ggh.agent";
  version: 1;
  command: string[];
  status: AgentStatus;
  result?: unknown;
  error?: { code: AgentErrorCode; message: string; retryability: Retryability; retryAfterSeconds?: number; pushProtection?: PushProtectionDetails };
  requiredInputs?: RequiredInput[];
  effects?: { completed: string[]; pending: string[]; uncertain: string[] };
  operationId?: string;
  resources?: string[];
}

/**
 * `mutating: false` marks a read: its failure cannot have changed anything, so no
 * uncertain effects are reported. Unknown (undefined) is treated as mutating.
 */
export function agentEnvelope(input: { command: string[]; result?: unknown; issue?: CommandIssue; operation?: OperationRecord; failed: boolean; dryRun: boolean; preview: readonly string[]; completedEffects?: readonly string[]; uncertainEffects?: readonly string[]; mutating?: boolean }): AgentEnvelope {
  const { operation, issue } = input;
  const path = input.command.join(" ");
  const result = typeof input.result === "object" && input.result !== null && !Array.isArray(input.result) ? input.result : undefined;
  const bulkSync = path === "sync" && isProjectSyncResult(input.result) ? input.result : undefined;
  const workflow = Boolean(bulkSync) || path === "tidy" || path === "commit" || path === "pr create" || path === "repo create" || path.startsWith("stack ");
  const noOp = ["clone", "worktree remove", "worktree prune", "rename", "undo", "discard", "sync", "squash", "operation resume", "issue plan"].includes(path);
  const managedStatus = result && "status" in result && ((workflow && ["partially_completed", "needs_input", "cancelled", "failed", "succeeded", "no_op"].includes(String(result.status))) || (noOp && result.status === "no_op")) ? result.status : undefined;
  const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

  // Only journal state and explicit boundary metadata describe workflow outcomes.
  let status: AgentStatus = operation?.status.state === "running" ? "failed" : operation?.status.state ?? (issue?.status ?? (input.failed ? "failed" : input.dryRun ? "planned" : "succeeded"));
  if (managedStatus === "partially_completed" || managedStatus === "needs_input" || managedStatus === "cancelled" || managedStatus === "failed" || managedStatus === "no_op") status = managedStatus;
  if (input.dryRun && !issue && !input.failed) status = "planned";
  const blocked = issue?.code === "push_protection_blocked";
  const effects = {
    completed: operation?.steps.filter(step => step.state === "completed").map(step => step.name) ?? (workflow && result && "completed" in result ? strings(result.completed) : []),
    pending: operation?.steps.filter(step => step.state === "pending").map(step => step.name) ?? (workflow && result && "remaining" in result ? strings(result.remaining) : input.preview.length ? ["command_effects"] : []),
    uncertain: operation?.steps.filter(step => step.state === "unknown" || (step.state === "failed" && !blocked) || step.state === "uncertain").map(step => step.name) ?? (path === "tidy" && result && "uncertain" in result ? strings(result.uncertain) : []),
  };
  // A push-protection rejection is definitive: the blocked push did not happen.
  if (blocked && operation) effects.pending.push(...operation.steps.filter(step => step.state === "failed").map(step => step.name));
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
  // Rerunning review at the same head changes nothing.
  if (path === "review" && status === "succeeded" && result && "checkout" in result && result.checkout === "reused" && !effects.completed.length && !effects.uncertain.length) status = "no_op";
  let code: AgentErrorCode = blocked ? "push_protection_blocked" : status === "partially_completed" ? "partial_completion" : issue?.code ?? (status === "cancelled" ? "cancelled" : status === "needs_input" ? "missing_input" : "operation_failed");
  // needs_input always names what to supply; asking codes without inputs are plain failures.
  const requiredInputs = issue?.requiredInputs?.length ? issue.requiredInputs : undefined;
  const asks = code === "missing_input" || code === "confirmation_required";
  if (status === "failed" && asks && requiredInputs) status = "needs_input";
  if (status === "needs_input" && !(asks && requiredInputs)) {
    status = "failed";
    if (asks) code = "invalid_arguments";
  }
  const failed = ["failed", "partially_completed", "cancelled", "needs_input"].includes(status);
  if (failed && !bulkSync && !effects.uncertain.length && !AGENT_ERRORS[code].definitive && input.mutating !== false) effects.uncertain.push("command_effects");
  // Waiting cannot settle an uncertain mutation; inspect it first.
  const retryability: Retryability = AGENT_ERRORS[code].retryability === "after_delay" && effects.uncertain.length ? "after_inspection" : AGENT_ERRORS[code].retryability;
  effects.pending = [...new Set(effects.pending)];
  return {
    contract: "ggh.agent", version: 1, command: input.command, status,
    ...(input.result !== undefined ? { result: input.result } : {}),
    ...(failed ? { error: { code, message: issue?.message ?? "Command did not complete.", retryability, ...(code === "rate_limited" && issue?.retryAfterSeconds !== undefined ? { retryAfterSeconds: issue.retryAfterSeconds } : {}), ...(issue?.pushProtection ? { pushProtection: issue.pushProtection } : {}) } satisfies AgentEnvelope["error"] } : {}),
    ...(status === "needs_input" && requiredInputs ? { requiredInputs } : {}),
    ...((path === "status" || path === "agent brief") && !operation && !Object.values(effects).some(items => items.length) ? {} : { effects }),
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

const stringArraySchema = { type: "array", items: { type: "string" } };
export const envelopeSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object", required: ["contract", "version", "command", "status"],
  allOf: [{ if: { properties: { command: { enum: [["status"], ["agent", "brief"]] } } }, else: { required: ["effects"] } }],
  properties: {
    contract: { const: "ggh.agent" }, version: { const: 1 }, command: { type: "array", items: { type: "string" } },
    status: { enum: ["succeeded", "planned", "no_op", "needs_input", "cancelled", "failed", "partially_completed"] },
    result: { description: "Command-specific payload. Detailed result schemas are not yet guaranteed." },
    error: { type: "object", required: ["code", "message", "retryability"], properties: {
      code: { enum: Object.keys(AGENT_ERRORS), description: "not_found: the named PR, issue, repository or plan does not exist or is hidden. forbidden: the account lacks permission; a person must grant access. rate_limited: GitHub throttled the request. network: GitHub or the proxy was unreachable. precondition_failed: local or remote state blocks the command before any effect, such as nothing staged or a stale base; fix the state the message names, then retry. invalid_arguments also covers running a checkout command outside a Git repository. push_protection_blocked: GitHub push protection found a secret in the pushed commits and the push did not happen; stop and report pushProtection to the user." },
      message: { type: "string", description: "Human-readable cause and next step. Never contains raw GraphQL response bodies." },
      retryability: { enum: ["after_input", "after_delay", "after_inspection", "never"], description: "after_input: retry only with changed or added input. after_delay: nothing changed; retry the same command after waiting (retryAfterSeconds when known). after_inspection: inspect effects and state before any retry. never: retrying the same inputs cannot succeed; report to the user." },
      retryAfterSeconds: { type: "integer", minimum: 0, description: "Present only with rate_limited when GitHub reported a reset time." },
      pushProtection: { type: "object", required: ["findings", "bypassUrls", "remoteLines"], description: "Present only with push_protection_blocked. Fields GitHub did not report are omitted.", properties: {
        findings: { type: "array", items: { type: "object", properties: { secretType: { type: "string" }, commit: { type: "string" }, path: { type: "string" }, line: { type: "integer", minimum: 1 } } } },
        bypassUrls: { ...stringArraySchema, description: "GitHub bypass pages for a person to judge. Agents must never open or follow them." },
        remoteLines: { ...stringArraySchema, description: "Raw remote lines without the remote: prefix, kept when parsing is incomplete." },
      } },
    } },
    requiredInputs: { type: "array", minItems: 1, description: "Present exactly when status is needs_input, whose code is then missing_input or confirmation_required. Names are flags (--yes, -m) or positional arguments (file).", items: { type: "object", required: ["name", "description"], properties: { name: { type: "string" }, description: { type: "string" }, alternatives: { type: "array", items: { type: "string" } } } } },
    effects: { description: "Completed effects include explicit local mutations and launches, even when a later step fails. Review uses review_checkout_created/updated, review_objects_fetched, review_refs_updated and review_ledger_marked. Clone uses repository_cloned. Projects use projects_index_updated and projects_roots_updated/projects_exclusions_updated. Go launches use editor_opened/t3_opened. Single-repo sync uses refs_fetched_pruned and branch_deleted:<name>. A failed read never reports uncertain effects; a push blocked by push protection stays pending, never uncertain; command_effects in uncertain means a mutating command stopped without proof of what changed. Omitted only for read-only status and agent brief when all arrays are empty; defaults to completed: [], pending: [], uncertain: [].", type: "object", required: ["completed", "pending", "uncertain"], properties: Object.fromEntries(["completed", "pending", "uncertain"].map(key => [key, { type: "array", items: { type: "string" } }])) },
    operationId: { type: "string" }, resources: { type: "array", items: { type: "string" } },
  },
};


const workflowResultSchema = { type: "object", additionalProperties: true, properties: {
  status: { type: "string" }, target: { type: "string" }, completed: stringArraySchema, remaining: stringArraySchema,
  failed: { ...stringArraySchema, description: "Remaining steps that definitively did not happen, such as a push blocked by push protection." },
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
    headSha: { type: "string" }, baseSha: { type: "string" }, checkoutPath: { type: "string", description: "Always under the main clone's .worktrees, even when run from a linked worktree." },
    checkout: { enum: ["created", "updated", "reused"], description: "reused: the checkout was already at headSha; with no other effect the envelope status is no_op." },
    surface: { enum: ["editor", "tuicr", "delta", "renderer", "data"] }, marked: { const: true },
    since: { type: "object", additionalProperties: false, required: ["fromHead", "rewritten", "commits", "files", "threadsChanged"], properties: {
      fromHead: { type: "string" }, rewritten: { type: "boolean" }, files: stringArraySchema,
      commits: { type: "array", items: { type: "object", additionalProperties: false, required: ["sha", "subject"], properties: { sha: { type: "string" }, subject: { type: "string" } } } },
      threadsChanged: reviewThreadsResultSchema, rangeDiff: { type: "string" }, ambiguity: { type: "string" },
    } },
  },
};
const briefNotRead = (description: string) => ({ type: "object", additionalProperties: false, required: ["state", "reason"], description, properties: { state: { enum: ["unavailable", "skipped"] }, reason: { type: "string" } } });
const briefNone = { type: "object", additionalProperties: false, required: ["state"], properties: { state: { const: "none" } } };
const briefNotReadDescription = "unavailable: the read failed or missed the deadline. skipped: not attempted because of --local, a detached HEAD, or no readable branch PR.";
const briefAvailable = (required: string[], properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: ["state", ...required], properties: { state: { const: "available" }, ...properties } });
export const agentBriefResultSchema = {
  type: "object", additionalProperties: false,
  required: ["schemaVersion", "checkout", "pullRequest", "ci", "reviewThreads", "linkedIssues", "stack"],
  properties: {
    schemaVersion: { const: 1 },
    checkout: { type: "object", additionalProperties: false, required: ["root", "branch", "head", "upstream", "ahead", "behind", "unpublished", "aheadOfDefault", "staged", "unstaged", "untracked", "conflicts"], description: "Local and always read. Same porcelain-v2 parse as status --agent, with explicit counts. No network.", properties: {
      root: { type: "string" }, branch: { type: ["string", "null"], description: "Null means detached HEAD." },
      head: { type: ["string", "null"], description: "Full HEAD object ID; null for an unborn branch." }, upstream: { type: ["string", "null"] },
      ahead: { type: ["integer", "null"], minimum: 0, description: "Null without an upstream; use unpublished then." }, behind: { type: ["integer", "null"], minimum: 0, description: "Null without an upstream." },
      unpublished: { type: ["integer", "null"], minimum: 0, maximum: 1000, description: "Commits on HEAD that no remote-tracking ref contains, including a detached HEAD's own commits. Counts stop at 1000. Local refs only; fetch for freshness." },
      aheadOfDefault: { type: ["integer", "null"], minimum: 0, maximum: 1000, description: "Commits on HEAD not on the remote default branch (refs/remotes/<remote>/HEAD). Counts stop at 1000. Null when no remote HEAD is recorded." },
      ...Object.fromEntries(["staged", "unstaged", "untracked", "conflicts"].map(key => [key, { type: "integer", minimum: 0 }])),
      operation: { enum: ["rebase", "merge", "cherry-pick", "revert", "sequencer", "bisect"], description: "Omitted when no operation is in progress." },
      stackOperation: { type: "object", additionalProperties: false, required: ["mode", "selected", "operationId"], description: "An unfinished ggh stack restack or submit. A restack stopped on a conflict resumes with ggh stack restack --continue or rolls back with --abort.", properties: {
        mode: { enum: ["restack", "submit"] }, selected: { type: "string" }, operationId: { type: "string" },
      } },
    } },
    pullRequest: { anyOf: [briefAvailable(["number", "url", "prState", "draft", "headSha", "base", "reviewDecision", "mergeable", "headMatchesLocal"], {
      number: { type: "integer", minimum: 1 }, url: { type: "string" }, prState: { type: "string", description: "GitHub state: OPEN, CLOSED or MERGED." },
      draft: { type: "boolean" }, headSha: { type: "string" }, base: { type: "string" }, reviewDecision: { type: ["string", "null"] },
      mergeable: { type: "string" }, headMatchesLocal: { type: "boolean", description: "PR head equals the local full HEAD. False can mean unpushed or unpulled commits." },
    }), { ...briefNone, description: "The branch has no pull request." }, briefNotRead(briefNotReadDescription)] },
    ci: { anyOf: [briefAvailable(["total", "counts", "failing"], {
      total: { type: "integer", minimum: 0 }, counts: { type: "object", additionalProperties: { type: "integer", minimum: 1 }, description: "Non-zero check counts by gh bucket: pass, fail, pending, skipping, cancel." },
      failing: { ...stringArraySchema, description: "Names of failed and cancelled checks. Logs are not fetched; use ggh ci why." },
    }), briefNotRead(briefNotReadDescription)] },
    reviewThreads: { anyOf: [briefAvailable(["unresolved"], {
      unresolved: { type: "integer", minimum: 0 }, complete: { const: false, description: "Present when pagination stopped early; unresolved is then a lower bound." },
    }), briefNotRead(briefNotReadDescription)] },
    linkedIssues: { anyOf: [briefAvailable(["items"], {
      items: { type: "array", description: "Issues the PR closes, from closingIssuesReferences. At most 10.", items: { type: "object", additionalProperties: false, required: ["number", "artifacts"], properties: {
        number: { type: "integer", minimum: 1 }, repo: { type: "string", description: "OWNER/REPO, present only for issues in another repository." },
        artifacts: { anyOf: [briefAvailable(["items"], { items: { type: "array", items: { type: "object", additionalProperties: false, required: ["number", "name", "type"], properties: { number: { type: "integer" }, name: { type: "string" }, type: { type: "string" } } } } }), briefNotRead("unavailable: the artifact read failed. skipped: the issue is in another repository.")] },
      } } },
      more: { type: "integer", minimum: 1, description: "Linked issues beyond the first 10." },
    }), briefNotRead(briefNotReadDescription)] },
    stack: { anyOf: [briefAvailable(["number", "position", "size", "below"], {
      number: { type: "integer" }, position: { type: "integer", minimum: 1, description: "1-based position from the bottom of the stack." }, size: { type: "integer", minimum: 1 },
      below: { type: "array", description: "PRs below this one, bottom first. Merging this PR merges every unmerged PR below it.", items: { type: "object", additionalProperties: false, required: ["number", "prState"], properties: { number: { type: "integer" }, prState: { type: "string" } } } },
    }), { ...briefNone, description: "The PR is not in a GitHub native stack." }, briefNotRead(briefNotReadDescription)] },
    next: { ...stringArraySchema, description: "Suggested follow-up commands, such as ggh ci why, ggh pr threads, ggh pr create --dry-run for unpublished work, or ggh stack restack --continue/--abort for a stopped restack. Data, not permission to mutate." },
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
  agentBrief: { commandPaths: [["agent", "brief"]], schema: agentBriefResultSchema },
  tidy: { commandPaths: [["tidy"]], schema: tidyResultSchema },
  lost: { commandPaths: [["lost"]], schema: lostResultSchema },
  review: { commandPaths: [["review"]], schema: reviewResultSchema },
  inbox: { commandPaths: [["inbox"]], schema: inboxResultSchema },
  sync: { commandPaths: [["sync"]], schema: { anyOf: [projectSyncResultSchema,
    { type: "object", required: ["schemaVersion", "query", "candidates"], properties: { schemaVersion: { const: 1 }, query: { type: "string" }, candidates: { type: "array", items: { type: "object", required: ["name", "paths"], properties: { name: { type: "string" }, paths: stringArraySchema } } } } },
    { type: "object", required: ["currentBranch", "goneBranches", "deletedCount"], properties: { currentBranch: { type: "string" }, goneBranches: stringArraySchema, deletedCount: { type: "integer", minimum: 0 } } },
    { type: "object", required: ["status", "reason"], properties: { status: { const: "no_op" }, reason: { const: "no_remotes" } } },
  ] } },
  ciWhy: { commandPaths: [["ci", "why"]], schema: ciEvidenceResultSchema },
  projects: { commandPaths: [["projects"]], includesSubcommands: true, schema: projectsResultSchema },
  go: { commandPaths: [["go"]], schema: { type: "object", required: ["schemaVersion"], properties: { schemaVersion: { const: 1 }, path: { type: "string" }, target: { enum: ["cd", "editor", "t3"] }, query: { type: "string" }, candidates: { type: "array", items: { type: "object" } } }, anyOf: [{ required: ["path", "target"] }, { required: ["query", "candidates"] }] } },
  coverage: "Partial field schemas. Optional fields vary by outcome. Other command result payloads are not yet specified.",
  status: { commandPaths: [["status"]], schema: { type: "object", description: "Agent result only. Outside a repository, status --agent fails with invalid_arguments. Legacy --json retains result.repository with explicit counts, null outside a repository.", required: ["branch", "head"], properties: {
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
