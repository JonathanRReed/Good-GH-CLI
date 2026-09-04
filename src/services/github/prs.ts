/**
 * Pull request operations. Depends on client only.
 */

import { GitHubError, clampLimit, classifyGitHubError, getCurrentRepositoryNameWithOwner, gh, ghApi, parseRepoFlag, stdinTextRequest } from "./client.ts";
import { cached, invalidateCache } from "../cache.ts";

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
  const key = `pr-list:${limit}:${state}:${author ?? ""}:${options.label ?? ""}:${options.search ?? ""}:${options.head ?? ""}:${options.base ?? ""}`;
  return cached(key, () => fetchPullRequests({ ...options, limit, author, state }, cwd), {
    ttlMs: 120_000,
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
  "number,title,body,author,headRefName,baseRefName,state,url,isDraft,additions,deletions,changedFiles,mergeable,reviewDecision,labels";


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


export interface MergeOptions {
  method: "merge" | "squash" | "rebase";
  deleteBranch?: boolean;
  auto?: boolean;
  subject?: string;
  body?: string;
}


export async function mergePullRequest(
  prNumber: number | undefined,
  options: MergeOptions,
  cwd = process.cwd(),
): Promise<string> {
  const args = ["pr", "merge", ...(prNumber ? [String(prNumber)] : [])];
  args.push(`--${options.method}`);
  if (options.deleteBranch) args.push("--delete-branch");
  if (options.auto) args.push("--auto");
  if (options.subject) args.push("--subject", options.subject);
  let input: string | undefined;
  if (options.body !== undefined) {
    args.push("--body-file", "-");
    input = options.body;
  }
  try {
    const { stdout, stderr } = await gh(args, { cwd, input });
    return (stdout || stderr).trim();
  } catch (err) {
    throw classifyGitHubError(err, "merge pull request");
  } finally {
    invalidateCache("pr-list:");
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
): Promise<string> {
  const request = stdinTextRequest(["pr", "comment", ...(prNumber ? [String(prNumber)] : [])], "--body-file", body);
  try {
    const { stdout } = await gh(request.args, { cwd, input: request.input });
    return stdout.trim();
  } catch (err) {
    throw classifyGitHubError(err, "comment on pull request");
  } finally {
    invalidateCache("pr-list:");
  }
}


export async function editPullRequest(
  prNumber: number | undefined,
  fields: { title?: string; body?: string; base?: string; addLabel?: string[] },
  cwd = process.cwd(),
): Promise<void> {
  const args = ["pr", "edit", ...(prNumber ? [String(prNumber)] : [])];
  let input: string | undefined;
  if (fields.title) args.push("--title", fields.title);
  if (fields.body !== undefined) {
    args.push("--body-file", "-");
    input = fields.body;
  }
  if (fields.base) args.push("--base", fields.base);
  for (const label of fields.addLabel ?? []) args.push("--add-label", label);
  try {
    await gh(args, { cwd, input });
  } catch (err) {
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
  },
): Promise<string> {
  const request = stdinTextRequest(["pr", "create", "--title", options.title], "--body-file", options.body);
  const args = request.args;
  if (options.base) args.push("--base", options.base);
  if (options.draft) args.push("--draft");
  if (options.web) args.push("--web");

  try {
    const { stdout } = await gh(args, { cwd: options.cwd || process.cwd(), input: request.input });
    return stdout.trim();
  } catch (err) {
    throw classifyGitHubError(err, "create pull request");
  } finally {
    invalidateCache("pr-list:");
  }
}

/* ------------------------------------------------------------------ *
 * Issues
 * ------------------------------------------------------------------ */
