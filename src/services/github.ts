import { run } from "../utils/exec.ts";
import { getFlags } from "./runtime.ts";
import { cached } from "./cache.ts";

/**
 * Inserts `--repo owner/name` when the user targeted another repository, so
 * every GitHub command works from anywhere rather than only inside a checkout.
 */
export function withRepo(args: string[]): string[] {
  const repo = getFlags().repo;
  return repo ? [...args, "--repo", repo] : args;
}

export interface GitHubAccount {
  authenticated: boolean;
  login?: string;
  host?: string;
  protocol?: "https" | "ssh";
  /** True when the `gh` binary itself is missing from PATH (distinct from being logged out). */
  notInstalled?: boolean;
}

function isMissingBinary(err: unknown): boolean {
  return (err as { code?: string })?.code === "ENOENT";
}

export interface RepositoryItem {
  nameWithOwner: string;
  description?: string;
  isPrivate?: boolean;
  updatedAt?: string;
}

/**
 * Probes GitHub CLI auth status using `gh auth status --json hosts`.
 */
export async function getGitHubAuthStatus(): Promise<GitHubAccount> {
  try {
    const { stdout } = await run("gh", ["auth", "status", "--json", "hosts"]);
    if (stdout && stdout.trim()) {
      const parsed = JSON.parse(stdout);
      const hostsObj = parsed?.hosts;
      if (hostsObj && typeof hostsObj === "object") {
        const hostKeys = Object.keys(hostsObj);
        const hostKey = hostsObj["github.com"] ? "github.com" : hostKeys[0];
        const accounts = hostKey ? hostsObj[hostKey] : undefined;
        const accountList = Array.isArray(accounts) ? accounts : accounts ? [accounts] : [];
        if (accountList.length > 0) {
          const activeAccount = accountList.find((acc: { active?: boolean }) => acc.active) || accountList[0];
          const isAuthenticated = activeAccount.state === "success" || activeAccount.active === true;
          return {
            authenticated: isAuthenticated,
            login: activeAccount.login,
            host: activeAccount.host || hostKey || "github.com",
            protocol: activeAccount.gitProtocol === "ssh" ? "ssh" : "https",
          };
        }
      }
    }
  } catch (err) {
    if (isMissingBinary(err)) {
      return { authenticated: false, notInstalled: true };
    }
    // Fallback: check basic gh auth token
    try {
      const { stdout: token } = await run("gh", ["auth", "token"]);
      if (token.trim().length > 0) {
        return {
          authenticated: true,
          host: "github.com",
          protocol: "https",
        };
      }
    } catch {
      // Not authenticated
    }
  }

  return { authenticated: false };
}

/**
 * Lists user and organization repositories using `gh repo list`.
 */
export async function listUserRepositories(limit = 100, refresh = false): Promise<RepositoryItem[]> {
  return cached(`repo-list:${limit}`, () => fetchUserRepositories(limit), { ttlMs: 300_000, refresh });
}

async function fetchUserRepositories(limit: number): Promise<RepositoryItem[]> {
  try {
    const { stdout } = await run("gh", [
      "repo",
      "list",
      "--limit",
      limit.toString(),
      "--json",
      "nameWithOwner,description,isPrivate,updatedAt",
    ]);
    return JSON.parse(stdout);
  } catch {
    return [];
  }
}

/**
 * Lists user's starred repositories.
 */
export async function listStarredRepositories(limit = 30, refresh = false): Promise<RepositoryItem[]> {
  return cached(`starred:${limit}`, () => fetchStarredRepositories(limit), { ttlMs: 900_000, refresh });
}

async function fetchStarredRepositories(limit: number): Promise<RepositoryItem[]> {
  try {
    const { stdout } = await run("gh", [
      "api",
      `user/starred?per_page=${limit}`,
      "--jq",
      "[.[] | { nameWithOwner: .full_name, description: .description, isPrivate: .private }]",
    ]);
    return JSON.parse(stdout);
  } catch {
    return [];
  }
}

/**
 * Searches repositories on GitHub with live query.
 */
