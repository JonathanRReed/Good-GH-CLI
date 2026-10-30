// The pull-request inbox: review requests, your PRs that need a fix, and your
// PRs that are ready to merge. One GraphQL request with two bounded searches,
// classified locally and tied to the clone where you would act. Read-only: the
// next steps are suggestions and are never executed.

import { writeCacheValue } from "./cache.ts";
import { getActiveHost, getGitHubAuthStatus } from "./github/client.ts";
import { responseValidators } from "./github/response.ts";
import { resolveProjects } from "./projects/query.ts";
import { budgetBlock, cloneRemoteIds, graphql, RATE_FIELDS, readRemoteBudget, remoteBudgetKey, remoteRepoKey, type Response } from "./projects/remote.ts";
import type { IndexedClone } from "./projects/types.ts";
import { quoteShellArgument } from "../utils/command-args.ts";

export const INBOX_SECTIONS = ["reviewRequested", "needsFix", "readyToMerge"] as const;
export type InboxSectionName = typeof INBOX_SECTIONS[number];
export type InboxReason =
  | "requested_directly" | "requested_via_team"
  | "checks_failing" | "changes_requested" | "conflicts"
  | "merge_queue" | "approved" | "no_review_required" | "checks_passing" | "no_checks" | "mergeable" | "stacked";

export interface InboxPullRequestData {
  /** owner/name */
  repo: string;
  number: number;
  title: string;
  url: string;
  draft: boolean;
  author: string | null;
  updatedAt: string;
  headRefName: string;
  baseRefName: string;
  /** Repository default branch, null when GitHub did not report it. */
  defaultBranch: string | null;
  /** Head commit check rollup: SUCCESS, FAILURE, ERROR, PENDING, EXPECTED, null when none, UNKNOWN when unreadable. */
  checks: string | null;
  reviewDecision: string | null;
  /** MERGEABLE, CONFLICTING, or UNKNOWN while GitHub computes it. */
  mergeable: string;
  mergeQueue: { position: number | null } | null;
  /** Review requests only. */
  request?: { direct: boolean; teams: string[] };
}
export interface InboxLocal {
  /** Argument for `ggh go`: owner/name when it resolves to this clone, otherwise a checkout path. */
  name: string;
  path: string;
  /** True when this checkout has the PR head branch checked out. */
  branchCheckedOut: boolean;
  clones: number;
}
export interface InboxPullRequest extends InboxPullRequestData {
  reasons: InboxReason[];
  local: InboxLocal | null;
  /** PR number this one is stacked on, set together with the "stacked" reason. */
  stackedOn?: number;
  /** One self-contained shell command per suggestion: each works from any directory. ggh never runs them. */
  next: string[];
}
export type InboxSection =
  | { state: "available"; total: number; complete: boolean; skipped: number; skippedReason?: string; items: InboxPullRequest[] }
  | { state: "unavailable"; reason: string; retryAt?: string };
export interface InboxResult {
  schemaVersion: 1;
  host: string;
  login: string | null;
  filter: string | null;
  limit: number;
  /** The --limit you asked for, present only when it exceeded the maximum of 50. */
  requestedLimit?: number;
  sections: Record<InboxSectionName, InboxSection>;
  /** Your open PRs that are in neither section: waiting on review, checks, or mergeability. */
  waiting: number | null;
  local: { indexedAt: string; clones: number };
  requests: number;
  cost: number;
}
export interface InboxOptions {
  limit?: number;
  filter?: string;
  clones?: IndexedClone[];
  indexedAt?: string;
  deadlineMs?: number;
  reserve?: number;
}

const PR_FIELDS = "number title url isDraft updatedAt headRefName baseRefName repository { nameWithOwner defaultBranchRef { name } } author { login } reviewDecision mergeable mergeQueueEntry { position } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }";
const REQUEST_FIELDS = "reviewRequests(first: 10) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { combinedSlug } } } }";
const FILTER = /^[A-Za-z0-9][\w-]*(?:\/[\w.-]+)?$/;
const v = responseValidators({ label: "inbox" });

export function validInboxFilter(filter: string): boolean { return FILTER.test(filter); }

/**
 * Your open PRs are classified locally, so fetch more than one section shows.
 * GitHub computes mergeability per node: 100 PRs take about twice as long as 50.
 */
export function authoredFirst(limit: number): number { return Math.min(100, Math.max(50, limit * 5)); }

