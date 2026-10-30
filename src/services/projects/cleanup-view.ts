import { getConfig } from "../config.ts";
import { basename, dirname } from "node:path";
import type { LostResult } from "./lost.ts";
import type { TidyPlan } from "./tidy-plan.ts";
import type { Clone, DiscoveryCoverage } from "./types.ts";
import { within } from "./discovery.ts";
import { fitProjectLine, shortPath, type ProjectViewOptions } from "./view.ts";

export interface CleanupViewOptions extends ProjectViewOptions {
  verbose?: boolean;
  coverage?: DiscoveryCoverage;
  clones?: readonly Clone[];
}
export function fetchAge(value: string | null): string {
  if (!value) return "unknown";
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (!Number.isFinite(seconds)) return "unknown";
  return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h ago` : `${Math.floor(seconds / 86400)}d ago`;
}

function counts(values: string[]): [string, number][] {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return [...result];
}
export function renderCoverage(options: CleanupViewOptions, examples = 1): string[] {
  const groups = new Map<string, { paths: string[]; label: string; broken: boolean }>();
  for (const gap of options.coverage?.skipped ?? []) {
    const broken = /Broken checkout/.test(gap.reason);
    const clone = options.clones?.filter(clone => clone.checkouts.some(checkout => !checkout.bare && checkout.gitDir === clone.commonDir && within(checkout.path, gap.path)))
      .sort((a, b) => b.commonDir.length - a.commonDir.length)[0];
    const owner = clone?.displayName ?? shortPath(gap.path.replace(/[/\\]\.(claude|cursor)[/\\]worktrees[^/\\]*[/\\].*$/, ""));
    const key = broken ? `${clone?.commonDir ?? dirname(gap.path)}\0broken` : gap.reason;
    const group = groups.get(key) ?? { paths: [], label: broken ? owner : gap.reason, broken };
    group.paths.push(gap.path); groups.set(key, group);
  }
  const lines = [...groups.values()].flatMap(group => options.verbose ? group.paths.map(path => `${group.label}: ${group.broken ? "broken checkout " : ""}${shortPath(path)}`)
    : examples === 1 ? [`${group.label}: ${group.paths.length}${group.broken ? " broken checkout dirs" : " paths"}; e.g. ${shortPath(group.paths[0] ?? "")}`]
      : [`${group.label}: ${group.paths.length}${group.broken ? " broken checkout dirs" : " paths"}`, ...group.paths.slice(0, examples).map(path => `  ${shortPath(path)}`)]);
  if (options.coverage?.brokenElsewhere) lines.push(`${options.coverage.brokenElsewhere} broken checkouts elsewhere: ggh lost`);
  if (options.coverage?.truncated) lines.push("Discovery incomplete: scan depth reached");
  return lines.map(line => fitProjectLine(line, options));
}
function summaryLines(parts: string[], options: CleanupViewOptions): string[] {
  const lines: string[] = [];
  let line = "";
  for (const part of parts) {
    const joined = line ? `${line} · ${part}` : part;
    if (line && fitProjectLine(joined, options) !== joined) { lines.push(line); line = part; }
    else line = joined;
  }
  if (line) lines.push(line);
  return lines;
}
export function formatTidyPlan(plan: TidyPlan, options: CleanupViewOptions = {}): string[] {
  const actions = plan.clones.flatMap(clone => clone.actions);
  const branches = actions.filter(action => action.kind === "delete-local-branch" || action.kind === "delete-remote-branch").length;
  const broken = options.coverage?.skipped.filter(gap => /Broken checkout/.test(gap.reason)).length ?? 0;
  const lines = summaryLines([
    `${branches} branches to delete across ${plan.clones.filter(clone => clone.actions.some(action => action.kind === "delete-local-branch" || action.kind === "delete-remote-branch")).length} clones`,
    `${actions.filter(action => action.kind === "remove-checkout").length} checkouts`,
    `${actions.filter(action => action.kind === "prune-worktree-metadata").length} metadata prunes`,
    `${plan.clones.reduce((n, clone) => n + clone.kept.length, 0)} kept`,
    `${plan.clones.reduce((n, clone) => n + clone.hostManual.length, 0)} agent worktrees left to their hosts`, `${broken} broken checkout dirs`,
  ], options);
  lines.push(`Tidy plan ${plan.snapshotId}`);
  for (const clone of [...plan.clones].sort((a, b) => b.actions.length - a.actions.length || b.hostManual.length - a.hostManual.length || a.name.localeCompare(b.name))) {
    if (!clone.actions.length && !options.verbose) continue;
    const main = options.clones?.find(candidate => candidate.commonDir === clone.commonDir)?.checkouts.find(checkout => checkout.gitDir === clone.commonDir);
    const path = main?.path ?? (basename(clone.commonDir) === ".git" ? dirname(clone.commonDir) : clone.commonDir);
    lines.push(`${clone.name}  ${shortPath(path)}`);
    if (options.verbose) lines.push(`  Refs fetched ${fetchAge(clone.fetchedAt)}; remote state may have changed`);
    for (const action of clone.actions) {
      if (action.kind === "delete-local-branch" || action.kind === "delete-remote-branch") {
        lines.push(`  delete${action.kind === "delete-remote-branch" ? " remote" : ""}  ${action.branch}  ${action.tip.slice(0, 7)} ⊂ ${action.integration.ref.replace(/^refs\/(remotes|heads)\//, "")} ${action.integration.oid.slice(0, 7)} (fetched ${fetchAge(clone.fetchedAt)})`);
        if (action.kind === "delete-remote-branch") lines.push(`    ${action.destination}; lease ${action.tip.slice(0, 7)}; owner ${action.login}`);
      } else if (action.kind === "remove-checkout") lines.push(`  remove checkout ${shortPath(action.checkout.path)}; ignored override ${action.allowIgnored}; unknown-owner override ${action.allowUnknown}`);
      else lines.push(`  prune metadata: ${action.entries.length} missing checkouts; expiry ${action.expire}`);
    }
    if (options.verbose) {
      for (const [reason, count] of counts(clone.kept.map(kept => kept.reason))) lines.push(`  KEEP ${count}: ${reason}`);
      for (const kept of clone.kept) lines.push(`    ${kept.target}: ${kept.reason}`);
      for (const host of clone.hostManual) lines.push(`    ${shortPath(host.target)}: ${host.reason}`);
      for (const hint of clone.hints) lines.push(`  ${hint.kind}: ${hint.reason}`);
    }
  }
  for (const [reason, count] of counts(plan.clones.flatMap(clone => clone.kept.map(kept => kept.reason)))) lines.push(`KEEP ${count}: ${reason}`);
  for (const [host, count] of counts(plan.clones.flatMap(clone => clone.hostManual.map(item => item.host)))) {
    const name = host === "t3" ? "T3" : host === "claude" ? "Claude" : host === "cursor" ? "Cursor" : "Codex";
    const clones = plan.clones.filter(clone => clone.hostManual.some(item => item.host === host)).length;
    lines.push(`${count} ${name} worktrees across ${clones} clones; clean up in ${host === "t3" ? "T3 Code" : host === "claude" ? "Claude Code" : name}`);
  }
  for (const [kind, count] of counts(plan.clones.flatMap(clone => clone.hints.map(hint => hint.kind)))) lines.push(`${kind}: ${count} clones; use --verbose for details`);
  lines.push(`Publication proofs require remote refs fetched within ${getConfig().tidy_max_fetch_age_days ?? 30} days; unknown ages are kept. Use --fetch to refresh.`);
  lines.push(...renderCoverage(options));
  return lines.map(line => fitProjectLine(line, options));
}
export function formatLost(result: LostResult, options: CleanupViewOptions = {}): string[] {
  const groups = result.clones.map(clone => ({ clone, items: result.items.filter(item => item.commonDir === clone.commonDir) }))
    .filter(({ items }) => items.length || options.verbose);
  const newest = (items: LostResult["items"]) => Math.max(0, ...items.flatMap(item => item.kind === "unpublished" ? [Date.parse(item.newestDate)] : item.kind === "stash" ? item.stashes.map(stash => Date.parse(stash.date)) : []));
  groups.sort((a, b) => b.clone.uniqueCommits - a.clone.uniqueCommits || newest(b.items) - newest(a.items) || a.clone.name.localeCompare(b.clone.name));
  const tail: string[] = [];
  for (const warning of result.warnings) tail.push(`UNKNOWN ${shortPath(warning.target)}: ${warning.reason}`);
  tail.push(...renderCoverage(options, options.verbose ? 1 : 3));
  const orphaned = result.items.filter(item => !result.clones.some(clone => clone.commonDir === item.commonDir) && !options.coverage?.skipped.some(gap => gap.path === item.path));
  for (const [commonDir] of counts(orphaned.map(item => item.commonDir))) {
    const items = orphaned.filter(item => item.commonDir === commonDir);
    groups.push({ clone: { commonDir, name: options.clones?.find(clone => clone.commonDir === commonDir)?.displayName ?? shortPath(commonDir), uniqueCommits: 0, branches: 0, detachedHeads: 0, fetchedAt: null }, items });
  }
  if (!groups.length) return ["No unpublished work found in inspected checkouts.", ...tail].map(line => fitProjectLine(line, options));
  const lines: string[] = [];
  let remaining = 80 - groups.length - tail.length - 2;
  let expanded = 0;
  let expand = true;
  for (const { clone, items } of groups) {
    const unpublished = items.filter(item => item.kind === "unpublished").sort((a, b) => b.uniqueCommits - a.uniqueCommits || Date.parse(b.newestDate) - Date.parse(a.newestDate) || (a.branch ?? a.head).localeCompare(b.branch ?? b.head));
    const stashes = items.filter(item => item.kind === "stash").flatMap(item => item.stashes).sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    const dirty = items.filter(item => item.kind === "dirty-host-checkout");
    const ordinaryDirty = items.filter(item => item.kind === "dirty-checkout");
    const broken = items.filter(item => item.kind === "broken-gitdir").filter(item => !options.coverage?.skipped.some(gap => gap.path === item.path));
    const top = unpublished[0];
    lines.push(`${clone.name} · ${clone.uniqueCommits.toLocaleString("en-US")} unique · ${clone.branches} branch${clone.branches === 1 ? "" : "es"}${clone.detachedHeads ? ` + ${clone.detachedHeads} HEAD` : ""} · ${stashes.length} stash${stashes.length === 1 ? "" : "es"} · fetch ${fetchAge(clone.fetchedAt)}${dirty.length ? ` · ${dirty.length} dirty host` : ""}${ordinaryDirty.length ? ` · ${ordinaryDirty.length} dirty` : ""}${broken.length ? ` · ${broken.length} broken` : ""}${top ? ` · ${top.branch ?? `HEAD ${top.head.slice(0, 7)}`}` : ""}`);
    const detail: string[] = [];
    for (const item of items.filter(item => item.kind === "reflog-only")) detail.push(`  REFLOG ${item.branch ?? shortPath(item.path ?? item.commonDir)}: ${item.commits.length} unpublished commits; last ${item.scannedEntries} entries scanned${item.truncated ? "; older history unknown" : ""}`);
    for (const item of items.filter(item => item.kind === "restack-preimage")) detail.push(`  RESTACK PRE-IMAGE ${item.branch}: ${item.head.slice(0, 12)}; saved by stack recovery ${item.operationId}`);
    const shown = options.verbose ? unpublished : unpublished.slice(0, 3);
    for (const item of shown) {
      detail.push(`  ${item.branch ?? `HEAD ${item.head.slice(0, 7)}`}  ${item.commits} (${item.uniqueCommits} unique to it, ${item.sharedCommits} shared)  ${fetchAge(item.newestDate)}`);
      if (options.verbose) detail.push(`    ${shortPath(item.path ?? item.commonDir)}  ${item.createdBy}`, `    ${item.newestDate}  ${item.newestSubject}`);
    }
    const omitted = unpublished.slice(shown.length);
    const branches = omitted.filter(item => item.branch !== null);
    if (branches.length) detail.push(`  … ${branches.length} more branches (${branches.filter(item => item.uniqueCommits === 0).length} with 0 unique commits)`);
    const detached = omitted.length - branches.length;
    if (detached) detail.push(`  … ${detached} more detached HEAD${detached === 1 ? "" : "s"}`);
    if (stashes.length) {
      detail.push(`  STASH ${stashes.length}`);
      for (const stash of stashes.slice(0, options.verbose ? undefined : 3)) detail.push(`    ${stash.ref}  ${fetchAge(stash.date)}  ${stash.message}`);
    }
    if (dirty.length) {
      detail.push(`  DIRTY HOST ${dirty.length}`);
      for (const item of dirty.slice(0, options.verbose ? undefined : 3)) detail.push(`    ${shortPath(item.path ?? item.commonDir)}; ${item.host}${item.dirty ? `; ${item.dirty.staged} staged, ${item.dirty.unstaged} unstaged, ${item.dirty.untracked} untracked, ${item.dirty.conflicted} conflicted` : ""}`);
    }
    if (ordinaryDirty.length) {
      detail.push(`  DIRTY ${ordinaryDirty.length}`);
      for (const item of ordinaryDirty.slice(0, options.verbose ? undefined : 3)) detail.push(`    ${shortPath(item.path ?? item.commonDir)}; ${item.dirty.staged} staged, ${item.dirty.unstaged} unstaged, ${item.dirty.untracked} untracked, ${item.dirty.conflicted} conflicted`);
    }
    if (broken.length) {
      detail.push(`  BROKEN ${broken.length}`);
      for (const item of broken.slice(0, options.verbose ? undefined : 3)) detail.push(`    ${shortPath(item.path ?? item.commonDir)}; ${item.reason}`);
    }
    if (options.verbose) for (const item of items) for (const step of item.nextSteps) detail.push(`    next: ${step.map(arg => JSON.stringify(arg)).join(" ")}`);
    if (!options.verbose && detail.length > remaining) expand = false;
    if (options.verbose || expand) {
      lines.push(...detail);
      remaining -= detail.length;
      expanded++;
    }
  }
  lines.push(...tail);
  lines.push("Commits may already exist on the remote; use --fetch to refresh remote-tracking refs.");
  if (!options.verbose) lines.push(`Branch detail shown for ${expanded} of ${groups.length} clones; run ggh lost <name> or --verbose for the rest.`);
  return lines.map(line => fitProjectLine(line, options));
}