export async function searchRepositories(query: string, limit = 20): Promise<RepositoryItem[]> {
  const trimmedQuery = query?.trim() ?? "";
  if (!trimmedQuery) return [];

  try {
    const { stdout } = await run("gh", [
      "search",
      "repos",
      trimmedQuery,
      "--limit",
      limit.toString(),
      "--json",
      "fullName,description,isPrivate",
    ]);
    const parsed = JSON.parse(stdout);
    return parsed.map((r: { fullName: string; description?: string; isPrivate?: boolean }) => ({
      nameWithOwner: r.fullName,
      description: r.description,
      isPrivate: r.isPrivate,
    }));
  } catch {
    try {
      const { stdout } = await run("gh", [
        "api",
        `search/repositories?q=${encodeURIComponent(trimmedQuery)}&per_page=${limit}`,
        "--jq",
        "[.items[] | { nameWithOwner: .full_name, description: .description, isPrivate: .private }]",
      ]);
      return JSON.parse(stdout);
    } catch {
      return [];
    }
  }
}

/**
 * Normalizes input (e.g. 'owner/repo', 'repo', full URL) into a cloneable URL.
 */
export function normalizeCloneUrl(input: string, preferredProtocol: "https" | "ssh" = "https"): string {
  const trimmed = input?.trim() ?? "";
  if (!trimmed) return "";

  // Already a full git or HTTP/SSH URL
  if (
    trimmed.startsWith("git@") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("ssh://") ||
    trimmed.startsWith("git://")
  ) {
    return trimmed;
  }

  // Handle owner/repo shorthand (e.g. 'owner/repo', 'owner/repo.git', 'owner/repo/')
  if (trimmed.includes("/")) {
    const clean = trimmed.replace(/\/+$/, "").replace(/\.git$/, "");
    if (preferredProtocol === "ssh") {
      return `git@github.com:${clean}.git`;
    }
    return `https://github.com/${clean}.git`;
  }

  return trimmed;
}

/**
 * Creates a GitHub Pull Request using `gh pr create`.
 */
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
  const args = ["pr", "create", "--title", options.title, "--body", options.body];
  if (options.base) args.push("--base", options.base);
  if (options.draft) args.push("--draft");
  if (options.web) args.push("--web");

  const { stdout } = await run("gh", withRepo(args), { cwd: options.cwd || process.cwd() });
  return stdout.trim();
}

export interface PullRequestItem {
  number: number;
  title: string;
  author: { login: string; name?: string };
  headRefName: string;
  state: string;
  url: string;
}

export async function listPullRequests(
  limit = 20,
  cwd = process.cwd(),
): Promise<PullRequestItem[]> {
  try {
    const { stdout } = await run(
      "gh",
      withRepo(["pr", "list", "--limit", limit.toString(), "--json", "number,title,author,headRefName,state,url"]),
      { cwd },
    );
    return JSON.parse(stdout);
  } catch {
    return [];
  }
}

export async function checkoutPullRequest(prNumber: number, cwd = process.cwd()): Promise<void> {
  await run("gh", withRepo(["pr", "checkout", prNumber.toString()]), { cwd, stdio: "inherit" });
}

export async function viewPullRequestInBrowser(prNumber: number, cwd = process.cwd()): Promise<void> {
  await run("gh", withRepo(["pr", "view", "--web", prNumber.toString()]), { cwd });
}

export async function getPullRequestDiff(prNumber: number, cwd = process.cwd()): Promise<string> {
  try {
    const { stdout } = await run("gh", withRepo(["pr", "diff", prNumber.toString()]), { cwd });
    return stdout;
  } catch {
    return "";
  }
}

export interface ReleaseItem {
  name: string;
  tagName: string;
  publishedAt: string;
  isDraft?: boolean;
  isPrerelease?: boolean;
}

export async function listReleases(limit = 10, cwd = process.cwd()): Promise<ReleaseItem[]> {
  try {
    const { stdout } = await run(
      "gh",
      withRepo(["release", "list", "--limit", limit.toString(), "--json", "name,tagName,publishedAt,isDraft,isPrerelease"]),
      { cwd },
    );
    return JSON.parse(stdout);
  } catch {
    return [];
  }
}

export async function createRelease(
  options: {
    tag: string;
    title?: string;
    notes: string;
    draft?: boolean;
    prerelease?: boolean;
    cwd?: string;
  },
): Promise<string> {
  const args = ["release", "create", options.tag, "--notes", options.notes];
  if (options.title) args.push("--title", options.title);
  if (options.draft) args.push("--draft");
  if (options.prerelease) args.push("--prerelease");

  const { stdout } = await run("gh", withRepo(args), { cwd: options.cwd || process.cwd() });
  return stdout.trim();
}

