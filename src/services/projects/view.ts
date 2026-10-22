import { homedir } from "node:os";
import { relative } from "node:path";
import { p } from "../../utils/ui.ts";
import { stripAnsi, terminalText } from "../../utils/output.ts";
import { within } from "./discovery.ts";
import type { RemoteField, RemoteRepository, UnclonedResult } from "./remote-types.ts";
import type { CloneStatus, CommitSummary, FieldState, IndexedClone } from "./types.ts";

export interface ProjectRow { clone: IndexedClone; status: CloneStatus; stale?: boolean; remote?: RemoteRepository[] }
export function shortPath(path: string): string { return within(homedir(), path) ? `~${path === homedir() ? "" : `/${relative(homedir(), path)}`}` : path; }
function cell(value: string): string { return stripAnsi(terminalText(value)).replace(/[\r\n\t]/g, " "); }
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
export interface ProjectViewOptions { width?: number; wide?: boolean; remote?: boolean; uncloned?: boolean; refresh?: boolean }
type ProjectHistory = { recent: FieldState<CommitSummary[]>; unpublished: FieldState<CommitSummary[]> };
function available(options: ProjectViewOptions): number {
  return options.wide ? Infinity : Math.max(1, Math.floor(options.width ?? process.stdout.columns ?? 100) - 3);
}
function fit(value: string, width: number): string {
  value = cell(value);
  if (Bun.stringWidth(value) <= width) return value;
  if (width <= 0) return "";
  let result = "";
  for (const part of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)) {
    if (Bun.stringWidth(result + part.segment) > width - 1) break;
    result += part.segment;
  }
  return result + "…";
}
function table(rows: string[][], options: ProjectViewOptions): string[] {
  const widths = rows[0]?.map((_, index) => Math.max(...rows.map(row => Bun.stringWidth(cell(row[index] ?? ""))))) ?? [];
  const limit = available(options);
  while (widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * 2 > limit) {
    const widest = Math.max(...widths);
    if (widest <= 1) break;
    const index = widths.indexOf(widest);
    widths[index] = widest - 1;
  }
  return rows.map(row => fit(row.map((value, index) => {
    const width = widths[index] ?? 0;
    const text = fit(value, width);
    return text + " ".repeat(Math.max(0, width - Bun.stringWidth(text)));
  }).join("  ").trimEnd(), limit));
}
function branch(checkout: IndexedClone["checkouts"][number]): string {
  return checkout.bare ? "bare" : checkout.branch ?? `detached ${checkout.head?.slice(0, 7) ?? "unknown"}`;
}
function drift(field: CloneStatus["checkouts"][number]["upstream"]): string {
  return show(field, value => value ? `↑${value.ahead} ↓${value.behind}` : "-");
}
function unpublished(status: CloneStatus): string {
  return show(status.unpublished, refs => {
    const positive = refs.filter(ref => ref.commits > 0);
    return `${positive.length} br / ${positive.reduce((sum, ref) => sum + ref.commits, 0)} commits`;
  });
}
function stateSummary(row: ProjectRow): string {
  const states: string[] = [];
  const dirty = row.status.checkouts.filter(checkout => checkout.dirty.state === "ok" && Object.values(checkout.dirty.value).some(count => count > 0)).length;
  if (dirty) states.push(`${dirty} dirty`);
  if (row.status.checkouts.some(checkout => checkout.dirty.state === "ok" && checkout.dirty.value.conflicted > 0)) states.push("conflicts");
  const operations = new Set(row.status.checkouts.flatMap(checkout => checkout.operation.state === "ok" && checkout.operation.value ? [checkout.operation.value] : []));
  states.push(...operations);
  if (row.status.checkouts.length < row.clone.checkouts.length || row.status.checkouts.some(checkout => [checkout.dirty, checkout.upstream, checkout.operation].some(field => field.state !== "ok")) || [row.status.unpublished, row.status.stashes, row.status.lastCommit].some(field => field.state !== "ok")) states.push("unknown");
  if (row.clone.missing) states.push("missing");
  if (row.stale) states.unshift("stale");
  return states.join(", ") || "clean";
}
export function formatProjects(rows: ProjectRow[], options: ProjectViewOptions = {}): string[] {
  if (!rows.length) return [fit("No projects. Add a scan root with ggh projects roots add <path>.", available(options))];
  return table([["Name", "Branch", "State", "↑/↓", "Unpublished", "Stashes", "Worktrees", "Age", ...(options.remote ? ["Remote", "Seen"] : [])], ...rows.map(row => {
    const primary = row.clone.checkouts.find(checkout => checkout.gitDir === row.clone.commonDir) ?? row.clone.checkouts[0];
    const status = row.status.checkouts.find(checkout => checkout.path === primary?.path);
    const hosts = new Map<string, number>();
    for (const checkout of row.clone.checkouts.filter(checkout => checkout !== primary)) hosts.set(checkout.createdBy, (hosts.get(checkout.createdBy) ?? 0) + 1);
    return [row.clone.displayName, primary ? branch(primary) : "-", stateSummary(row), status ? drift(status.upstream) : "?", unpublished(row.status), show(row.status.stashes, String), [...hosts].map(([host, count]) => `${count} ${host === "unknown" ? "other" : host}`).join(", ") || "-", show(row.status.lastCommit, age), ...(options.remote ? [remoteSummary(row.remote), remoteAge(row.remote)] : [])];
  })], options);
}
export function renderProjects(rows: ProjectRow[], options: ProjectViewOptions = {}): void {
  for (const line of formatProjects(rows, options)) p.log.message(line);
}
export function formatProjectCard(row: ProjectRow, history?: ProjectHistory, brief = false, options: ProjectViewOptions = {}): string[] {
  const { clone, status } = row;
  const lines = [`${clone.displayName}${clone.primary ? `  ${clone.primary.host}/${clone.primary.owner}/${clone.primary.name}` : ""}${row.stale ? "  stale" : ""}`];
  if (!brief) for (const remote of clone.remotes) lines.push(`${remote.name}  ${remote.url}`);
  const checkouts = clone.checkouts.map(checkout => {
    const state = status.checkouts.find(state => state.path === checkout.path);
    const flags: string[] = [];
    if (checkout.locked) flags.push(`locked: ${checkout.locked.reason}`);
    if (checkout.prunable) flags.push(`prunable: ${checkout.prunable.reason}`);
    if (state) {
      for (const [name, field] of Object.entries({ dirty: state.dirty, upstream: state.upstream, operation: state.operation })) {
        if (field.state !== "ok") flags.push(`${name}: ${field.state === "unknown" ? field.reason : field.message}`);
      }
      if (state.operation.state === "ok" && state.operation.value) flags.push(state.operation.value);
    }
    return [shortPath(checkout.path), branch(checkout), state ? dirtySummary(state.dirty) : "?", state ? drift(state.upstream) : "?", checkout.createdBy, flags.join(", ")];
  });
  lines.push(...table([["Checkout", "Branch", "S/U/N/C", "↑/↓", "Host", "State"], ...checkouts], options));
  lines.push(`Unpublished: ${unpublished(status)}  Stashes: ${show(status.stashes, String)}${status.newestStash.state === "ok" && status.newestStash.value ? `  ${status.newestStash.value}` : ""}`);
  if (!brief) {
    if (status.unpublished.state === "ok") for (const ref of status.unpublished.value.filter(ref => ref.commits > 0)) lines.push(`${ref.ref.replace("refs/heads/", "")}  ${ref.commits} commits`);
    lines.push(`Merged branches: ${show(status.mergedBranches, branches => branches.join(", ") || "none")}`);
    for (const [name, field] of Object.entries({ stashes: status.stashes, unpublished: status.unpublished, mergedBranches: status.mergedBranches, lastCommit: status.lastCommit })) if (field.state !== "ok") lines.push(`${name}: ${field.state === "unknown" ? field.reason : field.message}`);
    for (const [label, commits] of [["Unpublished commits", history?.unpublished], ["Recent commits", history?.recent]] as const) {
      if (!commits) continue;
      lines.push(label);
      if (commits.state === "ok") for (const commit of commits.value) lines.push(`${commit.oid.slice(0, 7)}  ${commit.subject}`);
      else lines.push(commits.state === "unknown" ? commits.reason : commits.message);
    }
  }
  if (options.remote) lines.push(...remoteCard(row.remote));
  return lines.map(line => fit(line, available(options)));
}
export function renderProjectCard(row: ProjectRow, history?: ProjectHistory, brief = false, options: ProjectViewOptions = {}): void {
  for (const line of formatProjectCard(row, history, brief, options)) p.log.message(line);
}

