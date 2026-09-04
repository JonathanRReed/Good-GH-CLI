/**
 * Repository read/write operations. Depends on client only.
 */

import { clampLimit, classifyGitHubError, ghApi, ghGlobal, parseRepoFlag } from "./client.ts";
import { invalidateCache } from "../cache.ts";
import { cachedGitHub } from "./cache.ts";

export interface RepositoryItem {
  nameWithOwner: string;
  description?: string;
  isPrivate?: boolean;
  updatedAt?: string;
}


export async function listUserRepositories(
  options: { limit?: number; owner?: string; fork?: boolean; source?: boolean; archived?: boolean; language?: string } = {},
  refresh = false,
): Promise<RepositoryItem[]> {
  const limit = clampLimit(options.limit ?? 30);
  const key = `repo-list:${JSON.stringify([options.owner ?? "@me", limit, options.fork, options.source, options.archived, options.language])}`;
  return cachedGitHub(
    key,
    () => fetchUserRepositories({ ...options, limit }),
    { ttlMs: 300_000, refresh, scope: "account" },
  );
}

async function fetchUserRepositories(
  options: { limit: number; owner?: string; fork?: boolean; source?: boolean; archived?: boolean; language?: string },
): Promise<RepositoryItem[]> {
  const args = ["repo", "list"];
  if (options.owner) args.push(options.owner);
  args.push("--limit", String(options.limit), "--json", "nameWithOwner,description,isPrivate,updatedAt");
  if (options.fork) args.push("--fork");
  if (options.source) args.push("--source");
  if (options.archived) args.push("--archived");
  if (options.language) args.push("--language", options.language);
  try {
    const { stdout } = await ghGlobal(args);
    return JSON.parse(stdout);
  } catch (err) {
    throw classifyGitHubError(err, "repo list");
  }
}


export async function listStarredRepositories(limit = 30, refresh = false): Promise<RepositoryItem[]> {
  const n = clampLimit(limit);
  return cachedGitHub(`starred:${n}`, () => fetchStarredRepositories(n), { ttlMs: 900_000, refresh, scope: "account" });
}

async function fetchStarredRepositories(limit: number): Promise<RepositoryItem[]> {
  const pageSize = Math.min(limit, 100);
  const items: RepositoryItem[] = [];
  try {
    for (let page = 1; items.length < limit; page++) {
      const perPage = Math.min(pageSize, limit - items.length);
      const { stdout } = await ghGlobal([
        "api",
        `user/starred?per_page=${perPage}&page=${page}`,
        "--jq",
        "[.[] | { nameWithOwner: .full_name, description: .description, isPrivate: .private }]",
      ]);
      const parsed: RepositoryItem[] = JSON.parse(stdout);
      if (!Array.isArray(parsed) || parsed.length === 0) break;
      items.push(...parsed);
      if (parsed.length < perPage) break;
    }
  } catch (err) {
    throw classifyGitHubError(err, "starred repositories");
  }
  return items;
}


export async function searchRepositories(
  query: string,
  options: { limit?: number; owner?: string; language?: string; archived?: string } = {},
): Promise<RepositoryItem[]> {
  const limit = clampLimit(options.limit ?? 30);
  const trimmedQuery = query?.trim() ?? "";
  if (!trimmedQuery) return [];

  try {
    const args = ["search", "repos", trimmedQuery, "--limit", String(limit), "--json", "fullName,description,isPrivate"];
    if (options.owner) args.push("--owner", options.owner);
    if (options.language) args.push("--language", options.language);
    if (options.archived) args.push("--archived", options.archived);
    const { stdout } = await ghGlobal(args);
    const parsed = JSON.parse(stdout);
    return parsed.map((r: { fullName: string; description?: string; isPrivate?: boolean }) => ({
      nameWithOwner: r.fullName,
      description: r.description,
      isPrivate: r.isPrivate,
    }));
  } catch (err) {
    throw classifyGitHubError(err, "search repositories");
  }
}


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

function repoViewArg(nameWithOwner?: string): string[] {
  const parsed = nameWithOwner ? undefined : parseRepoFlag();
  const target = nameWithOwner || parsed?.repoArg || "";
  return target ? ["repo", "view", target] : ["repo", "view"];
}


export async function viewRepository(
  nameWithOwner?: string,
  cwd = process.cwd(),
): Promise<RepositoryDetail | null> {
  const fields =
    "nameWithOwner,description,url,isPrivate,isFork,stargazerCount,forkCount,primaryLanguage,defaultBranchRef,licenseInfo,repositoryTopics";
  const args = [...repoViewArg(nameWithOwner), "--json", fields];
  try {
    const { stdout } = await ghGlobal(args, { cwd, reject: false });
    if (!stdout.trim()) return null;
    return JSON.parse(stdout);
  } catch (err) {
    throw classifyGitHubError(err, "repository view");
  }
}


export async function getRepositoryReadme(
  nameWithOwner: string,
  cwd = process.cwd(),
): Promise<string> {
  try {
    const { stdout } = await ghApi([`repos/${nameWithOwner}/readme`, "--jq", ".content"], {
      cwd,
      reject: false,
    });
    const trimmed = stdout.trim();
    if (!trimmed) return "";
    return Buffer.from(trimmed, "base64").toString("utf-8");
  } catch (err) {
    throw classifyGitHubError(err, "README");
  }
}


export async function forkRepository(
  nameWithOwner: string,
  options: { clone?: boolean; remote?: boolean } = {},
  cwd = process.cwd(),
): Promise<string> {
  const args = ["repo", "fork", nameWithOwner, "--clone=" + String(Boolean(options.clone))];
  if (options.remote) args.push("--remote");
  try {
    const { stdout, stderr } = await ghGlobal(args, { cwd });
    return (stdout || stderr).trim();
  } catch (err) {
    throw classifyGitHubError(err, "fork repository");
  } finally {
    invalidateCache("repo-list:");
  }
}


export async function setDefaultRepository(nameWithOwner: string, cwd = process.cwd()): Promise<void> {
  try {
    await ghGlobal(["repo", "set-default", nameWithOwner], { cwd });
  } catch (err) {
    throw classifyGitHubError(err, "set default repository");
  }
}


export async function createRepository(
  fields: {
    name: string;
    visibility: "public" | "private" | "internal";
    description?: string;
    push?: boolean;
    source?: string;
  },
  cwd = process.cwd(),
): Promise<string> {
  const args = ["repo", "create", fields.name, `--${fields.visibility}`];
  if (fields.description) args.push("--description", fields.description);
  if (fields.source) args.push("--source", fields.source);
  if (fields.push) args.push("--push");
  try {
    const { stdout, stderr } = await ghGlobal(args, { cwd });
    return (stdout || stderr).trim();
  } catch (err) {
    throw classifyGitHubError(err, "create repository");
  } finally {
    invalidateCache("repo-list:");
  }
}

/* ------------------------------------------------------------------ *
 * Pull requests
 * ------------------------------------------------------------------ */
