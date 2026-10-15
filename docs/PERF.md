# Performance notes

These measurements separate process startup, local Git work, and remote waiting.
Commands that include GitHub state may call GitHub. Local commands stay offline.

## Budgets (enforced in CI)

| Probe | Budget | Why it exists |
| --- | --- | --- |
| `ggh --version` | < 2 s | Catches network, AI, or other blocking work on the import path. Real number is ~0.03 s. |
| `ggh status --json` | < 10 s | Catches serialized or unbounded GitHub probes. Real number is ~0.5 s. |

Both run against the shipped `dist/` bundle, not `bun run` (which pays ~0.4 s
of TypeScript transform on every invocation — a dev-mode cost users never see).

## Historical receipts (dist bundle, Apple M1, medians)

| Command | Time | Dominant cost |
| --- | --- | --- |
| `--version`, `--help` | 0.03 s | Bun startup alone |
| `alias --json`, `completion zsh` | 0.02 s | Pure local |
| `log` | 0.06 s | One `git log` + render |
| `status --json` | 0.5 s | `gh auth status` 0.3 s + `gh pr view` 0.5 s in parallel; git probes ~0.03 s |

Method: `/usr/bin/time -p bun dist/ggh.js <args>`, five runs, median.
Outliers (~1 s on `status`) are `gh`/network variance, not ours.

## Where time went (profiled 2026-09)

- `getActivePullRequest` (`gh pr view`): ~0.55 s. Inherent — one network
  round trip. Left unmemoized on purpose: commands mutate PR state mid-run.
- `getGitHubAuthStatus` (`gh auth status`): ~0.3 s per call, and
  `requireAuth` runs on nearly every command. Now memoized per process
  (identity cannot change mid-run): second call is 0 ms.
- `checkSubmodules` (`git submodule status`): ~0.13 s even with no
  submodules. Now early-exits when no `.gitmodules` file exists.
- `getAvailableProviders`: spawns four CLIs (~0.08 s here, up to 15 s
  worst case each). Memoized 60 s process-wide.
- `getAheadOfDefault`: current-branch lookup overlaps default-branch detection;
  the remaining git work is below the noise floor.

## Policy for new code

1. Mutating git calls go through `execGitWithRetry`; reads use `run`
   directly (see `src/services/git/exec.ts`).
2. Anything that spawns a subprocess per command and returns identity-like
   data gets memoized (auth, providers, `commandExists`).
3. Local reads (`log`, `stack list`, and similar commands) never touch the
   network. Commands that include GitHub state, such as `status`, may call `gh`
   and must degrade cleanly when offline.
4. `--dry-run` never bills AI and never prompts (enforced by
   `tests/safety-net.test.ts`).

## Candidate bundle budget

The next beta allows a minified bundle up to 600,000 bytes. This guards
unexpected growth while accommodating the agent schema, recovery, and Windows
privacy code. The 991f466 hosted build measured 502,021 bytes, just above the
previous 500,000-byte gate. Bundle size is a packaging check. Startup and workflow
latency need their own measurements before the final release.


## Packaged candidate qualification

The native runner starts a fresh process for every sample, verifies its output,
and alternates baseline and candidate order. It records the first invocation
separately from five later runs per side. It does not flush OS caches or claim
cold-disk startup. Fixtures contain 20, 5,000 and 10,000 synthetic data files.
Profiles are isolated, repositories have no remotes, and known GitHub/provider
clients are blocked during POSIX runs. Windows uses a restricted executable PATH.
Remote latency is outside this local-workload measurement.

The 2026-10-14 run validated all 11 workloads on both exact native artifacts with
zero errors. Load reached 74.9 on 14 cores, and timing ranges overlap. The
comparison is inconclusive. The artifacts may embed different native runtimes,
so these results cannot isolate the cost of a source change. Raw samples,
artifact hashes, runner hash, environment and validation counts are in
[the packaged performance receipt](verification/2026-10-14-packaged-performance.json).

Representative candidate samples from that busy host:

| Workload | Median of 5 | Range |
| --- | ---: | ---: |
| Version |37.8ms |28.8–54.4ms |
| Small-repo status |316.4ms |264.6–581.6ms |
|5000-file status |302.4ms |252.7–368.2ms |
|10000-file monorepo status |424.9ms |264.7–601.3ms |

These are observations, not a speedup or a universal latency promise. Platform
release jobs run the same validated workloads against their current and previous
artifacts. The final release must retain those exact-artifact results.

Run locally with a trusted native artifact:

```bash
python3 scripts/measure-performance.py --binary /absolute/path/to/ggh \
  --expected-version 0.4.0-beta.3 --baseline /absolute/path/to/previous-ggh \
  --results performance.json
```
