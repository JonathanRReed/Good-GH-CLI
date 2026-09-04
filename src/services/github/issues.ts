/**
 * Issue operations. Depends on client only.
 */

import { clampLimit, classifyGitHubError, gh, stdinTextRequest } from "./client.ts";
import { cached, invalidateCache } from "../cache.ts";

export interface IssueItem {
  number: number;
  title: string;
  state: string;
  url: string;
  author: { login: string };
  labels: Array<{ name: string }>;
  createdAt: string;
}


export interface IssueFilters {
  limit?: number;
  state?: string;
  assignee?: string;
  author?: string;
  label?: string;
  search?: string;
  mine?: boolean;
}


export async function listIssues(
  options: IssueFilters = {},
  cwd = process.cwd(),
): Promise<IssueItem[]> {
  const limit = clampLimit(options.limit ?? 30);
  const state = options.state ?? "open";
  const author = options.mine ? "@me" : options.author;
  const key = `issue-list:${limit}:${state}:${options.assignee ?? ""}:${author ?? ""}:${options.label ?? ""}:${options.search ?? ""}`;
  return cached(key, () => fetchIssues({ ...options, limit, author, state }, cwd), {
    ttlMs: 120_000,
  });
}

async function fetchIssues(
  options: IssueFilters & { limit: number; author?: string; state: string },
  cwd = process.cwd(),
): Promise<IssueItem[]> {
  const args = [
    "issue",
    "list",
    "--limit",
    String(options.limit),
    "--state",
    options.state,
    "--json",
    "number,title,state,url,author,labels,createdAt",
  ];
  if (options.assignee) args.push("--assignee", options.assignee);
  if (options.author) args.push("--author", options.author);
  if (options.label) args.push("--label", options.label);
  if (options.search) args.push("--search", options.search);
  try {
    const { stdout } = await gh(args, { cwd });
    return JSON.parse(stdout);
  } catch (err) {
    throw classifyGitHubError(err, "issue list");
  }
}


export async function viewIssue(issueNumber: number, cwd = process.cwd()): Promise<IssueDetail | null> {
  try {
    const args = [
      "issue",
      "view",
      String(issueNumber),
      "--json",
      "number,title,body,state,url,author,labels,createdAt,comments",
    ];
    const { stdout } = await gh(args, { cwd, reject: false });
    if (!stdout.trim()) return null;
    return JSON.parse(stdout);
  } catch (err) {
    throw classifyGitHubError(err, "issue view");
  }
}


export interface IssueDetail extends IssueItem {
  body: string;
  comments?: Array<{ author: { login: string }; body: string; createdAt: string }>;
}


export async function createIssue(
  fields: { title: string; body?: string; labels?: string[]; assignee?: string },
  cwd = process.cwd(),
): Promise<string> {
  const request = stdinTextRequest(["issue", "create", "--title", fields.title], "--body-file", fields.body ?? "");
  const args = request.args;
  for (const label of fields.labels ?? []) args.push("--label", label);
  if (fields.assignee) args.push("--assignee", fields.assignee);
  try {
    const { stdout } = await gh(args, { cwd, input: request.input });
    return stdout.trim();
  } catch (err) {
    throw classifyGitHubError(err, "create issue");
  } finally {
    invalidateCache("issue-list:");
  }
}


export async function setIssueState(action: "close" | "reopen", issueNumber: number, cwd = process.cwd()): Promise<void> {
  try {
    await gh(["issue", action, String(issueNumber)], { cwd });
  } catch (err) {
    throw classifyGitHubError(err, `${action} issue`);
  } finally {
    invalidateCache("issue-list:");
  }
}


export async function commentOnIssue(issueNumber: number, body: string, cwd = process.cwd()): Promise<string> {
  try {
    const request = stdinTextRequest(["issue", "comment", String(issueNumber)], "--body-file", body);
    const { stdout } = await gh(request.args, { cwd, input: request.input });
    return stdout.trim();
  } catch (err) {
    throw classifyGitHubError(err, "comment on issue");
  } finally {
    invalidateCache("issue-list:");
  }
}

/* ------------------------------------------------------------------ *
 * Workflow runs
 * ------------------------------------------------------------------ */
