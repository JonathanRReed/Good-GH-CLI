/**
 * GitHub transport: gh wrappers, auth, pagination, caching helpers, and URL builders. Leaf module.
 */

import { run, type RunOptions, type RunResult } from "../../utils/exec.ts";
import { getFlags } from "../runtime.ts";


export interface GitHubAccount {
  authenticated: boolean;
  login?: string;
  host?: string;
  protocol?: "https" | "ssh";
  /** True when the `gh` binary itself is missing from PATH (distinct from being logged out). */
  notInstalled?: boolean;
}


export interface ParsedRepoName {
  host: string;
  nameWithOwner: string;
  toString(): string;
}


export type GitHubErrorKind =
  | "not_installed"
  | "not_authenticated"
  | "not_found"
  | "forbidden"
  | "rate_limit"
  | "unknown";


export class GitHubError extends Error {
  readonly kind: GitHubErrorKind;
  constructor(kind: GitHubErrorKind, message: string) {
    super(message);
    this.name = "GitHubError";
    this.kind = kind;
  }
}

function isMissingBinary(err: unknown): boolean {
  return (err as { code?: string })?.code === "ENOENT";
}

function extractText(err: unknown): string {
  return [
    (err as { stdout?: string })?.stdout,
    (err as { stderr?: string })?.stderr,
    err instanceof Error ? err.message : String(err),
  ]
    .filter((s): s is string => Boolean(s && s.trim()))
    .join("\n");
}


export function classifyGitHubError(err: unknown, context = ""): GitHubError {
  if (err instanceof GitHubError) return err;
  if (isMissingBinary(err)) {
    return new GitHubError(
      "not_installed",
      "GitHub CLI (`gh`) is not installed. Install it from https://cli.github.com.",
    );
  }
  const extracted = extractText(err);
  const text = extracted.toLowerCase();
  if (
    /not logged|not authenticated|not signed in|please run gh auth login|no oauth token|you are not logged|unauthorized|authentication failed/i.test(
      text,
    )
  ) {
    return new GitHubError("not_authenticated", "GitHub CLI is not authenticated. Run `gh auth login`.");
  }
  if (/rate limit|api rate limit|too many requests|429/.test(text)) {
    return new GitHubError("rate_limit", "GitHub API rate limit reached. Wait a moment and try again.");
  }
  if (/http 404|404: not found|404 not found|not found/.test(text)) {
    return new GitHubError(
      "not_found",
      context ? `${context} not found.` : "GitHub resource not found.",
    );
  }
  if (/http 403|403|forbidden/.test(text)) {
    return new GitHubError(
      "forbidden",
      context ? `${context} forbidden.` : "Permission denied by GitHub.",
    );
  }
  const detail = extracted.trim().slice(0, 200);
  return new GitHubError(
    "unknown",
    context ? `${context} failed: ${detail}` : `GitHub CLI error: ${detail}`,
  );
}

let cachedHost: string | undefined;


export function getActiveHost(): string {
  return cachedHost || process.env.GH_HOST || "github.com";
}


export interface RepoRef {
  host: string;
  owner: string;
  repo: string;
  nameWithOwner: string;
  repoArg: string;
}

let cachedRepoFlag: RepoRef | null | undefined;


export function parseRepoFlag(repo = getFlags().repo): RepoRef | null {
  if (!repo) return null;
  if (cachedRepoFlag !== undefined && repo === getFlags().repo) return cachedRepoFlag;
  const trimmed = repo.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const parts = trimmed.split("/");
  if (parts.length === 3) {
    // split() always yields strings, but the type is string|undefined —
    // default rather than assert so malformed input behaves as before.
    const host = parts[0] ?? "";
    const owner = parts[1] ?? "";
    const repoName = parts[2] ?? "";
    cachedRepoFlag = {
      host,
      owner,
      repo: repoName,
      nameWithOwner: `${owner}/${repoName}`,
      repoArg: `${host}/${owner}/${repoName}`,
    };
    return cachedRepoFlag;
  }
  if (parts.length === 2) {
    const owner = parts[0] ?? "";
    const repoName = parts[1] ?? "";
    const host = getActiveHost();
    cachedRepoFlag = {
      host,
      owner,
      repo: repoName,
      nameWithOwner: `${owner}/${repoName}`,
      repoArg: host !== "github.com" ? `${host}/${owner}/${repoName}` : `${owner}/${repoName}`,
    };
    return cachedRepoFlag;
  }
  cachedRepoFlag = null;
  return null;
}

function mergeEnv(options?: RunOptions): NodeJS.ProcessEnv | undefined {
  const base = options?.env ? { ...options.env } : undefined;
  const host = getActiveHost();
  if (host === "github.com" && !base) return undefined;
  if (host === "github.com") return base;
  return { ...base, GH_HOST: host };
}

/** Appends `-R owner/name` when the user targeted another repository. */


