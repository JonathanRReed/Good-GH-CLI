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
| 1 | (1A projects, 1B clone, 1C ci why, 1D threads merged; 1A.2 real-data fixes in progress) Identity + discovery + index; `ggh` / `projects`; `clone` extensions (alias `get`); `go` + `init <shell>`. Parallel: `ci why` prototype + benchmark harness; lossless review-thread reads | pending |
| 2 | `sync --all`; `tidy` with deletion proofs; `lost`; `tidy --audit`; `projects --remote` | pending |
| 3 | Compact status; preflight fixtures; skill pack; `review --editor` + ledger | 3A review merged; 3B status/preflight in progress; skill pack after Phase 2 |
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
