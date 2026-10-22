const strings = { type: "array", items: { type: "string" } };
const nullableString = { type: ["string", "null"] };
const count = { type: "integer", minimum: 0 };
function field(value: object) {
  return { oneOf: [
    { type: "object", required: ["state", "value", "observedAt"], properties: { state: { const: "ok" }, value, observedAt: { type: "string", format: "date-time" } } },
    { type: "object", required: ["state", "reason"], properties: { state: { const: "unknown" }, reason: { type: "string" } } },
    { type: "object", required: ["state", "message"], properties: { state: { const: "error" }, message: { type: "string" } } },
  ] };
}
const remote = { anyOf: [{ type: "null" }, { type: "object", required: ["host", "owner", "name"], properties: { host: { type: "string" }, owner: { type: "string" }, name: { type: "string" } } }] };
const commit = { type: "object", required: ["oid", "subject", "committedAt"], properties: { oid: { type: "string" }, subject: { type: "string" }, committedAt: { type: "string", format: "date-time" } } };
const checkout = {
  type: "object", required: ["path", "gitDir", "branch", "head", "bare", "locked", "prunable", "createdBy", "hostClaims", "dirty", "upstream", "operation"],
  properties: {
    path: { type: "string" }, gitDir: { type: "string" }, branch: nullableString, head: nullableString, bare: { type: "boolean" },
    locked: { type: ["object", "null"], properties: { reason: { type: "string" } } }, prunable: { type: ["object", "null"], properties: { reason: { type: "string" } } },
    createdBy: { enum: ["ggh", "t3", "cursor", "claude", "codex", "unknown"] }, hostClaims: { type: "array", items: { type: "object", required: ["host", "evidence"], properties: { host: { enum: ["t3", "cursor", "claude", "codex"] }, evidence: { type: "string" } } } },
    dirty: field({ type: "object", required: ["staged", "unstaged", "untracked", "conflicted"], properties: { staged: count, unstaged: count, untracked: count, conflicted: count } }),
    upstream: field({ type: ["object", "null"], required: ["name", "ahead", "behind", "fetchedAt"], properties: { name: { type: "string" }, ahead: count, behind: count, fetchedAt: nullableString } }),
    operation: field({ enum: [null, "merge", "rebase", "cherry-pick", "revert", "bisect"] }),
  },
};
const project = {
  type: "object", required: ["commonDir", "name", "primary", "remotes", "lastSeen", "checkouts", "stashes", "newestStash", "unpublished", "mergedBranches", "lastCommit"],
  properties: {
    commonDir: { type: "string" }, name: { type: "string" }, primary: remote, lastSeen: { type: "string" }, missing: { type: "boolean" },
    remotes: { type: "array", items: { type: "object", required: ["name", "url", "repo"], properties: { name: { type: "string" }, url: { type: "string" }, repo: remote } } },
    checkouts: { type: "array", items: checkout }, stashes: field(count), newestStash: field(nullableString), mergedBranches: field(strings), lastCommit: field({ anyOf: [{ type: "null" }, commit] }),
    unpublished: field({ type: "array", items: { type: "object", required: ["ref", "commits"], properties: { ref: { type: "string" }, commits: count } } }),
  },
};
export const projectsResultSchema = {
  type: "object", required: ["schemaVersion"], properties: {
    schemaVersion: { const: 1 }, updatedAt: { type: "string" },
    projects: { type: "array", items: project }, project,
    history: { type: "object", required: ["recent", "unpublished"], properties: { recent: field({ type: "array", items: commit }), unpublished: field({ type: "array", items: commit }) } },
    coverage: { type: "object", required: ["roots", "skipped", "truncated"], properties: { roots: strings, truncated: { type: "boolean" }, skipped: { type: "array", items: { type: "object", required: ["path", "reason"], properties: { path: { type: "string" }, reason: { type: "string" } } } } } },
    query: { type: "string" }, candidates: { type: "array", items: { type: "object", required: ["name", "paths"], properties: { name: { type: "string" }, paths: strings, primary: remote } } }, suggestion: strings,
    roots: strings, registered: { type: "string" }, excluded: { type: "string" },
  },
  anyOf: [{ required: ["projects", "updatedAt", "coverage"] }, { required: ["project", "history", "updatedAt", "coverage"] }, { required: ["query", "candidates"] }, { required: ["roots"] }, { required: ["registered"] }, { required: ["excluded"] }],
};
