# Good GH: v3 plan (Claude Opus 5.5, after adversary R1-R3 and 3-model interrogate)

Supersedes v2. Binding: decisions.md. Open owner questions: Q6-Q13 (see end).

## Thesis
**Agents are interchangeable. The task isn't.**
ggh makes a unit of work portable between humans and agents without losing its acceptance
conditions, its evidence, or the human's place in the review. Any agent can pick a task up; every
candidate answers the same requirements; the human sees only what needs a decision.
Local, GitHub identity only, no telemetry, no server. Process control among cooperating tools,
not security against a hostile same-user agent.

README demo (the whole pitch in 60 seconds): freeze one bug reproducer + one preservation check.
Agent A submits a bloated partial fix. You checkpoint it. Hand the task to agent B with no
transcript. B finishes. ggh shows the exact review delta since your checkpoint, refuses B's
attempted edit to the expectation, and exports a replayable receipt.

## Data shape (name it before any code)
```
Task {
  id, repo: {host, owner/name, stable id}
  intent: { issueRef?, title, nonGoals[] }
  acceptance: AcceptancePack {             // the evaluator; candidates never edit it silently
    state: proposed | accepted(by owner, at, digest)
    recipe: { runner, workdir, prepare argv[], run argv[], env allowlist }
    regressionChecks[]: { testId, expectedBaseAssertion, expectedHead }
    preservationChecks[]: { testId }
    bundle: { files[] with digests: tests, helpers, fixtures, config, snapshots(frozen) }
  }
  candidates[]: { ref, head, pr?, worktree?, claimedBy (self-reported, unknown allowed) }
  observations[]: Observation {            // bet 1
    comparison: contribution(mergeBase→head) | integration(syntheticMerge) | rehearsal(set)
    identity: verifierVersion, trees, bundleDigest, argv, depsDigest, runtime, envKeys, mode
    perCheck: assertion-failed | could-not-execute | passed, attempts[] in fresh state
    outcome: expected-transition-observed | no-transition-observed | preservation-observed
             | head-check-failed | unstable | inconclusive(reason)
    applicability: current | historical(why stale)
  }
  checkpoints[]: { scope: opened | inspected(files) | decided(verdict), head, mergeBase, target,
                   comparisonTrees, packDigest, remoteFetchedAt, threadCursor }
  feedbackCursor: { observedThreads, editsSeen, paginationComplete }
  effects: link to existing operation journal
}
```
Stored locally under Git metadata (private refs / .git/ggh), retaining objects needed to rebuild a
prior checkpoint view. Export is explicit. Starts single-repo, single-PR; cross-repo is a view later.

## P0 fixes (verified defects, ship first)
- Expected-head precondition on every merge path (prs.ts:181-206; `--match-head-commit`).
- Honest merge outcomes: merged / queued / auto-merge-armed / rejected / uncertain (pr-lifecycle.ts:185).
- Dedicated verifier workspace; never `worktreeAdd` (worktree.ts:137 .env copy, :153 submodules, :166 metadata).
- Env for verification is an allowlist, not a merge into process.env (exec.ts:145).

## Commitments (one product, three verbs on one record)

