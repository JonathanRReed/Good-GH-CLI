import type { Command } from "commander";
import { existsSync, statSync } from "node:fs";
import { getConfig, saveConfig } from "../services/config.ts";
import { isNonInteractive, getFlags, recordCompletedEffect } from "../services/runtime.ts";
import { discoverProjects, projectPath } from "../services/projects/discovery.ts";
import { forgetProject, readProjectIndex, refreshProjectIndex, registerProject } from "../services/projects/index-store.ts";
import { resolveProjects } from "../services/projects/query.ts";
import { projectHistory, readCloneStatus, readProjectStatuses } from "../services/projects/status.ts";
import { formatProjects, formatProjectCard, formatUncloned, renderProjectCard, renderProjects, shortPath, sortProjects, type ProjectRow, type ProjectViewOptions } from "../services/projects/view.ts";
import { projectStatusScope, readProjectStatusCache, writeProjectStatusCache } from "../services/projects/status-cache.ts";
import { cloneRemoteIds, readProjectRemotes, remoteRepoKey } from "../services/projects/remote.ts";
import type { RemoteResult } from "../services/projects/remote-types.ts";
import type { IndexedClone } from "../services/projects/types.ts";
import { fail, jsonOut, p, selectMenu } from "../utils/ui.ts";

export function projectPayload({ clone, status, remote }: ProjectRow) {
  return {
    ...(remote ? { remote } : {}),
    commonDir: clone.commonDir, name: clone.displayName, primary: clone.primary, remotes: clone.remotes,
    ...(clone.missing ? { missing: true } : {}), lastSeen: clone.lastSeen,
    checkouts: clone.checkouts.map(checkout => ({ ...checkout, ...status.checkouts.find(state => state.path === checkout.path) })),
    stashes: status.stashes, newestStash: status.newestStash, unpublished: status.unpublished, mergedBranches: status.mergedBranches, lastCommit: status.lastCommit,
  };
}

export async function selectProject(clones: IndexedClone[], query: string): Promise<IndexedClone | null> {
  const candidates = resolveProjects(clones, query);
  if (candidates.length === 1) return candidates[0] ?? null;
  const message = candidates.length ? `Several projects match ${query}. Use an exact checkout path.` : `No local project matches ${query}. Run ggh clone ${JSON.stringify(query)} to clone it.`;
  if (candidates.length && !isNonInteractive()) {
    return selectMenu({ message: "Choose a project", options: candidates.map(clone => ({ value: clone, label: `${clone.displayName}  ${shortPath(clone.checkouts[0]?.path ?? clone.commonDir)}` })) });
  }
  fail(message, { code: "missing_input", requiredInputs: [{ name: "query", description: "An exact local name or path", alternatives: candidates.flatMap(clone => clone.checkouts.map(checkout => checkout.path)) }] });
  // Even plain noninteractive go reports candidates as data rather than guessing.
  if (getFlags().json) jsonOut({ schemaVersion: 1, query, candidates: candidates.map(clone => ({ name: clone.displayName, paths: clone.checkouts.map(checkout => checkout.path), primary: clone.primary })), ...(!candidates.length ? { suggestion: ["ggh", "clone", query] } : {}) });
  else if (isNonInteractive()) {
    const { data } = await import("../utils/output.ts");
    data(JSON.stringify({ schemaVersion: 1, query, candidates: candidates.map(clone => ({ name: clone.displayName, paths: clone.checkouts.map(checkout => checkout.path) })), ...(!candidates.length ? { suggestion: ["ggh", "clone", query] } : {}) }));
  }
  return null;
}

export async function showProjects(query?: string, options: ProjectViewOptions = {}): Promise<void> {
  options = { ...options, remote: options.remote || options.uncloned };
  let cachedLines = 0;
  const flags = getFlags();
  if (query === undefined && process.stdout.isTTY && process.stderr.isTTY && !flags.json && !flags.quiet && !options.wide) {
    const previous = readProjectIndex();
    const cached = readProjectStatusCache(projectStatusScope(previous, getConfig()));
    if (cached) {
      const statuses = new Map(cached.statuses.map(status => [status.commonDir, status]));
      const rows = sortProjects(previous.clones.flatMap(clone => {
        const status = statuses.get(clone.commonDir);
        return status ? [{ clone, status, stale: true }] : [];
      }));
      if (rows.length) {
        // Keep the preview in the viewport so redraw cannot erase earlier output.
        const visible = rows.slice(0, Math.max(1, (process.stderr.rows ?? 24) - 2));
        cachedLines = previewHeight(formatProjects(visible, options));
        renderProjects(visible, options);
      }
    }
  }
  const index = await refreshProjectIndex();
  if (query !== undefined) {
    const clone = await selectProject(index.clones, query); if (!clone) return;
    const status = await readCloneStatus(clone);
    const history = await projectHistory(clone, status);
    const row: ProjectRow = { clone, status };
    const progressive = !!(options.remote && process.stdout.isTTY && process.stderr.isTTY && !flags.json && !flags.quiet);
    let previewLines = 0;
    if (progressive) { previewLines = previewHeight(formatProjectCard(row, history, false, options)); renderProjectCard(row, history, false, options); }
    const remote = options.remote ? await readProjectRemotes([clone], { ...options, localClones: index.clones }) : undefined;
    if (remote) attachRemotes([row], remote);
    if (jsonOut({ schemaVersion: 1, updatedAt: index.updatedAt, project: projectPayload(row), history, coverage: index.coverage, ...(remote ? { remote: remoteMetadata(remote) } : {}) })) return;
    if (previewLines) clearPreview(previewLines);
    renderProjectCard(row, history, false, options);
    if (remote) for (const line of formatUncloned(remote.uncloned, options)) p.log.message(line);
  } else {
    const statuses = await readProjectStatuses(index.clones);
    await writeProjectStatusCache(projectStatusScope(index, getConfig()), statuses);
    const rows: ProjectRow[] = sortProjects(index.clones.flatMap((clone, i) => { const status = statuses[i]; return status ? [{ clone, status }] : []; }));
    const progressive = !!(options.remote && process.stdout.isTTY && process.stderr.isTTY && !flags.json && !flags.quiet);
    if (cachedLines) { clearPreview(cachedLines); cachedLines = 0; }
    if (progressive) {
      const visible = rows.slice(0, Math.max(1, (process.stderr.rows ?? 24) - 2));
      cachedLines = previewHeight(formatProjects(visible, options));
      renderProjects(visible, options);
    }
    const remote = options.remote ? await readProjectRemotes(index.clones, options) : undefined;
    if (remote) attachRemotes(rows, remote);
    if (jsonOut({ schemaVersion: 1, updatedAt: index.updatedAt, projects: rows.map(projectPayload), coverage: index.coverage, ...(remote ? { remote: remoteMetadata(remote) } : {}) })) return;
    if (cachedLines) clearPreview(cachedLines);
    renderProjects(rows, options);
    if (remote) for (const line of formatUncloned(remote.uncloned, options)) p.log.message(line);
  }
  if (index.coverage) {
    for (const skipped of index.coverage.skipped) p.log.warn(`${shortPath(skipped.path)}: ${skipped.reason}`);
    if (index.coverage.truncated) p.log.warn("Scan depth reached. Register a nested repository or increase project_scan_depth.");
  }
}

