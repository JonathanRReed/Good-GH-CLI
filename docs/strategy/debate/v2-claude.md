# Good GH: v2 plan (Claude Opus 5.5 synthesis after adversary R1+R2 and 3-model interrogate)

Inputs: decisions.md (binding), v0, v1, r1-codex, r2-codex, interrogate-{gpt,swe2,glm}.md.
Status: pending owner answers to Q6-Q10 (daily loop, review surface, trust default, tool vs orchestrator, name).

## Thesis
**ggh is the local control room for one human working with many coding agents.** It spends the
human's attention only where a decision is needed: what changed since you last looked, what has
executable support, what collides with what. The same state is one structured call away for agents.
Local process, GitHub identity only, no telemetry, no server.

Everything in this plan answers one of three questions, for a human or an agent:
1. **What needs me?** (attention)
2. **What is actually supported by evidence?** (observation)
3. **What will break when this lands next to everything else?** (integration)

## P0: fix now (verified defects in today's code, independent of strategy)
- `ggh pr merge` has no head precondition: `MergeOptions` (src/services/github/prs.ts:181) and
  `mergePullRequest` (:189) never pass `--match-head-commit`. An agent can push after review and
  the unreviewed head merges. Add expected-head to every merge path.
- `src/commands/pr-lifecycle.ts:185` prints "merged" whenever `--auto` was not passed; on merge-queue
  repos gh only enqueues. Model outcomes: merged / queued / auto-merge-armed / rejected / uncertain.
- Verification must never go through `worktreeAdd` (src/services/git/worktree.ts:137 copies .env*,
  :153 inits submodules, :166 writes shared branch metadata). Separate verifier workspace path.

## Bets (ranked)

### 1. `ggh verify`: observations, not verdicts (core)
Contract (adopted from R2 §2, all three reviewers concur):
- **Comparison**: recorded merge-base vs PR head isolates the contribution. Integration with today's
  target is a separate run on a recorded synthetic merge; conflict = inconclusive. Stacks use real parent.
