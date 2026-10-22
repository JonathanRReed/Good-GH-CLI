import { homedir } from "node:os";
import { relative } from "node:path";
import { p } from "../../utils/ui.ts";
import { terminalText } from "../../utils/output.ts";
import { within } from "./discovery.ts";
import type { CloneStatus, CommitSummary, FieldState, IndexedClone } from "./types.ts";

export interface ProjectRow { clone: IndexedClone; status: CloneStatus }
export function shortPath(path: string): string { return within(homedir(), path) ? `~${path === homedir() ? "" : `/${relative(homedir(), path)}`}` : path; }
function cell(value: string): string { return terminalText(value).replace(/[\r\n\t]/g, " "); }
function show<T>(field: FieldState<T>, render: (value: T) => string): string {
  return field.state === "ok" ? render(field.value) : field.state === "error" ? "error" : "?";
}
export function dirtySummary(status: CloneStatus["checkouts"][number]["dirty"]): string {
  return show(status, value => `${value.staged}/${value.unstaged}/${value.untracked}/${value.conflicted}`);
}
function attention(row: ProjectRow): number {
  return Number(row.status.checkouts.some(checkout => (checkout.dirty.state === "ok" && Object.values(checkout.dirty.value).some(count => count > 0)) || (checkout.upstream.state === "ok" && checkout.upstream.value && checkout.upstream.value.behind > 0)) || (row.status.unpublished.state === "ok" && row.status.unpublished.value.some(ref => ref.commits > 0)));
}
export function sortProjects(rows: ProjectRow[]): ProjectRow[] {
  return rows.sort((a, b) => attention(b) - attention(a) || (b.status.lastCommit.state === "ok" && b.status.lastCommit.value ? Date.parse(b.status.lastCommit.value.committedAt) : 0) - (a.status.lastCommit.state === "ok" && a.status.lastCommit.value ? Date.parse(a.status.lastCommit.value.committedAt) : 0) || a.clone.displayName.localeCompare(b.clone.displayName));
}
function age(commit: CommitSummary | null): string {
  if (!commit) return "-";
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(commit.committedAt)) / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h` : `${Math.floor(seconds / 86400)}d`;
}
export function renderProjects(rows: ProjectRow[]): void {
  if (!rows.length) { p.log.info("No projects. Add a scan root with ggh projects roots add <path>."); return; }
  const lines = rows.map(({ clone, status }) => {
    const hosts = new Map<string, number>();
    for (const checkout of clone.checkouts) hosts.set(checkout.createdBy, (hosts.get(checkout.createdBy) ?? 0) + 1);
    return [clone.displayName + (clone.missing ? " [missing]" : ""), shortPath(clone.checkouts[0]?.path ?? clone.commonDir), clone.checkouts.map(checkout => checkout.bare ? "bare" : checkout.branch ?? checkout.head?.slice(0, 7) ?? "unborn").join(", "),
      status.checkouts.map(checkout => dirtySummary(checkout.dirty)).join(", "),
      status.checkouts.map(checkout => show(checkout.upstream, value => value ? `+${value.ahead}/-${value.behind}` : "-")).join(", "),
      show(status.unpublished, refs => refs.filter(ref => ref.commits).map(ref => `${ref.ref.replace("refs/heads/", "")}:${ref.commits}`).join(",") || "0"),
      show(status.stashes, String), `${clone.checkouts.length} ${[...hosts].map(([host, count]) => `${host}:${count}`).join(" ")}`, show(status.lastCommit, age)].map(cell);
  });
  const headings = ["Name", "Path", "Branch", "Staged/unstaged/new/conflicts", "Ahead/behind", "Unpublished", "Stashes", "Worktrees", "Commit"];
  const widths = headings.map((heading, index) => Math.max(heading.length, ...lines.map(line => line[index]?.length ?? 0)));
  for (const line of [headings, ...lines]) p.log.message(line.map((value, index) => value.padEnd(widths[index] ?? 0)).join("  ").trimEnd());
}
export function renderProjectCard(row: ProjectRow, history?: { recent: FieldState<CommitSummary[]>; unpublished: FieldState<CommitSummary[]> }, brief = false): void {
  const { clone, status } = row;
  p.log.step(`${clone.displayName}${clone.primary ? `  ${clone.primary.host}/${clone.primary.owner}/${clone.primary.name}` : ""}`);
  if (!brief) for (const remote of clone.remotes) p.log.message(`${remote.name}  ${remote.url}`);
  for (const checkout of clone.checkouts) {
    const state = status.checkouts.find(state => state.path === checkout.path);
    p.log.message(`${shortPath(checkout.path)}  ${checkout.createdBy}  ${checkout.bare ? "bare" : checkout.branch ?? `detached ${checkout.head?.slice(0, 7) ?? "unknown"}`}  ${state ? dirtySummary(state.dirty) : "?"}${checkout.locked ? `  locked: ${checkout.locked.reason}` : ""}${checkout.prunable ? `  prunable: ${checkout.prunable.reason}` : ""}`);
    if (state) for (const [name, field] of Object.entries({ dirty: state.dirty, upstream: state.upstream, operation: state.operation })) {
      if (field.state !== "ok") p.log.message(`${name}: ${field.state === "unknown" ? field.reason : field.message}`);
      else if (name === "operation" && field.value) p.log.message(`operation: ${String(field.value)}`);
    }
  }
  p.log.message(`Unpublished: ${show(status.unpublished, refs => refs.filter(ref => ref.commits > 0).map(ref => `${ref.ref.replace("refs/heads/", "")}: ${ref.commits}`).join(", ") || "0")}  Stashes: ${show(status.stashes, String)}${status.newestStash.state === "ok" && status.newestStash.value ? `  ${status.newestStash.value}` : ""}`);
  if (brief) return;
  p.log.message(`Merged branches: ${show(status.mergedBranches, branches => branches.join(", ") || "none")}`);
  for (const [name, field] of Object.entries({ stashes: status.stashes, unpublished: status.unpublished, mergedBranches: status.mergedBranches, lastCommit: status.lastCommit })) if (field.state !== "ok") p.log.message(`${name}: ${field.state === "unknown" ? field.reason : field.message}`);
  for (const [label, commits] of [["Unpublished commits", history?.unpublished], ["Recent commits", history?.recent]] as const) {
    if (!commits) continue;
    p.log.step(label);
    if (commits.state === "ok") for (const commit of commits.value) p.log.message(`${commit.oid.slice(0, 7)}  ${commit.subject}`);
    else p.log.message(commits.state === "unknown" ? commits.reason : commits.message);
  }
}
