import { existsSync, lstatSync, realpathSync } from "node:fs";
import { getConfig } from "../config.ts";
import { readStackRecoveryFromCommonDir } from "../git/stack.ts";
import { projectGit, projectPool } from "./git.ts";
import { lostGraph, lostReflogs, lostRefs, reachableLostCommits } from "./lost-inventory.ts";
import { fetchedAt, freshClone, hostClaims } from "./tidy-plan.ts";
import { REFLOG_LIMIT } from "./reflog.ts";
import { parseCheckoutStatus } from "./status.ts";
import type { CheckoutCreator, CheckoutStatus, Clone } from "./types.ts";

type DirtyState = Extract<CheckoutStatus["dirty"], { state: "ok" }>["value"];
interface LostBase { commonDir: string; path: string | null; createdBy: CheckoutCreator; nextSteps: string[][] }
export type LostItem = LostBase & (
  | { kind: "unpublished"; branch: string | null; head: string; commits: number; uniqueCommits: number; sharedCommits: number; newestSubject: string; newestDate: string; oldestDate: string }
  | { kind: "reflog-only"; branch: string | null; commits: string[]; scannedEntries: number; truncated: boolean }
  | { kind: "restack-preimage"; branch: string; head: string; operationId: string }
  | { kind: "stash"; count: number; stashes: { ref: string; oid: string; date: string; message: string }[]; oldestDate: string }
  | { kind: "dirty-checkout"; dirty: DirtyState; reason: string }
  | { kind: "dirty-host-checkout"; host: string; dirty?: DirtyState; reason: string }
  | { kind: "broken-gitdir"; reason: string }
);
export interface LostClone { commonDir: string; name: string; fetchedAt: string | null; uniqueCommits: number; branches: number; detachedHeads: number }
export interface LostResult { schemaVersion: 1; clones: LostClone[]; items: LostItem[]; warnings: { target: string; reason: string }[] }
export function sortLost(items: LostItem[]): LostItem[] {
  return items.sort((a, b) => {
    const commits = (item: LostItem) => item.kind === "unpublished" ? item.uniqueCommits : 0;
    const date = (item: LostItem) => "oldestDate" in item ? Date.parse(item.oldestDate) : -Infinity;
    const identity = (item: LostItem) => `${"branch" in item ? item.branch ?? "" : ""}\0${"head" in item ? item.head : ""}\0${item.kind === "reflog-only" ? item.commits.join(" ") : ""}`;
    return commits(b) - commits(a) || date(a) - date(b) || a.commonDir.localeCompare(b.commonDir) || (a.path ?? "").localeCompare(b.path ?? "") || a.kind.localeCompare(b.kind) || identity(a).localeCompare(identity(b));
  });
}

