/**
 * Pull request operations. Depends on client only.
 */

import { GitHubError, clampLimit, classifyGitHubError, getCurrentRepositoryNameWithOwner, gh, ghApi, ghGlobal, parseRepoFlag, stdinTextRequest } from "./client.ts";
import { invalidateCache } from "../cache.ts";
import { cachedGitHub } from "./cache.ts";
import { addAttachmentArgs, appendFallbackMarkdown, fallbackMutationFailure, PartialAttachmentOperationError, PartialGitHubMutationError, prepareAttachmentPlan, uploadFallbackAttachments, type AttachmentPlan, type AttachmentVisibility } from "./attachments.ts";

export interface PullRequestItem {
  number: number;
  title: string;
  author: { login: string; name?: string };
  headRefName: string;
  state: string;
  url: string;
}


export interface PullRequestFilters {
  limit?: number;
  state?: string;
  author?: string;
  label?: string;
  search?: string;
  mine?: boolean;
  head?: string;
  base?: string;
}


export async function listPullRequests(
  options: PullRequestFilters = {},
  cwd = process.cwd(),
): Promise<PullRequestItem[]> {
  const limit = clampLimit(options.limit ?? 30);
  const state = options.state ?? "open";
  const author = options.mine ? "@me" : options.author;
  const key = `pr-list:${JSON.stringify([limit, state, author, options.label, options.search, options.head, options.base])}`;
  return cachedGitHub(key, () => fetchPullRequests({ ...options, limit, author, state }, cwd), {
    ttlMs: 120_000, cwd,
  });
}

async function fetchPullRequests(
  options: PullRequestFilters & { limit: number; author?: string; state: string },
  cwd = process.cwd(),
): Promise<PullRequestItem[]> {
  const args = [
    "pr",
    "list",
    "--limit",
    String(options.limit),
    "--state",
    options.state,
    "--json",
    "number,title,author,headRefName,state,url",
  ];
  if (options.author) args.push("--author", options.author);
  if (options.label) args.push("--label", options.label);
  if (options.search) args.push("--search", options.search);
  if (options.head) args.push("--head", options.head);
  if (options.base) args.push("--base", options.base);
  try {
    const { stdout } = await gh(args, { cwd });
    return JSON.parse(stdout);
  } catch (err) {
    throw classifyGitHubError(err, "pull request list");
  }
}


export async function checkoutPullRequest(prNumber: number, cwd = process.cwd()): Promise<void> {
  try {
    await gh(["pr", "checkout", prNumber.toString()], { cwd, stdio: "inherit" });
  } catch (err) {
    throw classifyGitHubError(err, "pull request checkout");
  }
}


export async function viewPullRequestInBrowser(prNumber: number, cwd = process.cwd()): Promise<void> {
  try {
    await gh(["pr", "view", "--web", prNumber.toString()], { cwd });
  } catch (err) {
    throw classifyGitHubError(err, "pull request browser");
  }
}


export async function getPullRequestDiff(prNumber: number, cwd = process.cwd()): Promise<string> {
  try {
    const { stdout } = await gh(["pr", "diff", prNumber.toString()], { cwd, reject: false });
    return stdout;
  } catch (err) {
    throw classifyGitHubError(err, "pull request diff");
  }
}


export interface ActivePullRequestInfo {
  number: number;
  title: string;
  state: string;
  url: string;
}