- **Recipes, not magic**: first supported recipe = Bun/TS (bun test, vitest). pytest and go next.
  Auto-detect proposes a test pack; `ggh verify 42 --test <path>... -- <argv>` overrides (absorbs
  R1's reviewer-supplied challenge as the escape hatch). Unsupported = inconclusive, never green.
- **Test pack** is a previewable bundle: test files, helpers, fixtures, setup, config, snapshots,
  working dir. Snapshots frozen, update mode disabled, expectation diff shown ("self-certifying").
- **Per-test result parsing**: base outcome is assertion-failed / could-not-execute / passed. Only
  assertion-failed supports a transition. Missing symbol, collection failure, missing dep = inconclusive.
- **Outcomes**: `expected-transition-observed` · `no-transition-observed` · `preservation-observed`
  · `head-check-failed` · `unstable` · `inconclusive(reason)`. Attempt counts always shown.
  Execution status is separate from observation. Never `proven-fix`, never a merge permission.
- **Identity/expiry**: verifier version, tree + test-pack digests, argv, dependency recipe, runtime,
  declared env inputs, execution mode. Historical vs currently-applicable results distinguished.
- **Trust**: `--trusted` = explicit consent to host execution, printed on every result ("runs as your
  user; host files and credentials accessible"). Network disabled during the measured run where the
  platform allows. Foreign-author PRs refuse local execution unless explicitly trusted. THREAT-MODEL.md
  gets a verify section before ship.
- **Isolated mode = a GitHub Action** (GLM + SWE-2): `ggh-verify` composite action runs the identical
  core on GitHub runners. Strangers' PRs get a credential-free executor for free; no local container
  work before launch. Result published as a **commit status** `ggh/verify` (works with ordinary gh
  auth, shows in the merge box, can be a required check). Comments only for detail.
- **Bonus signals** (cheap, deterministic): changed-line coverage where the runner supports it;
  **test-weakening detector** (deleted tests, changed expected values, added skips, narrowed
  selection, altered setup) shown beside the diff.
- **Prior art named openly**: PatchProof (fail-before/pass-after, Oct 2026), SWE-bench F2P/P2P,
  Stryker/Arcmutate. ggh's claim is integration into the daily loop, not invention.

### 2. `ggh review <pr> --since last`: review only what changed since your last decision
(Top-ranked new idea from GPT panelist + adversary R2.) Record a local decision checkpoint bound to
host/repo/PR/head. On return: new diff (range-diff aware), new thread replies, changed checks,
which observations expired, which test expectations changed. Same cursor for agents
(`ggh pr feedback 42 --since <cursor> --agent`). Never transfers a GitHub approval. Works for
self-authored agent PRs, where GitHub forbids self-approval.

### 3. `ggh integrate <pr...> --rehearse`: pass alone, fail together
(Adversary R2 #2 + GPT panelist wacky #4.) Build pinned combinations of individually-green agent
branches in disposable state, run owner-chosen checks, and preserve a minimal failing combination.
Starts with pairs and a run budget. Native merge queue remains authoritative. This is the problem
only many-agent fleets create, and nobody targets it.

### 4. `ggh work`: the fleet map (all 4 reviewers converged)
Cross-repo view of in-flight work: worktrees, branches, dirty state, active ggh operations/locks
(stack.ts:55 single recovery checkpoint), linked PR state, last verify observation, overlapping
files/packages between tasks. Advisory claims (`ggh work claim`), not locks. Refuses cleanup of a
worktree another task owns. `--agent` output is the agent's "what's mine, what's safe" call.
Agent provenance: `Agent-Tool:` commit trailer when ggh detects an agent env (SWE-2 #14).

### 5. Agent feedback contract (repositioned honestly)
GitHub MCP already reads/resolves threads; ggh's value is a provider-neutral, CLI-only contract
with cursors, evidence binding, and recoverable writes.
- `ggh pr feedback 42 --since <cursor> --agent`: raw reviewer text, thread ids, current/original
  locations, outdated/resolved state, pagination coverage. Interpretations labeled as such.
- `ggh pr respond 42 --thread <id> --disposition fixed|disputed|needs-owner --commit <sha>`:
  validates commit reachability from PR head, fresh thread/head check, dedupes replies, tracks
  reply and resolve as separate effects. Resolve only when authorized (owner preference, Q12).
- CLI + skill first. MCP stays read-only until the write contract is proven.

### 6. `ggh ship`: simplify, don't duplicate
Rename/fold existing `commit --pr` path into `ship` (commit.ts:128/164/1022 already does
stage→commit→push→PR with publication previews). Explicit file selection or an owned worktree;
never `add -A` in a shared checkout. `--land` later: head-bound merge, queue-aware outcomes, a
persistent lifecycle covering commit/verify/wait/merge/cleanup, cleanup only after confirmed merge.

### 7. Attention view, not a Desk TUI (yet)
`ggh next` (alias `ggh desk`): non-interactive ranked report + `--agent`. Includes authored PRs
(agents use your identity), review deltas, expired evidence, blocked vs ready, fetch time. Ship a
**gh-dash keybinding pack** wiring verify / review --since / worktree checkout / merge. Full TUI only
if dogfooding proves the report + gh-dash insufficient (Oct-15 keyboard-view prototype was cut).

### 8. Native stacks interop
Probe pinned gh-stack (docs claim cascade rebase, continue/abort, worktrees). If equivalent, delete
ggh's stack engine and keep only guarantees gh-stack lacks (tip-change check stack.ts:767, uncertain
push reconciliation :780). Resolve existing checkpoints before migration. `ggh split-plan` proposes
a native-stack decomposition for oversized agent diffs (later).

## Subtractions (break freely, cut for a stated reason)
- Delete now (proxy or low value): label, secret (gh prompts masked + stdin, v2.100 source),
  variable, gist, search, browse, team, release family (unless owner wants releases, Q13).
- Retire with reason: triage (AI grouping without evidence), workflow UI (keep cache invalidation
  in services if ship needs it).
- Move: draft's named-stash restore into `stash`; drop AI naming.
- Decide with owner (Q13): notifications (account-wide actions, gh has no equivalent), changelog
  (preamble-preserving writer).
- Stack submit/remote list: delete after interop probe passes.
- README: install, verify, review --since, work, ship, agent contract. Catalog → reference docs.
- Document that `ggh gh ...` is native semantics (no dry-run/envelope).

## Wacky / extreme (ranked by EV at achievable feasibility)
1. **Acceptance packs** (R2 #3 + GLM #7): owner-approved test pack + non-goals + preservation
   checks as the unit of agent work; any agent can pick it up; changing the expectation is visibly
   changing the task. `ggh issue repro` proposes one (tool-disabled AI is enough today).
2. **`ggh shrink 42`**: delta-debug the patch: find the smallest subset of hunks that still passes
   the same acceptance + preservation checks. Directly cuts human reading.
3. **Agent standings ledger** (GLM #3): private, local: per agent/model → transition rate,
   no-transition rate, review rework, diff size, integration breaks. "Which agent gets this task."
4. **`ggh repro export`**: content-addressed replayable bug package a stranger can run.
5. **`ggh decide 42`**: behavior-first review: owner-selected examples run on base vs head; approve the
   behavior change before reading code. CLI/API adapter first.
6. **Verify gauntlet corpus** (GLM #6): public adversarial PR corpus with ground truth; ggh and
   competitors run under equal conditions. Marketing that can embarrass ggh.
7. **Flake ledger**: persistent per-test instability learned from verify runs.
8. **Race** (parked): only via existing agent hosts (T3 Code etc.), evaluated by acceptance packs.

## Distribution (Q1: adoption)
- Fix npm publication blocker (README:26) and ship one channel at launch; Homebrew tap next.
- `ggh-verify` GitHub Action + commit status = zero-install reach to strangers.
- Skill pack for Claude Code / Codex teaching the `--agent` contract; gh-dash keybinding pack.
- Launch artifact: 3 real agent PRs from the owner's fleet: one `no-transition-observed` on a
  claimed fix, one integration break caught by `--rehearse`, one honest `inconclusive`.
- Metrics (no telemetry): release downloads, stars, Action usage visible on GitHub, issues from
  strangers, contributors. Product truth comes from dogfooding, not these.

## Validation (owner-scale, R1/R2 discipline)
- Before building verify: classify an unselected sample of ~20 recent owner PRs by class (fix,
  feature, refactor, dep, snapshot, flaky) and expected observation. Measure applicability and
  inconclusive rate. Kill/reshape if most land inconclusive.
- Fixture suite: one fixture per R2 §2 failure case (12) + R1 F (24), including permanent
  unsupported cases. Gate = correct classification + zero unsupported claims.
- Script baseline (R1 D): if a 50-line gh script matches, ship the script.
- After a vertical slice: invite one willing stranger to run the README task uncoached.

## Sequencing (outcome gates, parallel lanes, one integration owner)
0. P0 fixes. Probes: owner PR sample, gh-stack, network-off feasibility per OS.
1. Schemas first: identities, observation states, feedback cursor, decision checkpoint, effect results.
2. Lane A: verify core (Bun/TS recipe) + fixtures + THREAT-MODEL section.
   Lane B: review --since + feedback read + `next` report.
   Lane C: subtractions + README rewrite.
3. Experimental release (npm/Homebrew) with limits stated. Dogfood.
4. GitHub Action + commit status. `work` fleet map. `ship` fold-in.
5. integrate --rehearse. respond (write path). gh-stack interop + stack deletion.
6. Wacky tier by observed need: acceptance packs, shrink, standings ledger.
