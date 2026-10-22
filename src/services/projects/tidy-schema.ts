const text = { type: "string" };
const nullableText = { type: ["string", "null"] };
const paths = { type: "array", items: text };
const ref = { type: "object", required: ["ref", "oid"], properties: { ref: text, oid: text } };
const creator = { enum: ["ggh", "t3", "claude", "cursor", "codex", "unknown"] };
const checkout = { type: "object", required: ["path", "gitDir", "branch", "head", "createdBy", "hostClaims"], properties: { path: text, gitDir: text, branch: nullableText, head: nullableText, createdBy: creator, hostClaims: { type: "array", items: { type: "object" } } } };
const notice = { type: "object", required: ["target", "reason"], properties: { target: text, reason: text } };
const proof = { type: "object", required: ["commonDir", "cloneIdentity", "refs", "remoteRefs", "stash"], properties: {
  commonDir: text, cloneIdentity: text, refs: { type: "array", items: ref }, remoteRefs: { type: "array", items: ref }, stash: text,
} };
export const tidyActionSchema = { type: "object", required: ["id", "kind", "proof"], properties: { id: text, proof }, oneOf: [
  ...["delete-local-branch", "delete-remote-branch"].map(kind => ({ required: ["branch", "tip", "integration", ...kind === "delete-remote-branch" ? ["destination", "login"] : []], properties: { kind: { const: kind }, branch: text, tip: text, integration: ref, destination: text, login: text } })),
  { required: ["checkout", "checkoutIdentity", "fileState", "allowIgnored", "allowUnknown", "integration"], properties: { kind: { const: "remove-checkout" }, checkout, checkoutIdentity: text, fileState: text, allowIgnored: { type: "boolean" }, allowUnknown: { type: "boolean" }, integration: { anyOf: [ref, { type: "null" }] } } },
  { required: ["entries", "registry", "expire", "dryRun"], properties: { kind: { const: "prune-worktree-metadata" }, entries: { type: "array", items: checkout }, registry: text, expire: text, dryRun: text } },
] };
export const lostResultSchema = { type: "object", required: ["schemaVersion", "clones", "items", "warnings"], properties: {
  schemaVersion: { const: 1 },
  clones: { type: "array", items: { type: "object", required: ["commonDir", "name", "fetchedAt", "uniqueCommits", "branches", "detachedHeads"], properties: {
    commonDir: text, name: text, fetchedAt: nullableText, uniqueCommits: { type: "integer", minimum: 0 }, branches: { type: "integer", minimum: 0 }, detachedHeads: { type: "integer", minimum: 0 },
  } } }, warnings: { type: "array", items: notice },
  items: { type: "array", items: { type: "object", required: ["kind", "commonDir", "path", "createdBy", "nextSteps"], properties: { commonDir: text, path: nullableText, createdBy: creator, nextSteps: { type: "array", items: paths } }, oneOf: [
    { required: ["branch", "head", "commits", "uniqueCommits", "sharedCommits", "newestSubject", "newestDate", "oldestDate"], properties: { kind: { const: "unpublished" }, branch: nullableText, head: text, commits: { type: "integer", minimum: 1 }, uniqueCommits: { type: "integer", minimum: 0 }, sharedCommits: { type: "integer", minimum: 0 }, newestSubject: text, newestDate: text, oldestDate: text } },
    { required: ["count", "stashes", "oldestDate"], properties: { kind: { const: "stash" }, count: { type: "integer", minimum: 1 }, oldestDate: text, stashes: { type: "array", items: { type: "object", required: ["ref", "oid", "date", "message"], properties: { ref: text, oid: text, date: text, message: text } } } } },
    { required: ["reason", "host"], properties: { kind: { const: "dirty-host-checkout" }, reason: text, host: text } },
    { required: ["reason"], properties: { kind: { const: "broken-gitdir" }, reason: text } },
  ] } },
} };
export const tidyResultSchema = { type: "object", required: ["schemaVersion", "plan", "lost", "status"], properties: {
  schemaVersion: { const: 1 }, status: { enum: ["planned", "needs_input", "no_op", "succeeded", "failed", "partially_completed", "cancelled"] }, lost: lostResultSchema,
  plan: { type: "object", required: ["schemaVersion", "snapshotId", "options", "clones"], properties: {
    schemaVersion: { const: 1 }, snapshotId: { type: "string", pattern: "^[a-f0-9]{64}$" },
    options: { type: "object", properties: { remoteBranches: { type: "boolean" }, allowIgnored: paths, allowUnknown: paths, staleDays: { type: "integer", minimum: 1 } } },
    clones: { type: "array", items: { type: "object", required: ["commonDir", "name", "fetchedAt", "actions", "kept", "hostManual", "hints"], properties: {
      commonDir: text, name: text, fetchedAt: nullableText, actions: { type: "array", items: tidyActionSchema }, kept: { type: "array", items: notice },
      hostManual: { type: "array", items: { ...notice, required: ["target", "reason", "host"], properties: { ...notice.properties, host: { enum: ["t3", "claude", "cursor", "codex"] } } } },
      hints: { type: "array", items: { ...notice, required: ["target", "reason", "kind"], properties: { ...notice.properties, kind: { enum: ["stale-repo", "gc-hint"] } } } },
    } } },
  } },
  outcomes: { type: "array", items: { type: "object", required: ["id", "kind", "commonDir", "state", "reason", "operationId"], properties: { id: text, kind: text, commonDir: text, state: { enum: ["completed", "skipped", "refused", "failed", "uncertain"] }, reason: text, operationId: text } } },
  completed: paths, remaining: paths, uncertain: paths,
} };