async function findLostClone(input: Clone, config: ReturnType<typeof getConfig>): Promise<LostResult> {
  const result: LostResult = { schemaVersion: 1, clones: [], items: [], warnings: [] };
  let clone: Clone;
  try { clone = await freshClone(input, config); }
  catch {
    for (const checkout of input.checkouts) if (existsSync(checkout.path)) result.items.push({ kind: "broken-gitdir", commonDir: input.commonDir, path: checkout.path, createdBy: checkout.createdBy, reason: "Cannot resolve checkout/common directory; inspect .git before repairing", nextSteps: [["git", "-C", checkout.path, "rev-parse", "--git-dir"]] });
    result.warnings.push({ target: input.commonDir, reason: "Cannot inspect clone; unpublished state is unknown" });
    return result;
  }
  const commonDir = clone.commonDir;
  const base = { commonDir, path: null, createdBy: "unknown" as const };
  try {
    const refs = await lostRefs(commonDir);
    const branches = refs.filter(ref => ref.ref.startsWith("refs/heads/"));
    let checkpoint: Awaited<ReturnType<typeof readStackRecoveryFromCommonDir>> = null;
    try { checkpoint = await readStackRecoveryFromCommonDir(commonDir); }
    catch (error) { result.warnings.push({ target: commonDir, reason: error instanceof Error ? error.message : "Cannot inspect stack recovery state" }); }
    const recovery = checkpoint;
    const preimages = recovery?.mode === "restack" ? recovery.entries.filter(entry => entry.state === "completed" && entry.originalTip !== entry.expectedTip && branches.some(ref => ref.ref === `refs/heads/${entry.branch}` && ref.head === entry.expectedTip)).map(entry => ({ ...entry, operationId: recovery.operationId })) : [];
    for (const entry of preimages) result.items.push({ ...base, kind: "restack-preimage", branch: entry.branch, head: entry.originalTip, operationId: entry.operationId, nextSteps: [["git", "-C", commonDir, "show", "--stat", entry.originalTip]] });
    const heads = clone.checkouts.flatMap(checkout => checkout.head ? [checkout.head] : []);
    const targets = [...new Map([...branches, ...clone.checkouts.flatMap(checkout => !checkout.branch && checkout.head && !preimages.some(entry => entry.originalTip === checkout.head) ? [{ ref: checkout.head, head: checkout.head }] : [])].map(target => [target.ref, target])).values()];
    const reserved = new Set(branches.map(ref => ref.ref.slice(11)));
    const suggested = new Set<string>();
    const rescue = (head: string, cwd: string): string[][] => {
      if (suggested.has(head)) return [];
      const prefix = `rescue-work-${head.slice(0, 12)}`;
      let name = prefix;
      for (let suffix = 2; reserved.has(name) || [...reserved].some(branch => branch.startsWith(`${name}/`) || name.startsWith(`${branch}/`)); suffix++) name = `${prefix}-${suffix}`;
      reserved.add(name); suggested.add(head);
      return [["git", "-C", cwd, "branch", name, head]];
    };
    const graph = await lostGraph(commonDir, targets.map(target => target.head));
    const reachable = reachableLostCommits(targets.map(target => [target.head]), graph);
    const unpublished: { item: Extract<LostItem, { kind: "unpublished" }>; oids: string[] }[] = [];
    const membership = new Map<string, number>();
    for (const [index, target] of targets.entries()) {
      const commits = reachable[index] ?? [];
      if (!commits.length) continue;
      commits.sort((a, b) => Date.parse(b.committedAt) - Date.parse(a.committedAt));
      const newest = commits[0]; const oldest = commits.at(-1);
      if (!newest || !oldest) continue;
      const branch = target.ref.startsWith("refs/heads/") ? target.ref.slice(11) : null;
      const checkout = clone.checkouts.find(checkout => branch ? checkout.branch === branch : !checkout.branch && checkout.head === target.head);
      const path = checkout?.path ?? null; const cwd = path && existsSync(path) ? path : commonDir;
      const item: Extract<LostItem, { kind: "unpublished" }> = { ...base, kind: "unpublished", path, createdBy: checkout?.createdBy ?? "unknown", branch, head: target.head, commits: commits.length, uniqueCommits: 0, sharedCommits: 0, newestSubject: newest.subject, newestDate: newest.committedAt, oldestDate: oldest.committedAt,
        nextSteps: branch ? [["git", "-C", cwd, "push", "origin", `refs/heads/${branch}:refs/heads/${branch}`]] : rescue(target.head, cwd) };
      const oids = commits.map(commit => commit.oid);
      for (const oid of oids) membership.set(oid, (membership.get(oid) ?? 0) + 1);
      unpublished.push({ item, oids });
    }
    for (const { item, oids } of unpublished) {
      item.uniqueCommits = oids.filter(oid => membership.get(oid) === 1).length;
      item.sharedCommits = item.commits - item.uniqueCommits;
      result.items.push(item);
    }
    const reflogs = await lostReflogs(clone, branches);
    const orphanGraph = await lostGraph(commonDir, reflogs.flatMap(log => log.tips), ["--all", ...heads, ...preimages.map(entry => entry.originalTip)]);
    const orphaned = reachableLostCommits(reflogs.map(log => log.tips), orphanGraph);
    const reflogOids = new Set<string>();
    for (const [index, target] of reflogs.entries()) {
      if (target.truncated) result.warnings.push({ target: target.path ?? target.branch ?? commonDir, reason: `Reflog scan limited to last ${REFLOG_LIMIT} entries; older unpublished work is unknown` });
      const commits = (orphaned[index] ?? []).map(commit => commit.oid).sort();
      if (!commits.length) continue;
      for (const oid of commits) reflogOids.add(oid);
      result.items.push({ ...base, kind: "reflog-only", branch: target.branch, path: target.path, commits, scannedEntries: REFLOG_LIMIT, truncated: target.truncated,
        nextSteps: commits.flatMap(oid => rescue(oid, commonDir)) });
    }
    result.clones.push({ commonDir, name: clone.displayName, fetchedAt: fetchedAt(commonDir), uniqueCommits: new Set([...membership.keys(), ...reflogOids]).size,
      branches: unpublished.filter(({ item }) => item.branch !== null).length, detachedHeads: unpublished.filter(({ item }) => item.branch === null).length });
    const stashText = refs.some(ref => ref.ref === "refs/stash") ? (await projectGit(commonDir, ["reflog", "show", "--date=iso-strict", "--format=%gd%x00%H%x00%cI%x00%gs", "refs/stash"])).stdout : "";
    const stashes = stashText.split("\n").filter(Boolean).map((line, i) => {
      const [, oid = "", date = "", message = ""] = line.split("\0"); return { ref: `stash@{${i}}`, oid, date, message };
    });
    if (stashes.length) result.items.push({ ...base, kind: "stash", count: stashes.length, stashes, oldestDate: stashes.map(stash => stash.date).sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? "", nextSteps: stashes.map(stash => { const cwd = clone.checkouts.find(checkout => !checkout.bare && existsSync(checkout.path))?.path; return cwd ? ["git", "-C", cwd, "stash", "show", "--stat", stash.ref] : ["git", "-C", commonDir, "show", "--stat", stash.ref]; }) });
  } catch (error) { result.warnings.push({ target: commonDir, reason: error instanceof Error ? error.message : "Unknown publication state" }); }
  for (const checkout of clone.checkouts) {
    const base = { commonDir, path: checkout.path, createdBy: checkout.createdBy };
    if (!existsSync(checkout.path) || checkout.bare) continue;
    try {
      if (lstatSync(checkout.path).isSymbolicLink()) throw new Error("Checkout path was replaced by a symlink");
      const actual = (await projectGit(checkout.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
      if (realpathSync.native(actual) !== commonDir) throw new Error("Checkout common directory changed");
    } catch {
      result.items.push({ ...base, kind: "broken-gitdir", reason: "Checkout .git gitdir is broken or points to another clone", nextSteps: [["git", "-C", checkout.path, "rev-parse", "--git-dir"]] });
      continue;
    }
    try {
      const state = parseCheckoutStatus((await projectGit(checkout.path, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=none"])).stdout).dirty;
      if (state.state !== "ok") throw new Error("Checkout changes are unknown");
      if (!Object.values(state.value).some(count => count > 0)) continue;
      const claims = await hostClaims(checkout, commonDir, config);
      const nextSteps = [["git", "-C", checkout.path, "status"]];
      if (claims.length) result.items.push({ ...base, kind: "dirty-host-checkout", dirty: state.value, host: claims[0]?.host ?? checkout.createdBy, reason: "Possible abandoned agent work; host session activity is unknown", nextSteps });
      else result.items.push({ ...base, kind: "dirty-checkout", dirty: state.value, reason: "Uncommitted work", nextSteps });
    } catch { result.warnings.push({ target: checkout.path, reason: "Cannot inspect checkout changes" }); }
  }
  return result;
}

export async function findLost(clones: readonly Clone[], config = getConfig(), options: { workers?: number; onProgress?: (completed: number, total: number, name: string) => void } = {}): Promise<LostResult> {
  const selected = [...new Map(clones.map(clone => [clone.commonDir, clone])).values()].sort((a, b) => a.commonDir.localeCompare(b.commonDir));
  let completed = 0;
  const results = await projectPool(selected, async clone => {
    const result = await findLostClone(clone, config);
    options.onProgress?.(++completed, selected.length, clone.displayName);
    return result;
  }, options.workers ?? 4);
  return { schemaVersion: 1, clones: results.flatMap(result => result.clones), items: sortLost(results.flatMap(result => result.items)), warnings: results.flatMap(result => result.warnings).sort((a, b) => a.target.localeCompare(b.target) || a.reason.localeCompare(b.reason)) };
}
