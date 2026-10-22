import { responseValidators } from "./response.ts";
import { classifyGitHubError, gh, ghApi, GitHubError, parseRepoFlag } from "./client.ts";

export interface ReviewThreadComment {
  id: string;
  databaseId: number | null;
  author: { login: string } | null;
  body: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  outdated: boolean;
  bodyTruncated?: true;
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  viewerCanResolve: boolean;
  viewerCanUnresolve: boolean;
  path: string;
  line: number | null;
  originalLine: number | null;
  startLine: number | null;
  diffSide: "LEFT" | "RIGHT";
  comments: ReviewThreadComment[];
}

export interface ReviewThreadsResult {
  schemaVersion: 1;
  number: number;
  headSha: string;
  baseSha: string;
  threads: ReviewThread[];
  cursor: string | null;
  pagination: { complete: boolean; threads: number; comments: number };
}

export interface ReviewThreadsOptions {
  unresolved?: boolean;
  since?: string;
  maxBody?: number;
  /** Total GraphQL request budget, including nested comment pages. */
  maxPages?: number;
}

export const MAX_REVIEW_THREAD_PAGES = 200;

// One document handles the initial read and both independent connection cursors.
const QUERY = `query ReviewThreads($owner: String!, $name: String!, $number: Int!, $threadsCursor: String, $commentsCursor: String, $threadId: ID!, $readThreads: Boolean!, $readComments: Boolean!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid baseRefOid
      reviewThreads(first: 100, after: $threadsCursor) @include(if: $readThreads) {
        nodes {
          id isResolved isOutdated viewerCanResolve viewerCanUnresolve path line originalLine startLine diffSide
          comments(first: 100) { ...Comments }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
  node(id: $threadId) @include(if: $readComments) {
    ... on PullRequestReviewThread { id comments(first: 100, after: $commentsCursor) { ...Comments } }
  }
}
fragment Comments on PullRequestReviewCommentConnection {
  nodes { id databaseId author { login } body createdAt updatedAt url outdated }
  pageInfo { hasNextPage endCursor }
}`;

const { object, string, boolean, nullableNumber } = responseValidators({ label: "review thread", source: " from GitHub", object: "response" });

/** The cursor is an ISO timestamp, so it can be passed directly to --since. */
export function reviewThreadsSince(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error("Invalid --since. Use an ISO timestamp or a cursor returned by pr threads.");
  }
  return Date.parse(value);
}

function comment(value: unknown): ReviewThreadComment {
  const row = object(value);
  const createdAt = string(row.createdAt);
  const updatedAt = string(row.updatedAt);
  reviewThreadsSince(createdAt);
  reviewThreadsSince(updatedAt);
  return {
    id: string(row.id), databaseId: nullableNumber(row.databaseId),
    author: row.author === null ? null : { login: string(object(row.author).login) },
    body: string(row.body), createdAt, updatedAt, url: string(row.url), outdated: boolean(row.outdated),
  };
}

function connection<T>(value: unknown, parse: (node: unknown) => T): { nodes: T[]; next: string | null } {
  const row = object(value);
  const info = object(row.pageInfo);
  if (!Array.isArray(row.nodes)) throw new Error("Missing review thread nodes from GitHub.");
  const next = boolean(info.hasNextPage) ? string(info.endCursor) : null;
  if (next === "") throw new Error("Missing review thread pagination cursor from GitHub.");
  return { nodes: row.nodes.map(parse), next };
}

function thread(value: unknown): { thread: ReviewThread; next: string | null } {
  const row = object(value);
  const comments = connection(row.comments, comment);
  const diffSide = row.diffSide;
  if (diffSide !== "LEFT" && diffSide !== "RIGHT") throw new Error("Invalid review thread diff side from GitHub.");
  return { thread: {
    id: string(row.id), isResolved: boolean(row.isResolved), isOutdated: boolean(row.isOutdated),
    viewerCanResolve: boolean(row.viewerCanResolve), viewerCanUnresolve: boolean(row.viewerCanUnresolve),
    path: string(row.path), line: nullableNumber(row.line), originalLine: nullableNumber(row.originalLine),
    startLine: nullableNumber(row.startLine), diffSide, comments: comments.nodes,
  }, next: comments.next };
}

