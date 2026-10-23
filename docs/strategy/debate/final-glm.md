# Good GH v3: final adversarial review

Reviewed 2026-10-22 against `32a3e4b` (worktree clean, matching the commit all prior rounds reviewed). Read in full: decisions.md, v3-claude.md, r3-codex.md, r2-codex.md, interrogate-{gpt,swe2,glm}.md, plus v2-claude.md for loss checking. Every file:line claim in v3 was verified against source. Read-only; this file is the only artifact.

## 1. Fatal or critical problems

No fatal problem. R3's attacks were absorbed correctly, and I verified the load-bearing claims: `PR_VIEW_FIELDS` omits head/base OIDs (`src/services/github/prs.ts:160-161`), `MergeOptions` has no head-match field and `mergePullRequest` passes none (`prs.ts:181-187, 195-206`), merge prints "merged" whenever `--auto` is absent (`src/commands/pr-lifecycle.ts:184`), `worktreeAdd` copies env files (`src/services/git/worktree.ts:137-151`), initializes submodules (`:153-164`), writes shared branch metadata (`:166-173`), and `worktreeRemove` has no ownership or dirty-state check (`:179-189`), `run` merges caller env over `process.env` (`src/utils/exec.ts:145`), MCP is documented read-only (`src/commands/mcp.ts:6`), npm publication is gated (`README.md:26`), and the threat model demands revision when a command gains code execution (`docs/THREAT-MODEL.md:5`). The verify contract carries the restored R2 requirements: owner-accepted expectation, named base assertion, separate prep per revision, nonzero discovery, per-test parsing, fresh-state repetition, missing symbol means inconclusive, honest outcome vocabulary, author-supplied labels, allowlist env, dedicated workspace, threat-model section.

Two design gaps survive. Both are cheap now and expensive after schema freeze, which sequencing step 1 makes the one costly step to revisit:

[P1] The Task record has no concurrent-writer model. Q5 gives the owner many agents running in parallel, and v3 says "name it before any code" (line 18-19) while putting observations, checkpoints, candidates, and claims in one record under one metadata store (lines 39-43). Two agent processes appending observations to the same task, or `task list` reading mid-write, is the normal case, not an edge case. The plan never says append-only journal, lock, or merge rule. Left unstated, the implementation improvises, and the thing that corrupts is the evidence trail the product exists to keep. The fix is one sentence in the data-shape section, and the primitives already exist: the operation journal plus process locks (`src/services/operations.ts:8, 33-48`) is the right pattern to extend. Task entries are appended to a per-task journal under a lock; readers get snapshots; nothing mutates in place.

[P2] Checkpoint object retention has no policy. "Retaining objects needed to rebuild a prior checkpoint view" (v3:45-46) means every checkpointed head and synthetic tree needs a ref or gc eats it after a force-push, and nothing in the plan ever prunes. One sentence: checkpoint entries anchor refs under `refs/ggh/`, and pruning is an explicit owner command, never automatic.

Nothing else rises to critical. The trust story is coherent (trusted means printed consent, foreign authors refused, honest Action scoping, statuses informational), validation and P0 fixes precede every lane, and no commitment violates the binding constraints.

## 2. The human-at-terminal test

Mostly passes, with one ambiguity to close. What the plain human gets without ever touching `ggh task`: safe merges (P0 expected-head plus honest outcomes), `ggh review 42 --since last`, `ggh next`, and `ship` as the folded `commit --pr` (`src/commands/commit.ts:164`). None of it requires an acceptance pack. The thesis even serves them in a way v3 never says out loud: the record that lets agent B continue without A's transcript also lets Jonathan continue without their own week-old context. They are sometimes agent B.

The ambiguity: "one product, three verbs on one record" (v3:54) plus R3's merger of review, feedback, `next`, and the work map into the task record leaves it unclear whether a PR must be registered before review works. If a human's first `ggh review 42` demands `ggh task new` first, they have gained ceremony where the plan promised them safety. Minimal fix, no dilution: state that task records are created lazily by first interaction, and `ggh task new` exists for when you want an acceptance pack, never as a prerequisite for anything. Add one more sentence while you are in there: a local checkpoint is a local decision and never transfers as a GitHub approval. R2 §3 and GPT #7 required that label; v3 only implies it via the self-approval note. And keep the Q13 answer honest about notifications: deleting it before any replacement exists is the exact regression GLM #5 flagged in v1, so cut it with or after the replacement, never before.

## 3. Over-engineering check

The Task shape is roughly right but carries three semesters of features into a first release. Cuts and deferrals:

- `comparison` enum: ship `contribution` only. `integration(syntheticMerge)` has no consumer until merge binding or rehearse (seq 4-5), `rehearsal(set)` none until seq 5. One value now, add the rest when a lane calls for them. This also defers synthetic-tree identity.
- `regressionChecks[]` and `preservationChecks[]` collapse into one `checks[]` with `kind: regression | preservation` and `expect`. Two parallel shapes for one concept is schema you carry forever. The demo needs both behaviors, not both shapes.
- `identity`: keep verifierVersion, trees, bundleDigest, argv, envKeys, mode. `depsDigest` and `runtime` matter once dependency-changing PRs are classified (R2 §2 case 5); with one Bun recipe the lockfile is inside the tree hash anyway. Say which you are deferring.
- `applicability: historical(why stale)`: derive on read by comparing identity to current state. A stored reason drifts from the recomputable truth.
- `intent.nonGoals[]`: optional free text. Do not build a concept around it yet.
- `task list` overlapping files: defer the overlap computation, it needs candidate diffs plus a comparison policy. List claims, worktrees, candidates, last observation now.
- `handoff --to-agent-host` variants: emit one canonical format. Host-specific instructions belong to the skill pack.

