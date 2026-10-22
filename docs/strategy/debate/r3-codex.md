# Good GH: round 3 adversarial review

Reviewed October 22, 2026 against `32a3e4b6a1848434e45aa7287bf0ab30d1867ce7`. All six requested documents were read in full. References below use repository-relative paths and `/tmp/ggh-plan/` filenames. Proposals remain unimplemented.

V2 is a credible direction with an unsafe Action shortcut and too many independent commitments. Accept its evidence vocabulary and smaller review interface. Repair the experiment contract, collapse the command plan, and delete agent standings. The strongest product is a task whose requirements, observations, and review history survive switching agents.

## 1. Synthesis errors

1. **Critical: SWE-2 #9 and GLM opportunity #1 were accepted without challenging their security premise.** v2-claude.md:48-51 converts "CI distributes this well" into "a composite Action gives strangers a credential-free executor." A composite Action packages job steps; it does not establish a security boundary. Both reviewers overclaimed. The consequence is a dangerous default workflow template, especially when someone fixes fork publishing by adding privileges. See section 3. [Composite Action documentation](https://docs.github.com/en/actions/tutorials/create-actions/create-a-composite-action).

2. **Warning: the experiment contract lost essential requirements during compression.** r2-codex.md:66-88 and GPT #1-3 require expectation ownership, a named expected behavioral assertion, separate preparation and builds, nonzero discovery, and repetition in fresh state. v2-claude.md:35-43 retains a bundle, result parsing, identities, and attempt counts, but does not explicitly require those operations. An assertion failure about the wrong behavior still earns `expected-transition-observed`; one unlucky base run followed by a lucky head run still qualifies. Restore those requirements, including visible missing preservation checks. Counting attempts does not require more than one.

3. **Warning: identity became a list of labels rather than identities of actual inputs.** r2-codex.md:68-80 requires checking loaded artifacts and separating writable build/dependency state. v2-claude.md:42 names a dependency recipe but does not say how installed bytes, mutable caches, generated outputs, or unknown environment inputs affect applicability. A pinned command can load head's generated client while allegedly testing base. The existing runner also merges supplied environment entries into `process.env`, so an environment override is not an allowlist, `src/utils/exec.ts:145`. Keep unsupported environments inconclusive and never export secret hashes as identities.

4. **Warning: comparative validation lost its cost measurement.** GPT #12/#14 and r2-codex.md:209-225 ask whether setup, test creation, execution, and interpretation actually reduce active human work. v2-claude.md:144-149 retains applicability and inconclusive rates plus the script comparison, but omits those costs and false accusations. A technically accurate runner can still waste Jonathan's attention. Record those locally in the owner trials. Neither cohorts nor telemetry are needed.

5. **Warning: the response interface contradicts its own dispositions.** v2-claude.md:83 requires `--commit` even for `disputed` and `needs-owner`. r2-codex.md:142 explicitly says disagreement must not require a fake fixing commit. Require reachability validation when a commit is claimed; permit an explanation without one. Otherwise agents learn to invent closure evidence.

6. **Warning: `shrink` lost its operating limits.** v2-claude.md:122-123 drops r2-codex.md:275-277's disposable candidate, explicit removable region, original-branch preservation, and refusal to claim equivalence. Restore them before treating this as a buildable experiment.

Two smaller synthesis regressions matter. v2-claude.md:69's "only many-agent fleets create" and "nobody targets it" repeat the novelty mistake GLM #13 warned against. GitHub's queue explicitly tests combined PRs against the target. Local preflight and a reduced counterexample are the proposed distinction. [Merge queue documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue).

Also, interrogate-gpt.md:161 and r2-codex.md:217 opposed rewriting the README around unbuilt commands. v2-claude.md:157 still puts the README rewrite before the experimental release. Narrow current documentation immediately; add new command promises only as they work.

## 2. One product, if three commitments disappear