export function withRepo(args: string[]): string[] {
  const parsed = parseRepoFlag();
  return parsed ? [...args, "--repo", parsed.repoArg] : args;
}

/** Run a `gh` command that supports the inherited `-R` flag. */


export async function gh(args: string[], options: RunOptions = {}): Promise<RunResult> {
  return run("gh", withRepo(args), { ...options, env: mergeEnv(options) });
}

/** Run a `gh` command that does not support `-R` (auth, search, gist, notifications). */


export async function ghGlobal(args: string[], options: RunOptions = {}): Promise<RunResult> {
  return run("gh", args, { ...options, env: mergeEnv(options) });
}

/** Builds a `gh` request whose long-form text is read from stdin. */
export function stdinTextRequest(
  args: string[],
  flag: "--body-file" | "--notes-file",
  input: string,
): { args: string[]; input: string } {
  return { args: [...args, flag, "-"], input };
}

/** Run `gh api` with `GH_REPO` and `GH_HOST` set when `-R` is used. */


export async function ghApi(args: string[], options: RunOptions = {}): Promise<RunResult> {
  const parsed = parseRepoFlag();
  const extra: NodeJS.ProcessEnv = {};
  if (parsed) {
    extra.GH_REPO = parsed.nameWithOwner;
    if (parsed.host !== "github.com") extra.GH_HOST = parsed.host;
  } else {
    const host = getActiveHost();
    if (host !== "github.com") extra.GH_HOST = host;
  }
  return run("gh", ["api", ...args], { ...options, env: { ...options.env, ...extra } });
}

/**
 * Paginates a user-scoped `gh api` endpoint (no `GH_REPO`) by following page
 * parameters until exhausted. Uses `--paginate` under the hood and
 * concatenates JSON arrays. Non-array responses are returned as-is.
 * Respects `maxPages` to avoid unbounded fetches.
 */
export async function paginateGhGlobal<T = unknown>(
  endpoint: string,
  options: { perPage?: number; maxPages?: number; params?: string[] } = {},
): Promise<T[]> {
  return paginateGhEndpoint<T>(endpoint, options, true);
}

async function paginateGhEndpoint<T>(
  endpoint: string,
  options: { perPage?: number; maxPages?: number; params?: string[] },
  global: boolean,
): Promise<T[]> {
  const perPage = options.perPage ?? 100;
  const maxPages = options.maxPages ?? 20;
  const params = options.params ?? [];
  const results: T[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const separator = endpoint.includes("?") ? "&" : "?";
    const url = `${endpoint}${separator}per_page=${perPage}&page=${page}`;
    const runner = global ? ghGlobal : ghApi;
    const { stdout } = await runner([url, ...params]);
    let batch: T[];
    try {
      const parsed = JSON.parse(stdout);
      batch = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      break;
    }
    if (batch.length === 0) break;
    results.push(...batch);
    if (batch.length < perPage) break; // last page
  }

  return results;
}

/** Direct passthrough to `gh api` for the `ggh api` escape hatch. */


export async function ghApiPassthrough(endpoint: string[], cwd = process.cwd()): Promise<number> {
  const result = await ghApi(endpoint, { cwd, stdio: "inherit", reject: false });
  return result.exitCode;
}

/**
 * Probes GitHub CLI auth status using `gh auth status --json hosts`.
 * The detected host is cached so subsequent `gh` invocations can set `GH_HOST`.
 */

const authCache = new Map<string, Promise<GitHubAccount>>();

export async function getGitHubAuthStatus(host = getActiveHost()): Promise<GitHubAccount> {
  const key = host || "github.com";
  const hit = authCache.get(key);
  if (hit) return hit;
  const pending = fetchAuthStatus(host);
  authCache.set(key, pending);
  return pending;
}

async function fetchAuthStatus(host: string): Promise<GitHubAccount> {
  const args = ["auth", "status", "--json", "hosts"];
  if (host && host !== "github.com") args.push("--hostname", host);
  try {
    const { stdout } = await ghGlobal(args);
    if (stdout && stdout.trim()) {
      const parsed = JSON.parse(stdout);
      const hostsObj = parsed?.hosts;
      if (hostsObj && typeof hostsObj === "object") {
        const hostKeys = Object.keys(hostsObj);
        const hostKey =
          (host && hostsObj[host] ? host : undefined) ||
          (hostsObj["github.com"] ? "github.com" : hostKeys[0]) ||
          host ||
          "github.com";
        const accounts = hostsObj[hostKey];
        const accountList = (Array.isArray(accounts) ? accounts : accounts ? [accounts] : []).filter(
          (acc: unknown): acc is Record<string, unknown> => typeof acc === "object" && acc !== null,
        );
        if (accountList.length > 0) {
          const activeAccount =
            accountList.find((acc) => acc.active === true) ?? accountList[0];
          if (!activeAccount) return { authenticated: false };
          const isAuthenticated = activeAccount.state === "success" || activeAccount.active === true;
          const finalHost = String(activeAccount.host || hostKey || host || "github.com");
          cachedHost = finalHost;
          return {
            authenticated: isAuthenticated,
            login: typeof activeAccount.login === "string" ? activeAccount.login : undefined,
            host: finalHost,
            protocol: activeAccount.gitProtocol === "ssh" ? "ssh" : "https",
          };
        }
      }
    }
  } catch (err) {
    if (isMissingBinary(err)) {
      return { authenticated: false, notInstalled: true };
    }
    try {
      const tokenArgs = ["auth", "token"];
      if (host && host !== "github.com") tokenArgs.push("--hostname", host);
      const { stdout: token } = await ghGlobal(tokenArgs);
      if (token.trim().length > 0) {
        cachedHost = host || "github.com";
        return {
          authenticated: true,
          host: cachedHost,
          protocol: "https",
        };
      }
    } catch {
      // Not authenticated
    }
  }
  return { authenticated: false, host };
}

