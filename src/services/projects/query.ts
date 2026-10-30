import { samePath } from "./paths.ts";
import { projectPath } from "./discovery.ts";
import type { IndexedClone } from "./types.ts";

export function resolveProjects(clones: readonly IndexedClone[], query: string): IndexedClone[] {
  if (!query) return [];
  const available = clones.filter(clone => !clone.missing);
  const path = projectPath(query);
  const paths = available.filter(clone => samePath(clone.commonDir, path) || clone.checkouts.some(checkout => samePath(checkout.path, path)));
  if (paths.length) return paths;
  const term = query.toLowerCase();
  const exact = available.filter(clone => clone.displayName.toLowerCase() === term || (clone.primary && `${clone.primary.owner}/${clone.primary.name}`.toLowerCase() === term));
  if (exact.length) return exact;
  // Only the project name and owner/repo ever match, never a filesystem path:
  // a query like "nope" must not resolve because its letters appear in order
  // somewhere under /home/user/Downloads/. A match also has to clear a quality
  // bar, so a miss stays a miss: either the query is a run of adjacent
  // characters, or its letters appear in order while skipping at most as many
  // name characters as the query itself types (separators are free).
  function fuzzy(text: string): number {
    text = text.toLowerCase();
    const at = text.indexOf(term);
    if (at >= 0) return 1000 - at * 10 - text.length;
    let offset = 0;
    let skipped = 0;
    for (const character of term) {
      const index = text.indexOf(character, offset);
      if (index < 0) return -Infinity;
      skipped += text.slice(offset, index).replaceAll(/[^a-z0-9]/g, "").length;
      offset = index + 1;
    }
    return skipped > term.length ? -Infinity : 500 - skipped * 10 - text.length;
  }
  return available.map(clone => ({ clone, score: Math.max(...[clone.displayName, clone.primary ? `${clone.primary.owner}/${clone.primary.name}` : ""].map(fuzzy)) }))
    .filter(hit => Number.isFinite(hit.score)).sort((a, b) => b.score - a.score).map(hit => hit.clone);
}