The questions organize review decisions. They do not organize eight implementation projects. `ship`, stack migration, a provenance trailer, and agent rankings do not naturally answer them. `next`, `work`, and review feedback also risk becoming three partially synchronized task lists.

Make these cuts:

- **Merge review deltas, feedback reads, `next`, and the known-worktree map into one task record with several views.** Keep useful command spellings, but one identity, cursor, evidence lookup, and freshness model. Start with one PR and its local checkout. Cross-repository ranking is an extension. Do not require a universal fleet registry before one review works.
- **Delete standings and automatic provenance trailers from the committed plan.** Unknown authorship should remain unknown. A local operation history is sufficient until a concrete attribution task earns more.
- **Remove `ship` and stack replacement as strategic bets.** Folding an existing path and qualifying a replacement are maintenance. Preserve them where useful, but they should not compete with the review loop or delay it. `--land` remains deferred lifecycle work.

The resulting commitment is manageable: review delta plus one supported observation recipe. Integration rehearsal is the single bold adjacent experiment. Acceptance packs define shared data; shrink remains an optional experiment against that data. The public gauntlet is validation, not another product.

## 3. Mechanism attacks

### Review checkpoints

`host/repo/PR/head` is necessary but insufficient, v2-claude.md:59-61. An unchanged head can acquire a different target, merge-base, review reply, check rerun, or acceptance pack. A force-push can make the previous commit unavailable after garbage collection. Range-diff compares patch series heuristically; it cannot certify preserved behavior.

Record stable repository identity, previous comparison trees and merge-base, checkpoint scope, selected pack, and separately fetched remote state. Retain enough local objects to reconstruct the prior view. Distinguish "opened," "inspected these files," and an explicit decision. Merely displaying a report must not consume unread work. Keep full-PR access and flag ambiguous matching.

Thread cursors need edited/deleted comments, resolution changes, pagination coverage, and partial-fetch states. Advance only through successfully observed data. A timestamp alone misses edits to older comments. The current PR view does not even acquire head/base OIDs, `src/services/github/prs.ts:160-161`; this requires a new acquisition contract.

Smallest catching case: checkpoint, rebase, retarget, edit an old comment, and rerun a failed check. Show each change without pretending everything is new or everything is already reviewed.

### Integration rehearsal

"Individually green" must mean each candidate passes the same selected invariant suite on the same pinned target and environment. Historic CI greens on different bases do not establish that premise. Dependency preparation may itself fail together even when Git merges cleanly.

Record ordered candidate heads, stack ancestry, target, synthetic tree, recipe, attempts, and budgets. Avoid counting an ancestor twice. Test dependencies with their required parents. A conflict prevents that combination's behavioral experiment; it does not convict either PR. Never resolve it automatically merely to continue testing.

Pairs miss three-way interactions. Merge order can change results. Reduction under a budget yields a smaller observed failure, not necessarily the smallest or unique cause. Emit tested combinations and untested ones. Recheck the final counterexample in fresh state.

Retain the native queue where available, but do not assume Jonathan's personal repositories have one. GitHub documents queue availability for organization-owned public repositories and qualifying organization private repositories. Rehearsal must still be useful without it. [Queue availability](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-a-pull-request-with-a-merge-queue).

### Work map and `Agent-Tool:`

Git sees worktrees and branches, not all agent sessions or task ownership. Today's `WorktreeInfo` contains path, head, branch, and bare state, `src/services/git/worktree.ts:13-18`. Operation AI records identify ggh's own provider calls, not the external agent that authored a patch, `src/services/operations.ts:33-47`. A Claude commit-message request could otherwise credit Claude for Codex's implementation.

Use explicitly registered repositories and task claims, canonical paths, stable task IDs, timestamps, and unknown/stale states. Crash recovery needs explicit release or reconciliation. Claims can govern ggh cleanup; they cannot constrain arbitrary Git commands. Recheck dirty state and ownership immediately before removal. The current remover has no task check, `src/services/git/worktree.ts:179-188`.

