import { relative, sep } from "node:path";
import { projectGit } from "./git.ts";
import { REFLOG_LIMIT } from "./reflog.ts";
import type { Clone, CommitSummary } from "./types.ts";

export interface LostRef { ref: string; head: string }
export interface LostCommit extends CommitSummary { parents: string[] }
export interface LostReflog { branch: string | null; path: string | null; tips: string[]; truncated: boolean }

export async function lostRefs(commonDir: string): Promise<LostRef[]> {
  const text = (await projectGit(commonDir, ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads/", "refs/stash", "refs/ggh/stack-recovery/"])).stdout;
  return text.split("\n").filter(Boolean).map(line => {
    const [ref, head] = line.split("\0");
    if (!ref || !head || !/^[a-f0-9]{40,64}$/.test(head)) throw new Error("Cannot parse exact ref identity");
    return { ref, head };
  });
}

/** One walk for all tips. stdin avoids the platform's argument-size limit. */
export async function lostGraph(commonDir: string, tips: string[], exclusions: string[] = []): Promise<LostCommit[]> {
  if (!tips.length) return [];
  const text = (await projectGit(commonDir, ["log", "--topo-order", "--format=%H%x00%P%x00%cI%x00%s", "--stdin", "--not", "--remotes", ...exclusions, "--"], Date.now() + 10000, [...new Set(tips)].join("\n") + "\n")).stdout;
  return text.split("\n").filter(Boolean).map(line => {
    const [oid = "", parents = "", committedAt = "", subject = ""] = line.split("\0");
    return { oid, parents: parents.split(" ").filter(Boolean), committedAt, subject };
  });
}

/** Propagate each target's membership through the shared graph once. */
export function reachableLostCommits(tips: readonly string[][], graph: readonly LostCommit[]): LostCommit[][] {
  const masks = new Map<string, bigint>();
  const results = tips.map((): LostCommit[] => []);
  tips.forEach((heads, index) => { for (const head of heads) masks.set(head, (masks.get(head) ?? 0n) | (1n << BigInt(index))); });
  for (const commit of graph) {
    const mask = masks.get(commit.oid) ?? 0n;
    masks.delete(commit.oid);
    for (const [index, result] of results.entries()) if ((mask & (1n << BigInt(index))) !== 0n) result.push(commit);
    for (const parent of commit.parents) masks.set(parent, (masks.get(parent) ?? 0n) | mask);
  }
  return results;
}

/** Git includes main and linked HEAD logs, even for missing worktree paths. */
export async function lostReflogs(clone: Clone, refs: readonly LostRef[], read: typeof projectGit = projectGit): Promise<LostReflog[]> {
  const targets = new Map<string, LostReflog>(refs.filter(ref => ref.ref.startsWith("refs/heads/")).map(ref => [ref.ref, { branch: ref.ref.slice(11), path: null, tips: [], truncated: false }]));
  for (const checkout of clone.checkouts.filter(checkout => !checkout.bare)) {
    const ref = checkout.gitDir === clone.commonDir ? "HEAD" : `${relative(clone.commonDir, checkout.gitDir).split(sep).join("/")}/HEAD`;
    targets.set(ref, { branch: checkout.branch, path: checkout.path, tips: [], truncated: false });
  }
  // Keep each log's limit independently. A global -n would let one busy log hide others.
  let text: string;
  try {
    text = (await read(clone.commonDir, ["reflog", "show", "--all", "--format=%gD%x00%H"], Date.now() + 10000)).stdout;
  } catch {
    // A very large reflog can exceed the batched read's output cap or deadline.
    // Read each log with its own bound; one that still fails is reported truncated.
    const parts: string[] = [];
    for (const [ref, target] of targets) {
      try { parts.push((await read(clone.commonDir, ["reflog", "show", `-n${REFLOG_LIMIT + 1}`, "--format=%gD%x00%H", ref, "--"], Date.now() + 10000)).stdout); }
      catch { target.truncated = true; }
    }
    text = parts.join("\n");
  }
  for (const line of text.split("\n").filter(Boolean)) {
    const [selector = "", oid = ""] = line.split("\0");
    const match = /^(.*)@\{(\d+)\}$/.exec(selector);
    const target = match?.[1] ? targets.get(match[1]) : undefined;
    if (!target) continue;
    if (!/^[a-f0-9]{40,64}$/.test(oid)) throw new Error("Cannot parse reflog commit identity");
    if (Number(match?.[2]) >= REFLOG_LIMIT) target.truncated = true;
    else target.tips.push(oid);
  }
  return [...targets.values()].map(target => ({ ...target, tips: [...new Set(target.tips)] }));
}
