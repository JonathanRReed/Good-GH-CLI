import { within } from "./paths.ts";
import type { Clone, DiscoveryCoverage } from "./types.ts";

export function coverageOwner(clones: readonly Clone[], path: string): Clone | undefined {
  return clones.flatMap(clone => [clone.commonDir, ...clone.checkouts.map(checkout => checkout.path)]
    .filter(root => within(root, path)).map(root => ({ clone, length: root.length })))
    .sort((a, b) => b.length - a.length || a.clone.commonDir.localeCompare(b.clone.commonDir))[0]?.clone;
}

export function selectedCoverage(coverage: DiscoveryCoverage, clones: readonly Clone[]): DiscoveryCoverage {
  const skipped = coverage.skipped.filter(gap => coverageOwner(clones, gap.path));
  return { ...coverage, skipped, brokenElsewhere: coverage.skipped.filter(gap => /Broken checkout/.test(gap.reason) && !coverageOwner(clones, gap.path)).length };
}
