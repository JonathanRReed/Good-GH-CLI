/**
 * `ggh agent brief`: one session-start read of checkout identity plus the
 * branch PR's CI, review, issue and stack state. Every remote section reports
 * its own availability, so one failed or slow read never hides the others.
 */

import { readCheckoutState } from "./git/checkout-state.ts";
import { classifyGitHubError } from "./github/client.ts";
import { listIssueArtifacts, type IssueArtifacts } from "./github/issues.ts";
import { getBranchPullRequest, getPullRequestCheckSummary, type BranchPullRequest, type CheckSummary } from "./github/prs.ts";
import { getReviewThreads, type ReviewThreadsResult } from "./github/review-threads.ts";
import { findNativeStack, parsePullRequestUrl, type NativeStack, type PullRequestTarget } from "./github/stacks.ts";
import { readStackRecovery } from "./git/stack.ts";
import { getRemotes } from "./git/branch.ts";
import { killAllChildren, run } from "../utils/exec.ts";

export const BRIEF_DEADLINE_MS = 15_000;
const MAX_LINKED_ISSUES = 10;
/** Commit counts stop here so a huge history never slows the brief. */
export const BRIEF_COUNT_LIMIT = 1000;

export interface BriefCheckout {
  root: string;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  /** Null without an upstream: there is nothing to be ahead of. */
  ahead: number | null;
  behind: number | null;
  /** Commits reachable from HEAD but from no remote-tracking ref, capped at BRIEF_COUNT_LIMIT. */
  unpublished: number | null;
  /** Commits on HEAD not on the default branch, capped at BRIEF_COUNT_LIMIT; null when no default branch is known. */
  aheadOfDefault: number | null;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicts: number;
  operation?: string;
  /** An unfinished ggh stack restack or submit, such as one stopped on a conflict. */
  stackOperation?: { mode: "restack" | "submit"; selected: string; operationId: string };
}

type Unavailable = { state: "unavailable"; reason: string };
type Skipped = { state: "skipped"; reason: string };
type Section<T> = ({ state: "available" } & T) | Unavailable | Skipped;

export type BriefPullRequest = Section<{
  number: number; url: string; prState: string; draft: boolean; headSha: string; base: string;
  reviewDecision: string | null; mergeable: string; headMatchesLocal: boolean;
}> | { state: "none" };
export type BriefCi = Section<CheckSummary>;
export type BriefThreads = Section<{ unresolved: number; complete?: false }>;
export type BriefLinkedIssue = {
  number: number;
  repo?: string;
  artifacts: { state: "available"; items: Array<{ number: number; name: string; type: string }> } | Unavailable | Skipped;
};
export type BriefLinkedIssues = Section<{ items: BriefLinkedIssue[]; more?: number }>;
export type BriefStack = Section<{ number: number; position: number; size: number; below: Array<{ number: number; prState: string }> }> | { state: "none" };

export interface AgentBrief {
  schemaVersion: 1;
  checkout: BriefCheckout;
  pullRequest: BriefPullRequest;
  ci: BriefCi;
  reviewThreads: BriefThreads;
  linkedIssues: BriefLinkedIssues;
  stack: BriefStack;
  next?: string[];
}

/** Remote reads, injectable so deadline and failure isolation can be tested without gh. */
export interface BriefReaders {
  pullRequest(timeoutMs: number): Promise<BranchPullRequest | null>;
  checks(number: number, timeoutMs: number): Promise<CheckSummary>;
  threads(number: number): Promise<ReviewThreadsResult>;
  artifacts(issue: number): Promise<IssueArtifacts>;
  stack(target: PullRequestTarget): Promise<NativeStack | null>;
  /** Stops reads that lost the deadline race. */
  cancel?(): Promise<void>;
}

const defaultReaders: BriefReaders = {
  pullRequest: timeoutMs => getBranchPullRequest({ timeoutMs }),
  checks: (number, timeoutMs) => getPullRequestCheckSummary(number, { timeoutMs }),
  // Only the unresolved count is reported. A small page budget keeps huge PRs inside the deadline.
  threads: number => getReviewThreads(number, { unresolved: true, maxBody: 0, maxPages: 10 }),
  artifacts: issue => listIssueArtifacts(issue),
  stack: target => findNativeStack(target),
  cancel: killAllChildren,
};

async function countCommits(args: string[], cwd: string): Promise<number | null> {
  const result = await run("git", ["rev-list", "--count", `--max-count=${BRIEF_COUNT_LIMIT}`, ...args], { cwd, reject: false });
  const count = Number.parseInt(result.stdout.trim(), 10);
  return result.exitCode === 0 && Number.isSafeInteger(count) ? count : null;
}

