# Quality release execution

## Objective

Complete the 18 ranked roadmap items in order, prototype the six approved experiments, then clean up, remove unnecessary code, measure packaged performance, commit, merge to main, and publish the next beta. Jonathan is the sole user. Outside human participants are not an acceptance gate. Automated checks, independent agent workflows, and direct manual checks supply the qualification evidence.

## Current state and authority

The work is on `feat/quality-release`, based on `4b1657e`. The 112 existing dirty entries belong to this session's implementation and audit. Preserve them. `origin/main` has one additional CI-only commit, `eab613e`; integrate it without rewriting shared history. The baseline patch and untracked inventory are saved outside the repo in a temporary quality-release baseline directory.

The user authorized edits, cleanup, tests, commit, push, merge to main, and a new release. Live qualification uses disposable repositories under the authenticated account, with synthetic content and explicit private defaults. Never change existing repository visibility or touch unrelated repositories. No spending, credential rotation, or messages to other people are authorized.

## Sequence

1. Owner-aware operation lock recovery.
2. Nested completion in zsh, bash, fish, and PowerShell.
3. Additive versioned agent output and schema discovery. Preserve documented JSON and native escapes.
4. Recovery guidance and safe resumable publication, without storing content by default.
5. Explicit snapshots and revalidation of material plan changes.
6. Exact-artifact clean installation and platform CI.
7. Windows private storage and subprocess-tree cleanup.
8. Live GitHub qualification and cleanup.
9. macOS signing, notarization, and downloaded-package checks.
10. Terminal input, cancellation, and restoration matrix.
11. Failure injection and uncertain-effect recovery.
12. Solo-user and independent agent task completion. External participants waived by the user.
13. Manual multiline PR editing and previews.
14. Specific install and dependency repair guidance.
15. Repeatable packaged performance measurements.
16. Execution-model simplification where direct evidence supports it.
17. Hermetic offline demo with assertions.
18. Dependency capability compatibility.
19. Prototype recovery timeline, local rehearsal, contextual next actions, metadata handoff, incident fixtures, and keyboard stack view in that order. Retain experiments only when they improve an observed task.
20. Final cleanup, debloat, performance, security, source, package, and platform checks.
21. Reviewed commit integration, main merge, tagged beta release, downloaded-artifact verification.

Only three priorities are active at once: the current implementation item, its behavioral verification, and read-only discovery of external release prerequisites. Checkpoint commits may be needed to run exact-SHA hosted CI before the final merge. No release is a claim of perfect software.

## Evidence gates

Each item ends in a focused behavioral receipt before implementation advances. The final revision must pass typecheck, lint, source tests, generated manual freshness, native and installed-package checks, secret scanning, and hosted platform checks. Live service and signing gates are tracked separately and require direct results. No skipped or unavailable check counts as passed.

## Release tranche

Implementation items 01 through 18 and all six experiments are closed. The final
cleanup, regression audit, performance and security passes are complete. The
October 15 platform receipt records passing source checks on all three hosts
and complete qualification of all five native artifacts. Final tagged builds
repeat the distribution gates. Finish main integration, final macOS
notarization, draft asset assembly and public download verification before
calling the release complete. Outside human testing remains waived.
