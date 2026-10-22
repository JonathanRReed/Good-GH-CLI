import { join } from "node:path";
import { run } from "../utils/exec.ts";
import { getRepoRoot, getRemotes } from "./git/branch.ts";
import { checkoutForReview } from "./git/worktree.ts";
import { gh, parseGitHubRepositoryNameWithOwnerFromRemoteUrl, parseRepoFlag } from "./github/client.ts";
import { getReviewThreads } from "./github/review-threads.ts";
import { setFlags } from "./runtime.ts";
import { reviewChanges, type ReviewSince } from "./review/changes.ts";
import { isReviewSha, markReview, readReviewMark } from "./review/ledger.ts";

export interface ReviewSnapshot {
  pr: { number: number; url: string; host: string; owner: string; repo: string };
  headSha: string;
  baseSha: string;
}

export interface ReviewResult extends ReviewSnapshot {
  schemaVersion: 1;
  checkoutPath: string;
  surface: "editor" | "tuicr" | "delta" | "renderer" | "data";
  since?: ReviewSince;
  marked?: true;
}

export async function resolveReview(number: number, cwd = process.cwd()): Promise<ReviewSnapshot> {
  const { stdout } = await gh(["pr", "view", String(number), "--json", "number,url,headRefOid,baseRefOid"], { cwd });
  const value: unknown = JSON.parse(stdout);
  if (typeof value !== "object" || value === null || !("number" in value) || value.number !== number ||
      !("url" in value) || typeof value.url !== "string" ||
      !("headRefOid" in value) || !isReviewSha(value.headRefOid) ||
      !("baseRefOid" in value) || !isReviewSha(value.baseRefOid)) throw new Error("Invalid PR revision data from GitHub.");
  const url = new URL(value.url);
  const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/.exec(url.pathname);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !match || Number(match[3]) !== number) throw new Error("Invalid PR URL from GitHub.");
  const target = parseRepoFlag(`${url.host}/${match[1]}/${match[2]}`);
  if (!target) throw new Error("Invalid PR repository.");
  const requested = parseRepoFlag();
  if (requested && requested.repoArg.toLowerCase() !== target.repoArg.toLowerCase()) throw new Error("PR and repository targets disagree.");
  setFlags({ repo: target.repoArg });
  return { pr: { number, url: value.url, host: target.host, owner: target.owner, repo: target.repo }, headSha: value.headRefOid, baseSha: value.baseRefOid };
}

export async function prepareReview(input: {
  snapshot: ReviewSnapshot; since?: string; mark?: boolean; cwd?: string;
}): Promise<{ result: ReviewResult; from: string; files: string[] }> {
  const { snapshot, since } = input;
  const at = new Date().toISOString();
  const cwd = await getRepoRoot(input.cwd);
  const { pr, headSha, baseSha } = snapshot;
  const key = `${pr.host}/${pr.owner}/${pr.repo}/${pr.number}`;
  const previous = since === "last" ? readReviewMark(key) : undefined;
  if (since === "last" && !previous) throw new Error(`No local review mark for PR #${pr.number}. Review it first, then use --mark.`);
  const fromHead = previous?.reviewedHead ?? since;
  let source: string | undefined;
  for (const remote of await getRemotes(cwd)) {
    const url = await run("git", ["config", "--get", `remote.${remote}.url`], { cwd });
    const parsed = parseGitHubRepositoryNameWithOwnerFromRemoteUrl(url.stdout.trim());
    const identity = typeof parsed === "string" ? `github.com/${parsed}` : parsed ? `${parsed.host}/${parsed.nameWithOwner}` : "";
    if (identity.toLowerCase() === `${pr.host}/${pr.owner}/${pr.repo}`.toLowerCase()) { source = remote; break; }
  }
  if (!source) throw new Error("The PR repository must match a local Git remote. Run review from its clone.");
  // Fetch immutable revisions, without moving a user branch or writing FETCH_HEAD.
  await run("git", ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", source, headSha, baseSha], { cwd, env: { GIT_TERMINAL_PROMPT: "0" } });
  if (fromHead && !isReviewSha(fromHead)) throw new Error("--since must be last or a full commit SHA.");
  if (fromHead) {
    const exists = await run("git", ["cat-file", "-e", `${fromHead}^{commit}`], { cwd, reject: false });
    if (exists.exitCode !== 0) throw new Error("Previous review commit is unavailable. Fetch it or start a full review.");
  }
  const mergeBase = (await run("git", ["merge-base", baseSha, headSha], { cwd })).stdout.trim();
  const result: ReviewResult = { schemaVersion: 1, ...snapshot, checkoutPath: join(cwd, ".worktrees", `review-${pr.number}`), surface: "data" };
  if (fromHead) {
    const threads = await getReviewThreads(pr.number, { since: previous?.at });
    if (threads.headSha !== headSha || threads.baseSha !== baseSha) throw new Error("PR changed while reading review threads. Run review again.");
    if (!threads.pagination.complete) throw new Error("Review thread pagination is incomplete. Narrow the review before marking it.");
    result.since = await reviewChanges({ cwd, fromHead, headSha, mergeBase, mark: previous, threads });
  }
  const from = fromHead ?? mergeBase;
  const files = result.since?.files ?? (await run("git", ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", from, headSha, "--"], { cwd })).stdout.split("\0").filter(Boolean);
  await checkoutForReview(headSha, result.checkoutPath, { cwd, detached: true, reuse: true });
  if (input.mark) {
    // Keep marked commits reachable even after a force push and Git garbage collection.
    await run("git", ["update-ref", `refs/ggh/reviews/${pr.number}/${headSha}`, headSha], { cwd });
    await run("git", ["update-ref", `refs/ggh/reviews/${pr.number}/${mergeBase}`, mergeBase], { cwd });
    markReview(key, { reviewedHead: headSha, reviewedBase: baseSha, mergeBase, at, scope: "inspected" });
    result.marked = true;
  }
  return { result, from, files };
}
