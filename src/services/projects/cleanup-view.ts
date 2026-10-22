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
function staleFetch(value: string | null): boolean { return !value || !Number.isFinite(Date.parse(value)) || Date.now() - Date.parse(value) > 86400000; }
function counts(values: string[]): [string, number][] {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return [...result];
}
export function renderCoverage(options: CleanupViewOptions): string[] {
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
    : [`${group.label}: ${group.paths.length}${group.broken ? " broken checkout dirs" : " paths"}; e.g. ${shortPath(group.paths[0] ?? "")}`]);
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
    `${plan.clones.reduce((n, clone) => n + clone.kept.length, 0)} kept`,
    `${plan.clones.reduce((n, clone) => n + clone.hostManual.length, 0)} agent worktrees left to their hosts`, `${broken} broken checkout dirs`,
  ], options);
  lines.push(`Tidy plan ${plan.snapshotId}`);
  for (const clone of [...plan.clones].sort((a, b) => b.actions.length - a.actions.length || b.hostManual.length - a.hostManual.length || a.name.localeCompare(b.name))) {
    const main = options.clones?.find(candidate => candidate.commonDir === clone.commonDir)?.checkouts.find(checkout => checkout.gitDir === clone.commonDir);
    const path = main?.path ?? (basename(clone.commonDir) === ".git" ? dirname(clone.commonDir) : clone.commonDir);
    lines.push(`${clone.name}  ${shortPath(path)}`);
    if (clone.actions.length || options.verbose) lines.push(`  Refs fetched ${fetchAge(clone.fetchedAt)}; remote state may have changed`);
    for (const action of clone.actions) {
      if (action.kind === "delete-local-branch" || action.kind === "delete-remote-branch") {
        lines.push(`  delete${action.kind === "delete-remote-branch" ? " remote" : ""}  ${action.branch}  ${action.tip.slice(0, 7)} ⊂ ${action.integration.ref.replace(/^refs\/(remotes|heads)\//, "")} ${action.integration.oid.slice(0, 7)} (fetched ${fetchAge(clone.fetchedAt)})`);
        if (action.kind === "delete-remote-branch") lines.push(`    ${action.destination}; lease ${action.tip.slice(0, 7)}; owner ${action.login}`);
      } else if (action.kind === "remove-checkout") lines.push(`  remove checkout ${shortPath(action.checkout.path)}; ignored override ${action.allowIgnored}; unknown-owner override ${action.allowUnknown}`);
      else lines.push(`  prune metadata: ${action.entries.length} missing checkouts; expiry ${action.expire}`);
    }
    for (const [reason, count] of counts(clone.kept.map(kept => kept.reason))) lines.push(`  KEEP ${count}: ${reason}`);
    if (options.verbose) for (const kept of clone.kept) lines.push(`    ${kept.target}: ${kept.reason}`);
    for (const [host, count] of counts(clone.hostManual.map(host => host.host))) {
      const name = host === "t3" ? "T3" : host === "claude" ? "Claude" : host === "cursor" ? "Cursor" : "Codex";
      lines.push(`  ${count} ${name} worktrees; clean up in ${host === "t3" ? "T3 Code" : host === "claude" ? "Claude Code" : name}`);
    }
    if (options.verbose) {
      for (const host of clone.hostManual) lines.push(`    ${shortPath(host.target)}: ${host.reason}`);
      for (const hint of clone.hints) lines.push(`  ${hint.kind}: ${hint.reason}`);
    }
  }
  for (const [kind, count] of counts(plan.clones.flatMap(clone => clone.hints.map(hint => hint.kind)))) lines.push(`${kind}: ${count} clones; use --verbose for details`);
  if (plan.clones.some(clone => staleFetch(clone.fetchedAt))) lines.push("Some fetch ages exceed 1d or are unknown; use --fetch to refresh remote-tracking refs.");
  lines.push(...renderCoverage(options));
  return lines.map(line => fitProjectLine(line, options));
}
export function formatLost(result: LostResult, options: CleanupViewOptions = {}): string[] {
  const lines: string[] = [];
  const groups = result.clones.map(clone => ({ clone, items: result.items.filter(item => item.commonDir === clone.commonDir) }));
  const oldest = (items: LostResult["items"]) => Math.min(...items.flatMap(item => "oldestDate" in item ? [Date.parse(item.oldestDate)] : []));
  groups.sort((a, b) => b.clone.uniqueCommits - a.clone.uniqueCommits || oldest(a.items) - oldest(b.items) || a.clone.name.localeCompare(b.clone.name));
  for (const { clone, items } of groups) {
    if (!items.length && !options.verbose) continue;
    lines.push(`${clone.name}: ${clone.uniqueCommits.toLocaleString("en-US")} unique commits on ${clone.branches} branch${clone.branches === 1 ? "" : "es"}${clone.detachedHeads ? ` + ${clone.detachedHeads} detached HEAD${clone.detachedHeads === 1 ? "" : "s"}` : ""}`,
      `  as of fetch ${fetchAge(clone.fetchedAt)}; commits may already exist on the remote`);
    for (const item of [...items.filter(item => item.kind === "unpublished"), ...items.filter(item => item.kind !== "unpublished")]) {
      if (item.kind === "unpublished") {
        lines.push(`  ${item.branch ?? `HEAD ${item.head.slice(0, 7)}`}  ${item.commits} (${item.uniqueCommits} unique to it, ${item.sharedCommits} shared)  ${fetchAge(item.oldestDate)}`);
        if (options.verbose) lines.push(`    ${shortPath(item.path ?? item.commonDir)}  ${item.createdBy}`, `    ${item.newestDate}  ${item.newestSubject}`);
      } else if (item.kind === "stash") {
        lines.push(`  STASH ${item.count}`);
        if (options.verbose) for (const stash of item.stashes) lines.push(`    ${stash.ref}  ${fetchAge(stash.date)}  ${stash.message}`);
      } else if (item.kind === "dirty-host-checkout") lines.push(`  DIRTY HOST ${shortPath(item.path ?? item.commonDir)}; ${item.host}`);
      if (options.verbose) for (const step of item.nextSteps) lines.push(`    next: ${step.map(arg => JSON.stringify(arg)).join(" ")}`);
    }
  }
  for (const item of result.items.filter(item => !result.clones.some(clone => clone.commonDir === item.commonDir))) {
    if (item.kind === "dirty-host-checkout") lines.push(`DIRTY HOST ${shortPath(item.path ?? item.commonDir)}; ${item.host}`);
  }
  const broken = result.items.filter(item => item.kind === "broken-gitdir" && !options.coverage?.skipped.some(gap => gap.path === item.path));
  for (const [commonDir, count] of counts(broken.map(item => item.commonDir))) {
    const clone = result.clones.find(clone => clone.commonDir === commonDir);
    const example = broken.find(item => item.commonDir === commonDir);
    lines.push(`${clone?.name ?? shortPath(commonDir)}: ${count} broken checkout dirs; e.g. ${shortPath(example?.path ?? commonDir)}`);
  }
  for (const warning of result.warnings) lines.push(`UNKNOWN ${shortPath(warning.target)}: ${warning.reason}`);
  if (!lines.length) lines.push("No unpublished work found in inspected checkouts.");
  if (groups.some(({ clone, items }) => items.length && staleFetch(clone.fetchedAt))) lines.push("Use --fetch to refresh remote-tracking refs; --verbose shows paths and recovery commands.");
  else if (result.items.length) lines.push("Use --verbose for paths and recovery commands.");
  lines.push(...renderCoverage(options));
  return lines.map(line => fitProjectLine(line, options));
}
