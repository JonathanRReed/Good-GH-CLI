# v0.6 build progress

Plan: [PLAN.md](PLAN.md). Owner decisions: [decisions.md](decisions.md). Debate trail: [debate/](debate/). Research: [research/](research/).

Branch `feat/v0.6-projects`. Loop started 2026-10-22 ("until the new version of the app is fully done").

## Safeguards
- Local commits on this branch only. Push, PRs, tags, npm/Homebrew publication, and GitHub writes beyond read-only probes need owner approval.
- Each phase commit requires typecheck, lint, and the test suite to pass.
- Implementation lanes run in isolated worktrees; Claude integrates and reviews.
- Stop when phases 0-4 are complete and green, or on a blocker only the owner can clear.

## Phases
| Phase | Scope | Status |
|---|---|---|
| 0 | P0 fixes: merge head pin + honest outcomes; safe checkout path (no .env copy); worktree removal recheck; `worktree list --porcelain -z` parser; env allowlist; agent envelope diet (status, run) | done (c0bec09 merged; verified on source CLI) |
| 1 | (all lanes merged: 1A projects, 1A.2 real-data fixes, 1B clone, 1C ci why, 1D threads) Identity + discovery + index; `ggh` / `projects`; `clone` extensions (alias `get`); `go` + `init <shell>`. Parallel: `ci why` prototype + benchmark harness; lossless review-thread reads | pending |
| 2 | `sync --all`; `tidy` with deletion proofs; `lost`; `tidy --audit`; `projects --remote` | pending |
| 3 | Compact status; preflight fixtures; skill pack; `review --editor` + ledger | 3A review + 3B status/preflight merged; skill pack + agent polish after Phase 2 |
| 4 | Cuts; README rewrite around projects; release prep (no publication without approval) | pending |

## Log
- 2026-10-22: branch created; strategy docs saved.
- 2026-10-22: baseline green (569 pass, 1 skip). Phase 0 lane and Phase 1D lane started. Host layouts probed; Phase 1 design committed (d2ea57a).
- 2026-10-22: 1D `ggh pr threads` merged (258e925; 586 pass). 1B clone extensions started; clones carry `ggh.created` marker for the index.
- 2026-10-22: Phase 0 merged. status --agent 1,479→367 bytes offline; run --agent 49,631→15,572. Verify: merge head pin flag, review checkout without .env, dirty-worktree removal refused. Simplify: two localized cleanups. 607 pass, 1 skip.
- 2026-10-22: 1B clone merged. Verified: clones into $PWD/<repo>, writes ggh.created, re-clone is no_op with alreadyCloned. 632 pass. Known edge: HTTPS fallback keeps a custom SSH port for ggh-derived GHE URLs (follow-up).
- 2026-10-22: 1C `ci why` + `bun run bench:agent` merged. Gate result: equal 100% evidence recall everywhere; ci why wins VS Code 133,470→8,625 bytes and 5→1 calls; loses Zod CI 5,402→7,231 bytes (filtered native command is tighter) but 4→1 calls. Status still 331 vs porcelain 121 (envelope overhead) → Phase 3 compact status. 646 pass. Follow-up: shared response validators (ci.ts, review-threads.ts) in Phase 4.
- 2026-10-22: 1A projects merged (686 pass; fixture 70 repos warm 889 ms). Real ~/Downloads read-only run: 73 clones / 139 checkouts, 4.7-5.3 s total, 15 checkouts hit the 3 s deadline, 14 paths skipped; table packs every checkout into one row (2,200-char lines). Validates `lost`: planet-iou has 9 unpublished branches incl. 3 worktree-agent-*; Apple-MCPs 5. Scans use GIT_OPTIONAL_LOCKS=0 and an env allowlist.
- 2026-10-22: 3A review merged (714 pass). Live check on PR #14: review checkout without .env, --mark, --since last; agent mode launches nothing. Gap: agent envelope reports no effects for checkout creation and ledger writes (fix in agent polish).
- 2026-10-22: 3B merged (743 pass). Exact-scope incidents 4/20 → 0/20 (concurrent index inclusion, stale-HEAD execution, hook-added content reaching publication, matching push publishing another branch; plus clean-index amend and stack-lock race). Clean status 331→181 bytes (1.5× porcelain). Follow-up: dirty-repo status embeds raw porcelain-v2 lines (3,509 bytes / 23 files) → add dirty bench case + compact XY/path default; envelope effects for review checkout/ledger.
- 2026-10-22: 1A.2 isolated lane fixes clone summary/detail widths, adds private atomic status snapshots and warm TTY replacement, batches unpublished walks, and gives checkouts independent deadlines. Gates: 698 pass, 1 skip; typecheck and lint pass. Five paired warm TTY runs: fixture first rows 2227 -> 50 ms median, Downloads 6112 -> 52 ms; fresh TTY completion 2230 -> 1731 ms and 6118 -> 2842 ms. Downloads had 73 clones / 141 checkouts during paired runs, 15 missing checkout paths and 14 discovery skips. Details: [projects-performance.md](projects-performance.md).
- 2026-10-22: 1A.2 merged. Full suite 756 tests: 1 failure in 1 of 3 runs, unidentified (earlier lanes saw a stack-lock race) → Phase 4 flake hunt. Phase 2 lanes start: 2B tidy+lost (deletion proofs), 2C projects --remote.

- 2026-10-22: 2A sync --all merged (Ran 773 tests, 0 fail). Not run against the owner's real repos (would fast-forward working copies without approval); covered by bare-remote tests.

- 2026-10-22: 2C projects --remote merged (799 pass). LIVE FAILURE on real ~/Downloads: first aliased GraphQL batch timed out (cold 14 s); one failure marked all 73 repos unavailable, and the failure was cached (warm: 0 requests, still unavailable). Fixtures never time out. Fix lane 2C.2 started.


- 2026-10-22: 2C.2 isolated fix lane groups PR searches, limits check reads to the latest three PRs per repo, bisects transient failures, enforces a 20-second remote deadline, and caches only successful fields per host/login/repo. Unavailable rows show a dash and one reason footer. Gates: typecheck, lint, 816 pass / 1 skip / 0 fail. Live read-only Downloads pair: 73 clones, 35 distinct remotes across 69 clones; 4 clones without recognized remotes. Cold 8.527 s / 2 requests / cost 2; warm 2.574 s / 0 requests / cost 0. All 35 remotes complete, no unavailable reasons. The cold target of about 5 seconds remains unmet. [Query, cache, rendering and live receipts](projects-remote-verification.md).
