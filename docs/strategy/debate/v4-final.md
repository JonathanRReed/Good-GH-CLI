# Good GH: final plan (v4)

Produced 2026-10-22 by Claude Opus 5.5 against GPT-6.1 Sol (Codex, high) as designated adversary
over four rounds, with two /interrogate panels (GPT-6.1 Sol, SWE-2, GLM-5.3). Every final reviewer
returned "ship to owner with listed edits"; those edits are applied here. Binding owner decisions:
decisions.md. Open owner questions: Q6-Q13 at the end.

## Thesis
**Keep your place and your requirements across every interruption.** Agents are
interchangeable; the task isn't. ggh carries a unit of work (its intent, its accepted
expectations, its evidence, and your last review position) across breaks, rebases, and
handoffs between agents or between you-today and you-next-week. A human who never uses
agents gets saved review position and honest evidence. An agent fleet gets portable tasks
that every candidate must answer the same way. Local, GitHub identity only, no telemetry,
no server. Process control among cooperating tools, not security against a hostile agent.

Two acceptance demos, both required:
1. **Manual (no agent, no AI configured):** commit, open a PR, inspect it, amend, return
   later, `ggh review 42 --since last` shows exactly the delta. No task ceremony.
2. **Handoff:** freeze one bug reproducer + one preservation check. Agent A submits a bloated
   partial fix; you checkpoint. Agent B (different host, no transcript) finishes from the task.
   ggh shows the review delta, refuses B's edit to the evaluator, and a receipt replays on a
   fresh checkout with no access to the producer's metadata.

## P0 fixes (verified defects, first)
- Expected-head precondition on every merge (`--match-head-commit`; prs.ts:181-206).
- Honest merge outcomes: merged / queued / auto-merge-armed / rejected / uncertain (pr-lifecycle.ts:185).
- Dedicated verifier workspace, never `worktreeAdd` (.env copy :137, submodules :153, metadata :166).
- Worktree removal rechecks dirty state + ownership immediately before deleting (worktree.ts:179).
- Verification env is an allowlist, not a merge into process.env (exec.ts:145).

## Data shape
Tasks are **optional records** inferred or attached by existing commands on first touch of a PR.
`ggh task new` exists only to author intent ahead of work. Packs are optional until you ask for an
expectation-based observation. Missing evidence is information, never a blocked workflow.
Creating or inspecting a task never runs tests.

```
TaskV1 {                                   // small mutable index
  schemaVersion, id, repoIdentity
  brief { title, goal, nonGoals?, continuationNote? }   // enough intent to resume w/o transcript
  candidate { ref, pinnedHead, pr? }        // single candidate; A then B advance it sequentially
  packRef?            -> AcceptancePack     // immutable
  checkpointRefs[]    -> Checkpoint         // immutable
  observationRefs[]   -> Observation        // immutable
}
AcceptancePack { v, recipe{runner, workdir, prepare[], run[], envAllowlist},
  checks[{ id, kind: regression|preservation, expectedBaseAssertion?, expectHead }],
  bundle{ files+digests: tests, helpers, fixtures, config, frozen snapshots },
  decision: proposed | accepted(at, digest) }       // acceptance is its own immutable record
Observation { v, comparison: contribution (tagged, extensible),
  identity{ verifierVersion, trees, mergeBase, bundleDigest, packDecisionDigest, argv,
            depsDigest?, runtime?, declaredInputsDigest?, unverifiableInputs[], mode },
  perCheck: assertion-failed | could-not-execute | passed, attempts[] in fresh state,
  outcome: expected-transition-observed | no-transition-observed | preservation-observed
           | head-check-failed | unstable | inconclusive(reason),
  executionStatus (separate from outcome) }
Checkpoint { v, scope: inspected(files) | decided(decision), head, mergeBase, target,
  packDecisionDigest?, feedbackSnapshotRef?, remoteFetchedAt }
FeedbackSnapshot { v, threads (raw text, ids, locations, outdated/resolved), edits, deletions,
  resolutionChanges, paginationComplete }            // ships with feedback reads
```
- **Applicability is derived on read** by comparing identity to current state. A declared input
  value change (e.g. FEATURE_FLAG) with identical OIDs makes the observation non-current.
  Secret/external inputs are recorded as unverifiable, never hashed or exported.
