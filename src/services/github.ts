import { execa } from "execa";

export interface GitHubAccount {
  authenticated: boolean;
  login?: string;
  host?: string;
  protocol?: "https" | "ssh";
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
    const { stdout } = await execa("gh", ["auth", "status", "--json", "hosts"]);
    const parsed = JSON.parse(stdout);
    const githubHosts = parsed?.hosts?.["github.com"];
    if (Array.isArray(githubHosts) && githubHosts.length > 0) {
      const activeAccount = githubHosts.find((acc: { active?: boolean }) => acc.active) || githubHosts[0];
      return {
        authenticated: activeAccount.state === "success",
        login: activeAccount.login,
        host: activeAccount.host || "github.com",
        protocol: activeAccount.gitProtocol === "ssh" ? "ssh" : "https",
      };
    }
  } catch {
    // Fallback: check basic gh auth token
    try {
      const { stdout: token } = await execa("gh", ["auth", "token"]);
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
export async function listUserRepositories(limit = 100): Promise<RepositoryItem[]> {
  try {
    const { stdout } = await execa("gh", [
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
export async function listStarredRepositories(limit = 30): Promise<RepositoryItem[]> {
  try {
    const { stdout } = await execa("gh", [
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
  try {
    const { stdout } = await execa("gh", [
      "search",
      "repos",
      query,
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
      const { stdout } = await execa("gh", [
        "api",
        `search/repositories?q=${encodeURIComponent(query)}&per_page=${limit}`,
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
  const trimmed = input.trim();

  // Already a full git or HTTP URL
  if (trimmed.startsWith("git@") || trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
    return trimmed;
  }

  // Handle owner/repo shorthand
  if (trimmed.includes("/")) {
    if (preferredProtocol === "ssh") {
      return `git@github.com:${trimmed}.git`;
    }
    return `https://github.com/${trimmed}.git`;
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
    cwd?: string;
  },
): Promise<string> {
  const args = ["pr", "create", "--title", options.title, "--body", options.body];
  if (options.draft) args.push("--draft");
  if (options.web) args.push("--web");

  const { stdout } = await execa("gh", args, { cwd: options.cwd || process.cwd() });
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
    const { stdout } = await execa(
      "gh",
      ["pr", "list", "--limit", limit.toString(), "--json", "number,title,author,headRefName,state,url"],
      { cwd },
    );
    return JSON.parse(stdout);
  } catch {
    return [];
  }
}

export async function checkoutPullRequest(prNumber: number, cwd = process.cwd()): Promise<void> {
  await execa("gh", ["pr", "checkout", prNumber.toString()], { cwd, stdio: "inherit" });
}

export async function viewPullRequestInBrowser(prNumber: number, cwd = process.cwd()): Promise<void> {
  await execa("gh", ["pr", "view", "--web", prNumber.toString()], { cwd });
}

export async function getPullRequestDiff(prNumber: number, cwd = process.cwd()): Promise<string> {
  try {
    const { stdout } = await execa("gh", ["pr", "diff", prNumber.toString()], { cwd });
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
    const { stdout } = await execa(
      "gh",
      ["release", "list", "--limit", limit.toString(), "--json", "name,tagName,publishedAt,isDraft,isPrerelease"],
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

  const { stdout } = await execa("gh", args, { cwd: options.cwd || process.cwd() });
  return stdout.trim();
}

export async function getCommitsSinceTag(tag?: string, cwd = process.cwd()): Promise<string[]> {
  try {
    const revRange = tag ? `${tag}..HEAD` : "HEAD";
    const { stdout } = await execa(
      "git",
      ["log", revRange, "--pretty=format:%h %s", "-n", "50"],
      { cwd },
    );
    return stdout.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * T3 Code pattern: Parse a GitHub `owner/repo` identifier from common remote URL shapes.
 */
export function parseGitHubRepositoryNameWithOwnerFromRemoteUrl(url: string | null): string | null {
  const trimmed = url?.trim() ?? "";
  if (trimmed.length === 0) return null;

  const match =
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/|git:\/\/github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(
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
    const { stdout } = await execa("gh", ["pr", "view", "--json", "number,title,state,url"], { cwd });
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
    const { stdout } = await execa("gh", ["pr", "checks", "--json", "name,state,description,link"], { cwd });
    return JSON.parse(stdout);
  } catch {
    return [];
  }
}