### 1. Observe: `ggh verify`
Contract (R2 §2, GPT #1-3, SWE-2 #1/#3/#11, GLM #1-3/#7, R3 §1.2-1.3 restored):
- Owner-accepted expectation required for a positive transition; a named expected base assertion,
  not "any failure". Author-supplied tests are labeled author-supplied.
- Separate preparation and builds per revision in separate writable dirs; verify which artifact the
  test actually loaded; shared caches keyed by real inputs.
- Nonzero test discovery required; per-test parsing; missing symbol / collection / setup = inconclusive.
- Repetition in fresh state (default 2 base, 2 head; disagreement = unstable); order varied where relevant.
- Missing preservation checks shown as missing.
- Bun/TS recipe first (bun test, vitest); explicit `--test`/`--` override. Unsupported = inconclusive.
- Trust: `--trusted` = explicit host-execution consent printed on every observation; network off
  where the OS allows; foreign authors refused locally unless explicitly trusted.
- Bonus deterministic signals: test-weakening diff (deleted tests, changed expected values, new
  skips, narrowed selection, setup changes); changed-line coverage when the runner supports it.
- Prior art named: PatchProof, SWE-bench F2P/P2P, Stryker/Arcmutate.

### 2. Decide: `ggh review` with checkpoints
- `ggh review 42 --since last`: delta since your last checkpoint across rebase, retarget, merge-base
  change, edited/deleted old comments, resolution changes, check reruns, pack changes, expired
  observations. Range-diff is a hint, flagged when ambiguous; full PR always one key away.
- Displaying a report never consumes unread work; only `inspected`/`decided` advance it.
- New PR acquisition contract (head/base OIDs, PR_VIEW_FIELDS prs.ts:160 lacks them).
- Agent side: `ggh task feedback 42 --since <cursor> --agent` (raw text, thread ids, locations,
  coverage); `ggh task respond --thread <id> --disposition fixed|disputed|needs-owner [--commit sha]`
  (commit required only when claimed fixed; reachability-validated; reply and resolve are separate
  effects; resolve only with authority, Q12). CLI + skill first; MCP stays read-only.
- `ggh next`: compact report of tasks needing a decision, including authored PRs (self-approval is
  impossible on GitHub), with fetch time. gh-dash keybinding pack. No TUI until earned.

### 3. Hand off: `ggh task`
- `ggh task new [--issue 184]` drafts intent + proposed pack (AI proposal allowed, labeled proposed).
- `ggh task accept` freezes the pack (digest); later edits are a visible new decision.
- `ggh task handoff <id> [--to-agent-host]` emits the record (CLI JSON + skill instructions) so any
  agent host continues without a transcript. `ggh task export` = replayable receipt package.
- `ggh task list` = the work map: registered repos, task claims (self-reported), worktrees,
  candidates, last observation, overlapping files. Claims govern only ggh cleanup; worktree removal
  rechecks dirty state + ownership immediately before deleting (worktree.ts:179 lacks this today).

## One bold adjacent experiment: `ggh integrate --rehearse`
Candidates must pass the same accepted pack on the same pinned target/env first. Record ordered
heads, ancestry (no double-counting stacked parents), synthetic trees, attempts, budget. Conflict
= that combination untested, never auto-resolved. Output tested AND untested combinations and an
observed (not minimal) failing set, rechecked fresh. Useful without a merge queue (personal repos
often lack one). Not "nobody does this": GitHub's queue tests combinations; ggh's distinction is
local preflight before publishing plus a reduced counterexample.

## Optional experiments (only after the core is used daily)
- `ggh shrink`: owner-selected removable region, immutable packs outside it, fresh builds, budgets,
  output a separate candidate, "smaller candidate found" not "minimal". Never rewrites the branch.
- Public verify gauntlet corpus = validation and launch evidence, not a product.
- Hosted runner adapter (see Distribution) for foreign PRs.

## Deleted from the plan
Agent standings ledger; automatic Agent-Tool trailers (private self-reported claims instead);
Desk TUI; phone approvals; universal undo; signed receipts; daemon mirror; ggh-owned stacks as a
differentiator; race as a ggh feature.

## Maintenance track (necessary, not strategy)
- `ship`: fold existing `commit --pr` into it; `--land` deferred until head-bound lifecycle (Q11).
- gh-stack interop probe → replace ggh stack engine where equivalent; keep tip-change checks and
  uncertain-push reconciliation; resolve checkpoints before migration.
- Cuts: label, secret, variable, gist, search, browse, team, triage, workflow UI; release/changelog
  and notifications per Q13; draft's restore → stash.
- README narrowed now to what works; new verbs added only when they work.
- THREAT-MODEL.md: verify (host execution), task records (local metadata), respond (remote writes).

## Distribution
- One install channel at first release (fix npm publication blocker README:26), Homebrew next.
- Skill pack for Claude Code / Codex / T3 Code teaching task + verify + feedback contract.
- gh-dash keybinding pack.
- GitHub workflow template, honestly scoped: unprivileged `pull_request` job on hosted runners,
  no secrets, `persist-credentials: false`, no later privileged steps, normal job check + bounded
  receipt artifact. Never `pull_request_target` with candidate checkout. Statuses informational
  only; never marketed as a required gate until a protected publisher design exists.

## Validation (no telemetry, no cohort)
- Before building verify: unselected sample of ~20 recent owner PRs. Record per PR: class,
  expected observation, applicability, setup time, test-creation time, execution time,
  interpretation time, false accusations, valid catches, inconclusive reason.
- Fixtures: one per failure case (R2 §2 ×12, R1 F ×24, R3 review-checkpoint case, R3 rehearsal
  triple-interaction case), with permanent unsupported cases.
- Script baseline: if a 50-line gh script matches, ship the script.
- The handoff demo above, run for real across two different agent hosts.
- After a working slice: one uncoached outsider runs the README task.

## Sequencing
0. P0 fixes. Owner PR sample. gh-stack probe. Narrow README.
1. Task record schema + storage + PR acquisition contract (one integration owner).
2. Lanes: (A) verify core + fixtures + threat model; (B) review checkpoints + feedback read + next;
   (C) task new/accept/handoff/list; (D) cuts.
3. Experimental release, one channel. Dogfood the handoff demo daily.
4. respond (writes), workflow template, ship fold-in, stack interop.
5. integrate --rehearse. 6. Optional experiments by observed need.

## Open owner questions
Q6 daily loop/bottleneck · Q7 review surface · Q8 trust default · Q9 tool vs orchestrator ·
Q10 name · Q11 --land scope · Q12 thread resolution authority · Q13 peripheral features.