export async function getReviewThreads(number?: number, options: ReviewThreadsOptions = {}): Promise<ReviewThreadsResult> {
  const since = options.since === undefined ? undefined : reviewThreadsSince(options.since);
  if (number !== undefined && (!Number.isSafeInteger(number) || number < 1)) throw new Error("Invalid PR number.");
  if (options.maxBody !== undefined && (!Number.isSafeInteger(options.maxBody) || options.maxBody < 0)) throw new Error("Invalid --max-body. Use a non-negative integer.");
  const maxPages = options.maxPages ?? MAX_REVIEW_THREAD_PAGES;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > MAX_REVIEW_THREAD_PAGES) throw new Error("Invalid review thread page budget.");

  try {
    let repo = parseRepoFlag();
    if (!repo) {
      const { stdout } = await gh(["repo", "view", "--json", "nameWithOwner,url"]);
      const value = object(JSON.parse(stdout));
      repo = parseRepoFlag(`${new URL(string(value.url)).host}/${string(value.nameWithOwner)}`);
    }
    if (!repo) throw new GitHubError("not_found", "No GitHub repository found.");
    const target = repo;
    if (number === undefined) {
      const { stdout } = await gh(["pr", "view", "--json", "number"]);
      const value = object(JSON.parse(stdout));
      const active = nullableNumber(value.number);
      if (active === null || active < 1) throw new GitHubError("not_found", "No PR found for the current branch. Pass a number.");
      number = active;
    }
    const result: ReviewThreadsResult = {
      schemaVersion: 1, number, headSha: "", baseSha: "", threads: [], cursor: null,
      pagination: { complete: true, threads: 0, comments: 0 },
    };
    let requests = 0;
    async function page(threadsCursor: string | null, threadId?: string, commentsCursor: string | null = null): Promise<Record<string, unknown>> {
      const { stdout } = await ghApi([
        "graphql", "-F", `threadsCursor=${threadsCursor ?? "null"}`, "-F", `commentsCursor=${commentsCursor ?? "null"}`,
        "-f", `threadId=${threadId ?? "unused"}`, "-F", `readThreads=${threadId === undefined}`, "-F", `readComments=${threadId !== undefined}`,
        "-f", `owner=${target.owner}`, "-f", `name=${target.repo}`, "-F", `number=${number}`,
        "-f", `query=${QUERY}`, "--hostname", target.host,
      ]);
      requests++;
      const response = object(JSON.parse(stdout));
      if (response.errors !== undefined) {
        if (!Array.isArray(response.errors)) throw new Error("Invalid GraphQL errors from GitHub.");
        if (response.errors.length) throw new Error(response.errors.map(error => string(object(error).message)).join("; "));
      }
      const data = object(response.data);
      const repository = data.repository;
      if (repository === null || object(repository).pullRequest === null) throw new GitHubError("not_found", `PR #${number} not found.`);
      const pr = object(object(repository).pullRequest);
      const head = string(pr.headRefOid);
      const base = string(pr.baseRefOid);
      if (requests > 1 && (head !== result.headSha || base !== result.baseSha)) throw new Error("PR head or base changed during pagination. Run pr threads again.");
      result.headSha = head;
      result.baseSha = base;
      return data;
    }

    let threadsCursor: string | null = null;
    const seenThreads = new Set<string>();
    const threadCursors = new Set<string>();
    do {
      const data = await page(threadsCursor);
      const batch = connection(object(object(data.repository).pullRequest).reviewThreads, thread);
      for (const entry of batch.nodes) {
        const item = entry.thread;
        if (seenThreads.has(item.id)) continue;
        seenThreads.add(item.id);
        result.threads.push(item);
        const comments = new Map(item.comments.map(item => [item.id, item]));
        let next = entry.next;
        const commentCursors = new Set<string>();
        while (next !== null) {
          if (requests >= maxPages || commentCursors.has(next)) { result.pagination.complete = false; break; }
          commentCursors.add(next);
          const more = await page(null, item.id, next);
          const node = object(more.node);
          if (string(node.id) !== item.id) throw new Error("GitHub returned a different review thread.");
          const batch = connection(node.comments, comment);
          for (const item of batch.nodes) comments.set(item.id, item);
          next = batch.next;
        }
        item.comments = [...comments.values()];
      }
      threadsCursor = batch.next;
      if (threadsCursor !== null && (requests >= maxPages || threadCursors.has(threadsCursor))) {
        result.pagination.complete = false;
        break;
      }
      if (threadsCursor !== null) threadCursors.add(threadsCursor);
    } while (threadsCursor !== null);

    result.pagination.threads = result.threads.length;
    for (const item of result.threads) {
      result.pagination.comments += item.comments.length;
      for (const comment of item.comments) {
        if (result.cursor === null || Date.parse(comment.updatedAt) > Date.parse(result.cursor)) result.cursor = comment.updatedAt;
      }
    }
    result.threads = result.threads.filter(item =>
      (!options.unresolved || !item.isResolved) &&
      (since === undefined || item.comments.some(comment => Date.parse(comment.createdAt) > since || Date.parse(comment.updatedAt) > since)),
    );
    if (options.maxBody !== undefined) {
      for (const item of result.threads) {
        for (const comment of item.comments) {
          const characters = Array.from(comment.body);
          if (characters.length > options.maxBody) {
            comment.body = characters.slice(0, options.maxBody).join("");
            comment.bodyTruncated = true;
          }
        }
      }
    }
    return result;
  } catch (error) {
    const detail = error instanceof Error && "stderr" in error && typeof error.stderr === "string" ? error.stderr
      : error instanceof Error ? error.message : String(error);
    if (/HTTP 401\b|bad credentials|please run:\s*gh auth login/i.test(detail)) {
      throw new GitHubError("not_authenticated", "GitHub CLI is not authenticated. Run `gh auth login`.");
    }
    if (error instanceof Error && /no pull requests? (?:found|associated)|no pull request found/i.test(error.message)) {
      throw new GitHubError("not_found", "No PR found for the current branch. Pass a number.");
    }
    throw classifyGitHubError(error, "review threads");
  }
}
