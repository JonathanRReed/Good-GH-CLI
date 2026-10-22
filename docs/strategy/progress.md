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
| 0 | P0 fixes: merge head pin + honest outcomes; safe checkout path (no .env copy); worktree removal recheck; `worktree list --porcelain -z` parser; env allowlist; agent envelope diet (status, run) | pending |
| 1 | Identity + discovery + index; `ggh` / `projects`; `clone` extensions (alias `get`); `go` + `init <shell>`. Parallel: `ci why` prototype + benchmark harness; lossless review-thread reads | pending |
| 2 | `sync --all`; `tidy` with deletion proofs; `lost`; `tidy --audit`; `projects --remote` | pending |
| 3 | Compact status; preflight fixtures; skill pack; `review --editor` + ledger | pending |
| 4 | Cuts; README rewrite around projects; release prep (no publication without approval) | pending |

## Log
- 2026-10-22: branch created; strategy docs saved.