/**
 * Checks GitHub auth and calls `fail()` with a helpful message if not
 * authenticated. Returns `true` when safe to proceed. Replaces 12 copies of
 * the same guard across command files.
 */


export async function requireAuth(): Promise<boolean> {
  const auth = await getGitHubAuthStatus();
  if (auth.authenticated) return true;
  const { fail } = await import("../../utils/ui.ts");
  fail(
    auth.notInstalled
      ? "GitHub CLI (`gh`) is not installed. Install it from https://cli.github.com."
      : "GitHub CLI is not authenticated. Run `gh auth login`.",
  );
  return false;
}


export function clampLimit(n: number, max = 1000, defaultValue = 30): number {
  const parsed = Number.isFinite(n) ? n : Number.parseInt(String(n), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return Math.min(parsed, max);
}

/**
 * Normalizes input (e.g. 'owner/repo', 'repo', full URL) into a cloneable URL.
 * For a bare owner/repo shorthand the host is taken from the active auth host.
 */


export function normalizeCloneUrl(
  input: string,
  preferredProtocol: "https" | "ssh" = "https",
  host = getActiveHost(),
): string {
  const trimmed = input?.trim() ?? "";
  if (!trimmed) return "";

  if (
    trimmed.startsWith("git@") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("ssh://") ||
    trimmed.startsWith("git://")
  ) {
    return trimmed;
  }

  if (trimmed.includes("/")) {
    const clean = trimRepositorySuffix(trimmed);
    if (preferredProtocol === "ssh") {
      return `git@${host}:${clean}.git`;
    }
    return `https://${host}/${clean}.git`;
  }

  return trimmed;
}


export function trimRepositorySuffix(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  if (end >= 4 && value.slice(end - 4, end) === ".git") end -= 4;
  return value.slice(0, end);
}

/**
 * Parses a GitHub `owner/repo` identifier out of any common remote URL shape.
 * For github.com the legacy string is returned; for other hosts an object with
 * `host` and `nameWithOwner` is returned so GHES remotes keep their hostname.
 */


export function parseGitHubRepositoryNameWithOwnerFromRemoteUrl(
  url: string | null,
): string | ParsedRepoName | null {
  const trimmed = url?.trim() ?? "";
  if (trimmed.length === 0) return null;

  const match = new RegExp(
    "^(?:git@([^:\\s]+):|ssh://git@([^/\\s:]+)(?::\\d+)?/|https?://([^/\\s:]+)/|git://([^/\\s:]+)/)([^/\\s]+/[^/\\s]+?)(?:\\.git)?/?$",
    "i",
  ).exec(trimmed);
  if (!match) return null;

  const host = match[1] || match[2] || match[3] || match[4] || "github.com";
  const rawName = match[5];
  if (!rawName) return null;
  const nameWithOwner = rawName.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  if (nameWithOwner.length === 0) return null;

  if (host === "github.com") return nameWithOwner;
  return { host, nameWithOwner, toString: () => `${host}/${nameWithOwner}` };
}


export function getPullRequestUrl(nameWithOwner: string, number: number, host = getActiveHost()): string {
  return `https://${host}/${nameWithOwner}/pull/${number}`;
}


export function getIssueUrl(nameWithOwner: string, number: number, host = getActiveHost()): string {
  return `https://${host}/${nameWithOwner}/issues/${number}`;
}

/* ------------------------------------------------------------------ *
 * Repositories
 * ------------------------------------------------------------------ */


export async function getCurrentRepositoryNameWithOwner(cwd = process.cwd()): Promise<string | null> {
  const parsed = parseRepoFlag();
  if (parsed) return parsed.nameWithOwner;
  try {
    const { stdout } = await ghGlobal(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], {
      cwd,
      reject: false,
    });
    return stdout.trim() || null;
  } catch (err) {
    throw classifyGitHubError(err, "current repository");
  }
}