An environment variable proves only what a process inherited. Nested tools, spoofed values, cherry-picks, and squash merges defeat authorship inference. Automatic trailers also publish metadata into permanent history. Default to private, self-reported task attribution. Any public trailer should be explicit and describe a tool claim, never authenticated model authorship.

### Action execution and status publishing

The Action is a good distribution adapter. Its proposed trust story fails in five places.

1. **Fork permissions.** Ordinary fork `pull_request` runs receive a read-only `GITHUB_TOKEN`, and other secrets are withheld. They cannot simply post `ggh/verify` to the base repository with `statuses: write`. Local publishing also requires repository push authority and an appropriate token scope or commit-status permission. A logged-in stranger lacks that authority. [Fork execution rules](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target), [status API permissions](https://docs.github.com/en/rest/commits/statuses).

2. **The privilege trap.** Switching to `pull_request_target`, checking out the candidate, then installing dependencies or running tests executes foreign code with the base repository's authority. `workflow_run` has a related trap if its privileged consumer executes downloaded artifacts. Neither is an acceptable fix for missing publishing permission. [GitHub's warning](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target).

3. **Executor scope.** Hosted compute separates the PR from Jonathan's laptop; a composite does not separate tests from the rest of its job. Avoid secrets, persisted checkout credentials, privileged tokens, and later privileged steps on the compromised machine. Include dependency preparation in this boundary. Hosted execution does not itself promise network-off measurement. Never label a caller-selected self-hosted runner equivalent. [Hosted runner model](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners), [secure workflow guidance](https://docs.github.com/en/actions/reference/security/secure-use).

4. **Status spoofing.** Anyone with write permission can set a status. An agent using Jonathan's credential can post success without running verify. The context name is not authentication. GitHub supports selecting an expected App source, but even an Actions source does not uniquely identify a protected workflow. Keep local statuses informational. Strong enforcement needs a protected evaluator/publisher and an explicit threat model, without requiring a ggh account. [Required status sources](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

5. **Meaning and expiry.** `success` cannot universally mean fail-to-pass; refactors and inconclusive observations need different policy. A status on head H does not expire when its pack or integration target changes. PR head, synthetic PR merge, and queue merge-group SHA are distinct. Required queue checks need `merge_group` handling. Name the comparison in the receipt; separate observation from merge policy. [Queue check requirements](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks).

Start with an unprivileged hosted workflow, its normal job check, and a bounded receipt. If a privileged publisher becomes necessary, run trusted publisher code separately, bind repository/run/head/recipe, validate bounded artifact data, and never execute it. Such validation authenticates where the report came from; it does not make candidate-controlled tests honest. Prove same-repo, fork, stale-head, cancellation, and queue behavior before advertising a required gate.

### Shrink

"Smallest subset" overpromises a combinatorial search, v2-claude.md:122. Test acceptance is non-monotonic. Removing either of two coupled edits can fail while removing both passes. Smaller code can also delete an untested requirement, weaken validation, or retain a hard-coded example.

Use an owner-selected removable region, immutable acceptance and preservation packs outside that region, fresh builds, attempt budgets, and mandatory checks that cannot become skipped. Output a separate candidate plus a diff and the checks preserved. Say "smaller candidate found" unless minimality was actually established. Never automatically rewrite or publish the original branch.

### Acceptance packs

This is the best candidate for the central data model. Approval must bind exact bytes and versions. Include expected observations, applicability, non-goals, preservation checks, preparation, environment requirements, and the human-owned expectation decision. The owner need not author every test, but must be able to distinguish proposed requirements from accepted ones.

A candidate must not silently edit its evaluator and call the task satisfied. Pack changes need their own visible decision. Generated tests remain proposals; issue prose alone does not supply executable truth. Start with a reviewed local file format. No new registry, account, or orchestrator is necessary.

