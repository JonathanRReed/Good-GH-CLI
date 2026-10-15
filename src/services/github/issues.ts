/**
 * Issue operations. Depends on client only.
 */

import { clampLimit, classifyGitHubError, gh, ghGlobal, parseRepoFlag, stdinTextRequest } from "./client.ts";
import { invalidateCache } from "../cache.ts";
import { cachedGitHub } from "./cache.ts";
import { addAttachmentArgs, appendFallbackMarkdown, fallbackMutationFailure, PartialAttachmentOperationError, PartialGitHubMutationError, prepareAttachmentPlan, uploadFallbackAttachments, type AttachmentPlan, type AttachmentVisibility, type UploadedAttachment } from "./attachments.ts";

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
  const key = `issue-list:${JSON.stringify([limit, state, options.assignee, author, options.label, options.search])}`;
  return cachedGitHub(key, () => fetchIssues({ ...options, limit, author, state }, cwd), {
    ttlMs: 120_000, cwd,
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
  fields: { title: string; body?: string; labels?: string[]; assignee?: string; attachments?: string[]; visibility?: AttachmentVisibility },
  cwd = process.cwd(),
): Promise<string> {
  const plan = await prepareAttachmentPlan({
    attachments: fields.attachments, operation: "issue-create", recipient: "issue:create",
    visibility: fields.visibility ?? "unknown", cwd,
  });
  const uploads = await uploadFallbackAttachments(plan);
  const request = stdinTextRequest(addAttachmentArgs(["issue", "create", "--title", fields.title], plan), "--body-file", appendFallbackMarkdown(fields.body ?? "", uploads));
  const args = request.args;
  for (const label of fields.labels ?? []) args.push("--label", label);
  if (fields.assignee) args.push("--assignee", fields.assignee);
  try {
    const { stdout } = await gh(args, { cwd, input: request.input });
    return stdout.trim();
  } catch (err) {
    const partial = fallbackMutationFailure(plan, uploads, classifyGitHubError(err, "create issue"));
    if (partial) throw partial;
    if (err instanceof PartialAttachmentOperationError) throw err;
    const resourceUrl = resourceUrlFromStdout(err, /\/issues\/\d+\/?$/);
    if (resourceUrl && plan.kind !== "none") {
      throw new PartialGitHubMutationError({ resourceUrl, operation: "Issue creation", requestedCount: plan.files.length });
    }
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


export async function commentOnIssue(
  issueNumber: number,
  body: string,
  cwd = process.cwd(),
  options: { attachments?: string[]; visibility?: AttachmentVisibility } = {},
): Promise<string> {
  return commentOnIssueWithAttachments(issueNumber, body, options, cwd);
}

export async function commentOnIssueWithAttachments(
  issueNumber: number,
  body: string,
  options: { attachments?: string[]; visibility?: AttachmentVisibility } = {},
  cwd = process.cwd(),
): Promise<string> {
  let plan: AttachmentPlan | undefined;
  let uploads: UploadedAttachment[] = [];
  try {
    plan = await prepareAttachmentPlan({
      attachments: options.attachments, operation: "issue-comment", recipient: `issue:${issueNumber}`,
      visibility: options.visibility ?? "unknown", cwd,
    });
    uploads = await uploadFallbackAttachments(plan);
    const request = stdinTextRequest(addAttachmentArgs(["issue", "comment", String(issueNumber)], plan), "--body-file", appendFallbackMarkdown(body, uploads));
    const { stdout } = await gh(request.args, { cwd, input: request.input });
    return stdout.trim();
  } catch (err) {
    const partial = plan ? fallbackMutationFailure(plan, uploads, classifyGitHubError(err, "comment on issue")) : undefined;
    if (partial) throw partial;
    if (err instanceof PartialAttachmentOperationError) throw err;
    throw classifyGitHubError(err, "comment on issue");
  } finally {
    invalidateCache("issue-list:");
  }
}

export async function editIssue(
  issueNumber: number,
  fields: { title?: string; body?: string; addLabel?: string[]; removeLabel?: string[]; assignee?: string; attachments?: string[]; visibility?: AttachmentVisibility; repo?: string; host?: string },
  cwd = process.cwd(),
): Promise<void> {
  const plan = await prepareAttachmentPlan({
    attachments: fields.attachments, operation: "issue-edit", recipient: `issue:${issueNumber}`,
    visibility: fields.visibility ?? "unknown", repo: fields.repo, host: fields.host, cwd,
  });
  const existingBody = plan.kind === "fallback" && fields.body === undefined
    ? await readIssueBody(issueNumber, fields.repo, fields.host, cwd)
    : undefined;
  const uploads = await uploadFallbackAttachments(plan);
  const args = addAttachmentArgs(["issue", "edit", String(issueNumber)], plan);
  let input: string | undefined;
  if (fields.title) args.push("--title", fields.title);
  if (fields.body !== undefined || uploads.length > 0) {
    args.push("--body-file", "-");
    input = appendFallbackMarkdown(fields.body ?? existingBody ?? "", uploads);
  }
  for (const label of fields.addLabel ?? []) args.push("--add-label", label);
  for (const label of fields.removeLabel ?? []) args.push("--remove-label", label);
  if (fields.assignee) args.push("--assignee", fields.assignee);
  const repo = fields.repo ? parseRepoFlag(fields.repo) : null;
  if (repo) args.push("--repo", repo.repoArg);
  try {
    if (repo) await ghGlobal(args, { cwd, input, env: { GH_REPO: repo.nameWithOwner, GH_HOST: fields.host ?? repo.host } });
    else await gh(args, { cwd, input, ...(fields.host ? { env: { GH_HOST: fields.host } } : {}) });
  } catch (err) {
    const partial = fallbackMutationFailure(plan, uploads, classifyGitHubError(err, "edit issue"));
    if (partial) throw partial;
    if (err instanceof PartialAttachmentOperationError) throw err;
    throw classifyGitHubError(err, "edit issue");
  } finally {
    invalidateCache("issue-list:");
  }
}

function errorStdout(err: unknown): string {
  if (!err || typeof err !== "object") return "";
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

async function readIssueBody(issueNumber: number, repoName: string | undefined, host: string | undefined, cwd: string): Promise<string> {
  const args = ["issue", "view", String(issueNumber), "--json", "body"];
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
  throw new Error("Could not read the current issue body before using configured attachment storage. No attachment was uploaded.");
}

/* ------------------------------------------------------------------ *
 * Workflow runs
 * ------------------------------------------------------------------ */