/** Search qualifiers for both sections. `user:` also matches organizations. */
export function inboxQuery(limit: number, filter?: string): string {
  const scope = filter ? filter.includes("/") ? ` repo:${filter}` : ` user:${filter}` : "";
  const search = (alias: string, qualifier: string, first: number, extra = "") =>
    `${alias}: search(type: ISSUE, query: ${JSON.stringify(`is:pr is:open archived:false ${qualifier} sort:updated-desc${scope}`)}, first: ${first}) { issueCount nodes { ... on PullRequest { ${PR_FIELDS}${extra ? ` ${extra}` : ""} } } }`;
  return `query { viewer { login } ${search("review", "review-requested:@me", limit, REQUEST_FIELDS)} ${search("authored", "author:@me", authoredFirst(limit))} ${RATE_FIELDS} }`;
}

/** Where one of your open PRs belongs. Fix reasons win over readiness. */
export function classifyAuthored(pr: InboxPullRequestData): { section: Exclude<InboxSectionName, "reviewRequested"> | null; reasons: InboxReason[] } {
  const fix: InboxReason[] = [];
  if (pr.checks === "FAILURE" || pr.checks === "ERROR") fix.push("checks_failing");
  if (pr.reviewDecision === "CHANGES_REQUESTED") fix.push("changes_requested");
  if (pr.mergeable === "CONFLICTING") fix.push("conflicts");
  if (fix.length) return { section: "needsFix", reasons: fix };
  if (pr.mergeQueue) return { section: "readyToMerge", reasons: ["merge_queue"] };
  // A null decision means the base branch requires no review.
  const review: InboxReason | undefined = pr.reviewDecision === "APPROVED" ? "approved" : pr.reviewDecision === null ? "no_review_required" : undefined;
  const checks: InboxReason | undefined = pr.checks === "SUCCESS" ? "checks_passing" : pr.checks === null ? "no_checks" : undefined;
  if (!pr.draft && review && checks && pr.mergeable === "MERGEABLE") return { section: "readyToMerge", reasons: [review, checks, "mergeable"] };
  return { section: null, reasons: [] };
}

/** The local clone where you would act on a PR, preferring a checkout on its head branch. */
export function findLocalClone(host: string, pr: Pick<InboxPullRequestData, "repo" | "headRefName">, clones: readonly IndexedClone[], own: boolean): InboxLocal | null {
  const key = `${host}/${pr.repo}`.toLowerCase();
  const matches = clones.filter(clone => !clone.missing && cloneRemoteIds(clone).some(repo => remoteRepoKey(repo) === key));
  const usable = (clone: IndexedClone) => clone.checkouts.filter(checkout => !checkout.bare);
  const onBranch = own ? matches.flatMap(clone => usable(clone).filter(checkout => checkout.branch === pr.headRefName).map(checkout => ({ clone, checkout }))) : [];
  const picked = onBranch[0] ?? matches.flatMap(clone => usable(clone).slice(0, 1).map(checkout => ({ clone, checkout })))[0];
  if (!picked) return null;
  const resolved = resolveProjects(clones, pr.repo);
  const byName = !onBranch.length && resolved.length === 1 && resolved[0] === picked.clone;
  return { name: byName ? pr.repo : picked.checkout.path, path: picked.checkout.path, branchCheckedOut: onBranch.length > 0, clones: matches.length };
}

/** A paste-ready shell word: bare when it needs no quoting, single-quoted otherwise. */
export function shellWord(value: string): string {
  return /^[\w@%+=:,./~-]+$/.test(value) ? value : quoteShellArgument(value);
}

/** Where you would act on this PR. `go` runs as a child process, so only `cd` moves the caller's shell. */
function enterClone(name: string): string {
  return `cd "$(ggh go ${shellWord(name)} --print)"`;
}

/**
 * Suggested next commands. Every suggestion is one self-contained shell command
 * that works from any directory: `go` cannot move the caller's shell, so local
 * commands are prefixed with `cd "$(ggh go ... --print)"`, and remote ones carry
 * `-R` instead of relying on the current directory. ggh never runs them.
 */
export function nextSteps(section: InboxSectionName, host: string, pr: InboxPullRequestData, reasons: readonly InboxReason[], local: InboxLocal | null): string[] {
  const number = String(pr.number);
  const repo = host === "github.com" ? pr.repo : `${host}/${pr.repo}`;
  const remote = (argv: string[]) => [...argv, "-R", shellWord(repo)].join(" ");
  if (section === "reviewRequested") {
    // review fetches Git objects through a local remote and has no -R.
    const enter = enterClone(local ? local.name : pr.repo);
    return local ? [`${enter} && ggh review ${number}`] : [`ggh clone ${shellWord(repo)} && ${enter} && ggh review ${number}`];
  }
  if (section === "readyToMerge") return [reasons.includes("merge_queue") ? remote(["ggh", "pr", "view", number]) : remote(["ggh", "pr", "merge", number])];
  if (reasons.includes("checks_failing")) return [remote(["ggh", "ci", "why", number])];
  if (reasons.includes("changes_requested")) return [remote(["ggh", "pr", "threads", number])];
  if (!local) return [`ggh clone ${shellWord(repo)}`];
  const enter = enterClone(local.name);
  return [local.branchCheckedOut ? enter : `${enter} && ggh switch ${shellWord(pr.headRefName)}`];
}

