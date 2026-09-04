# Performance notes

`ggh` will never win a benchmark against ripgrep — it shells out to `git`,
`gh`, and AI CLIs, and no architecture changes that. What it can do is never
waste *your* time: start instantly, parallelize probes, memoize spawns, and
stay off the network unless you asked. This file records the budgets and the
receipts.

## Budgets (enforced in CI)

| Probe | Budget | Why it exists |
| --- | --- | --- |
| `ggh --version` | < 2 s | Catches network, AI, or other blocking work on the import path. Real number is ~0.03 s. |
| `ggh status --json` | < 10 s | Catches serialized or unbounded GitHub probes. Real number is ~0.5 s. |

Both run against the shipped `dist/` bundle, not `bun run` (which pays ~0.4 s
of TypeScript transform on every invocation — a dev-mode cost users never see).

## Receipts (dist bundle, Apple M1, medians)

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
