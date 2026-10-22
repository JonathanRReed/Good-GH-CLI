# Owner decisions (grilling round 1, 2026-10-22)

- Q1 Goal: open-source adoption (installs, stars, contributors). Not enterprise, not a business. Started personal; owner thinks it can be genuinely good.
- Q2 Primary user: humans at a terminal AND coding agents, both first-class; a little of maintainers reviewing agent PRs. Owner likes the agent direction.
- Q3 Constraints: NO telemetry, ever. NO account (GitHub identity is enough). No server preferred (negotiable only if strongly justified). NO phone approvals / phone app. Lean single local process; a small opt-in local daemon is tolerable.
- Q4 Cut hard, break freely before 1.0. Owner is the only user. "Be creative, be bold, make this the best product it can be."
- Q5 Effort: owner has many agents; agents implement, owner reviews. No deadline, but finish ASAP without compromising quality. Owner wants to use it daily.

# Owner decisions (grilling round 2-3, 2026-10-22)
- Q6 Daily loop: mix (d). T3 Code, Codex app, Claude app already have good Git/GitHub integrations; agent-side GitHub workflow is largely built into those hosts. DO NOT build what those already do. ggh needs selling features on top. Original motivation: hated the GitHub CLI; wanted an easy way to get projects, manage them, do everything. Agents welcome if ggh is better for them than raw git / the git paths built into agent hosts.
- Q7 Review surface: terminal review "dumb most of the time" UNLESS truly first-class (latest diff + syntax-highlighting tech, fast). Opening the editor is interesting. Offer a couple of options; research which is actually beneficial.
- Q8 Trust default: agreed (trusted local for own repos, printed consent, foreign refused unless opted in) AND user-toggleable.
- Q9 ggh is a tool called by agents/humans. Never an orchestrator; do not recreate T3 Code.
- Q10 Keep ggh / Good GH. Rename possible later.
- Q11 --land: follow best practice; learn from T3 Code's Git implementation.
- Q12 Thread resolution: best practice; look to T3 Code.
- Q13 Agreed with recommendation (draft restore into stash; keep notifications until replaced; drop release/changelog unless used to ship ggh, team, triage).
- NEW: Deep-dive T3 Code (its clone-a-repo-in-app flow inspired ggh) and competitors for internals and tricks worth stealing.

# Owner decisions (grilling round 4, 2026-10-22)
- Q14 Project management: ALL of (a) instant get/clone from any of your repos + open in editor/T3, (b) one view across all local clones incl. T3 worktrees, (c) bulk upkeep, (d) jump-to-project by name, (e) fork/upstream sync, (f) folder -> GitHub repo. Framing: "a better version of what the GitHub CLI should have been, modernized for today's tools."
- Q15 Primary user: human-first, roughly 60/40 to near-equal with agents. Agent usefulness needs more RESEARCH before committing (empirical, not opinion).
- Q16 Project location: owner keeps repos in ~/Downloads; workflow is `cd ~/Downloads && gh repo clone ...` and work there. Default = clone into current directory (today's behavior); allow a configured default root OR choose each time. Never force a layout; index clones wherever they are.
- Q7 (from research): editor first, local web (@pierre/diffs, T3 parity) and first-class OpenTUI TUI as options; never own diff rendering; own review state/posting.

# Owner decisions (grilling round 5, 2026-10-22)
- Q17 Open target: owner defers to Claude. Decision: `ggh go <name>` jumps the shell via `ggh init <shell>` hook (zoxide-style); `--editor` / `--t3` flags; configurable default.
- Q18 Tidy: (b) one preview + one batch confirmation; unpushed/uncommitted work never touched. PLUS: optional AI audit: an agent/provider of the user's choice reviews the tidy plan, recommends prune/keep with reasons, and can execute the approved plan for you; or do it manually.
- Q11/Q12 resolved by T3 research: pin reviewed head on every merge, re-read state, honest merged/queued/auto-merge/unknown; resolve threads via GraphQL node id, separate from reply, permission + canResolve checks, never auto-resolve on fix.

# Owner decisions (grilling round 6, 2026-10-22)
- Q19 verify: DEFER until projects + agent pillars ship and are in daily use. Research/contract from v1-v4 retained.
- Frontier empty. Final plan: /tmp/ggh-plan/v6-final.md. Awaiting owner confirmation of shared understanding before any implementation or file moves.
