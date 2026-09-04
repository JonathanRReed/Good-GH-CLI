import { realpathSync } from "node:fs";
import { cached, type CacheOptions } from "../cache.ts";
import { run } from "../../utils/exec.ts";
import { getActiveHost, getCurrentRepositoryNameWithOwner, getGitHubAuthStatus, parseRepoFlag } from "./client.ts";

/** Never share results across principals, hosts, explicit targets or checkouts. */
export async function cachedGitHub<T>(
  key: string,
  fetcher: () => Promise<T>,
  options: CacheOptions & { cwd?: string; scope?: "repository" | "account" } = {},
): Promise<T> {
  // Two tokens for the same login can grant different repository scopes.
  // Never persist or hash credentials, and never reuse disk data across them.
  if (["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"].some((key) => process.env[key])) return fetcher();
  const explicit = parseRepoFlag();
  const host = options.scope === "account" ? getActiveHost() : explicit?.host ?? getActiveHost();
  let namespace: string;
  try {
    const auth = await getGitHubAuthStatus(host, true);
    // Unknown token identity must not reuse another credential's cached response.
    if (!auth.authenticated || !auth.login || auth.host?.toLowerCase() !== host.toLowerCase()) return fetcher();
    let repository: string | null = null;
    let checkout: string | null = null;
    if (options.scope !== "account") {
      repository = explicit?.nameWithOwner ?? await getCurrentRepositoryNameWithOwner(options.cwd);
      if (!repository) return fetcher();
      const root = await run("git", ["rev-parse", "--show-toplevel"], { cwd: options.cwd, reject: false });
      if (root.exitCode === 0) checkout = realpathSync(root.stdout.trim());
    }
    namespace = JSON.stringify([2, host.toLowerCase(), auth.login.toLowerCase(), repository?.toLowerCase(),
      checkout, options.scope ?? "repository", process.env.GH_REPO ?? null, explicit?.repoArg ?? null]);
  } catch {
    // No reliable namespace, or no Git installed for a remote call: fetch uncached.
    return fetcher();
  }
  return cached(`${key}:identity=${namespace}`, fetcher, options);
}