export async function getCommitsSinceTag(tag?: string, cwd = process.cwd()): Promise<string[]> {
  try {
    if (tag) {
      try {
        const { stdout: hasTag } = await run("git", ["tag", "-l", tag], { cwd });
        if (!hasTag.trim()) {
          // Tag not found locally; try to fetch tags from remote
          await run("git", ["fetch", "--tags", "--quiet"], { cwd });
        }
      } catch {
        // Ignore tag fetch failure
      }
    }
    const revRange = tag ? `${tag}..HEAD` : "HEAD";
    const { stdout } = await run(
      "git",
      ["log", revRange, "--pretty=format:%h %s", "-n", "50"],
      { cwd },
    );
    return stdout.split("\n").filter(Boolean);
  } catch {
    // If tag..HEAD failed (e.g. tag deleted or unborn revision), fallback to recent HEAD
    try {
      const { stdout } = await run(
        "git",
        ["log", "HEAD", "--pretty=format:%h %s", "-n", "50"],
        { cwd },
      );
      return stdout.split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }
}

/**
 * T3 Code pattern: Parse a GitHub `owner/repo` identifier from common remote URL shapes.
 */
export function parseGitHubRepositoryNameWithOwnerFromRemoteUrl(url: string | null): string | null {
  const trimmed = url?.trim() ?? "";
  if (trimmed.length === 0) return null;

  const match =
    /^(?:git@github\.com:|ssh:\/\/git@github\.com(?::\d+)?\/|https?:\/\/github\.com\/|git:\/\/github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(
      trimmed,
    );
  const repositoryNameWithOwner = match?.[1]?.trim() ?? "";
  return repositoryNameWithOwner.length > 0 ? repositoryNameWithOwner : null;
}

export interface ActivePullRequestInfo {
  number: number;
  title: string;
  state: string;
  url: string;
}

export async function getActivePullRequest(
  cwd = process.cwd(),
): Promise<ActivePullRequestInfo | null> {
  try {
    const { stdout } = await run(
      "gh",
      withRepo(["pr", "view", "--json", "number,title,state,url"]),
      { cwd, reject: false },
    );
    if (!stdout || !stdout.trim()) return null;
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

export interface CheckRunResult {
  name: string;
  state: string;
  description?: string;
  link?: string;
}

export async function getPullRequestChecks(
  cwd = process.cwd(),
): Promise<CheckRunResult[]> {
  try {
    // gh pr checks exits with 1 (failing) or 2 (pending); reject: false ensures stdout is preserved
    const { stdout } = await run(
      "gh",
      withRepo(["pr", "checks", "--json", "name,state,description,link"]),
      { cwd, reject: false },
    );
    if (!stdout || !stdout.trim()) return [];
    return JSON.parse(stdout);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * Pull request lifecycle
 * ------------------------------------------------------------------ */

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
    const { stdout } = await run("gh", withRepo(args), { cwd, reject: false });
    if (!stdout.trim()) return null;
    return JSON.parse(stdout);
  } catch {
    return null;
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
  if (options.body) args.push("--body", options.body);
  const { stdout, stderr } = await run("gh", withRepo(args), { cwd });
  return (stdout || stderr).trim();
}

export async function setPullRequestState(
  action: "ready" | "close" | "reopen",
  prNumber?: number,
  cwd = process.cwd(),
): Promise<void> {
  const args = ["pr", action, ...(prNumber ? [String(prNumber)] : [])];
  await run("gh", withRepo(args), { cwd });
}

export async function commentOnPullRequest(
  prNumber: number | undefined,
  body: string,
  cwd = process.cwd(),
): Promise<string> {
  const args = ["pr", "comment", ...(prNumber ? [String(prNumber)] : []), "--body", body];
  const { stdout } = await run("gh", withRepo(args), { cwd });
  return stdout.trim();
}

export async function editPullRequest(
  prNumber: number | undefined,
  fields: { title?: string; body?: string; base?: string; addLabel?: string[] },
  cwd = process.cwd(),
): Promise<void> {
  const args = ["pr", "edit", ...(prNumber ? [String(prNumber)] : [])];
  if (fields.title) args.push("--title", fields.title);
  if (fields.body) args.push("--body", fields.body);
  if (fields.base) args.push("--base", fields.base);
  for (const label of fields.addLabel ?? []) args.push("--add-label", label);
  await run("gh", withRepo(args), { cwd });
}

export interface ReviewComment {
  path: string;
  line: number;
  body: string;
}

/**
 * Posts a real GitHub review with line-anchored comments, so AI findings land on
 * the pull request where the team can see them instead of only in the terminal.
 */
export async function submitPullRequestReview(
  prNumber: number,
  options: { event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES"; body: string; comments?: ReviewComment[] },
  cwd = process.cwd(),
): Promise<void> {
  const repo = getFlags().repo || (await getCurrentRepositoryNameWithOwner(cwd));
  if (!repo) throw new Error("Could not determine the repository for this review.");

  const payload: Record<string, unknown> = { event: options.event, body: options.body };
  if (options.comments?.length) {
    payload.comments = options.comments.map((c) => ({ path: c.path, line: c.line, body: c.body }));
  }

  await run("gh", ["api", "--method", "POST", `repos/${repo}/pulls/${prNumber}/reviews`, "--input", "-"], {
    cwd,
    input: JSON.stringify(payload),
  });
}

export async function getCurrentRepositoryNameWithOwner(cwd = process.cwd()): Promise<string | null> {
  try {
    const { stdout } = await run("gh", withRepo(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]), {
      cwd,
      reject: false,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Issues
 * ------------------------------------------------------------------ */

export interface IssueItem {
  number: number;
  title: string;
  state: string;
  url: string;
  author: { login: string };
  labels: Array<{ name: string }>;
  createdAt: string;
}

export interface IssueDetail extends IssueItem {
  body: string;
  comments?: Array<{ author: { login: string }; body: string; createdAt: string }>;
}

export async function listIssues(
  options: { limit?: number; state?: string; assignee?: string; label?: string } = {},
  cwd = process.cwd(),
): Promise<IssueItem[]> {
  try {
    const args = [
      "issue", "list",
      "--limit", String(options.limit ?? 30),
      "--state", options.state ?? "open",
      "--json", "number,title,state,url,author,labels,createdAt",
    ];
    if (options.assignee) args.push("--assignee", options.assignee);
    if (options.label) args.push("--label", options.label);
    const { stdout } = await run("gh", withRepo(args), { cwd });
    return JSON.parse(stdout);
  } catch {
    return [];
  }
}

export async function viewIssue(issueNumber: number, cwd = process.cwd()): Promise<IssueDetail | null> {
  try {
    const args = ["issue", "view", String(issueNumber), "--json",
      "number,title,body,state,url,author,labels,createdAt,comments"];
    const { stdout } = await run("gh", withRepo(args), { cwd, reject: false });
    if (!stdout.trim()) return null;
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

export async function createIssue(
  fields: { title: string; body?: string; labels?: string[]; assignee?: string },
  cwd = process.cwd(),
): Promise<string> {
  const args = ["issue", "create", "--title", fields.title, "--body", fields.body ?? ""];
  for (const label of fields.labels ?? []) args.push("--label", label);
  if (fields.assignee) args.push("--assignee", fields.assignee);
  const { stdout } = await run("gh", withRepo(args), { cwd });
  return stdout.trim();
}

export async function setIssueState(
  action: "close" | "reopen",
  issueNumber: number,
  cwd = process.cwd(),
): Promise<void> {
  await run("gh", withRepo(["issue", action, String(issueNumber)]), { cwd });
}

export async function commentOnIssue(
  issueNumber: number,
  body: string,
  cwd = process.cwd(),
): Promise<string> {
  const { stdout } = await run(
    "gh",
    withRepo(["issue", "comment", String(issueNumber), "--body", body]),
    { cwd },
  );
  return stdout.trim();
}

/* ------------------------------------------------------------------ *
 * Workflow runs
 * ------------------------------------------------------------------ */

export interface WorkflowRun {
  databaseId: number;
  displayTitle: string;
  workflowName: string;
  status: string;
  conclusion: string;
  headBranch: string;
  event: string;
  createdAt: string;
  url: string;
}

export interface WorkflowJob {
  name: string;
  status: string;
  conclusion: string;
  steps?: Array<{ name: string; status: string; conclusion: string; number: number }>;
}

export async function listWorkflowRuns(
  options: { limit?: number; branch?: string; status?: string; workflow?: string } = {},
  cwd = process.cwd(),
): Promise<WorkflowRun[]> {
  try {
    const args = [
      "run", "list", "--limit", String(options.limit ?? 20),
      "--json", "databaseId,displayTitle,workflowName,status,conclusion,headBranch,event,createdAt,url",
    ];
    if (options.branch) args.push("--branch", options.branch);
    if (options.status) args.push("--status", options.status);
    if (options.workflow) args.push("--workflow", options.workflow);
    const { stdout } = await run("gh", withRepo(args), { cwd });
    return JSON.parse(stdout);
  } catch {
    return [];
  }
}

export async function viewWorkflowRun(
  runId: number,
  cwd = process.cwd(),
): Promise<{ run: WorkflowRun; jobs: WorkflowJob[] } | null> {
  try {
    const args = ["run", "view", String(runId), "--json",
      "databaseId,displayTitle,workflowName,status,conclusion,headBranch,event,createdAt,url,jobs"];
    const { stdout } = await run("gh", withRepo(args), { cwd, reject: false });
    if (!stdout.trim()) return null;
    const parsed = JSON.parse(stdout);
    return { run: parsed, jobs: parsed.jobs ?? [] };
  } catch {
    return null;
  }
}

/** Raw log text for the failed steps of a run — the input for AI triage. */
export async function getFailedRunLog(runId: number, cwd = process.cwd()): Promise<string> {
  try {
    const { stdout } = await run("gh", withRepo(["run", "view", String(runId), "--log-failed"]), {
      cwd,
      reject: false,
      timeoutMs: 60_000,
    });
    return stdout;
  } catch {
    return "";
  }
}

export async function rerunWorkflowRun(
  runId: number,
  options: { failedOnly?: boolean } = {},
  cwd = process.cwd(),
): Promise<void> {
  const args = ["run", "rerun", String(runId)];
  if (options.failedOnly) args.push("--failed");
  await run("gh", withRepo(args), { cwd });
}

export async function cancelWorkflowRun(runId: number, cwd = process.cwd()): Promise<void> {
  await run("gh", withRepo(["run", "cancel", String(runId)]), { cwd });
}

/* ------------------------------------------------------------------ *
 * Repositories
 * ------------------------------------------------------------------ */

export interface RepositoryDetail {
  nameWithOwner: string;
  description: string;
  url: string;
  isPrivate: boolean;
  isFork: boolean;
  stargazerCount: number;
  forkCount: number;
  primaryLanguage: { name: string } | null;
  defaultBranchRef: { name: string } | null;
  licenseInfo: { name: string } | null;
  repositoryTopics: Array<{ name: string }>;
  openIssues?: { totalCount: number };
}

export async function viewRepository(
  nameWithOwner?: string,
  cwd = process.cwd(),
): Promise<RepositoryDetail | null> {
  try {
    const fields =
      "nameWithOwner,description,url,isPrivate,isFork,stargazerCount,forkCount,primaryLanguage,defaultBranchRef,licenseInfo,repositoryTopics";
    const args = ["repo", "view", ...(nameWithOwner ? [nameWithOwner] : []), "--json", fields];
    const { stdout } = await run("gh", nameWithOwner ? args : withRepo(args), { cwd, reject: false });
    if (!stdout.trim()) return null;
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

export async function getRepositoryReadme(
  nameWithOwner: string,
  cwd = process.cwd(),
): Promise<string> {
  try {
    const { stdout } = await run(
      "gh",
      ["api", `repos/${nameWithOwner}/readme`, "--jq", ".content"],
      { cwd, reject: false },
    );
    if (!stdout.trim()) return "";
    return Buffer.from(stdout.trim(), "base64").toString("utf-8");
  } catch {
    return "";
  }
}

export async function forkRepository(
  nameWithOwner: string,
  options: { clone?: boolean; remote?: boolean } = {},
  cwd = process.cwd(),
): Promise<string> {
  const args = ["repo", "fork", nameWithOwner, "--clone=" + String(Boolean(options.clone))];
  if (options.remote) args.push("--remote");
  const { stdout, stderr } = await run("gh", args, { cwd });
  return (stdout || stderr).trim();
}

export async function setDefaultRepository(
  nameWithOwner: string,
  cwd = process.cwd(),
): Promise<void> {
  await run("gh", ["repo", "set-default", nameWithOwner], { cwd });
}

export async function createRepository(
  fields: { name: string; visibility: "public" | "private" | "internal"; description?: string; push?: boolean; source?: string },
  cwd = process.cwd(),
): Promise<string> {
  const args = ["repo", "create", fields.name, `--${fields.visibility}`];
  if (fields.description) args.push("--description", fields.description);
  if (fields.source) args.push("--source", fields.source);
  if (fields.push) args.push("--push");
  const { stdout, stderr } = await run("gh", args, { cwd });
  return (stdout || stderr).trim();
}

/** Direct passthrough to `gh api`, the escape hatch for anything unwrapped. */
export async function ghApi(args: string[], cwd = process.cwd()): Promise<number> {
  const result = await run("gh", ["api", ...args], { cwd, stdio: "inherit", reject: false });
  return result.exitCode;
}
