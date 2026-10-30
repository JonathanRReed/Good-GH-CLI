/**
 * GitHub native stacked pull requests: stack membership, registration, and
 * asynchronous merges. A stacked PR cannot be merged through the legacy
 * synchronous endpoints that `gh pr merge` uses, and merging one merges every
 * PR below it, so callers must disclose the whole set before acting.
 */

import { classifyGitHubError, GitHubError, ghGlobal } from "./client.ts";
import type { MergeOptions, MergeOutcome } from "./prs.ts";

const API_VERSION = "2026-03-10";
const MERGE_POLL_DEADLINE_MS = 60_000;

export interface PullRequestTarget {
  host: string;
  nameWithOwner: string;
  number: number;
}

export interface NativeStackMember {
  number: number;
  state: string;
  draft: boolean;
  mergedAt: string | null;
  headRef: string;
  headSha: string;
}

export interface NativeStack {
  number: number;
  open: boolean;
  baseRef: string;
  url?: string;
  /** Bottom first. */
  pullRequests: NativeStackMember[];
}

export type NativeStackRegistration =
  | { state: "created" | "extended" | "unchanged"; number: number; pullRequests: number[] }
  | { state: "skipped" | "unavailable" | "conflict"; reason: string; number?: number };

export type NativeStackPlan =
  | { action: "create"; pullRequests: number[] }
  | { action: "add"; number: number; pullRequests: number[] }
  | { action: "unchanged"; number: number }
  | { action: "conflict"; reason: string; number?: number };

export function parsePullRequestUrl(value: string): PullRequestTarget | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/.exec(url.pathname);
  if (url.protocol !== "https:" || !match?.[1] || !match[2] || !match[3]) return null;
  return { host: url.host.toLowerCase(), nameWithOwner: `${match[1]}/${match[2]}`, number: Number(match[3]) };
}

async function stackApi(target: Pick<PullRequestTarget, "host">, args: string[], input?: unknown) {
  const request = ["api", "--hostname", target.host, "-H", `X-GitHub-Api-Version: ${API_VERSION}`, ...args];
  if (input !== undefined) request.push("--input", "-");
  return ghGlobal(request, input === undefined ? {} : { input: JSON.stringify(input) });
}

function toStack(raw: unknown): NativeStack | null {
  const value = raw as { number?: unknown; open?: unknown; base?: { ref?: unknown }; url?: unknown; pull_requests?: unknown };
  if (typeof value?.number !== "number" || !Array.isArray(value.pull_requests)) return null;
  const pullRequests: NativeStackMember[] = [];
  for (const item of value.pull_requests as Array<Record<string, unknown>>) {
    const head = item?.head as { ref?: unknown; sha?: unknown } | undefined;
    if (typeof item?.number !== "number") return null;
    pullRequests.push({
      number: item.number,
      state: typeof item.state === "string" ? item.state : "unknown",
      draft: item.draft === true,
      mergedAt: typeof item.merged_at === "string" ? item.merged_at : null,
      headRef: typeof head?.ref === "string" ? head.ref : "",
      headSha: typeof head?.sha === "string" ? head.sha : "",
    });
  }
  return {
    number: value.number,
    open: value.open !== false,
    baseRef: typeof value.base?.ref === "string" ? value.base.ref : "",
    ...(typeof value.url === "string" ? { url: value.url } : {}),
    pullRequests,
  };
}

/** Returns the open native stack containing the PR, or null when it is not stacked. */
export async function findNativeStack(target: PullRequestTarget): Promise<NativeStack | null> {
  try {
    const { stdout } = await stackApi(target, [`repos/${target.nameWithOwner}/stacks?pull_request=${target.number}`]);
    const stacks = JSON.parse(stdout || "[]");
    if (!Array.isArray(stacks)) throw new Error("GitHub returned an unexpected stack list.");
    for (const raw of stacks) {
      const stack = toStack(raw);
      if (stack?.open && stack.pullRequests.some(pr => pr.number === target.number)) return stack;
    }
    return null;
  } catch (err) {
    throw classifyGitHubError(err, "stack lookup");
  }
}

/**
 * Decides how to make GitHub's stack match the desired bottom-first PR order
 * without reordering or removing PRs someone else stacked. Merged PRs left at
 * the bottom of an existing stack are expected and ignored.
 */