function unavailableSections(reason: string, retryAt?: string): Record<InboxSectionName, InboxSection> {
  const section: InboxSection = { state: "unavailable", reason, ...(retryAt ? { retryAt } : {}) };
  return { reviewRequested: section, needsFix: section, readyToMerge: section };
}

function parsePullRequest(value: unknown, viewer: string | null, degraded: boolean, requests: boolean): InboxPullRequestData {
  const row = v.object(value);
  const author = row.author === null ? null : v.string(v.object(row.author).login);
  const commit = v.array(v.object(row.commits).nodes)[0];
  const rollup = commit === undefined ? null : v.object(commit).commit === null ? null : v.object(v.object(commit).commit).statusCheckRollup;
  const queue = row.mergeQueueEntry === null || row.mergeQueueEntry === undefined ? null : v.object(row.mergeQueueEntry);
  const repository = v.object(row.repository);
  const defaultBranch = repository.defaultBranchRef === null || repository.defaultBranchRef === undefined ? null : v.string(v.object(repository.defaultBranchRef).name);
  const pr: InboxPullRequestData = {
    repo: v.string(repository.nameWithOwner), number: v.integer(row.number), title: v.string(row.title), url: v.string(row.url),
    draft: v.boolean(row.isDraft), author, updatedAt: v.string(row.updatedAt), headRefName: v.string(row.headRefName), baseRefName: v.string(row.baseRefName),
    defaultBranch,
    // A field error nulls the rollup, which must not read as "no checks configured".
    checks: degraded ? "UNKNOWN" : rollup === null || rollup === undefined ? null : v.string(v.object(rollup).state),
    reviewDecision: row.reviewDecision === null ? null : v.string(row.reviewDecision),
    mergeable: degraded ? "UNKNOWN" : v.string(row.mergeable),
    mergeQueue: queue ? { position: v.nullableNumber(queue.position ?? null) } : null,
  };
  if (requests) {
    // Unreadable team requests (no read:org) arrive as null reviewers.
    const reviewers = row.reviewRequests === null ? [] : v.array(v.object(row.reviewRequests).nodes).flatMap(node => {
      const reviewer = v.object(node).requestedReviewer;
      return reviewer === null ? [] : [v.object(reviewer)];
    });
    const direct = reviewers.some(reviewer => reviewer.__typename === "User" && typeof reviewer.login === "string" && reviewer.login.toLowerCase() === viewer?.toLowerCase());
    pr.request = { direct, teams: reviewers.flatMap(reviewer => reviewer.__typename === "Team" && typeof reviewer.combinedSlug === "string" ? [reviewer.combinedSlug] : []) };
  }
  return pr;
}

interface SearchPage { total: number; fetched: number; items: InboxPullRequestData[]; skipped: number; skippedReason?: string }

function readSearch(response: Response, alias: string, viewer: string | null, requests: boolean): SearchPage | { error: string } {
  const top = response.errors.find(error => !error.path.length || error.path[0] === alias && error.path.length <= 1);
  if (top || response.data[alias] === null || response.data[alias] === undefined) return { error: top?.message ?? response.errors[0]?.message ?? "GitHub returned no search results" };
  try {
    const connection = v.object(response.data[alias]);
    const nodes = v.array(connection.nodes);
    // Errors under one node, such as SAML-protected organizations, hide only that PR.
    const nodeErrors = new Map<number, string>();
    for (const error of response.errors) {
      const index = error.path[2];
      if (error.path[0] !== alias || error.path[1] !== "nodes" || typeof index !== "number" || error.path.includes("reviewRequests")) continue;
      if (!nodeErrors.has(index)) nodeErrors.set(index, error.message);
    }
    const page: SearchPage = { total: v.integer(connection.issueCount), fetched: nodes.length, items: [], skipped: 0 };
    for (const [index, node] of nodes.entries()) {
      // Search can return non-PR nodes as empty objects.
      if (node === null || (typeof node === "object" && !Array.isArray(node) && !("number" in node))) {
        page.skipped++; page.skippedReason ??= nodeErrors.get(index) ?? "Pull request unavailable";
        continue;
      }
      page.items.push(parsePullRequest(node, viewer, nodeErrors.has(index), requests));
    }
    return page;
  } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}

function section(page: SearchPage, items: InboxPullRequest[], limit: number, total: number): InboxSection {
  return { state: "available", total, complete: page.fetched >= page.total && page.skipped === 0, skipped: page.skipped, ...(page.skippedReason ? { skippedReason: page.skippedReason } : {}), items: items.slice(0, limit) };
}

