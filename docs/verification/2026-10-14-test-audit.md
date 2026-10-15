# Regression test audit

Audited all 50 source test files, 72 native cases, and both package smoke scripts. Removed 104 source cases on net and one duplicate native case. All 500 remaining source tests and 71 native regressions passed on macOS. Typecheck, lint, and the diff check passed.

The [receipt](2026-10-14-test-audit.json) records every file verdict, case counts, removal reasons, source hashes, and native results. The [implementation receipt](2026-10-14-local-acceptance.md) remains the record of the earlier build, package, terminal, and runtime checks. The native executable and bundle still match its hashes. This audit changed tests and documentation only; it did not rebuild or republish packages.

## What was removed

| Source case group | Net reduction | Reason |
| --- | ---: | --- |
| Source-text flag scans | 75 | Function spellings did not prove JSON or dry-run behavior. Kept option-forwarding and capability-registration checks. |
| Help-name self-checks | 8 | Finding a command by name and checking that help repeated its name added no useful result. Registration and actual CLI help checks remain. |
| Shape-only, constant, and no-throw checks | 7 | Arbitrary arrays, numbers, or defined output passed. The zero-line erasure check did not assert that nothing was written. |
| Duplicate or combined behavioral cases | 13 | Kept the useful assertions in existing fixtures. |
| JSON and no-input flag checks | 1 | Replaced two headless checks with one test that simulates a terminal, checks the interactive baseline and both flags, and restores stdin. |
| Total | 104 | Source cases decreased from 604 to 500. |

The native harness decreased from 72 to 71 cases. `test_51` called `test_17` in full. Its parent-pointer and stack-list assertions now run within `test_17`.

Useful assertions were preserved when combining fixtures. The existing-branch worktree test now checks that a recorded parent survives a different requested base. Detached status still checks `isRepo`. The env-copy test checks the returned file list as well as copied content. Help, stderr, and shell-completion assertions share their existing CLI invocations.

## Changed source suites

| File | Before | After |
| --- | ---: | ---: |
| `tests/audit-edgecases.test.ts` | 6 | 6 |
| `tests/audit-fixes.test.ts` | 7 | 4 |
| `tests/flag-contract.test.ts` | 77 | 2 |
| `tests/git-safety.test.ts` | 8 | 6 |
| `tests/git.test.ts` | 27 | 21 |
| `tests/github-surface.test.ts` | 18 | 9 |
| `tests/github.test.ts` | 8 | 6 |
| `tests/platform.test.ts` | 25 | 23 |
| `tests/prompts.test.ts` | 10 | 9 |
| `tests/release-safety.test.ts` | 22 | 21 |
| `tests/smoke.test.ts` | 24 | 21 |
| `tests/suggest.test.ts` | 10 | 10 |

All 50 files remain because each still protects distinct behavior. Unit, CLI, native-executable, and installed-package checks were evaluated separately. Similar workflow names did not make those layers interchangeable. The two package smoke scripts remain unchanged.

## Verification and limits

- `bun test --timeout 30000`: 500 passed, zero failed, 50 files.
- Focused checks: 135 passed across 11 edited suites. The final worktree and detached-status assertion merges also passed two targeted checks.
- `python3 scripts/audit-regressions.py --binary "$PWD/ggh" --results <report>`: 71 passed, zero failures or errors.
- `bun run typecheck`, `bun run lint`, and `git diff --check`: passed.

The GitHub and model calls used local mocks, and pushes used temporary bare repositories. Linux, Windows, live services, signing, and publication remain outside this receipt. Package smoke results come from the earlier implementation receipt; their artifacts are unchanged.

Removing shape-only tests does not establish functional coverage for drift or submodule statuses. Those cases did not prove correct results before this audit either. No speedup is claimed because host load differed between runs.

The work remains uncommitted on `main`.
