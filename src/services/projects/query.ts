import { projectPath } from "./discovery.ts";
import type { IndexedClone } from "./types.ts";

export function resolveProjects(clones: readonly IndexedClone[], query: string): IndexedClone[] {
  if (!query) return [];
  const available = clones.filter(clone => !clone.missing);
  const path = projectPath(query);
  const paths = available.filter(clone => clone.commonDir === path || clone.checkouts.some(checkout => checkout.path === path));
  if (paths.length) return paths;
  const term = query.toLowerCase();
  const exact = available.filter(clone => clone.displayName.toLowerCase() === term || (clone.primary && `${clone.primary.owner}/${clone.primary.name}`.toLowerCase() === term));
  if (exact.length) return exact;
  function fuzzy(text: string): number {
    text = text.toLowerCase();
    if (text.includes(term)) return 1000 - text.length;
    let offset = 0;
    let score = 0;
    for (const character of term) { const index = text.indexOf(character, offset); if (index < 0) return -Infinity; score -= index - offset; offset = index + 1; }
    return score - text.length;
  }
  return available.map(clone => ({ clone, score: Math.max(...[clone.displayName, clone.primary ? `${clone.primary.owner}/${clone.primary.name}` : "", ...clone.checkouts.map(checkout => checkout.path)].map(fuzzy)) }))
    .filter(hit => Number.isFinite(hit.score)).sort((a, b) => b.score - a.score).map(hit => hit.clone);
}
