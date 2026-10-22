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
| 1 | (1D threads, 1B clone, 1C ci why merged; 1A projects in progress) Identity + discovery + index; `ggh` / `projects`; `clone` extensions (alias `get`); `go` + `init <shell>`. Parallel: `ci why` prototype + benchmark harness; lossless review-thread reads | pending |
| 2 | `sync --all`; `tidy` with deletion proofs; `lost`; `tidy --audit`; `projects --remote` | pending |
| 3 | Compact status; preflight fixtures; skill pack; `review --editor` + ledger | 3A review + 3B status/preflight in progress; skill pack after Phase 2 |
| 4 | Cuts; README rewrite around projects; release prep (no publication without approval) | pending |

## Log
- 2026-10-22: branch created; strategy docs saved.
- 2026-10-22: baseline green (569 pass, 1 skip). Phase 0 lane and Phase 1D lane started. Host layouts probed; Phase 1 design committed (d2ea57a).
- 2026-10-22: 1D `ggh pr threads` merged (258e925; 586 pass). 1B clone extensions started; clones carry `ggh.created` marker for the index.
- 2026-10-22: Phase 0 merged. status --agent 1,479→367 bytes offline; run --agent 49,631→15,572. Verify: merge head pin flag, review checkout without .env, dirty-worktree removal refused. Simplify: two localized cleanups. 607 pass, 1 skip.
- 2026-10-22: 1B clone merged. Verified: clones into $PWD/<repo>, writes ggh.created, re-clone is no_op with alreadyCloned. 632 pass. Known edge: HTTPS fallback keeps a custom SSH port for ggh-derived GHE URLs (follow-up).
- 2026-10-22: 1C `ci why` + `bun run bench:agent` merged. Gate result: equal 100% evidence recall everywhere; ci why wins VS Code 133,470→8,625 bytes and 5→1 calls; loses Zod CI 5,402→7,231 bytes (filtered native command is tighter) but 4→1 calls. Status still 331 vs porcelain 121 (envelope overhead) → Phase 3 compact status. 646 pass. Follow-up: shared response validators (ci.ts, review-threads.ts) in Phase 4.