function previewHeight(lines: string[]): number {
  const width = Math.max(1, process.stderr.columns ?? process.stdout.columns ?? 100);
  return lines.reduce((total, line) => total + Math.max(1, Math.ceil((Bun.stringWidth(line) + 3) / width)), 0);
}
function clearPreview(lines: number): void {
  // A tall context card may have scrolled beyond the viewport. Append instead.
  if (lines < (process.stderr.rows ?? 24)) process.stderr.write(`\x1b[${lines}A\r\x1b[0J`);
}
function attachRemotes(rows: ProjectRow[], result: RemoteResult): void {
  const remotes = new Map(result.repositories.map(repo => [remoteRepoKey(repo.repo), repo]));
  for (const row of rows) row.remote = cloneRemoteIds(row.clone).flatMap(repo => { const status = remotes.get(remoteRepoKey(repo)); return status ? [status] : []; });
}
function remoteMetadata(result: RemoteResult) { return { requests: result.requests, cost: result.cost, uncloned: result.uncloned }; }

export function registerProjectsCommand(program: Command): void {
  const projects = program.command("projects [query]").description("List local projects or inspect one project").option("--wide", "Show full column values").option("--remote", "Include GitHub PRs and CI").option("--uncloned", "Include owned repositories without local clones").option("--refresh", "Bypass the remote result cache").action((query: string | undefined, options: ProjectViewOptions) => showProjects(query, options));
  const roots = projects.command("roots").description("Manage project scan roots");
  roots.command("list").description("List configured roots").action(() => { const paths = getConfig().project_roots ?? []; if (!jsonOut({ schemaVersion: 1, roots: paths })) for (const path of paths) p.log.message(path); });
  for (const action of ["add", "remove"] as const) roots.command(`${action} <path>`).description(`${action === "add" ? "Add" : "Remove"} a scan root`).action((path: string) => {
    const canonical = projectPath(path);
    if (action === "add" && (!existsSync(canonical) || !statSync(canonical).isDirectory())) { fail(`Scan root is not a directory: ${canonical}`); return; }
    const paths = (getConfig().project_roots ?? []).map(projectPath);
    const next = action === "add" ? [...new Set([...paths, canonical])] : paths.filter(value => value !== canonical);
    saveConfig({ project_roots: next });
    recordCompletedEffect("projects_roots_updated");
    if (!jsonOut({ schemaVersion: 1, roots: next })) for (const path of next) p.log.message(shortPath(path));
  });
  projects.command("register <path>").description("Include a nested repository explicitly").action(async (path: string) => {
    const canonical = projectPath(path);
    const discovered = await discoverProjects({ config: { ...getConfig(), project_roots: [], host_worktree_dirs: {} }, registered: [canonical] });
    if (!discovered.clones.length) { fail(`Not a readable Git checkout: ${canonical}`); return; }
    await registerProject(canonical);
    if (!jsonOut({ schemaVersion: 1, registered: canonical })) p.log.success(`Registered ${shortPath(canonical)}`);
  });
  for (const action of ["exclude", "forget"] as const) projects.command(`${action} <path>`).description(`${action === "exclude" ? "Exclude" : "Forget"} a path without deleting its files`).action(async (path: string) => {
    const canonical = projectPath(path);
    await forgetProject(canonical);
    if (action === "exclude") {
      saveConfig({ project_exclude: [...new Set([...getConfig().project_exclude ?? [], canonical])] });
      recordCompletedEffect("projects_exclusions_updated");
    }
    if (!jsonOut({ schemaVersion: 1, excluded: canonical })) p.log.success(`Excluded ${shortPath(canonical)}`);
  });
}
