import { existsSync, lstatSync } from "node:fs";
import { getConfig } from "../config.ts";
import { projectGit } from "./git.ts";
import { freshClone, hostClaims } from "./tidy-plan.ts";
import { readCloneStatus } from "./status.ts";
import type { CheckoutCreator, Clone } from "./types.ts";

interface LostBase { commonDir: string; path: string | null; createdBy: CheckoutCreator; nextSteps: string[][] }
export type LostItem = LostBase & (
  | { kind: "unpublished"; branch: string | null; head: string; commits: number; newestSubject: string; newestDate: string; oldestDate: string }
  | { kind: "stash"; count: number; stashes: { ref: string; oid: string; date: string; message: string }[]; oldestDate: string }
  | { kind: "dirty-host-checkout"; host: string; reason: string }
  | { kind: "broken-gitdir"; reason: string }
);
export interface LostResult { schemaVersion: 1; items: LostItem[]; warnings: { target: string; reason: string }[] }
export function sortLost(items: LostItem[]): LostItem[] {
  return items.sort((a, b) => {
    const commits = (item: LostItem) => item.kind === "unpublished" ? item.commits : 0;
    const date = (item: LostItem) => "oldestDate" in item ? Date.parse(item.oldestDate) : -Infinity;
    return commits(b) - commits(a) || date(a) - date(b) || a.commonDir.localeCompare(b.commonDir) || (a.path ?? "").localeCompare(b.path ?? "") || a.kind.localeCompare(b.kind);
  });
}
export async function findLost(clones: readonly Clone[], config = getConfig()): Promise<LostResult> {
  const result: LostResult = { schemaVersion: 1, items: [], warnings: [] };
  for (const input of clones) {
    let clone: Clone;
    try { clone = await freshClone(input, config); }
    catch {
      for (const checkout of input.checkouts) if (existsSync(checkout.path)) result.items.push({ kind: "broken-gitdir", commonDir: input.commonDir, path: checkout.path, createdBy: checkout.createdBy, reason: "Cannot resolve checkout/common directory; inspect .git before repairing", nextSteps: [["git", "-C", checkout.path, "rev-parse", "--git-dir"]] });
      result.warnings.push({ target: input.commonDir, reason: "Cannot inspect clone; unpublished state is unknown" });
      continue;
    }
    const commonDir = clone.commonDir;
    const base = { commonDir, path: null, createdBy: "unknown" as const };
    try {
      const status = await readCloneStatus(clone, { deadlineMs: 10000 });
      if (status.unpublished.state !== "ok") throw new Error("Unpublished commit inventory is unavailable");
      for (const target of status.unpublished.value.filter(ref => ref.commits > 0)) {
        const branch = target.ref.startsWith("refs/heads/") ? target.ref.slice(11) : null;
        const checkout = clone.checkouts.find(checkout => branch ? checkout.branch === branch : !checkout.branch && checkout.head === target.ref);
        const head = (await projectGit(commonDir, ["rev-parse", "--verify", `${target.ref}^{commit}`])).stdout.trim();
        const commits = (await projectGit(commonDir, ["log", "--format=%cI%x00%s", head, "--not", "--remotes", "--"])).stdout.split("\n").filter(Boolean).map(line => { const n = line.indexOf("\0"); return { date: line.slice(0, n), subject: line.slice(n + 1) }; }).sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
        const newest = commits[0];
        const oldest = commits.at(-1);
        if (!newest || !oldest) throw new Error("Commit graph changed during lost inventory");
        const path = checkout?.path ?? null;
        const cwd = path && existsSync(path) ? path : commonDir;
        result.items.push({ ...base, kind: "unpublished", path, createdBy: checkout?.createdBy ?? "unknown", branch, head, commits: target.commits, newestSubject: newest.subject, newestDate: newest.date, oldestDate: oldest.date,
          nextSteps: branch ? [["git", "-C", cwd, "push", "origin", `refs/heads/${branch}:refs/heads/${branch}`]] : [["git", "-C", cwd, "branch", "rescue-work", head]] });
      }
      const stashText = status.stashes.state === "ok" && status.stashes.value === 0 ? "" : (await projectGit(commonDir, ["reflog", "show", "--date=iso-strict", "--format=%gd%x00%H%x00%cI%x00%gs", "refs/stash"])).stdout;
      const stashes = stashText.split("\n").filter(Boolean).map((line, i) => {
        const [, oid = "", date = "", message = ""] = line.split("\0");
        return { ref: `stash@{${i}}`, oid, date, message };
      });
      if (stashes.length) result.items.push({ ...base, kind: "stash", count: stashes.length, stashes, oldestDate: stashes.map(stash => stash.date).sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? "", nextSteps: stashes.map(stash => { const cwd = clone.checkouts.find(checkout => !checkout.bare && existsSync(checkout.path))?.path; return cwd ? ["git", "-C", cwd, "stash", "show", "--stat", stash.ref] : ["git", "-C", commonDir, "show", "--stat", stash.ref]; }) });
    } catch (error) { result.warnings.push({ target: commonDir, reason: error instanceof Error ? error.message : "Unknown publication state" }); }
    for (const checkout of clone.checkouts) {
      const base = { commonDir, path: checkout.path, createdBy: checkout.createdBy };
      if (!existsSync(checkout.path) || checkout.bare) continue;
      try {
        if (lstatSync(checkout.path).isSymbolicLink()) throw new Error("Checkout path was replaced by a symlink");
        const actual = (await projectGit(checkout.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
        if (actual !== commonDir) throw new Error("Checkout common directory changed");
      } catch {
        result.items.push({ ...base, kind: "broken-gitdir", reason: "Checkout .git gitdir is broken or points to another clone", nextSteps: [["git", "-C", checkout.path, "rev-parse", "--git-dir"]] });
        continue;
      }
      try {
        const claims = await hostClaims(checkout, commonDir, config);
        if (!claims.length) continue;
        const state = await projectGit(checkout.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored", "--ignore-submodules=none"]);
        if (state.stdout) result.items.push({ ...base, kind: "dirty-host-checkout", host: claims[0]?.host ?? checkout.createdBy, reason: "Possible abandoned agent work; host session activity is unknown", nextSteps: [["git", "-C", checkout.path, "status", "--ignored"]] });
      } catch { result.warnings.push({ target: checkout.path, reason: "Cannot inspect host checkout changes" }); }
    }
  }
  sortLost(result.items);
  return result;
}
