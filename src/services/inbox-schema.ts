const strings = { type: "array", items: { type: "string" } };
const nullableString = { type: ["string", "null"] };
const pullRequest = {
  type: "object",
  required: ["repo", "number", "title", "url", "draft", "author", "updatedAt", "headRefName", "baseRefName", "checks", "reviewDecision", "mergeable", "mergeQueue", "reasons", "local", "next"],
  properties: {
    repo: { type: "string", description: "owner/name" }, number: { type: "integer", minimum: 1 }, title: { type: "string" }, url: { type: "string" },
    draft: { type: "boolean" }, author: nullableString, updatedAt: { type: "string", format: "date-time" }, headRefName: { type: "string" }, baseRefName: { type: "string" },
    defaultBranch: { ...nullableString, description: "Repository default branch, null when GitHub did not report it." },
    checks: { ...nullableString, description: "Head commit rollup. Null means no checks; UNKNOWN means GitHub did not return it." },
    reviewDecision: { ...nullableString, description: "Null means the base branch requires no review." },
    mergeable: { enum: ["MERGEABLE", "CONFLICTING", "UNKNOWN"] },
    mergeQueue: { anyOf: [{ type: "null" }, { type: "object", required: ["position"], properties: { position: { type: ["integer", "null"] } } }] },
    request: { type: "object", required: ["direct", "teams"], description: "Review requests only.", properties: { direct: { type: "boolean" }, teams: strings } },
    reasons: { type: "array", items: { enum: ["requested_directly", "requested_via_team", "checks_failing", "changes_requested", "conflicts", "merge_queue", "approved", "no_review_required", "checks_passing", "no_checks", "mergeable", "stacked"] } },
    stackedOn: { type: "integer", minimum: 1, description: "PR number this one is stacked on, present with the stacked reason." },
    local: { anyOf: [{ type: "null" }, { type: "object", required: ["name", "path", "branchCheckedOut", "clones"], properties: {
      name: { type: "string", description: "Argument for ggh go." }, path: { type: "string" }, branchCheckedOut: { type: "boolean" }, clones: { type: "integer", minimum: 1 },
    } }] },
    next: { type: "array", items: { type: "string" }, description: "Suggested shell commands, one per entry. Each is self-contained and works from any directory; ggh never runs them." },
  },
};
const section = { oneOf: [
  { type: "object", required: ["state", "total", "complete", "skipped", "items"], properties: {
    state: { const: "available" }, total: { type: "integer", minimum: 0 }, complete: { type: "boolean", description: "False when more PRs matched than were fetched, or some were hidden." },
    skipped: { type: "integer", minimum: 0 }, skippedReason: { type: "string" }, items: { type: "array", items: pullRequest },
  } },
  { type: "object", required: ["state", "reason"], properties: { state: { const: "unavailable" }, reason: { type: "string" }, retryAt: { type: "string", format: "date-time" } } },
] };

export const inboxResultSchema = {
  type: "object",
  required: ["schemaVersion", "host", "login", "filter", "limit", "sections", "waiting", "local", "requests", "cost"],
  properties: {
    schemaVersion: { const: 1 }, host: { type: "string" }, login: nullableString, filter: nullableString, limit: { type: "integer", minimum: 1, maximum: 50 },
    requestedLimit: { type: "integer", minimum: 1, description: "The --limit you asked for, present only when it exceeded the maximum of 50." },
    sections: { type: "object", required: ["reviewRequested", "needsFix", "readyToMerge"], properties: { reviewRequested: section, needsFix: section, readyToMerge: section } },
    waiting: { type: ["integer", "null"], minimum: 0, description: "Your open PRs in neither section." },
    local: { type: "object", required: ["indexedAt", "clones"], properties: { indexedAt: { type: "string" }, clones: { type: "integer", minimum: 0 } } },
    requests: { type: "integer", minimum: 0 }, cost: { type: "integer", minimum: 0 },
  },
};
