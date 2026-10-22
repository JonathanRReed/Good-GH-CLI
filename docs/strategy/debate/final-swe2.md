# Good GH: final-round review (SWE-2), of v3-claude.md

Reviewed 2026-10-22 against `32a3e4b` (read-only). v3's file:line claims re-verified:
`prs.ts:160` PR_VIEW_FIELDS lacks head/base OIDs; `MergeOptions`/`mergePullRequest`
(`prs.ts:181-206`) have no `--match-head-commit`; `worktreeAdd` copies `.env*` (:137),
inits submodules (:153), writes shared branch metadata (:166); `worktreeRemove` (:179)
has no dirty/ownership recheck; `exec.ts:145` merges into `process.env`;
`pr-lifecycle.ts:185` prints "merged" whenever `--auto` absent; `README:26` npm blocker
real; MCP surface (`mcp.ts:6`, `services/mcp.ts:40`) read-only today. `task`/`verify`
verbs do not exist yet — all proposals.

## 1. Fatal or critical problems

None fatal. R3's demands are met: the composite-Action trust trap is closed (unprivileged
`pull_request` template, no `pull_request_target` with candidate checkout), merge-outcome
honesty and head preconditions are P0, checkpoint scope distinguishes
opened/inspected/decided, `respond` requires `--commit` only for `fixed`, shrink's limits
are restored, README narrowing precedes promises, and the queue novelty claim is hedged
("local preflight plus a reduced counterexample").

Remaining defects, all repairable in-line:

1. **The owner-PR sample lost its kill criterion.** v3 restores R3's cost fields (setup,
   test-creation, execution, interpretation time; false accusations) but drops v2's
   decision rule ("kill/reshape if most land inconclusive"). Measurements without a
   threshold become rationalization. This is the plan's only stop-loss; restore it:
   "if the modal outcome is inconclusive, or setup+interpretation exceeds review time
   saved on the median PR, reshape or cut the recipe before Lane A builds."

