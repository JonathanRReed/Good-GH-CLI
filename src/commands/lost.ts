import type { Command } from "commander";
import { getConfig } from "../services/config.ts";
import { discoverProjects } from "../services/projects/discovery.ts";
import { readProjectIndex } from "../services/projects/index-store.ts";
import { findLost, type LostResult } from "../services/projects/lost.ts";
import { resolveProjects } from "../services/projects/query.ts";
import { projectGit } from "../services/projects/git.ts";
import type { DiscoveryCoverage, IndexedClone } from "../services/projects/types.ts";
import { fail, jsonOut, p } from "../utils/ui.ts";

/** Read-only discovery. Neither command rewrites the project index or status cache. */
export async function cleanupProjects(names: string[], all: boolean, defaultAll = false): Promise<{ clones: IndexedClone[]; coverage: DiscoveryCoverage }> {
  if (all && names.length) throw new Error("Choose project names or --all, not both");
  const index = readProjectIndex();
  const discovered = await discoverProjects({ config: getConfig(), registered: index.registered, excluded: index.excluded, known: index.clones });
  const available = [...discovered.clones, ...index.clones.filter(clone => !discovered.clones.some(current => current.commonDir === clone.commonDir))];
  if (all || (!names.length && defaultAll)) return { clones: available, coverage: discovered.coverage };
  if (!names.length) {
    const current = (await projectGit(process.cwd(), ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
    let clone = available.find(clone => clone.commonDir === current);
    if (!clone) clone = (await discoverProjects({ config: { ...getConfig(), project_roots: [] }, registered: [process.cwd()] })).clones.find(clone => clone.commonDir === current);
    if (!clone) throw new Error("Current clone is unavailable; name a project or use --all");
    return { clones: [clone], coverage: discovered.coverage };
  }
  const selected: IndexedClone[] = [];
  for (const name of names) {
    const matches = resolveProjects(available, name);
    if (matches.length !== 1 || !matches[0]) throw new Error(`Project ${JSON.stringify(name)} is missing or ambiguous; use an exact checkout path`);
    selected.push(matches[0]);
  }
  return { clones: [...new Map(selected.map(clone => [clone.commonDir, clone])).values()], coverage: discovered.coverage };
}
export function renderLost(result: LostResult): string[] {
  const lines: string[] = [];
  for (const item of result.items) {
    const target = item.path ?? item.commonDir;
    if (item.kind === "unpublished") lines.push(`LOST ${item.commits} commit(s)  ${item.branch ?? "detached HEAD"}  ${target}  ${item.createdBy}`, `  ${item.newestDate}  ${item.newestSubject}`);
    else if (item.kind === "stash") {
      lines.push(`STASH ${item.count}  ${target}`);
      for (const stash of item.stashes) lines.push(`  ${stash.ref}  ${Math.max(0, Math.floor((Date.now() - Date.parse(stash.date)) / 86400000))} days old  ${stash.message}`);
    } else lines.push(`${item.kind === "broken-gitdir" ? "BROKEN" : "DIRTY HOST"}  ${target}  ${item.reason}`);
    for (const step of item.nextSteps) lines.push(`  next: ${step.map(arg => JSON.stringify(arg)).join(" ")}`);
  }
  for (const warning of result.warnings) lines.push(`UNKNOWN ${warning.target}: ${warning.reason}`);
  if (!lines.length) lines.push("No unpublished work found in inspected checkouts.");
  return lines;
}
export function registerLostCommand(program: Command): void {
  program.command("lost [projects...]").description("Find unpublished commits, stashes, and possible abandoned agent work")
    .option("--all", "Inspect all indexed projects, the default for lost")
    .action(async (names: string[], options: { all?: boolean }) => {
      try {
        const { clones, coverage } = await cleanupProjects(names, Boolean(options.all), true);
        const result = await findLost(clones);
        for (const gap of coverage.skipped) {
          if (/Broken checkout/.test(gap.reason) && !result.items.some(item => item.path === gap.path)) result.items.push({ kind: "broken-gitdir", commonDir: "unknown", path: gap.path, createdBy: "unknown", reason: gap.reason, nextSteps: [["git", "-C", gap.path, "rev-parse", "--git-dir"]] });
        }
        if (jsonOut({ ...result, coverage })) return;
        for (const line of renderLost(result)) p.log.message(line);
        for (const gap of coverage.skipped) p.log.warn(`${gap.path}: ${gap.reason}`);
      } catch (error) { fail(error instanceof Error ? error.message : "Lost inventory failed"); }
    });
}