- **Concurrency:** immutable records in separate files; short per-task index updates under a lock
  with reread-inside-lock and precondition checks (reuse operations.ts:277-303). Never hold the lock
  while tests run. Location resolved via Git common dir so all linked worktrees share it
  (operations.ts:231-243), with existing private-storage protections.
- **Retention:** checkpoint heads/trees anchored under local `refs/ggh/keep/*` so gc can't eat them
  after force-push. Pruning is an explicit owner command, never automatic.
- **Transport:** `ggh task push|fetch <remote>` uses opt-in `refs/ggh/tasks/*` (SWE-2) for live
  cross-machine handoff with no server; never pushed by default refspecs. `ggh task export` emits a
  versioned manifest: required objects, pack bytes, prerequisites, bounded logs, inspectable content
  inventory; private source stays referenced unless explicitly included. Replay distinguishes
  missing prerequisite from failed check.
- **Privacy:** packs retain selected content, an explicit, documented change from metadata-only
  records. Stated storage, retention, deletion, export boundary in THREAT-MODEL.md.

## The three verbs

### Observe: `ggh verify`
- Positive transition requires an owner-accepted pack with a named expected base assertion.
  Author-supplied tests are labeled author-supplied; unaccepted packs yield `proposed` observations.
- On the evaluation path, candidate bytes at bundled paths that differ from the accepted digest =
  refusal (no observation). On the task path it surfaces as a pack decision for the owner.
- Separate preparation/builds per revision in separate writable dirs; verify the loaded artifact;
  caches keyed by real inputs. Nonzero discovery; per-test parsing; missing symbol / collection /
  setup = inconclusive. Default 2+2 fresh attempts; disagreement = unstable.
- Snapshot-update PRs flagged `self-certifying`. Missing preservation checks shown as missing.
- Bonus deterministic signals: test-weakening diff; changed-line coverage when supported.
- Bun/TS recipe first, `--test`/`--` override; unsupported = inconclusive.
- `--trusted` = printed host-execution consent; network off where the OS allows (probe per OS);
  foreign authors refused locally unless explicitly trusted.
- Prior art named: PatchProof, SWE-bench F2P/P2P, Stryker/Arcmutate.

### Decide: `ggh review`
- Works on any PR, including ones whose author never used ggh. Offers to save a checkpoint.
- `--since last` delta across rebase, retarget, merge-base change, edited/deleted comments,
  resolution changes, check reruns, pack changes, expired observations. Range-diff is a hint,
  ambiguity flagged; full PR one key away. Viewing never consumes unread work.
- A local checkpoint is a local decision and never stands in for a GitHub approval.
- New PR acquisition contract (head/base OIDs; prs.ts:160 lacks them).
- `ggh next`: compact report of what needs a decision in this repo, including authored PRs,
  with fetch time. gh-dash keybinding pack. No TUI until earned.

### Hand off: `ggh task`
- `task show|handoff|push|fetch|export|accept`. Handoff emits one canonical JSON record; host-
  specific instructions live in the skill pack.
- **Agent definition of done:** a fresh observation on the candidate head under the accepted pack.
- Agent feedback: `ggh task feedback --since <snapshot> --agent` (read-only, first release).
  `ggh task respond --thread <id> --disposition fixed|disputed|needs-owner [--commit sha]` (later):
  commit only when claiming fixed, reachability-validated; fresh thread/head check before write;
  reply and resolve are separate effects; reply IDs preserved; retries reconcile, never duplicate;
  resolve only with authority (Q12). MCP stays read-only.
- Versioned schemas for Task, Observation, FeedbackSnapshot in the `--agent` contract. A runner
  that successfully measured a failing check never reports "task succeeded".

## One bold experiment (after daily use): `ggh integrate --rehearse`
Same accepted pack on the same pinned target first; record ordered heads, ancestry, synthetic
trees, budget; conflicts = untested, never auto-resolved; report tested and untested combinations
and an observed (not minimal) failing set, rechecked fresh. Works without a merge queue.
Distinction vs GitHub's queue: local preflight before publishing plus a reduced counterexample.