Smallest Task that still runs the README handoff demo:

```
Task { id, repo, intent { title, issueRef? },
  pack { recipe { prepare[], run[] }, checks [{ id, kind, expect }],
         bundle { files, digests }, digest, acceptedBy, acceptedAt },
  candidates [{ ref, head, pr? }],
  observations [{ trees, bundleDigest, argv, perCheck, attempts, outcome }],
  checkpoints [{ scope, head, mergeBase, packDigest }] }
```

The demo needs exactly this: pack digest at accept, A's candidate checkpointed, B's candidate observed against the same digest, review delta as the diff between checkpoint head and new head, refusal of B's bundle edit as a digest mismatch turned into a visible decision, then export. Keep `feedbackCursor` in the schema since lane B ships in the same release, but it is not load-bearing for the demo. Everything else earns its way in when a lane needs it.

## 4. Synthesis losses

I checked v3 against r2, r3, and all three interrogates point by point. The big restorations are present: cost and false-accusation recording in the owner sample, commit required only when fixed, shrink limits, honest Action scope, opened/inspected/decided, PR acquisition contract, network-off, threat model, prior-art naming, script baseline, uncoached outsider. Five losses remain, each one clause to restore:

1. Reply dedup and partial-outcome recovery on `respond`. R2 §3 required preserving reply IDs and avoiding duplicate replies on retry; v2 had "dedupes." v3 kept separate effects but dropped recovery. A retry after a lost ack should not post twice.
2. Resolution changes in the agent cursor. R2 §3 listed edited/deleted comments, resolution changes, and pagination. v3's `feedbackCursor { observedThreads, editsSeen, paginationComplete }` misses a thread someone else resolved, which then looks unchanged to the agent. The human-side delta names resolution changes (v3:75), so the requirement was understood and half-dropped.
3. Claim crash recovery. R3 §3: "Crash recovery needs explicit release or reconciliation." A crashed agent leaves a stale claim forever. Report claim age and let the owner release it.
4. v2's ship selection rule: "Explicit file selection or an owned worktree; never add -A in a shared checkout." v3 reduced ship to the fold. The fold is right, and the rule should survive it, since shared checkouts are the owner's normal state.
5. Receipts and secrets. R2 §2 case 11 said never export secret hashes as identity. v3's identity carries env key names and export produces a receipt package, but the export section never says no values, no hashes. Half a line.

Smaller: v2's seq-0 "network-off feasibility probe per OS" softened into "where the OS allows" with no probe; keep the probe, it is one afternoon on macOS. v2's kill condition for the owner sample ("kill/reshape if most land inconclusive") did not survive; without it the sample is a diary, not a gate. v2's post-launch adoption signals (downloads, stars, stranger issues) vanished entirely, and Q1 is adoption, so name at least one no-telemetry signal. GLM opp #5's flake ledger is gone without comment; it pairs with the `unstable` outcome v3 already ships, costs almost nothing, and directly reduces the false accusations the validation section says to measure. `split-plan` is also gone, which is a defensible cut, but it deserved a line under "Deleted from the plan" rather than silence.

## 5. One last bold idea

Run an adversarial handoff gauntlet before release and publish the transcript as the launch artifact. Hand a fresh agent a task record and one instruction: get `expected-transition-observed` on your candidate while changing as little real behavior as possible. It will try the moves the plan blocks mechanically, so editing the expectation, weakening the test, adding a skip, refreshing a snapshot, citing an unreachable commit, submitting under a stale head. Then it will try the moves nobody has listed yet, which is the part worth having.

Why this beats what is there: v3 validates against mechanical fixtures and honest mistakes, but the product's whole claim is that the record keeps a candidate honest, and the threat-model line ("process control among cooperating tools, not security against a hostile same-user agent") draws a boundary without ever testing the near side. An agent optimizing to defeat the contract is the near side. The current demo shows a cooperative agent B. The gauntlet shows ggh surviving an uncooperative one, including the attempts it missed and the fixes that followed. That is the most persuasive README artifact available for adoption (Q1), a source of permanent fixtures, and it costs about a day with no telemetry. If ggh misses a lot, the owner learned the most important thing they could learn before release instead of after.

## 6. Verdict

Ship to the owner, with listed edits. The thesis is right and correctly bounded, R3's attacks were absorbed without losing the ceiling, and the commitment set respects every binding constraint. The edits are sentences, not redesigns, but they belong in the document before schema freeze: the concurrent-writer update model; lazy record creation for the human path; the checkpoint-is-not-approval sentence; reply dedup and partial outcomes; resolution changes in the agent cursor; claim crash recovery; the ship selection rule; ref retention and pruning policy; receipts never carry env values; restore the network-off probe; the sample's kill condition; one adoption signal. After those, Q6-Q13 are genuinely open owner questions rather than engineering obligations in disguise.