export async function getActivePullRequest(cwd = process.cwd()): Promise<ActivePullRequestInfo | null> {
  try {
    const { stdout } = await gh(["pr", "view", "--json", "number,title,state,url"], {
      cwd,
      reject: false,
    });
    if (!stdout || !stdout.trim()) return null;
    const parsed = JSON.parse(stdout);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch (err) {
    throw classifyGitHubError(err, "active pull request");
  }
}


export interface CheckRunResult {
  name: string;
  state: string;
  description?: string;
  link?: string;
}


export async function getPullRequestChecks(cwd = process.cwd()): Promise<CheckRunResult[]> {
  try {
    const { stdout } = await gh(["pr", "checks", "--json", "name,state,description,link"], {
      cwd,
      reject: false,
    });
    if (!stdout || !stdout.trim()) return [];
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed.filter((c) => c && typeof c.state === "string") : [];
  } catch (err) {
    throw classifyGitHubError(err, "pull request checks");
  }
}


export interface PullRequestDetail extends PullRequestItem {
  body: string;
  headRefOid: string;
  isDraft: boolean;
  baseRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  mergeable: string;
  reviewDecision: string | null;
  labels: Array<{ name: string }>;
}

const PR_VIEW_FIELDS =
  "number,title,body,author,headRefName,headRefOid,baseRefName,state,url,isDraft,additions,deletions,changedFiles,mergeable,reviewDecision,labels";


export async function viewPullRequest(
  prNumber?: number,
  cwd = process.cwd(),
): Promise<PullRequestDetail | null> {
  try {
    const args = ["pr", "view", ...(prNumber ? [String(prNumber)] : []), "--json", PR_VIEW_FIELDS];
    const { stdout } = await gh(args, { cwd, reject: false });
    if (!stdout.trim()) return null;
    const parsed = JSON.parse(stdout);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch (err) {
    throw classifyGitHubError(err, "pull request view");
  }
}


export type MergeOutcome = "merged" | "queued" | "auto_merge_enabled" | "unknown";

export interface MergeOptions {
  matchHeadCommit: string;
  method: "merge" | "squash" | "rebase";
  deleteBranch?: boolean;
  auto?: boolean;
  subject?: string;
  body?: string;
}


export async function mergePullRequest(
  prNumber: number,
  options: MergeOptions,
  cwd = process.cwd(),
): Promise<{ outcome: MergeOutcome; cleanupError?: string }> {
  if (!/^[a-f0-9]{40}$/i.test(options.matchHeadCommit)) {
    throw new Error("A full reviewed head SHA is required. Refresh the PR and retry.");
  }
  const args = ["pr", "merge", ...(prNumber ? [String(prNumber)] : []), `--${options.method}`, "--match-head-commit", options.matchHeadCommit];
  if (options.auto) args.push("--auto");
  if (options.subject) args.push("--subject", options.subject);
  let input: string | undefined;
  if (options.body !== undefined) {
    args.push("--body-file", "-");
    input = options.body;
  }
  try {
    await gh(args, { cwd, input });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/head.*(?:does not match|doesn't match|changed|modified|mismatch)|expected.*(?:head|oid)|head.*expected/i.test(message)) {
      throw new GitHubError("unknown", "PR head changed since review. Review the new head and retry with its SHA.");
    }
    throw classifyGitHubError(err, "merge pull request");
  } finally {
    invalidateCache("pr-list:");
  }

  const outcome = await readMergeOutcome(prNumber, cwd);
  if (outcome === "merged" && options.deleteBranch) {
    try {
      // gh skips merging an already merged PR and performs its branch cleanup.
      await gh(["pr", "merge", ...(prNumber ? [String(prNumber)] : []), `--${options.method}`, "--match-head-commit", options.matchHeadCommit, "--delete-branch"], { cwd });
    } catch (err) {
      return { outcome, cleanupError: `PR merged, but branch cleanup failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { outcome };
}

async function readMergeOutcome(prNumber: number, cwd: string): Promise<MergeOutcome> {
  try {
    const { stdout } = await gh(["pr", "view", ...(prNumber ? [String(prNumber)] : []), "--json", "state,mergedAt,autoMergeRequest,mergeStateStatus"], { cwd });
    const state = JSON.parse(stdout);
    if (state?.state === "MERGED" && state.mergedAt) return "merged";
    if (state?.state !== "OPEN") return "unknown";
    // gh pr view does not expose mergeQueueEntry; query it separately.
    const { stdout: queueJson } = await ghApi(["graphql", "-f", "query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){mergeQueueEntry{id}}}}", "-F", "owner={owner}", "-F", "name={repo}", "-F", `number=${prNumber}`], { cwd });
    const queue = JSON.parse(queueJson);
    const pr = queue?.data?.repository?.pullRequest;
    if (queue.errors || !pr || !("mergeQueueEntry" in pr)) return "unknown";
    if (pr.mergeQueueEntry?.id) return "queued";
    if (state.autoMergeRequest) return "auto_merge_enabled";
    return "unknown";
  } catch {
    return "unknown";
  }
}

export async function setPullRequestState(
  action: "ready" | "close" | "reopen",
  prNumber?: number,
  cwd = process.cwd(),
): Promise<string> {
  const args = ["pr", action, ...(prNumber ? [String(prNumber)] : [])];
  try {
    const { stdout, stderr } = await gh(args, { cwd });
    return (stdout || stderr).trim();
  } catch (err) {
    throw classifyGitHubError(err, `${action} pull request`);
  } finally {
    invalidateCache("pr-list:");
  }
}


export async function commentOnPullRequest(
  prNumber: number | undefined,
  body: string,
  cwd = process.cwd(),
  options: { attachments?: string[]; visibility?: AttachmentVisibility } = {},
): Promise<string> {
  const plan = await prepareAttachmentPlan({
    attachments: options.attachments, operation: "pr-comment", recipient: prNumber ? `pr:${prNumber}` : "pr:current",
    visibility: options.visibility ?? "unknown", cwd,
  });
  const fallbackUploads = await uploadFallbackAttachments(plan);
  const finalBody = appendFallbackMarkdown(body, fallbackUploads);
  const request = stdinTextRequest(addAttachmentArgs(["pr", "comment", ...(prNumber ? [String(prNumber)] : [])], plan), "--body-file", finalBody);
  try {
    const { stdout } = await gh(request.args, { cwd, input: request.input });
    return stdout.trim();
  } catch (err) {
    const partial = fallbackMutationFailure(plan, fallbackUploads, classifyGitHubError(err, "comment on pull request"));
    if (partial) throw partial;
    if (err instanceof PartialAttachmentOperationError) throw err;
    throw classifyGitHubError(err, "comment on pull request");
  } finally {
    invalidateCache("pr-list:");
  }
}


export async function editPullRequest(
  prNumber: number | undefined,
  fields: { title?: string; body?: string; base?: string; addLabel?: string[]; attachments?: string[]; visibility?: AttachmentVisibility; repo?: string; host?: string },
  cwd = process.cwd(),
): Promise<void> {
  const plan = await prepareAttachmentPlan({
    attachments: fields.attachments, operation: "pr-edit", recipient: prNumber ? `pr:${prNumber}` : "pr:current",
    visibility: fields.visibility ?? "unknown", repo: fields.repo, host: fields.host, cwd,
  });
  const existingBody = plan.kind === "fallback" && fields.body === undefined
    ? await readPullRequestBody(prNumber, fields.repo, fields.host, cwd)
    : undefined;
  const fallbackUploads = await uploadFallbackAttachments(plan);
  const args = addAttachmentArgs(["pr", "edit", ...(prNumber ? [String(prNumber)] : [])], plan);
  let input: string | undefined;
  if (fields.title) args.push("--title", fields.title);
  if (fields.body !== undefined) {
    args.push("--body-file", "-");
    input = appendFallbackMarkdown(fields.body, fallbackUploads);
  } else if (fallbackUploads.length > 0) {
    args.push("--body-file", "-");
    input = appendFallbackMarkdown(existingBody ?? "", fallbackUploads);
  }
  if (fields.base) args.push("--base", fields.base);
  for (const label of fields.addLabel ?? []) args.push("--add-label", label);
  const explicitRepo = fields.repo ? parseRepoFlag(fields.repo) : null;
  if (explicitRepo) args.push("--repo", explicitRepo.repoArg);
  try {
    if (explicitRepo) await ghGlobal(args, { cwd, input, env: { GH_REPO: explicitRepo.nameWithOwner, GH_HOST: fields.host ?? explicitRepo.host } });
    else await gh(args, { cwd, input });
  } catch (err) {
    const partial = fallbackMutationFailure(plan, fallbackUploads, classifyGitHubError(err, "edit pull request"));
    if (partial) throw partial;
    if (err instanceof PartialAttachmentOperationError) throw err;
    throw classifyGitHubError(err, "edit pull request");
  } finally {
    invalidateCache("pr-list:");
  }
}


export interface ReviewComment {
  path: string;
  line: number;
  body: string;
}


export interface ReviewFilterResult {
  comments: ReviewComment[];
  dropped: { comment: ReviewComment; reasons: string[] }[];
}

/**
 * Filters AI review comments before they are posted. Drops comments that
 * mention users, introduce URLs not present in the diff, or are too long.
 */


export function filterReviewComments(
  comments: ReviewComment[],
  diff: string,
): ReviewFilterResult {
  const diffUrls = new Set<string>();
  for (const match of diff.match(/https?:\/\/[^\s]+/gi) ?? []) {
    diffUrls.add(match);
  }
  const kept: ReviewComment[] = [];
  const dropped: { comment: ReviewComment; reasons: string[] }[] = [];

  for (const comment of comments) {
    const reasons: string[] = [];
    if (/@\w+/.test(comment.body)) reasons.push("contains a @mention");
    const urls = comment.body.match(/https?:\/\/[^\s]+/gi) ?? [];
    for (const url of urls) {
      if (!diffUrls.has(url)) {
        reasons.push(`contains URL not in the diff: ${url}`);
      }
    }
    if (comment.body.length > 2000) reasons.push("exceeds 2000 characters");
    if (reasons.length) {
      dropped.push({ comment, reasons });
    } else {
      kept.push(comment);
    }
  }

  return { comments: kept, dropped };
}


export async function submitPullRequestReview(
  prNumber: number,
  options: { event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES"; body: string; comments?: ReviewComment[] },
  cwd = process.cwd(),
): Promise<void> {
  const repo = (await getCurrentRepositoryNameWithOwner(cwd)) ?? parseRepoFlag()?.nameWithOwner;
  if (!repo) throw new GitHubError("unknown", "Could not determine the repository for this review.");

  const payload: Record<string, unknown> = { event: options.event, body: options.body };
  if (options.comments?.length) {
    payload.comments = options.comments.map((c) => ({ path: c.path, line: c.line, body: c.body }));
  }

  try {
    await ghApi(
      ["--method", "POST", `repos/${repo}/pulls/${prNumber}/reviews`, "--input", "-"],
      { cwd, input: JSON.stringify(payload) },
    );
  } catch (err) {
    throw classifyGitHubError(err, "submit pull request review");
  }
}


export async function createPullRequest(
  options: {
    title: string;
    body: string;
    draft?: boolean;
    web?: boolean;
    base?: string;
    cwd?: string;
    attachments?: string[];
    repo?: string;
    head?: string;
    host?: string;
    visibility?: AttachmentVisibility;
  },
): Promise<string> {
  const cwd = options.cwd || process.cwd();
  const plan = await prepareAttachmentPlan({
    attachments: options.attachments, operation: "pr-create", recipient: "pr:create",
    visibility: options.visibility ?? "unknown", repo: options.repo, host: options.host, cwd,
  });
  const fallbackUploads = await uploadFallbackAttachments(plan);
  const request = stdinTextRequest(addAttachmentArgs(["pr", "create", "--title", options.title], plan), "--body-file", appendFallbackMarkdown(options.body, fallbackUploads));
  const args = request.args;
  if (options.base) args.push("--base", options.base);
  if (options.head) args.push("--head", options.head);
  const explicitRepo = options.repo ? parseRepoFlag(options.repo) : null;
  if (explicitRepo) args.push("--repo", explicitRepo.repoArg);
  if (options.draft) args.push("--draft");
  if (options.web) args.push("--web");

  try {
    const result = explicitRepo
      ? await ghGlobal(args, { cwd, input: request.input, env: { GH_REPO: explicitRepo.nameWithOwner, GH_HOST: options.host ?? explicitRepo.host } })
      : await gh(args, { cwd, input: request.input });
    const { stdout } = result;
    return stdout.trim();
  } catch (err) {
    const partial = fallbackMutationFailure(plan, fallbackUploads, classifyGitHubError(err, "create pull request"));
    if (partial) throw partial;
    if (err instanceof PartialAttachmentOperationError) throw err;
    const resourceUrl = resourceUrlFromStdout(err, /\/pull\/\d+\/?$/);
    if (resourceUrl && plan.kind !== "none") {
      throw new PartialGitHubMutationError({ resourceUrl, operation: "Pull request creation", requestedCount: plan.files.length });
    }
    throw classifyGitHubError(err, "create pull request");
  } finally {
    invalidateCache("pr-list:");
  }
}

export { PartialGitHubMutationError };
export type { AttachmentPlan };

function errorStdout(err: unknown): string {
  if (!err || typeof err !== "object") return err instanceof Error ? err.message : String(err);
  const value: unknown = Object.getOwnPropertyDescriptor(err, "stdout")?.value;
  return typeof value === "string" ? value : "";
}

function resourceUrlFromStdout(err: unknown, resourcePath: RegExp): string | undefined {
  for (const line of errorStdout(err).split(/\r?\n/)) {
    const candidate = line.trim();
    if (!candidate.startsWith("https://")) continue;
    try {
      const url = new URL(candidate);
      if (!url.username && !url.password && resourcePath.test(url.pathname)) return url.toString();
    } catch {
      // Ignore non-URL output lines.
    }
  }
  return undefined;
}

async function readPullRequestBody(
  prNumber: number | undefined,
  repoName: string | undefined,
  host: string | undefined,
  cwd: string,
): Promise<string> {
  const args = ["pr", "view", ...(prNumber ? [String(prNumber)] : []), "--json", "body"];
  const repo = repoName ? parseRepoFlag(repoName) : null;
  if (repo) args.push("--repo", repo.repoArg);
  try {
    const result = repo
      ? await ghGlobal(args, { cwd, env: { GH_REPO: repo.nameWithOwner, GH_HOST: host ?? repo.host } })
      : await gh(args, { cwd, ...(host ? { env: { GH_HOST: host } } : {}) });
    const parsed: unknown = JSON.parse(result.stdout);
    if (parsed && typeof parsed === "object" && "body" in parsed && typeof parsed.body === "string") return parsed.body;
  } catch {
    // Return one actionable preflight error below without leaking CLI internals.
  }
  throw new Error("Could not read the current pull request body before using configured attachment storage. No attachment was uploaded.");
}

/* ------------------------------------------------------------------ *
 * Issues
 * ------------------------------------------------------------------ */
