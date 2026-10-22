import { cachedGitHub } from "./cache.ts";
import { classifyGitHubError, ghGlobal } from "./client.ts";
import type { RepositoryItem } from "./repos.ts";

const SOURCE_LIMIT = 1000;
const REPO_FIELDS = "[.[] | {nameWithOwner: .full_name, description: .description, isPrivate: .private, updatedAt: .updated_at}]";

async function pages<T>(endpoint: string, jq: string, limit = SOURCE_LIMIT): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; items.length < limit; page++) {
    const separator = endpoint.includes("?") ? "&" : "?";
    const { stdout } = await ghGlobal(["api", `${endpoint}${separator}per_page=100&page=${page}`, "--jq", jq]);
    const batch: T[] = JSON.parse(stdout);
    if (!Array.isArray(batch)) throw new Error("Expected a repository list from GitHub.");
    items.push(...batch.slice(0, limit - items.length));
    if (batch.length < 100) break;
  }
  return items;
}

/** The cache layer scopes this list to the active host and credential/account. */
export async function listCloneRepositories(refresh = false): Promise<RepositoryItem[]> {
  return cachedGitHub("clone-repositories:v1", async () => {
    try {
      const [owned, stars, orgs] = await Promise.all([
        pages<RepositoryItem>("user/repos?affiliation=owner&sort=updated", REPO_FIELDS),
        pages<RepositoryItem>("user/starred", REPO_FIELDS),
        pages<string>("user/orgs", "[.[].login]"),
      ]);
      const organizations: RepositoryItem[] = [];
      for (const org of orgs) {
        if (organizations.length >= SOURCE_LIMIT) break;
        organizations.push(...await pages<RepositoryItem>(`orgs/${encodeURIComponent(org)}/repos?sort=updated`, REPO_FIELDS, SOURCE_LIMIT - organizations.length));
      }
      const unique = new Map<string, RepositoryItem>();
      for (const repo of [...owned, ...organizations, ...stars]) unique.set(repo.nameWithOwner.toLowerCase(), repo);
      return [...unique.values()];
    } catch (error) { throw classifyGitHubError(error, "clone repository discovery"); }
  }, { refresh, ttlMs: 300_000, scope: "account" });
}

export function matchCloneRepositories(repos: RepositoryItem[], query: string): RepositoryItem[] {
  const needle = query.toLowerCase();
  return repos.filter(repo => {
    const haystack = `${repo.nameWithOwner} ${repo.description ?? ""}`.toLowerCase();
    let index = 0;
    for (const char of haystack) if (char === needle[index]) index++;
    return index === needle.length;
  });
}