export async function readInbox(options: InboxOptions = {}): Promise<InboxResult> {
  const deadline = performance.now() + (options.deadlineMs ?? 20_000);
  const limit = Math.max(1, Math.min(options.limit ?? 10, 50));
  const host = getActiveHost().toLowerCase();
  const clones = options.clones ?? [];
  const result: InboxResult = {
    schemaVersion: 1, host, login: null, filter: options.filter ?? null, limit,
    sections: unavailableSections("not requested"), waiting: null,
    local: { indexedAt: options.indexedAt ?? new Date(0).toISOString(), clones: clones.length }, requests: 0, cost: 0,
  };
  try {
    const auth = await getGitHubAuthStatus(host, false, Math.max(1, deadline - performance.now()));
    if (!auth.authenticated || !auth.login) throw new Error("GitHub authentication unavailable");
    result.login = auth.login;
    const budgetKey = remoteBudgetKey(host, auth.login);
    const saved = readRemoteBudget(budgetKey);
    const blocked = budgetBlock(saved, 1, options.reserve);
    if (blocked) { result.sections = unavailableSections(blocked, saved?.retryAt ?? saved?.resetAt); return result; }
    if (performance.now() >= deadline) throw new Error("deadline");
    result.requests++;
    const response = await graphql(host, inboxQuery(limit, options.filter), Math.max(1, deadline - performance.now()));
    if (response.budget) {
      result.cost += response.budget.cost;
      writeCacheValue(budgetKey, { ...response.budget, ...(response.retryAt ? { retryAt: response.retryAt } : {}) });
    } else if (response.retryAt) writeCacheValue(budgetKey, { remaining: 0, cost: 0, resetAt: response.retryAt, retryAt: response.retryAt });
    const viewer = response.data.viewer && typeof response.data.viewer === "object" && "login" in response.data.viewer && typeof response.data.viewer.login === "string" ? response.data.viewer.login : auth.login;
    result.login = viewer;

    const review = readSearch(response, "review", viewer, true);
    const authored = readSearch(response, "authored", viewer, false);
    // Every fetched PR is open, so a base branch that is another fetched PR's
    // head branch means this PR is stacked on it. Detect it across both pages
    // before classifying, so ready PRs stop reading as plainly mergeable.
    const openHeads = new Map([...("error" in review ? [] : review.items), ...("error" in authored ? [] : authored.items)]
      .map(pr => [`${pr.repo.toLowerCase()}\0${pr.headRefName.toLowerCase()}`, pr.number] as const));
    const stackedOn = (pr: InboxPullRequestData): number | undefined => {
      const found = openHeads.get(`${pr.repo.toLowerCase()}\0${pr.baseRefName.toLowerCase()}`);
      return found !== undefined && found !== pr.number ? found : undefined;
    };
    if ("error" in review) result.sections.reviewRequested = { state: "unavailable", reason: review.error, ...(response.retryAt ? { retryAt: response.retryAt } : {}) };
    else {
      const items = review.items.map(pr => {
        const reasons: InboxReason[] = [pr.request?.direct ? "requested_directly" : "requested_via_team"];
        const stacked = stackedOn(pr);
        if (stacked !== undefined) reasons.push("stacked");
        const local = findLocalClone(host, pr, clones, false);
        return { ...pr, reasons, local, ...(stacked !== undefined ? { stackedOn: stacked } : {}), next: nextSteps("reviewRequested", host, pr, reasons, local) };
      });
      result.sections.reviewRequested = section(review, items, limit, review.total);
    }

    if ("error" in authored) {
      const failed: InboxSection = { state: "unavailable", reason: authored.error, ...(response.retryAt ? { retryAt: response.retryAt } : {}) };
      result.sections.needsFix = failed; result.sections.readyToMerge = failed;
    } else {
      const grouped: Record<"needsFix" | "readyToMerge", InboxPullRequest[]> = { needsFix: [], readyToMerge: [] };
      let waiting = 0;
      for (const pr of authored.items) {
        const { section: name, reasons } = classifyAuthored(pr);
        if (!name) { waiting++; continue; }
        const stacked = stackedOn(pr);
        if (stacked !== undefined) reasons.push("stacked");
        const local = findLocalClone(host, pr, clones, true);
        grouped[name].push({ ...pr, reasons, local, ...(stacked !== undefined ? { stackedOn: stacked } : {}), next: nextSteps(name, host, pr, reasons, local) });
      }
      result.sections.needsFix = section(authored, grouped.needsFix, limit, grouped.needsFix.length);
      result.sections.readyToMerge = section(authored, grouped.readyToMerge, limit, grouped.readyToMerge.length);
      result.waiting = waiting;
    }
  } catch (error) {
    const reason = performance.now() >= deadline ? "deadline" : error instanceof Error ? error.message : String(error);
    result.sections = unavailableSections(reason);
  }
  return result;
}
