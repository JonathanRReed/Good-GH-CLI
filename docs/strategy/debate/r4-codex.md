# Good GH: round 4 adversarial review

Reviewed October 22, 2026 against `32a3e4b6a1848434e45aa7287bf0ab30d1867ce7`. References to plan and review files mean `/tmp/ggh-plan/`. Owner answers remain binding.

## 1. Fatal or critical problems

None found in v3's direction. The unsafe hosted-workflow shortcut, universal correctness verdict, agent standings, and eight-project launch have been repaired. Three remaining contracts need edits before implementation.

**High: environment names cannot establish evidence freshness.** `v3-claude.md:33-37` records `envKeys` and labels observations `current`. Identical commits, dependencies, runtime, argv, and environment names can produce different behavior when `FEATURE_FLAG=off` becomes `on`. An allowlist controls inheritance; it does not identify values. The earlier requirement survives only partly, `r2-codex.md:80`, `r3-codex.md:13`.

Record declared nonsecret input values or their canonical digest. Secret-dependent or externally mutable inputs need an explicit unverifiable identity and a limited applicability claim. Never export secret hashes. Catching case: change a declared flag without changing any OID; the previous observation must cease to be current. Do not expand this into universal environment fingerprinting.

**High: one shared task record needs a write contract.** `v3-claude.md:20-46` joins owner decisions, verifier output, candidate updates, and feedback cursors without specifying concurrent updates. An owner checkpoints H1 while verify finishes H2. If both read the old Task and replace it, the later write loses either the checkpoint or the observation. Atomic rename alone does not prevent this.

Keep immutable packs, observations, and checkpoints in separate files. Serialize short task-index updates with a per-task lock, reread inside the lock, and reject obsolete acceptance/checkpoint preconditions. Never hold the lock while tests run. Reuse the existing storage and locking approach at `src/services/operations.ts:277-303`.