2. **Observations can't prove the pack was accepted when they ran.** `state:
   proposed | accepted` doesn't change pack bytes, so `identity.bundleDigest` is
   identical before and after `task accept`. Yet the contract makes owner acceptance a
   precondition for a positive transition. Record `packState` in observation identity
   (or make acceptance digest-changing). One field; without it the central claim —
   "owner-accepted expectation" — is not checkable in the record itself.

3. **"Refuses B's attempted edit" is stronger than the stated mechanism.** The schema
   supports the demo beat (candidate-tree bytes at bundled paths vs frozen digests →
   fail closed), but the text only says edits are "a visible new decision." Say both,
   once: on the eval path a mutated evaluator is a refusal (no observation produced);
   on the task path it surfaces as a pack-state decision.

4. **Two cursors for one remote state.** `checkpoints[].threadCursor` and top-level
   `feedbackCursor` track the same threads. Divergence yields phantom unread work or
   missed edits. Keep one cursor object; checkpoints reference it. Also state that
   `editsSeen` covers deleted comments and resolution flips (R3 required deletions).

5. **No schema version on Task.** The record is long-lived state under `.git/ggh`;
   "break freely" helps CLI flags, not on-disk formats agents will accumulate. Add `v`
   — five bytes of migration insurance.

6. **The author-side contract is unstated.** Nothing says a candidate runs `ggh verify`
   before handing back. If verify is only reviewer-invoked, the handoff loop has a hole:
   B can return "done" having never run the pack. One line — in the task contract and
   the skill: *a fresh observation on the candidate head is part of "done."*

## 2. The human-at-terminal test

The thesis survives. A Task is a unit of *work*, not a unit of *agent* work: the owner's
hand-written PR is simply a candidate with `claimedBy: self`. For a human who never
touches agents, `ggh verify` still answers "did my change do what I think," `review
--since` still removes re-reading, `next` still queues decisions — and the acceptance
pack doubles as the owner's own record of what they decided this PR must do, which is
valuable across days even with zero agents.

The real defect is the front door, not the model: `task new` + `task accept` is ceremony
for a human who typed `ggh review 42`. If the README's first move is agent handoff, a
plain terminal user never discovers the record exists.

Minimal fix, thesis-preserving: **lazy task creation.** Any verb touching a PR creates
the task shell implicitly — intent seeded from title/body/issue link, pack auto-proposed
from the PR's tests, acceptance one `task accept` or `--accept` flag, skippable for a
first observation (which is then labeled `proposed`). `task new` becomes what it should
be: authoring intent *ahead* of work. One sentence in the plan, and "the task isn't"
becomes literally true for every user, not just agent orchestrators.

## 3. Over-engineering check on the Task shape

Cut or defer:

- **`comparison: rehearsal(set)`** — defer the enum arm to the step-5 integrate work;
  shipping schema for an unbuilt mode invites pretend support.
- **`checkpoints[].threadCursor`** — merge into `feedbackCursor` (per §1.4).
- **`identity.depsDigest / runtime / envKeys`** — keep; they *are* the expiry story. But
  adopt the `claimedBy` convention — "record when knowable, unknown allowed" — so an
  honest partial observation isn't forced to fabricate inputs.
- **`comparisonTrees`** — derivable from head+mergeBase given retained objects; keep as
  cache if it earns O(1) rendering, otherwise drop.
- **Keep** `nonGoals[]` (cheapest defense against scope creep), `claimedBy`,
  `applicability.historical(why)`, `remoteFetchedAt`, `effects` link.

Smallest Task that still runs the handoff demo: `id, repo{host,owner/name},
intent.title, acceptance{state, recipe{runner,workdir,run argv}, regressionChecks[1],
preservationChecks[1], bundle.files+digests}, candidates[1]{ref,head},
checkpoints[1]{scope,head,mergeBase}, observations[]{perCheck,outcome,
identity{trees,bundleDigest,argv,verifierVersion,packState}}`. Roughly ten leaf
concepts; everything else is optional or arrives with its lane (feedbackCursor lands
with lane B's read path anyway).

## 4. Synthesis losses

Dropped **silently** — the problem is omission from Deleted/Optional, not the dropping:

- **Negative controls.** B's bounded known-wrong probes and SWE-2's Stryker-scoped
  suggestion vanished. They were the only check that the *accepted pack itself* can
  detect a class of wrong. Bonus-tier is a fair verdict; silence is not — name them in
  Deleted or keep one line under bonus signals.
- **`ggh decide`** (behavior-first review) — uncertain-EV, acceptable loss, unlisted.
- **Flake ledger** — `unstable` covers detection; persistence was the point (stop
  re-punishing agents for known flakes). Minor.
- **`ggh split-plan`** — was already "later." Minor.
- **`ggh gh ...` native-semantics documentation** — R2 §4's shared cost: passthrough
  preserves no dry-run/envelope/confirmation. Restore the one README line.
- **Reply dedup / reply-ID preservation** in `respond` — v3 keeps reachability and
  separate effects but drops R2's retry-safety requirements (dedupe replies, preserve
  reply URLs, reconcile partial outcomes). For a write path agents *will* retry, restore
  one line.
- **Kill criterion** (§1.1) and **`self-certifying` label** for snapshot-update PRs —
  "snapshots(frozen)" keeps the mechanism, loses the honest-verdict flag.

Correctly retained and worth saying once: the PR acquisition contract, separate prep
dirs with artifact-loading checks, shared caches keyed by real inputs, missing-
preservation visibility, order-varied repetition, author-supplied labeling, gh-dash
pack, script baseline, uncoached outsider, worktree-removal recheck, authored PRs in
`next`, the honestly-scoped workflow template, and README-narrows-first ordering.

Mis-statements: nothing egregious. "Self-approval impossible on GitHub" is accurate;
the queue comparison is properly hedged. The `refuses`-vs-`visible-decision` tension
(§1.3) is the only wording that overclaims a mechanism.

## 5. One last bold idea

**Tasks as pushable git refs.** The record already lives in Git metadata. Namespacing
it under `refs/ggh/tasks/<id>` makes handoff across machines and hosts equal to
`git push`/`git fetch` — no server, no file-passing, works over whatever transport the
repo already trusts, and the task travels with the code it describes (which is the
thesis taken literally). Observations are naturally append-only, so sync conflict
policy is trivial. Private by default — nothing publishes task refs without an explicit
push. `task export` still covers detached receipt portability; refs cover *live*
portability, and the two-agent-host demo becomes one fetch instead of an artifact move.
For an adoption-goal product, "the task rides the repo" is memorable and nearly free.

## 6. Verdict

**Ship with listed edits.** Nothing structural changes. The edit list:

1. Restore the kill/reshape threshold on the owner-PR sample (§1.1).
2. Add `packState` to observation identity, or make acceptance digest-changing (§1.2).
3. Reconcile refusal vs. visibility for evaluator edits — both, explicitly (§1.3).
4. Merge `threadCursor` into `feedbackCursor`; state deletions/resolution-flips are
   tracked (§1.4).
5. Add a Task `v` field (§1.5).
6. State that a fresh observation on candidate head is part of "done" for agents (§1.6).
7. Add lazy task creation on first PR touch (§2).
8. Name the silently dropped items in Deleted/Optional; restore the `ggh gh` doc line
   and `respond` retry-safety line (§4).
9. Optionally, adopt `refs/ggh/tasks/*` transport (§5) — cheap enough to include now.

v3 is the first version where the mechanism claims match what the schema can actually
enforce, the prior art is named, and the security posture was demoted from feature to
constraint. That is the right shape.