## Launch artifact: the adversarial handoff gauntlet (GLM)
Before release, give a fresh agent a task record and one instruction: obtain
`expected-transition-observed` while changing as little real behavior as possible. Publish the
transcript: every trick it tried (edit evaluator, weaken test, add skip, refresh snapshot, cite
unreachable commit, stale head, things nobody listed), which ggh caught, which it missed, and the
fixes. Every miss becomes a permanent fixture.

## Deferred / optional (named, not silent)
Multiple simultaneous candidates; claims and fleet/overlap map; cross-repo `next`; `shrink`
(with R2/R3 limits); negative controls (Stryker-scoped for TS); flake ledger; `split-plan`;
`decide` (behavior-first review); `ship --land` lifecycle; hosted-runner adapter for foreign PRs.

## Deleted
Agent standings ledger; automatic Agent-Tool trailers; Desk TUI; phone approvals; universal undo;
signed receipts; daemon mirror; ggh stacks as differentiator; race as a ggh feature; required-
status marketing; mandatory Docker; recruitment cohorts.

## Maintenance track
- `ship` = fold of existing `commit --pr`; explicit file selection or owned worktree; never `add -A`
  in a shared checkout. Manual commit-to-PR stays working throughout.
- gh-stack probe → replace engine where equivalent; keep tip-change checks + uncertain-push
  reconciliation; resolve checkpoints before migration.
- Cuts: label, secret, variable, gist, search, browse, team, triage, workflow UI; release,
  changelog, notifications per Q13 (notifications only with or after a replacement); draft
  restore → stash. Document that `ggh gh ...` keeps native semantics (no dry-run/envelope).
- README narrowed now; new verbs documented only once they work.
- THREAT-MODEL.md: verify host execution, task content storage/export, respond writes.
- Peripheral deletions never block the experimental release.

## Distribution
One install channel at first release (fix npm blocker README:26), Homebrew next. Skill pack for
Claude Code / Codex / T3 Code. gh-dash pack. Unprivileged GitHub workflow template (hosted
`pull_request`, no secrets, `persist-credentials: false`, no privileged later steps, normal job
check + bounded receipt; never `pull_request_target` with candidate checkout; statuses
informational). No-telemetry adoption signals: release downloads, stars, template forks visible on
GitHub, issues from strangers, contributors.

## Validation
- Owner PR sample (~20, unselected) before Lane A: class, expected observation, applicability,
  setup / test-creation / execution / interpretation time, false accusations, valid catches,
  inconclusive reasons. **Kill/reshape rule:** if the modal outcome is inconclusive, or setup +
  interpretation exceeds review time saved on the median PR, reshape or cut the recipe first.
- Fixtures: one per known failure case (R2 x12, R1 F x24, checkpoint rebase/retarget/edit case,
  triple-interaction rehearsal case, env-value change, concurrent writers across linked worktrees,
  interrupted index update), with permanent unsupported cases.
- Script baseline: if a 50-line gh script matches, ship the script.
- Both acceptance demos for real; the handoff across two different agent hosts.
- Installed-artifact and cross-platform checks (macOS, Linux, Windows) for storage and process
  execution; unsupported restrictions printed as limitations.
- After a working slice: one uncoached outsider runs the README task.

## Sequencing (outcome gates; one integration owner; agent lanes)
0. P0 fixes. Owner PR sample + kill rule. gh-stack probe. Network-off probe per OS. Narrow README.
1. Schemas + storage + concurrency + PR acquisition contract.
2. Lanes: (A) verify core + fixtures + threat model; (B) review checkpoints + feedback read +
   next; (C) task show/accept/handoff/push/fetch/export; (D) cuts.
3. Experimental release (one channel). Both demos. Gauntlet. Dogfood daily.
4. respond (writes), workflow template, ship fold-in, stack interop.
5. integrate --rehearse. 6. Deferred items by observed need.

## Open owner questions (grilling frontier)
Q6 actual daily loop and worst step · Q7 where you review · Q8 trust default for verify ·
Q9 ggh as tool vs orchestrator · Q10 name · Q11 `--land` scope · Q12 thread resolution
authority · Q13 release/changelog/notifications/draft.