Replace literal `.git/ggh` with a Git-resolved common-directory location. Linked worktrees may have a `.git` file, and all worktrees must find the same task. Existing operations already resolve the common directory, `src/services/operations.ts:231-243`; [Git documents the gitfile layout](https://git-scm.com/docs/gitrepository-layout). Catching case: concurrent checkpoint and observation writes from two linked worktrees, followed by an interrupted index update. Both completed records must remain discoverable.

**Medium: export is promised without a replay contract.** `v3-claude.md:45-46,88-89` says export is explicit and replayable, but never says what crosses the boundary. Local private refs and filesystem paths are insufficient on another checkout. Copying all referenced content risks exporting private fixtures, reviewer text, or unbounded logs. R2 specified selected bytes, bounded logs, private-source references, and inspection before embedding, `r2-codex.md:261-269`.

Specify a versioned manifest, required objects and pack bytes, external prerequisites, and an inspectable content inventory. Referenced private source remains referenced unless explicitly included. A receipt must distinguish missing prerequisites from a failed check. Add a fresh-checkout replay to the demo, with no access to the producer's metadata directory. This earns the word "replayable."

## 2. The human-at-terminal test

**The thesis can serve a human who never uses agents. The current onboarding promise does not yet prove it.**

A human writes code, commits, opens a PR, returns after a break, reads feedback, and changes it. Saved review position, preserved expectations, and reproducible checks help that person. Requiring `task new`, a regression pack, and `task accept` before ordinary publishing or review would make the product worse. Documentation, dependency updates, and small refactors often have no useful fail-to-pass pack.

Add one explicit rule: **tasks are optional records inferred or attached by existing commands; acceptance packs are optional until the user requests an expectation-based observation.** `review 42` must work on an arbitrary existing PR whose author never used ggh. It may offer to save a checkpoint. Missing executable evidence is information, not a blocked workflow. Creating or inspecting a task must never execute tests automatically.

Keep today's manual commit-to-PR path useful throughout the rewrite. It already exists, `README.md:43-54`; AI is optional. Folding its name into `ship` is maintenance, as v3 correctly says at line 114.

Add a second acceptance scenario beside the agent demo: with no agent installed or AI configured, make a manual commit, open a PR, inspect it, amend it, and retrieve the review delta. No issue, pack, or task ceremony required. This tests the binding audience in `decisions.md:4` directly.

Describe the benefit as keeping your place and requirements across interruptions. Switching agents is one strong demonstration of that benefit, rather than the only reason to install.

## 3. Over-engineering check

The shape at `v3-claude.md:20-43` is a useful eventual inventory. Do not make every field a first-release requirement.

Smallest Task for the handoff demo:

```text
TaskV1 {
  schemaVersion, id, repoIdentity
  brief: { title, goal, nonGoals, nextStepOrOpenDecision? }
  candidate: { ref, pinnedHead, pr? }
  packRef?                  // immutable bytes and acceptance decision
  checkpointRef?            // immutable review snapshot
  observationRefs[]         // immutable measured results
}
```

The brief needs enough human intent to continue without a transcript. An optional issue reference and a title alone do not supply that, `v3-claude.md:22`. Keep one plain-text continuation note; do not invent a planning language.

Preserve the detailed verification identity, test bundle, attempt classification, comparison trees, and checkpoint scope inside their referenced records. Moving them out of Task is not permission to weaken their contracts. Accepted pack versions remain retrievable after a new acceptance decision.

Cut or defer:

- Multiple simultaneous `candidates[]`, agent claims, host/session identity, file-overlap maps, registered-repository discovery, and cross-repository ranking. A then B can advance one candidate sequentially. Old observations and checkpoints retain prior heads.
- Integration and rehearsal variants in the first verifier implementation. Start with contribution comparison. Preserve an extensible tagged format without implementing future modes.
- `opened` as persisted checkpoint state. V3 already says displaying a report consumes nothing. Store inspected scope and explicit decisions.
- A global feedback cursor inside Task. Add a referenced feedback snapshot when feedback reads ship. Checkpoints can reference the exact snapshot they used; two independently advancing cursors must not disagree about what the human saw.
- Embedded operation history. Keep optional journal references only for actual effects.

Do not cut schema versions, accepted pack bytes, expected base assertions, preservation-check visibility, or previous checkpoint inputs. Those make the demo honest.

The first release needs one vertical task path, not a fleet registry. `task list` can initially list the current repository's tasks. Move claims and overlap discovery out of the committed slice at `v3-claude.md:90-92,144-145`. Peripheral deletions should not hold the experimental release hostage.

## 4. Synthesis losses

Four requirements still deserve explicit restoration. Most earlier objections are now resolved.

1. **Agent results need a versioned command-specific contract.** V3 promises JSON and skills, `v3-claude.md:78-89`, but omits `r2-codex.md:99`'s separation of successful measurement from measured test failure. Today's envelope leaves `result` unspecified, `src/services/agent-contract.ts:54-60`. Publish schemas for Task, Observation, and feedback. A successful runner measuring a failed head check must not appear as "task succeeded."

2. **Feedback reads and writes lost their remaining freshness/retry rules.** Raw text, pagination coverage, dispositions, reachability, and separate resolution effects survived. Fresh thread/head checks, partial-fetch cursor advancement, reply reconciliation, and preservation of reply IDs did not, `r2-codex.md:139-145`, `r3-codex.md:45`. Restore one short contract before `respond` ships. A timeout must not cause a duplicate reply or resolution against newly changed feedback. This need not block the read-only slice.

3. **Export and content retention change the older privacy policy deliberately.** The approved design keeps operation records metadata-only and content opt-in, `docs/superpowers/specs/2026-10-14-good-gh-quality-design.md:28`. Packs necessarily retain selected content. State their private storage, retention/deletion behavior, and explicit export boundary. Reuse private-storage protections rather than assuming Git metadata is private. This clarifies the new feature without forbidding it.

4. **Cross-platform and installed-artifact checks disappeared from validation.** The approved audience includes macOS, Linux, and Windows, `docs/superpowers/specs/2026-10-14-good-gh-quality-design.md:7-15`. A Bun recipe does not inherently change that. Keep separate checks for installed CLI behavior and supported-platform storage/process execution. Unsupported execution restrictions must be printed as limitations. A source fixture pass is not installation or host-execution proof.

I would not restore standings, automatic trailers, a full TUI, mandatory Docker, mandatory author adoption, recruitment quotas, or required-status marketing. Those were deliberate improvements in v3. The script baseline, owner sample, two-host demo, and uncoached outsider are enough research machinery.

## 5. One last bold idea

None. V3 has enough ambition. The highest-value addition is the manual acceptance scenario above, not another command or experiment.

## 6. Verdict

**Ship this plan to the owner with the listed edits.** Keep the task thesis and handoff demo. Make task adoption optional, define safe concurrent storage and evidence applicability, earn receipt replay, and remove fleet machinery from the first release. These edits sharpen the existing product; they do not require another strategy round.

Evidence: all seven requested documents read; current source and approved product contract inspected; official Git layout documentation checked; file-free probes confirmed environment-key collisions and lost updates under whole-record replacement. These demonstrate plan gaps, not defects in an implemented Task store. No repository tests, candidate execution, installation, or GitHub writes. Only this report was created. `$unslop` was explicitly invoked and applied.

<oai-mem-citation>
<citation_entries>
MEMORY.md:911-916|note=[located prior manual-use and platform contracts then verified them in current repository documents]
</citation_entries>
<rollout_ids>
01a13c1f-4290-78a3-92d5-447ef41c3065
</rollout_ids>
</oai-mem-citation>
