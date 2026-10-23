# Good GH: v0 disruptor plan (Claude Opus 5.5 draft, for adversarial attack)

## Ground truth (from repo, 2026-10-22)
- `ggh` 0.5.0-beta.2. TypeScript/Bun, ~11.7k lines in src/commands, 45 commands, wraps `git` + `gh`.
- 0 stars, 0 forks, sole user is the author. Months of hardening: approval snapshots, operation journal,
  recovery, `--agent` versioned envelope, MCP server, private-by-default repo creation, local stacks,
  multi-provider AI through installed CLIs (codex/claude/grok/ollama) with zero API keys.
- docs/quality/2026-10-14-path-to-ten.md self-rates 7/10. Six UX experiments were all excluded on
  2026-10-15 for "no observed task needed it".
- The product is extremely safe and well-proven, and nobody knows it exists. The bottleneck is no
  longer correctness. It is a reason to switch.

## Thesis
In 2026 most git/gh invocations on a developer's machine are typed by coding agents, not humans.
Nobody owns the layer between "agent wants to change GitHub" and "GitHub changed". `gh` is a thin
API client; Graphite (now Cursor) is a hosted stacking service; jj/GitButler re-invent VCS locally.
ggh already has the rare primitives for that layer: exact approval snapshots, an effect journal,
partial-outcome recovery, a structured agent contract, and zero-key multi-model access.

**Position ggh as the safety, provenance, and review layer every coding agent goes through to touch
Git and GitHub. "sudo + flight recorder + review council for agents on GitHub."** Humans get the
same thing with a nicer UI.

## Bets (ranked by leverage)

### B1. Agent Gate: intercept, don't ask agents to opt in
- `ggh agent install` writes PreToolUse hooks / rules for Claude Code, Codex, Cursor, Devin, Factory,
  Gemini CLI, OpenCode so raw `git push --force`, `gh repo create --public`, `gh pr merge`,
  `git reset --hard`, history rewrites, secret-bearing commits get routed through ggh.
- Policy file (`.ggh/policy.toml`, user + repo): allow / require-approval / deny per effect class
  (publish public, force-push, delete branch, merge, rewrite pushed history, upload media, call AI).
- Approval goes out-of-band: terminal, desktop notification, phone push (ntfy / Pushover / T3),
  with the exact snapshot diff. Agent receives `status: awaiting_approval` + snapshotId, not a hang.
- Wedge: one install command makes every agent on the machine safer. Nobody else ships this.

### B2. Universal undo, including remote effects
- jj-style operation log, but spanning GitHub: `ggh undo` reverts the last operation whatever it was,
  local or remote (reopen closed PR, restore deleted branch from recorded OID, revert a merge via
  revert-PR, delete a just-created repo after confirmation, retract a comment).
- Built on the existing effect journal. Every effect records its inverse at execution time.
- "GitHub has no undo button. ggh does." This is the demo GIF.

### B3. Proof-carrying PRs
- A PR opened through ggh can carry a signed, verifiable receipt: which agent/model, which commands,
  which tests passed at which OID, screenshots/recordings, policy decisions. Sigstore/in-toto
  attestation stored as a PR check-run + git note, never source content by default.
- Reviewer side: `ggh pr verify 42` re-checks the attestation and replays the declared verification
  command in a sandboxed worktree.
- Answers the 2026 maintainer pain: drowning in agent PRs with no idea what was actually run.

### B4. Review council (zero keys, multi-model)
- `ggh pr review --council` fans one diff out to every installed provider CLI (codex, claude, grok,
  ollama, devin, droid) in parallel, dedupes findings, ranks by cross-model agreement, posts only
  consensus + selected lone findings as line comments. Same for `ggh c --council` pre-commit.
- Uses subscriptions the user already pays for. No tool on the market does free multi-model consensus.

### B5. Local-first GitHub mirror
- SQLite mirror of PRs/issues/checks/notifications for repos you touch, synced with GraphQL + ETags +
  conditional requests in a background `ggh daemon` (opt-in).
- Every read is instant and offline; `ggh inbox` becomes the fastest GitHub UI that exists. Agents get
  cheap reads without rate-limit burn. Feeds B1 policy decisions and B2 inverses.

### B6. Stacks as the default unit of work
- Auto-restack on amend (jj semantics), stack-aware merge queue on the laptop
  (`ggh stack land`: merge bottom, retarget, restack, repeat, with CI waits), free and accountless —
  explicitly the "Graphite without the server" story.

## Subtractions (before any addition)
- Cut thin wrappers that add nothing over `gh`: label, secret, variable, gist, workflow, search,
  browse, team, release browse. Route them through `ggh gh`. Target ≤ 20 first-class commands.
- Kill `team` (secret-gist stack sharing) and `draft` (AI-described stash) unless used.
- Freeze new platform qualification work until there are external users; the safety bar is already
  above every competitor.

## Wacky / extreme options on the table
- Rename. "Good GH" reads as a joke wrapper. Something like `gate`, `ward`, or `tollbooth` for the
  agent-layer story.
- Ship ggh as a `gh` extension (`gh good ...`) for zero-friction install into gh's 40M users.
- `ggh shadow`: run in observe-only mode for a week behind an agent hook, then show "here are the 37
  dangerous things your agents did and what ggh would have stopped." Converts skeptics with their
  own data.
- Public "agent incident" corpus: reproductions of real agent disasters (force-push to main, public
  repo of secrets) each with a ggh policy that would have prevented it. Marketing as test suite.
- Drop the `gh` dependency in favor of direct REST/GraphQL with the gh token, to own latency and
  error semantics.

## Distribution
- Launch artifact: 60-second video of an agent trying `git push --force origin main` and ggh
  stopping it, sending a phone approval, then `ggh undo` reverting a merged PR.
- Homebrew tap, npm, `gh extension install`, MCP registry listing, skill packs for Claude Code / Codex.

## Success metric
- 6 months: 1,000 weekly active machines with Agent Gate installed (opt-in anonymous ping or GitHub
  stars as proxy given no-telemetry stance), 3 external contributors, one agent vendor linking to it.

## Sequencing
1. Subtract (cut commands).  2. B1 Agent Gate + shadow mode.  3. B2 undo.  4. Launch.
5. B4 council.  6. B3 proof-carrying PRs.  7. B5 mirror.  8. B6 land queue.
