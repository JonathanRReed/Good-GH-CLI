/**
 * Release operations. Depends on client only.
 */

import { clampLimit, classifyGitHubError, gh, stdinTextRequest } from "./client.ts";
import { run } from "../../utils/exec.ts";
import { invalidateCache } from "../cache.ts";
import { cachedGitHub } from "./cache.ts";

export interface ReleaseItem {
  name: string;
  tagName: string;
  publishedAt: string;
  isDraft?: boolean;
  isPrerelease?: boolean;
}


export async function listReleases(limit = 30, cwd = process.cwd()): Promise<ReleaseItem[]> {
  const n = clampLimit(limit);
  return cachedGitHub(`release-list:${n}`, () => fetchReleases(n, cwd), { ttlMs: 300_000, cwd });
}

async function fetchReleases(limit: number, cwd = process.cwd()): Promise<ReleaseItem[]> {
  try {
    const { stdout } = await gh(
      ["release", "list", "--limit", String(limit), "--json", "name,tagName,publishedAt,isDraft,isPrerelease"],
      { cwd },
    );
    return JSON.parse(stdout);
  } catch (err) {
    throw classifyGitHubError(err, "release list");
  }
}


export async function viewRelease(tag: string, cwd = process.cwd()): Promise<unknown | null> {
  try {
    const { stdout } = await gh(["release", "view", tag, "--json", "name,tagName,body,publishedAt,url,isDraft,isPrerelease"], {
      cwd,
      reject: false,
    });
    if (!stdout.trim()) return null;
    return JSON.parse(stdout);
  } catch (err) {
    throw classifyGitHubError(err, "release view");
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
  const request = stdinTextRequest(["release", "create", options.tag], "--notes-file", options.notes);
  const args = request.args;
  if (options.title) args.push("--title", options.title);
  if (options.draft) args.push("--draft");
  if (options.prerelease) args.push("--prerelease");

  try {
    const { stdout } = await gh(args, { cwd: options.cwd || process.cwd(), input: request.input });
    return stdout.trim();
  } catch (err) {
    throw classifyGitHubError(err, "create release");
  } finally {
    invalidateCache("release-list:");
  }
}


export async function deleteRelease(tag: string, cleanupTag = false, cwd = process.cwd()): Promise<void> {
  const args = ["release", "delete", tag, "--yes"];
  if (cleanupTag) args.push("--cleanup-tag");
  try {
    await gh(args, { cwd });
  } catch (err) {
    throw classifyGitHubError(err, "delete release");
  } finally {
    invalidateCache("release-list:");
  }
}


export async function downloadRelease(
  tag: string,
  options: { pattern?: string; dir?: string } = {},
  cwd = process.cwd(),
): Promise<void> {
  const args = ["release", "download", tag];
  if (options.pattern) args.push("-p", options.pattern);
  if (options.dir) args.push("-D", options.dir);
  try {
    await gh(args, { cwd });
  } catch (err) {
    throw classifyGitHubError(err, "download release");
  }
}


export async function uploadRelease(
  tag: string,
  files: string[],
  cwd = process.cwd(),
): Promise<void> {
  const args = ["release", "upload", tag, ...files];
  try {
    await gh(args, { cwd });
  } catch (err) {
    throw classifyGitHubError(err, "upload release assets");
  }
}


export async function getCommitsSinceTag(tag?: string, cwd = process.cwd()): Promise<string[]> {
  try {
    if (tag) {
      try {
        const { stdout: hasTag } = await run("git", ["tag", "-l", tag], { cwd });
        if (!hasTag.trim()) {
          await run("git", ["fetch", "--tags", "--quiet"], { cwd });
        }
      } catch {
        // Ignore tag fetch failure
      }
    }
    const revRange = tag ? `${tag}..HEAD` : "HEAD";
    const { stdout } = await run("git", ["log", revRange, "--pretty=format:%h %s", "-n", "50"], { cwd });
    return stdout.split("\n").filter(Boolean);
  } catch {
    try {
      const { stdout } = await run("git", ["log", "HEAD", "--pretty=format:%h %s", "-n", "50"], { cwd });
      return stdout.split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }
}
