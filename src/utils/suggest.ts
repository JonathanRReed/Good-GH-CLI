/**
 * "Did you mean" for mistyped commands. `ggh prr` used to fall through to
 * git, which suggested `prune` — useless. Now ggh checks the typo against
 * its own commands first, and only forwards to git when the typo looks like
 * git's (or matches one of the user's git aliases, which always win).
 *
 * Pure functions so the policy is unit-testable (tests/suggest.test.ts);
 * the git-alias guard lives in index.ts next to the forwarding decision.
 */

/** Classic edit distance. Short strings, tiny inputs — no library needed. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** Closest candidate within tolerance, or null. Short words get less slack. */
export function closestMatch(input: string, candidates: Iterable<string>): string | null {
  const word = input.toLowerCase();
  if (word.length < 2) return null;
  const tolerance = word.length <= 4 ? 1 : 2;
  let best: string | null = null;
  let bestDist = Infinity;
  for (const candidate of candidates) {
    const dist = editDistance(word, candidate.toLowerCase());
    if (dist < bestDist && dist <= tolerance) {
      bestDist = dist;
      best = candidate;
    }
  }
  return best;
}