function remoteShow<T>(field: RemoteField<T> | undefined, render: (value: T) => string): string {
  return field?.state === "ok" ? render(field.value) : "?";
}
function ci(state: string | null): string { return state === "SUCCESS" ? "✓" : state === "FAILURE" || state === "ERROR" ? "✗" : state === null ? "-" : "…"; }
function remoteSummary(repositories?: RemoteRepository[]): string {
  if (!repositories) return "pending";
  if (!repositories.length) return "-";
  return repositories.map(repo => {
    const parts: string[] = [];
    if (repo.authored) parts.push(remoteShow(repo.authored, value => `PR ${value.count}${value.pullRequests.some(pr => ci(pr.statusCheckRollup) === "✗") ? " ✗" : ""}`));
    if (repo.reviewRequested) parts.push(remoteShow(repo.reviewRequested, value => `review ${value}`));
    if (repo.archived?.state === "ok" && repo.archived.value) parts.push("archived");
    if (repo.fork?.state === "ok" && repo.fork.value.isFork) parts.push("fork");
    if (Object.values(repo).some(field => field && typeof field === "object" && "state" in field && field.state !== "ok")) parts.push("unavailable");
    return parts.join(" ");
  }).join("; ");
}
function remoteAge(repositories?: RemoteRepository[]): string {
  const dates = repositories?.flatMap(repo => Object.values(repo).flatMap(field => field && typeof field === "object" && "state" in field && field.state === "ok" && "observedAt" in field && typeof field.observedAt === "string" ? [field.observedAt] : []));
  const oldest = dates?.sort()[0];
  return oldest ? age({ oid: "", subject: "", committedAt: oldest }) : "-";
}
function remoteCard(repositories?: RemoteRepository[]): string[] {
  if (!repositories) return ["Remote: pending"];
  if (!repositories.length) return ["Remote: no recognized repository"];
  return repositories.flatMap(repo => {
    const lines = [`Remote ${repo.repo.host}/${repo.repo.owner}/${repo.repo.name}  ${repo.login ?? "unauthenticated"}  ${remoteAge([repo])}`];
    if (repo.defaultBranch) lines.push(`Default: ${remoteShow(repo.defaultBranch, value => value ? `${value.name} ${value.oid.slice(0, 7)}` : "empty repository")}`);
    if (repo.defaultCi) lines.push(`CI: ${remoteShow(repo.defaultCi, value => value ?? "no checks")}`);
    if (repo.archived?.state === "ok" && repo.archived.value) lines.push("Archived");
    if (repo.fork?.state === "ok" && repo.fork.value.isFork) lines.push(`Fork: ${repo.fork.value.parent ?? "parent unavailable"}`);
    if (repo.permission) lines.push(`Permission: ${remoteShow(repo.permission, value => value ?? "none")}`);
    if (repo.authored) {
      lines.push(`Authored PRs: ${remoteShow(repo.authored, value => String(value.count))}`);
      if (repo.authored.state === "ok") for (const pr of repo.authored.value.pullRequests) lines.push(`#${pr.number} ${pr.title}  ${pr.headRefName}  ${pr.statusCheckRollup ?? "no checks"}  ${pr.reviewDecision ?? "no decision"}`);
    }
    if (repo.reviewRequested) lines.push(`Review requested: ${remoteShow(repo.reviewRequested, String)}`);
    for (const [name, field] of Object.entries(repo)) if (field && typeof field === "object" && "state" in field && field.state !== "ok") lines.push(`${name}: ${"reason" in field ? field.reason : "message" in field ? field.message : "unavailable"}`);
    return lines;
  });
}
export function formatUncloned(results: UnclonedResult[], options: ProjectViewOptions = {}): string[] {
  return results.flatMap(result => [
    `Uncloned ${result.host}: ${remoteShow(result.count, String)}${result.complete ? "" : ` (incomplete, ${result.scanned} scanned)`}`,
    ...(result.repositories.state === "ok" ? result.repositories.value.map(repo => `${repo.nameWithOwner}  ${repo.pushedAt ?? "never pushed"}`) : []),
    ...(result.count.state !== "ok" ? [result.count.state === "error" ? result.count.message : result.count.reason] : []),
  ]).map(line => fit(line, available(options)));
}