export function planNativeStack(desired: number[], memberships: Map<number, NativeStack | null>): NativeStackPlan {
  const stacks = new Map<number, NativeStack>();
  for (const stack of memberships.values()) if (stack) stacks.set(stack.number, stack);
  if (stacks.size === 0) return { action: "create", pullRequests: desired };
  if (stacks.size > 1) {
    return { action: "conflict", reason: `These pull requests already belong to GitHub stacks ${[...stacks.keys()].map(n => `#${n}`).join(", ")}.` };
  }
  const [stack] = stacks.values();
  if (!stack) return { action: "create", pullRequests: desired };
  let start = 0;
  while (stack.pullRequests[start]?.mergedAt && !desired.includes(stack.pullRequests[start]?.number ?? -1)) start += 1;
  const existing = stack.pullRequests.slice(start).map(pr => pr.number);
  const isPrefix = existing.length <= desired.length && existing.every((number, index) => desired[index] === number);
  if (!isPrefix) {
    return {
      action: "conflict", number: stack.number,
      reason: `GitHub stack #${stack.number} holds ${existing.map(n => `#${n}`).join(", ")}, which does not match the local order ${desired.map(n => `#${n}`).join(", ")}.`,
    };
  }
  const missing = desired.slice(existing.length);
  return missing.length ? { action: "add", number: stack.number, pullRequests: missing } : { action: "unchanged", number: stack.number };
}

/** Links already-open PRs into a GitHub stack. Never throws; the PRs exist either way. */
export async function registerNativeStack(targets: PullRequestTarget[]): Promise<NativeStackRegistration> {
  const [first] = targets;
  if (!first || targets.length < 2) return { state: "skipped", reason: "A GitHub stack needs at least two pull requests." };
  if (targets.some(target => target.host !== first.host || target.nameWithOwner !== first.nameWithOwner)) {
    return { state: "skipped", reason: "The pull requests are not all in one repository." };
  }
  const desired = targets.map(target => target.number);
  try {
    const memberships = new Map<number, NativeStack | null>();
    for (const target of targets) memberships.set(target.number, await findNativeStack(target));
    const plan = planNativeStack(desired, memberships);
    if (plan.action === "conflict") return { state: "conflict", reason: plan.reason, ...(plan.number ? { number: plan.number } : {}) };
    if (plan.action === "unchanged") return { state: "unchanged", number: plan.number, pullRequests: desired };
    const path = plan.action === "create"
      ? `repos/${first.nameWithOwner}/stacks`
      : `repos/${first.nameWithOwner}/stacks/${plan.number}/add`;
    const { stdout } = await stackApi(first, ["-X", "POST", path], { pull_requests: plan.pullRequests });
    const stack = toStack(JSON.parse(stdout || "null"));
    if (!stack) throw new Error("GitHub did not return the stack.");
    return { state: plan.action === "create" ? "created" : "extended", number: stack.number, pullRequests: stack.pullRequests.map(pr => pr.number) };
  } catch (err) {
    const error = classifyGitHubError(err, "stack registration");
    const reason = error.kind === "not_found"
      ? "Stacked pull requests are not available for this repository."
      : error.message;
    return { state: "unavailable", reason };
  }
}

/** The PRs a stacked merge lands, bottom first, ending with the target. Already-merged PRs are excluded. */
export function stackMergeSet(stack: NativeStack, target: number): NativeStackMember[] {
  const index = stack.pullRequests.findIndex(pr => pr.number === target);
  if (index < 0) return [];
  return stack.pullRequests.slice(0, index + 1).filter(pr => !pr.mergedAt);
}

interface AsyncMergeResponse {
  status?: unknown;
  details?: { uuid?: unknown; message?: unknown; sha?: unknown };
}

function asyncOutcome(response: AsyncMergeResponse): { outcome?: MergeOutcome; failure?: string; uuid?: string } {
  const uuid = typeof response.details?.uuid === "string" ? response.details.uuid : undefined;
  if (response.status === "merged") return { outcome: "merged" };
  if (response.status === "enqueued") return { outcome: "queued" };
  if (response.status === "failed") return { failure: typeof response.details?.message === "string" ? response.details.message : "GitHub reported a failed merge." };
  return { uuid };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Merges a stacked PR, and every unmerged PR below it, through the
 * asynchronous merge API. The target's head is pinned; GitHub runs rules and
 * branch protection when the merge executes, so this polls for the result.
 */
export async function mergeStackedPullRequest(
  target: PullRequestTarget,
  options: Pick<MergeOptions, "matchHeadCommit" | "method" | "subject" | "body">,
): Promise<{ outcome: MergeOutcome; mergeRequestId?: string }> {
  if (!/^[a-f0-9]{40}$/i.test(options.matchHeadCommit)) {
    throw new Error("A full reviewed head SHA is required. Refresh the PR and retry.");
  }
  const path = `repos/${target.nameWithOwner}/pulls/${target.number}/merge-async`;
  let response: AsyncMergeResponse;
  try {
    const { stdout } = await stackApi(target, ["-X", "PUT", path], {
      sha: options.matchHeadCommit,
      merge_method: options.method,
      ...(options.subject ? { commit_title: options.subject } : {}),
      ...(options.body !== undefined ? { commit_message: options.body } : {}),
    });
    response = JSON.parse(stdout || "{}");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/head.*(?:does not match|doesn't match|changed|modified|mismatch)|expected.*(?:head|sha)/i.test(message)) {
      throw new GitHubError("unknown", "PR head changed since review. Review the new head and retry with its SHA.");
    }
    throw classifyGitHubError(err, "stacked merge");
  }

  let result = asyncOutcome(response);
  const uuid = result.uuid;
  const deadline = Date.now() + MERGE_POLL_DEADLINE_MS;
  for (let attempt = 1; !result.outcome && !result.failure && uuid && Date.now() < deadline; attempt += 1) {
    await sleep(Math.min(1_000 * attempt, 5_000));
    try {
      const { stdout } = await stackApi(target, [`${path}/${uuid}`]);
      result = { ...asyncOutcome(JSON.parse(stdout || "{}")), uuid };
    } catch {
      // A failed poll leaves the merge state unknown, never failed.
      break;
    }
  }
  if (result.failure) throw new GitHubError("unknown", `GitHub could not merge the stack: ${result.failure}`);
  return { outcome: result.outcome ?? "unknown", ...(uuid ? { mergeRequestId: uuid } : {}) };
}
