import type { Command } from "commander";
import { getConfig } from "../services/config.ts";
import { discoverProjects, projectPath } from "../services/projects/discovery.ts";
import { readProjectIndex } from "../services/projects/index-store.ts";
import { coverageOwner, selectedCoverage } from "../services/projects/coverage.ts";
import { findLost, sortLost } from "../services/projects/lost.ts";
import { resolveProjects } from "../services/projects/query.ts";
import { projectGit } from "../services/projects/git.ts";
import type { DiscoveryCoverage, IndexedClone } from "../services/projects/types.ts";
import { getFlags, setCommandCancellation } from "../services/runtime.ts";
import { fetchCleanupClones } from "../services/projects/cleanup-fetch.ts";
import { formatLost, type CleanupViewOptions } from "../services/projects/cleanup-view.ts";
import { fail, jsonOut, p } from "../utils/ui.ts";

/** Read-only discovery. Neither command rewrites the project index or status cache. */
export async function cleanupProjects(names: string[], all: boolean, defaultAll = false): Promise<{ clones: IndexedClone[]; coverage: DiscoveryCoverage }> {
  if (all && names.length) throw new Error("Choose project names or --all, not both");
  const index = readProjectIndex();
  const discovered = await discoverProjects({ config: getConfig(), registered: index.registered, excluded: index.excluded, known: index.clones });
  const available = [...discovered.clones, ...index.clones.filter(clone => !discovered.clones.some(current => current.commonDir === clone.commonDir))];
  if (all || (!names.length && defaultAll)) return { clones: available, coverage: discovered.coverage };
  if (!names.length) {
    const current = projectPath((await projectGit(process.cwd(), ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim());
    let clone = available.find(clone => clone.commonDir === current);
    if (!clone) clone = (await discoverProjects({ config: { ...getConfig(), project_roots: [] }, registered: [process.cwd()] })).clones.find(clone => clone.commonDir === current);
    if (!clone) throw new Error("Current clone is unavailable; name a project or use --all");
    return { clones: [clone], coverage: selectedCoverage(discovered.coverage, [clone]) };
  }
  const selected: IndexedClone[] = [];
  for (const name of names) {
    const matches = resolveProjects(available, name);
    if (matches.length !== 1 || !matches[0]) throw new Error(`Project ${JSON.stringify(name)} is missing or ambiguous; use an exact checkout path`);
    selected.push(matches[0]);
  }
  const clones = [...new Map(selected.map(clone => [clone.commonDir, clone])).values()];
  return { clones, coverage: selectedCoverage(discovered.coverage, clones) };
}
export { formatLost as renderLost } from "../services/projects/cleanup-view.ts";
export function registerLostCommand(program: Command): void {
  program.command("lost [projects...]").description("Find unpublished commits, stashes, and possible abandoned agent work")
    .option("--all", "Inspect all indexed projects, the default for lost")
    .option("--fetch", "Fetch and prune remote-tracking refs once per clone before inspection")
    .option("--wide", "Show full line values")
    .option("--verbose", "Show all branches, paths, commit subjects, and recovery commands")
    .action(async (names: string[], options: CleanupViewOptions & { all?: boolean; fetch?: boolean }) => {
      const controller = new AbortController();
      const interrupt = () => controller.abort();
      process.on("SIGINT", interrupt);
      setCommandCancellation(interrupt);
      try {
        const progress = process.stderr.isTTY && !getFlags().json && !getFlags().quiet;
        if (progress) p.log.info("Discovering projects for lost inventory...");
        const { clones, coverage } = await cleanupProjects(names, Boolean(options.all), true);
        if (options.fetch) await fetchCleanupClones(clones, "lost", controller.signal);
        if (controller.signal.aborted) { jsonOut({ schemaVersion: 1, clones: [], items: [], warnings: [], coverage, status: "cancelled" }); return; }
        if (progress) p.log.info(`Inspecting ${clones.length} clones for unpublished work...`);
        const result = await findLost(clones, getConfig(), { onProgress: progress ? (completed, total, name) => p.log.info(`Inspected ${completed}/${total}: ${name}`) : undefined });
        for (const gap of coverage.skipped) {
          if (/Broken checkout/.test(gap.reason) && !result.items.some(item => item.path === gap.path)) result.items.push({ kind: "broken-gitdir", commonDir: coverageOwner(clones, gap.path)?.commonDir ?? "unknown", path: gap.path, createdBy: "unknown", reason: gap.reason, nextSteps: [["git", "-C", gap.path, "rev-parse", "--git-dir"]] });
        }
        sortLost(result.items);
        if (jsonOut({ ...result, coverage })) return;
        for (const line of formatLost(result, { ...options, verbose: options.verbose || (names.length === 1 && clones.length === 1), coverage, clones })) p.log.message(line);
      } catch (error) { fail(error instanceof Error ? error.message : "Lost inventory failed"); }
      finally { setCommandCancellation(undefined); process.off("SIGINT", interrupt); }
    });
}