/** The remote default branch ref, from refs/remotes/<remote>/HEAD only; no network. */
async function defaultBranchRef(cwd: string): Promise<string | null> {
  const remotes = await getRemotes(cwd).catch((): string[] => []);
  for (const remote of [...new Set(["origin", ...remotes])].filter(name => remotes.includes(name))) {
    const result = await run("git", ["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`], { cwd, reject: false });
    if (result.exitCode === 0 && result.stdout.trim().startsWith(`refs/remotes/${remote}/`)) return result.stdout.trim();
  }
  return null;
}

/** Local checkout identity, or null outside a repository. */
export async function readBriefCheckout(): Promise<BriefCheckout | null> {
  const state = await readCheckoutState({ untracked: "all" });
  if (!state) return null;
  const cwd = state.root;
  const born = state.head !== null;
  const [unpublished, aheadOfDefault, recovery] = await Promise.all([
    born ? countCommits(["HEAD", "--not", "--remotes"], cwd) : Promise.resolve(0),
    born ? defaultBranchRef(cwd).then(ref => ref ? countCommits([`${ref}..HEAD`], cwd) : null) : Promise.resolve(null),
    readStackRecovery(cwd).catch(() => null),
  ]);
  return {
    root: state.root, branch: state.branch, head: state.head, upstream: state.upstream,
    ahead: state.upstream ? state.ahead : null, behind: state.upstream ? state.behind : null, unpublished, aheadOfDefault,
    ...state.counts, ...(state.operation ? { operation: state.operation } : {}),
    ...(recovery ? { stackOperation: { mode: recovery.mode, selected: recovery.selected, operationId: recovery.operationId } } : {}),
  };
}

/** Hints that follow from local state alone, so --local and detached HEAD still point somewhere. */
function localHints(checkout: BriefCheckout, hasPullRequest: boolean): string[] {
  if (checkout.stackOperation?.mode === "restack") return ["ggh stack restack --continue --agent", "ggh stack restack --abort --agent"];
  if (checkout.stackOperation) return [`ggh operation view ${checkout.stackOperation.operationId} --agent`];
  if (!checkout.unpublished) return [];
  if (checkout.branch === null) return ["git switch -c <branch>"];
  if (checkout.upstream === null && !hasPullRequest) return ["ggh pr create --dry-run --agent"];
  return [];
}

// gh errors repeat stderr inside the message; one line keeps the brief small.
const compact = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 200);
const reasonOf = (error: unknown, context: string) => compact(classifyGitHubError(error, context).message);
const skipped = (reason: string): Skipped => ({ state: "skipped", reason });
/** The sections that need a branch PR, all skipped for one reason. */
const withoutPr = (reason: string) => ({ ci: skipped(reason), reviewThreads: skipped(reason), linkedIssues: skipped(reason), stack: skipped(reason) });

/** Builds the brief. `local` skips every remote read. */
export async function buildAgentBrief(checkout: BriefCheckout, options: { local?: boolean; deadlineMs?: number; readers?: BriefReaders } = {}): Promise<AgentBrief> {
  const brief = await buildRemoteSections(checkout, options);
  const next = [...new Set([...localHints(checkout, brief.pullRequest.state === "available"), ...brief.next ?? []])];
  return next.length ? { ...brief, next } : brief;
}

async function buildRemoteSections(checkout: BriefCheckout, options: { local?: boolean; deadlineMs?: number; readers?: BriefReaders }): Promise<AgentBrief> {
  if (options.local) {
    const reason = "Skipped by --local.";
    return { schemaVersion: 1, checkout, pullRequest: skipped(reason), ...withoutPr(reason) };
  }
  const readers = options.readers ?? defaultReaders;
  const deadlineMs = options.deadlineMs ?? BRIEF_DEADLINE_MS;
  const deadline = performance.now() + deadlineMs;
  const remaining = () => Math.max(1, Math.round(deadline - performance.now()));
  const timeoutReason = `Remote reads exceeded the ${Number((deadlineMs / 1000).toFixed(1))}s deadline.`;
  let timedOut = false;

  // Each section settles to a value; the deadline turns unsettled sections into unavailable ones.
  async function bounded<T>(work: Promise<T>, onTimeout: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<T>(resolve => {
      timer = setTimeout(() => { timedOut = true; resolve(onTimeout); }, remaining());
    });
    try { return await Promise.race([work, expired]); }
    finally { clearTimeout(timer); }
  }
  const late: Unavailable = { state: "unavailable", reason: timeoutReason };

  const brief: AgentBrief = { schemaVersion: 1, checkout, pullRequest: late, ci: late, reviewThreads: late, linkedIssues: late, stack: late };
  try {
    if (!checkout.branch) {
      const reason = "Detached HEAD has no branch pull request.";
      return { ...brief, pullRequest: skipped(reason), ...withoutPr(reason) };
    }
    type PrRead = { pr: BranchPullRequest | null } | Unavailable;
    const read = await bounded<PrRead>(
      readers.pullRequest(remaining()).then(pr => ({ pr }), (error: unknown): Unavailable => ({ state: "unavailable", reason: reasonOf(error, "pull request") })),
      late,
    );
    if (!("pr" in read)) {
      return { ...brief, pullRequest: read, ...withoutPr("The branch pull request could not be read.") };
    }
    const { pr } = read;
    if (!pr) {
      return { ...brief, pullRequest: { state: "none" }, ...withoutPr("No pull request for this branch.") };
    }
    brief.pullRequest = {
      state: "available", number: pr.number, url: pr.url, prState: pr.state, draft: pr.isDraft, headSha: pr.headRefOid,
      base: pr.baseRefName, reviewDecision: pr.reviewDecision, mergeable: pr.mergeable, headMatchesLocal: pr.headRefOid === checkout.head,
    };
    const target = parsePullRequestUrl(pr.url);
    const failure = (context: string) => (error: unknown): Unavailable => ({ state: "unavailable", reason: reasonOf(error, context) });

    const [ci, reviewThreads, linkedIssues, stack] = await Promise.all([
      bounded<BriefCi>(readers.checks(pr.number, remaining()).then(summary => ({ state: "available" as const, ...summary }), failure("pull request checks")), late),
      bounded<BriefThreads>(readers.threads(pr.number).then(result => ({
        state: "available" as const, unresolved: result.threads.length,
        ...(result.pagination.complete ? {} : { complete: false as const }),
      }), failure("review threads")), late),
      bounded<BriefLinkedIssues>(linkedIssueSection(pr, target, readers), late),
      target
        ? bounded<BriefStack>(readers.stack(target).then(stackSection(pr.number), (error: unknown): Unavailable => {
          const classified = classifyGitHubError(error, "stack lookup");
          return { state: "unavailable", reason: classified.kind === "not_found" ? "Stacked pull requests are not available for this repository." : compact(classified.message) };
        }), late)
        : Promise.resolve<BriefStack>({ state: "unavailable", reason: "The pull request URL does not identify a GitHub repository." }),
    ]);
    Object.assign(brief, { ci, reviewThreads, linkedIssues, stack });
    const next = [
      ...(ci.state === "available" && ci.failing.length ? [`ggh ci why ${pr.number} --agent`] : []),
      ...(reviewThreads.state === "available" && reviewThreads.unresolved ? [`ggh pr threads ${pr.number} --agent`] : []),
      ...(linkedIssues.state === "available" ? linkedIssues.items.filter(issue => !issue.repo && issue.artifacts.state === "available" && issue.artifacts.items.length).map(issue => `ggh issue ${issue.number} --agent`) : []),
    ];
    if (next.length) brief.next = next;
    return brief;
  } finally {
    // Reads that lost the race must not keep the process alive.
    if (timedOut) await readers.cancel?.();
  }
}

async function linkedIssueSection(pr: BranchPullRequest, target: PullRequestTarget | null, readers: BriefReaders): Promise<BriefLinkedIssues> {
  const references = pr.closingIssuesReferences.slice(0, MAX_LINKED_ISSUES);
  const items = await Promise.all(references.map(async (issue): Promise<BriefLinkedIssue> => {
    const owner = issue.repository?.owner?.login;
    const name = issue.repository?.name;
    const repo = owner && name ? `${owner}/${name}` : undefined;
    const foreign = repo !== undefined && target !== null && repo.toLowerCase() !== target.nameWithOwner.toLowerCase();
    if (foreign) return { number: issue.number, repo, artifacts: skipped("Issue is in another repository.") };
    const artifacts = await readers.artifacts(issue.number).catch((error: unknown): IssueArtifacts => ({ state: "unavailable", reason: reasonOf(error, "issue artifacts") }));
    return {
      number: issue.number,
      artifacts: artifacts.state === "available"
        ? { state: "available", items: artifacts.items.map(item => ({ number: item.number, name: item.name, type: item.type })) }
        : { state: "unavailable", reason: compact(artifacts.reason) },
    };
  }));
  const more = pr.closingIssuesReferences.length - references.length;
  return { state: "available", items, ...(more > 0 ? { more } : {}) };
}

function stackSection(number: number) {
  return (stack: NativeStack | null): BriefStack => {
    if (!stack) return { state: "none" };
    const index = stack.pullRequests.findIndex(member => member.number === number);
    const prState = (member: NativeStack["pullRequests"][number]) => member.mergedAt ? "MERGED" : member.state.toUpperCase();
    return {
      state: "available", number: stack.number, position: index + 1, size: stack.pullRequests.length,
      below: stack.pullRequests.slice(0, Math.max(0, index)).map(member => ({ number: member.number, prState: prState(member) })),
    };
  };
}