### Standings ledger

Delete it. Task difficulty, missing evidence, model switches, human fixes, retries, and selection bias defeat the implied ranking. Transition rate can reward trivial bug fixes and penalize correct refactors. Integration failures involve combinations, not one guilty model. The trailer supplies neither reliable model identity nor contribution ownership.

If revisited, show task-linked observations with unknown attribution and denominators, not a league table or "safe to skim" score. Local storage avoids telemetry; it does not fix causal inference.

## 4. The ceiling

One unifying idea is enough: **make a task portable between agents without losing its acceptance conditions or the human's place.**

The unit is a work record containing requirements, candidate revision, observations, unresolved decisions, and the last human checkpoint. Any agent host can receive it. Any candidate must answer the same requirements. The human sees changed expectations, unsupported claims, and interactions requiring a decision. Existing commands become ways to create, inspect, test, or publish that record.

The README should demonstrate an interrupted task changing agents, not advertise eight verbs. Smallest demo: freeze one bug reproducer and preservation check; let agent A submit a bloated partial fix; checkpoint it; hand the record to agent B without A's transcript. B finishes. Show the exact review delta, reject an attempted expectation edit, and export the replayable receipt. A later experiment adds shrinking or a conflicting second task. None is needed to establish the first demo.

This raises the ambition while reducing the implementation commitments. It remains process control among cooperating tools, not security against hostile same-user agents.

## 5. Lock list

- Humans and agents first-class; adoption rather than a business; no telemetry ever, ggh account, or phone app. Local first. Break freely before 1.0.
- Bounded observations, supported recipes, previewable test bundles, explicit trust, visible inconclusive outcomes. Contribution and integration comparisons remain separate.
- Head-preconditioned merges and honest queued/armed/merged/uncertain states. Today's omissions are directly visible at `src/services/github/prs.ts:181-206` and `src/commands/pr-lifecycle.ts:179-187`.
- A dedicated verifier workspace path. Existing worktree creation copies environment files, initializes submodules, and records shared branch metadata, `src/services/git/worktree.ts:137-172`.
- CLI/skill feedback first; raw reviewer text and coverage; replies and resolution as separate effects; MCP remains read-only initially.
- A compact decision report plus gh-dash integration before a new TUI. Existing publication recovery stays valuable. Stack replacement requires qualification and migration.
- One useful release, one install channel, an unselected owner workload sample, honest fixtures, and an uncoached outsider after the slice works.

## 6. Genuine owner preferences still open

1. Which daily pain should lead: repeated review or getting work published? Recommend review checkpoints around existing publication; change this only if observed daily work says otherwise.
2. May agents resolve review threads? Recommend replies by default and explicit resolution authority, with disputed and needs-owner paths.
3. How far may an approved landing operation continue unattended? Recommend exact-head authorization with explicit queue/auto-merge scope and cleanup only after confirmed merge plus a fresh ownership check.
4. Which peripheral tasks remain ggh's responsibility? Recommend retiring team/triage and thin wrappers, preserving named stash restoration, and keeping notification actions noninteractively only if Jonathan uses them. Keep release/changelog only by deliberate preference.

Trust classification, fork permissions, status authenticity, and evidence expiry are engineering obligations, not owner taste questions.

Evidence: fresh source inspection, current official GitHub documentation, and two file-free counterexamples confirming that pairwise passes miss a triple failure and single-hunk deletion can miss a smaller passing patch. These establish mechanism limits, not a working implementation. No candidate code, GitHub writes, or repository tests were run. `$unslop` was explicitly invoked and applied. Only this report was created; repository source and Git history were unchanged.

<oai-mem-citation>
<citation_entries>
MEMORY.md:911-912|note=[located prior product contracts and checked current source against binding owner decisions]
</citation_entries>
<rollout_ids>
01a13c1f-4290-78a3-92d5-447ef41c3065
</rollout_ids>
</oai-mem-citation>
