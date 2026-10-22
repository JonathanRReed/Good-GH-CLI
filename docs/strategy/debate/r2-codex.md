# Good GH: round 2 adversarial review

October 22, 2026. Reviewed repository commit `32a3e4b6a1848434e45aa7287bf0ab30d1867ce7`. I read all four debate documents in full. The owner decisions govern this review. All proposed commands below are proposals unless explicitly described as current code.

V1 has the right audience and a plausible daily loop. I would approve that direction, but reject bet 2's inference rules, the blanket cut list, and the launch dependency chain. Its most distinctive feature currently promises more than its method establishes. Much of the remaining plan reproduces capabilities already available in gh-dash, GitHub MCP, Copilot CLI, and ggh itself.

The higher ceiling is a local tool that tells Jonathan what changed since their last decision, which claims have executable support, and which independently green agent branches break when combined. That serves humans and agents without an account, telemetry, a phone, or a hosted dependency.

## 1. Rebutting Part A's five rejections

### 1. Maintainer-first customer: concede

R1 chose the wrong primary audience. Humans at a terminal and coding agents are both first-class. Independent verification remains useful within that audience, including Jonathan reviewing their own agents, but it cannot require everyone to adopt a maintainer-specific workflow.

Lock the audience. Stop reopening it. Also stop treating the inferred fleet-review bottleneck as an established observation. Owner Q5 establishes many agents and owner review. It does not establish that reviewing PRs costs more time than branch coordination, broken integration, publishing, or recovering interrupted work. Dogfood those tasks before choosing the default screen.

### 2. Cohort program and 30% review-time target: concede the requirement; press on adoption evidence

Withdraw the recruitment quotas, business framing, calendar commitments, and mandatory improvement percentage. No telemetry, ever. Local dogfooding is sufficient to guide Jonathan's personal workflow.

But "not a business" does not make external usefulness irrelevant. Owner Q1 explicitly wants open-source adoption. Personal preference and public usability answer different questions. After a useful vertical slice exists, ask a willing stranger to complete its documented task without coaching and report failures voluntarily. This requires no account, instrumentation, cohort machinery, or delay to daily use.

"Kill it if the owner stops using it" is also too blunt. Nonuse may mean poor discoverability, unsupported project setup, or a bad interface. Record the concrete abandoned task locally when Jonathan chooses to, then fix or cut its cause. Stars and downloads remain adoption signals, not evidence that verification works.

### 3. Compatibility cycles: concede

Break freely before 1.0. No ceremonial deprecation period is needed for the only user's scripts. A deletion still needs a behavior inventory. Permission to break compatibility does not make useful code redundant. Section 4 identifies what each proposed cut actually removes.

### 4. Docker as the only runner: concede the exclusive mode; press on trust selection

Trusted local execution is a valid primary mode. Requiring Docker for Jonathan's reviewed code would add friction without matching their stated task. Support it.

Do not infer trust from "my agent wrote it." Generated code, dependency installation, build scripts, and submodules still execute with host authority. `--trusted` must mean the caller knowingly accepts that authority. Print "runs as your user; host files and credentials are accessible." Removing automatic `.env` copying does not prevent reads of the environment, home directory, credential helper, or shared Git metadata.

The existing worktree helper copies environment files at `src/services/git/worktree.ts:137` and initializes submodules at `src/services/git/worktree.ts:153`. It needs a deliberately separate verification path. Calling that path "local isolated worktree" conflates directory separation with execution isolation. Say "disposable worktree, trusted execution."

Foreign execution can remain unavailable in the first release. Refuse it unless the caller explicitly chooses trusted execution. Do not quietly treat repository ownership or agent authorship as consent. A container adapter can arrive later with its supported boundary stated precisely.

### 5. Command count and reader load: concede the focus argument; reject the classification

Forty-five top-level choices can burden help, completion, docs, and maintenance. Cut or group commands where that improves the product. R1's compatibility objection is withdrawn.

The new evidence is in the proposed cut files. `draft` restores named stashes; `triage` groups issues with AI; `changelog` preserves a file's preamble; `notifications` includes account-wide write actions. None is simply a gh proxy. They may deserve deletion, but for a product reason. The same behavior-based standard must apply to the proposed `pr feedback`, `pr address`, and `ship` wrappers.

I am not re-arguing Part A's conceded items. Those concessions should be locked.

## 2. Bet 2 needs a different contract

### The inference is unsound in both directions

Running fixed tests against old and new code is useful differential execution. It does not establish either of v1's proposed conclusions universally.

- Base passes and head passes: the selected tests did not distinguish these two implementations. They may still exercise every changed line. A refactor should often preserve results on both revisions. A bug may require a different input, platform, scheduling order, or configuration. Report the observation, not "tests do not exercise the change."
- Base fails and head passes: something in the compared inputs changed the outcome. It may be the intended fix, a new import, a helper, an updated snapshot, altered setup, or a pre-existing failure that head incidentally repairs. Even a legitimate regression test can accept a hard-coded answer and miss the remaining bug. Report an expected behavioral transition, never `proven-fix`.

I ran three file-free Python examples during this review. A behavior-preserving refactor passed the same test on both versions. A snapshot-like expectation accepted an intentionally wrong new result and failed the old result. A one-input patch failed before and passed after while remaining wrong on another input. All assertions passed. These demonstrate the logical limits, not a qualification of a future ggh runner.

### Specific failure cases the plan must handle

1. **Test-file classification is not a portable operation.** Rust commonly embeds tests beside production code. Go separates files but not every fixture or helper. Python fixtures can live in `conftest.py`. JavaScript snapshots, custom extensions, generated cases, and test utilities need not match `*.test.*`. File-level partitioning can retain the fix inside an alleged test file or remove a prerequisite from an alleged production file. Discovery may suggest a partition. Unsupported or ambiguous partitions need explicit selection or an inconclusive result.

2. **New symbols fail before an assertion.** `import { parseNewFormat }` against a base without that export can fail TypeScript compilation, module loading, Python collection, or JVM linking. That is not reproduction of the reported defect. V1 already calls setup failure inconclusive; enforce that rule for missing-symbol failures too. A useful new-feature test may need to target an existing public interface or use an explicit absence check. Do not repair the comparison by inserting arbitrary stubs into base.

3. **Snapshots can certify the wrong expectation.** A PR can change output incorrectly, update its golden file, and produce exactly the desired red/green pattern. Freeze expected artifacts across the comparison, disable update mode, and show the expectation diff for human review. A snapshot mismatch establishes a changed observation. It does not establish that the new observation is right.

4. **Helpers can carry the answer.** A changed mock can return the expected value without calling production code. A test-only helper can depend on a new production export. Including helpers can smuggle implementation into the test pack; excluding them can break collection. Pin the complete selected test pack and expose its contents. Distinguish author-supplied tests from reviewer-selected tests. Negative controls should challenge actual behavior when applicable.

5. **Configuration and dependencies are part of the experiment.** Base `package.json` may lack the new test script or framework dependency. Head configuration may exclude the failing case. A lockfile change can itself fix the defect. Blindly choosing base or head for all non-test files changes what is being tested. The recipe must name source, runner, config, dependency, and fixture inputs. Sometimes the only honest answer is that the proposed hybrid does not build.

6. **Generated artifacts can leak head into base.** Tests may import `dist/`, native libraries, generated clients, or a package-manager workspace link instead of the source tree under comparison. Reusing head's build cache can make base pass the fixed code. Rebuild revision-specific artifacts in separated writable directories, record the build recipe, and check which artifact the test loads. Shared caches need keys that include their actual inputs.

7. **Monorepos defeat "a test command" as a sufficient specification.** A root script may test one package, invoke an affected-project calculation that selects nothing, or require several builds first. A recipe needs working directory, package/task selection, preparation steps, and discovered test identities. A successful root command is not evidence that the changed package ran.

8. **Changed tests are not the complete preservation obligation.** New tests can flip red to green while an old test regresses. Keep distinct selected regression checks and preservation checks. Missing preservation evidence must remain visible. Changes to performance, documentation, UI layout, migrations, or public APIs may require another observation method entirely.

9. **One red run followed by one green run confounds order and flakiness.** Base may warm a shared cache or consume a fixture. Time, randomness, retries, ports, network state, and test order can produce the transition. Repeat in fresh state, preserve every attempt, and vary order where relevant. Three consistent runs still do not prove absence of flakes. Say how many ran. A timeout needs an explicit expected-timeout recipe before it can support a behavioral claim.

10. **Base is ambiguous.** The contribution comparison should normally use the recorded merge-base and PR head. Current target plus candidate is a different integration question. Stacked changes need their actual parent, not always `main`. Record the chosen comparison. A contribution check must not silently authorize landing on today's target.

11. **Result expiry needs more than Git OIDs.** Include source trees, test-pack bytes, runner/configuration, dependencies, toolchain, execution mode, relevant environment inputs, and the recipe version. A mutable environment does not become reproducible because the commit is pinned. Do not copy raw secrets into a receipt. Unknown environment identity means a weaker observation, and secret hashes should not become exported guess-verification material.

12. **An automated runner cannot infer intent from an exit code.** Parsing test-level results and confirming nonzero discovery is necessary. It still cannot decide that an assertion describes the desired product behavior. A trusted author or reviewer must own the expectation. The CLI can make that decision inspectable and repeatable.

### A defensible first implementation

Start with one explicit recipe for the owner's Bun/TypeScript projects. A raw argv command remains possible, but yields process observations when no supported result adapter exists. Do not advertise zero configuration for every language.

The recipe specifies comparison revisions, test pack, expected failing test/assertion, preparation, run argv, working directory, environment requirements, and preservation checks. Establish that head can build and discover the selected tests. Run the fixed test pack against both implementations in fresh state. If compatibility fails, report where. If the expected behavioral failure repeats on old code and the same check passes on new code, report that bounded transition.

Use outcomes such as:

- `expected-transition-observed`: named check, expected base assertion, head pass, attempt counts.
- `no-transition-observed`: selected checks passed on both revisions.
- `head-check-failed`: identify behavioral failure versus setup/collection failure.
- `inconclusive`: unsupported partition, incompatible inputs, missing tests, skipped required check, setup failure, or unresolved environment.
- `unstable`: inconsistent repeated outcomes.
- `preservation-observed`: selected checks passed on both revisions for a preservation task.

Keep the command's execution status separate from its observation. The runner can succeed at measuring a failing test. Existing `AgentEnvelope.result` is `unknown` at `src/services/agent-contract.ts:12`, and its schema explicitly declines detailed result guarantees at `src/services/agent-contract.ts:60`. A stable verification payload requires its own versioned schema.

Add a fixture for every case above, including one unsupported case that must stay unsupported. The acceptance gate is correct classification and no unsupported correctness claim. Do not promise a percentage of all wrong programs detected by a tiny fixture suite.

### It is not a new testing invention

The direct overlap is stronger than R1 found. [PatchProof](https://pypi.org/project/patchproof-ai/) documents expected fail-before/pass-after checks, repeated attempts, disposable Git snapshots, JSON/JUnit evidence, trusted local and Docker execution, and inconclusive outcomes for setup errors and skips. PyPI lists an October 13, 2026 release. Its [source repository](https://github.com/Balaji91221/patchproof) is available. I inspected documentation, not its runtime quality or adoption.

[SWE-bench's grading code](https://github.com/SWE-bench/SWE-bench/blob/main/swebench/harness/grading.py) distinguishes fail-to-pass and pass-to-pass obligations. Its [evaluation documentation](https://www.swebench.com/SWE-bench/reference/harness/) describes prepared container environments and patch application. That is a benchmark system, not an automatic arbitrary-PR oracle.

[Stryker](https://stryker-mutator.io/docs/mutation-testing-elements/mutant-states-and-metrics/) already separates killed and surviving mutants from invalid runtime/compile failures. Its standard mutation score excludes invalid mutants. [Arcmutate's Git integration](https://docs.arcmutate.com/docs/git-integration.html) scopes mutations to changed lines, and its [GitHub integration](https://docs.arcmutate.com/docs/github/overview.html) puts results and surviving-mutant annotations into PRs. V1's "mutate three touched lines" is a budget choice and UX proposal, not a novel mechanism.

[Claude Code Review](https://support.claude.com/en/articles/14233555-set-up-code-review-for-claude-code) describes verification of findings against behavior. [Devin Review](https://docs.devin.ai/work-with-devin/devin-review) combines organized diffs, bug findings, chat, and PR actions. These sources do not establish that either ships v1's exact local test-partition algorithm. Do not imply they do. They do establish that "review plus verification" is already contested.

Ggh can still win through convenient project recipes, portable evidence, exact-revision feedback, and daily integration with publication. The README must demonstrate that convenience rather than claim discovery of red/green testing.

## 3. Attack the other bets

### Desk: useful ambition, weak first differentiator

[gh-dash's PR bindings](https://www.gh-dash.dev/getting-started/keybindings/selected-pr/) already cover common review actions and watching checks. Its [custom bindings](https://www.gh-dash.dev/configuration/keybindings/) execute arbitrary commands with repository and PR context. A key that runs `ggh verify` is feasible without rebuilding its dashboard. The built-in action catalog already includes diff, checkout, comments, approval, merge, and close.

GitHub itself provides diff review and viewed-file tracking in its [review workflow](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/reviewing-proposed-changes-in-a-pull-request), plus [native stack navigation](https://github.blog/changelog/2026-10-06-stacked-pull-requests-generally-available/). Copying those screens is a large terminal rendering and interaction project before ggh has a unique decision to show.

There is also a solo-owner mismatch. An agent using Jonathan's GitHub credentials creates a PR authored by Jonathan. GitHub forbids authors from approving their own PRs, as the review documentation states. A queue based only on `review-requested:@me` can miss the dominant case. Include authored PRs and local unpublished work. Label a local owner decision separately from a GitHub approving review. Never weaken branch rules to manufacture the latter.

The stronger Desk is an attention queue: "these changes need a decision; this feedback arrived since you last looked; this evidence expired; these two branches fail together." Show why each item is present and when its remote state was fetched. Separate blocked work from ready work. Do not bury large or difficult PRs forever beneath a readiness score.

Build a small `next`/`status` view and a gh-dash integration first. A native Desk earns expansion when continuous inline evidence, review deltas, or integration results need interactions that a binding cannot provide. Human-first does not imply TUI-first.

### Feedback/address: real convenience, existing capability, incomplete semantics

GitHub's official [MCP server tool catalog](https://github.com/github/github-mcp-server#tools) already documents `pull_request_read` with `get_review_comments`, review-thread coordinates and pagination, and `pull_request_review_write` thread resolution. It also exposes replies through its comment tools. Raw `gh api graphql` can access the underlying GitHub objects. "Agents can consume feedback without scraping" is not the new value.

The competition now includes an entire terminal loop. [Copilot CLI's `/pr` documentation](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/manage-pull-requests) includes fixing feedback, conflicts, CI, and auto/automerge workflows. GitHub also documents [batch application of Copilot review feedback](https://github.blog/changelog/2026-05-19-easily-apply-copilot-code-review-feedback-with-copilot-cloud-agent/). Ggh's useful distinction would be a small provider-neutral contract with local evidence and recoverable effects.

`pr address --commit SHA` must not mean "a SHA was supplied, therefore resolve." That would automate the reviewer-attention problem away without solving it. A reply and resolution are separate remote writes with separate outcomes.

The minimum contract needs:

- Host/repository identity, PR head, thread ID, all relevant comments, current and original locations, outdated/resolved state, and pagination coverage.
- Original reviewer text. A generated `requestedChange` is an interpretation and must be labeled as one.
- A snapshot/cursor so the agent can ask for only feedback added or changed since its last pass.
- A disposition such as fixed, disputed, or needs-owner-decision. A valid disagreement must not force a fake fixing commit.
- Validation that the claimed commit belongs to the intended PR revision, plus a fresh thread/head check before writing.
- Reply deduplication, partial outcomes, and recovery when replying succeeds but resolution fails or times out. Preserve reply URLs/IDs. Avoid duplicate bot replies on retry.
- Explicit permission to resolve. Default to recording the response; resolve when requested. A check passing does not establish reviewer acceptance.

The current ggh MCP tool list is read-only at `src/commands/mcp.ts:6`; it contains PR reads and lists at `src/commands/mcp.ts:54` and `src/commands/mcp.ts:66`. The new write path is a new contract, not merely another entry in the existing list.

### Ship: build composition, but admit what already exists

[`gh pr create`](https://cli.github.com/manual/gh_pr_create) already handles pushing an unpublished branch and can fill title/body from commits. [`gh pr merge`](https://cli.github.com/manual/gh_pr_merge) supplies auto-merge, branch deletion, native queue handling, and `--match-head-commit`. Saving a few shell invocations is useful, but not an industry disruption.

More pointedly, ggh already advertises stage/message/commit/push/PR at `src/commands/commit.ts:128`, exposes `--pr` at `src/commands/commit.ts:164`, and calls the publication flow after committing at `src/commands/commit.ts:1022`. Exact publication previews already exist at `src/commands/pr-create.ts:110`, with recovery-aware execution at `src/commands/pr-create.ts:123`. `ship` should simplify that journey, not create a parallel implementation.

The valuable extension is one resumable operation that preserves the selected files, commit, publication target, evidence, and remaining work through interruption. "Dirty tree" cannot mean `git add -A` when several agents share the checkout. Use an owned worktree or an explicit selection, preserve unrelated staged/unstaged work, and invalidate a plan if selected content changes.

`--land` needs exact current head matching and GitHub's authoritative requirements. Current `MergeOptions` lacks a head-match field at `src/services/github/prs.ts:181`, and the constructed command at `src/services/github/prs.ts:195` does not pass one. This is a concrete gap to close before binding verification to merge. It is not evidence that today's merge command is universally unsafe.

Finally, `queued` and `auto-merge-enabled` are not `merged`. Do not clean up a worktree while its authoring agent is still using it or while GitHub has only accepted a queue request. If the terminal closes, GitHub can continue an armed auto-merge; local follow-up should reconcile on the next invocation. No daemon is required for that first implementation.

### Native stacks: the probe already changes the proposal

I ran `GH_PROMPT_DISABLED=1 gh stack --help` on installed gh 2.100.0. It exited 1 with instructions to install the official extension. I did not install it. That is not a hands-on stack qualification.

The current official [gh-stack README](https://github.com/github/gh-stack) documents cascade rebasing, continue/abort, restoration, clone-wide mutation serialization, and linked-worktree handling. It covers more than v1's remaining-local-restack hypothesis assumes. Compare a pinned release and its output/error/recovery behavior before preserving a duplicate engine solely because it has continue/abort.

Ggh's existing submission checks changing branch tips at `src/commands/stack.ts:767` and reconciles uncertain pushes at `src/commands/stack.ts:780`. Preserve those user-visible guarantees when replacing the implementation. Never hand an unfinished ggh checkpoint to gh-stack as though their journals were interchangeable. Native stacks also have [same-repository constraints](https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/creating-stacked-pull-requests). Interoperate within supported cases and state unsupported ones.

## 4. Audit of every proposed cut

I support hard cuts. I oppose describing all these commands as proxies. Breakage is allowed; accidental loss of useful behavior is avoidable.

1. **`label`: cut the dedicated command.** Mutation confirmation, dry-run, JSON results, and color normalization exist at `src/commands/label.ts:143` and `src/commands/label.ts:163`. That is some value, but little distinct product value. Retain common infrastructure rather than a bespoke label UI.

2. **`secret`: cut after documenting safe native input.** Ggh has hidden input and stdin transport at `src/commands/secret.ts:125` and `src/commands/secret.ts:143`. The installed `gh secret set --help` documents stdin input. More decisively, [gh v2.100.0 source](https://github.com/cli/cli/blob/v2.100.0/pkg/cmd/secret/set/set.go#L383) calls its password prompt and otherwise reads stdin. Hidden input is not a unique reason to retain ggh's wrapper. Document native prompt or stdin use; do not migrate examples to secret-bearing argv. No real secret was entered or transmitted during this review.

3. **`variable`: cut the dedicated command.** It adds confirmation and stdin handling at `src/commands/variable.ts:134`. Useful consistency, low differentiation. The native escape is sufficient for this peripheral task if the change in contract is explicit.

4. **`gist`: cut.** It adds JSON-oriented API reads and publication confirmation at `src/commands/gist.ts:121` and `src/commands/gist.ts:164`. That does not earn a major command family. Do not imply a secret gist is access-controlled private storage.

5. **`workflow`: cut its standalone UI, retain any service behavior the daily loop needs.** Dispatch confirms and invalidates run-list cache at `src/commands/workflow.ts:165`. Desk/ship may need the invalidation and honest dispatch status. Deleting a command registration need not delete useful lower-level behavior.

6. **`search`: cut.** Query normalization and fixed JSON fields at `src/commands/search.ts:24` and `src/commands/search.ts:45` are replaceable. The restricted field set is not a strategic advantage over native gh output selection.

7. **`browse`: cut.** `src/commands/browse.ts:11` passes straight through to gh. This is the cleanest example of the claimed redundancy.

8. **`release` browse/download/upload/delete: cut or route to native gh.** Asset patterns/directories and confirmations exist at `src/commands/release.ts:228` and `src/commands/release.ts:261`; most behavior delegates. Clarify the plan's wording: deleting the whole command also removes package-version inference at `src/commands/release.ts:20` and optional notes generation at `src/commands/release.ts:304`. Neither is a release verification system. I would retire this command family, including creation, unless Jonathan chooses releases as a daily goal. Do not mistake it for the separate project packaging scripts.

9. **`team`: delete.** It serializes branch ancestry and commit subjects to a gist at `src/commands/team.ts:99` and `src/commands/team.ts:136`. It is not a thin proxy, but it is a poor fit for the solo fleet. Its `--user` discovery lists the authenticated user's gists and filters description text at `src/commands/team.ts:173`, which is another reason not to preserve its advertised collaboration workflow unexamined.

10. **`draft`: merge its useful behavior into stash before deleting the command.** Named stash filtering at `src/commands/draft.ts:177`, selection at `src/commands/draft.ts:196`, and restore at `src/commands/draft.ts:244` serve interrupted human work. AI naming is dispensable. Existing drafts are ordinary tagged stashes; leave their bytes and restoration path intact. This deletion loses real UX unless the replacement supports that task.

11. **`triage`: retire the current feature, do not call it a proxy.** It invokes AI to group items and draft responses at `src/commands/triage.ts:127`. The display and suggestions at `src/commands/triage.ts:146` are real behavior. It lacks the deterministic evidence and task state that would justify placing it in the new core. Cut on relevance, not redundancy.

12. **`notifications`: fold the domain behavior, not just its PR rows.** Paginated account-wide reads exist at `src/commands/notifications.ts:98`. Mark-one, mark-all, and unsubscribe exist at `src/commands/notifications.ts:149`, `src/commands/notifications.ts:165`, and `src/commands/notifications.ts:181`. A PR-only Desk does not replace issue/security/other notifications. Preserve a small noninteractive path if the new product still claims that function; otherwise explicitly retire it. Do not delete it first on the promise of a later TUI.

13. **`changelog`: either fold into a deliberate release workflow or remove honestly.** It emits deterministic commit lists with optional AI and inserts entries without discarding the existing preamble at `src/commands/changelog.ts:48` and `src/commands/changelog.ts:88`. Native `gh release` does not automatically preserve that local file behavior. Low priority for fleet review, but real value.

14. **Owned stack submission and remote list: replace after interoperability is proven.** Recovery is substantive, and remote rendering adds review/CI state at `src/commands/stack.ts:481`. Confirm equivalent observation and partial-outcome behavior before removing them. Resolve or explicitly retain existing checkpoints first.

There is a shared cost across these cuts. `ggh gh ...` currently bypasses managed parsing and inherits native stdio at `src/index.ts:200`. It does not magically preserve ggh confirmations, dry-run, or the agent envelope. Document the native contract. A smaller command set is good; falsely claiming unchanged agent behavior is not.

## 5. Sequence around one reviewer, not unlimited implementers

Many agents increase implementation capacity. They also increase integration and review work. The scarce resource in the owner's stated arrangement is still the owner's review time. A serial roadmap that waits for verify, feedback, a full Desk, ship, and stack replacement before launch gives them a large batch to judge and delays public learning.

I recommend this order, with outcome gates rather than deadlines:

1. **Prove the comparison contract before reshaping the product.** Select historical PRs from the owner's repos that cover an ordinary fix, new API, preservation/refactor, dependency/setup change, snapshot, and flaky or unsupported case. Compare against explicit expected classifications. Include neutral and inconclusive examples. Do not require ten successful demonstrations of a preconceived method.

2. **Choose the shared identities and schemas.** Define repository/host identity, exact revisions, recipe identity, observation states, feedback cursor, and recoverable effect results. One integration owner reviews this boundary. Agents can then work on independent modules without inventing conflicting meanings of "verified" or "done."

3. **Ship one daily loop.** Existing commit/PR publication, one supported trusted verification recipe, structured feedback read, and a compact human decision view. Reuse existing flows. A thin `ship` entry can join this slice if it replaces duplicate UX rather than adding another implementation. Publish an experimental release once that loop works, with its limits visible.

4. **Build bounded adjacent pieces independently.** Verification recipes/fixtures, feedback transport/recovery, and gh-stack interoperability are suitable separate agent lanes after the schema decisions. Integrate one reviewable change at a time. This is a proposed implementation arrangement, not permission to mutate anything in this review.

5. **Cut peripheral commands alongside the replacement that makes the cut coherent.** README and help can narrow immediately. Named drafts and notification behavior need an explicit destination or retirement decision. Broad deletion is not the first dependency of a trustworthy verifier.

6. **Expand the attention view using observed tasks.** Add review deltas, expired evidence, and blocked decisions. Compare with a gh-dash binding before building inline diff review and comment editing. Build a full Desk if Jonathan prefers it and its task-level advantage is clear.

7. **Add integration rehearsal, selected negative controls, and isolated execution.** Priority follows actual projects. If a willing outside user needs foreign execution, bring the isolation adapter forward. If local branches keep breaking each other, integration rehearsal comes first. Neither requires a server.

8. **Add race only when an existing agent-host adapter can do most of the orchestration.** More candidate PRs can worsen the owner's bottleneck. Evaluate candidates on owner-controlled requirements, and allow "none accepted." Do not rank correctness by elapsed time, line count, or agent brand.

Daily dogfooding can coexist with public adoption. A README reader should be able to try one useful command on an existing PR before committing their entire workflow to ggh. Contributors need one working recipe, a bounded fixture format, and a simple way to add another. That is a stronger adoption path than a six-system launch event.

## 6. Raise the ceiling

These ranks estimate usefulness to Jonathan and open-source adoption relative to implementation and review cost. They are judgments, not measured returns. All ideas are local by default, use existing GitHub identity, retain evidence locally, and export content only through an explicit action. None claims worldwide novelty without further research.

### 1. Review only what changed since the last decision

**Expected value: highest. Wacky: no.**

Proposed `ggh review 42 --since last` binds the prior owner decision to a revision, then presents the new diff, new feedback, changed test expectations, and expired observations. Use Git range comparison first. Mark moved/ambiguous material for inspection rather than declaring it unchanged through an AI summary.

A maintainer can already inspect individual commits. The product value is joining that delta to the feedback and evidence the owner actually used. The same cursor lets an agent resume after compaction without rereading every resolved conversation. A README example could show one new behavioral change and two invalidated observations after a 700-line PR receives a small follow-up.

Smallest demonstration: record a local decision, amend one function and one snapshot, and show exactly what needs renewed attention. No remote write is necessary.

### 2. Find branches that pass alone and fail together

**Expected value: very high. Wacky: moderately.**

Proposed `ggh integrate 42 43 47 --rehearse` constructs pinned candidate combinations locally and runs project checks before any branch is pushed or retargeted. It can find semantic conflicts that Git merges cleanly, such as one PR renaming a JSON key while another adds a consumer of its old spelling.

Report an observed failing combination and preserve its reproduction. Use bounded selection based on shared packages/interfaces and explicit budgets. Do not claim arbitrary pairwise testing covers every higher-order interaction. GitHub's queue remains authoritative when landing.

Smallest demonstration: two cleanly merging, individually green branches that fail one named test together. Then identify which combination triggered the failure. This addresses a problem created by many agents, not merely the inconvenience of many tabs.

### 3. Acceptance requirements that survive switching agents

**Expected value: high. Wacky: no.**

Promote v1's test-first issue from a novelty into an optional work unit. An owner-approved acceptance pack records observed behavior, explicit non-goals, a reproducible failing input where applicable, and preservation checks. An agent receives the pack; another agent can replace it without rebuilding the task from a chat transcript.

The important addition is ownership. Candidate authors can propose tests, but a pack's expectation changes need a distinct decision. Changing the answer to pass the test should be visible as changing the task. This is process control in trusted local mode, not protection from a hostile same-user process.

Smallest demonstration: hand the same reviewed pack to two existing agent hosts and evaluate either result with one command. No new fleet scheduler is required.

### 4. A replayable bug package, not another verdict comment

**Expected value: high. Wacky: no.**

Proposed `ggh repro export <observation>` produces a content-addressed local package containing selected test/input bytes, recipe, dependency/toolchain references, revision identities, expected failure, and bounded logs. Another person can replay it without installing the author's agent or trusting the PR description.

Default to references for private source and explicit inspection before embedding or sharing bytes. State when external dependencies are unavailable. A compressed transcript is not a reproduction.

The memorable demo is a stranger reproducing a disputed bug from the exported package, then replaying the same package against the fix. This is stronger than a badge and fits an open protocol contributors can implement.

### 5. Make the patch smaller by trying to remove it

**Expected value: medium-high. Wacky: yes.**

Proposed `ggh shrink 42` searches removable hunks or commits in disposable state while preserving selected acceptance and preservation checks. Show that a smaller candidate still passes the same checks, and list untested behavior. Never call the candidates semantically equivalent just because the tests agree.

The owner chooses whether to keep a result. Ggh does not rewrite the original branch automatically. Equivalent renamed code, generated files, migrations, and coupled changes need constraints. Start with a tiny patch and an explicit removable region, not arbitrary program minimization.

A useful README result would be a large generated fix reduced to a small reviewable candidate with the same named evidence. This directly reduces human reading rather than adding more review opinions.

### 6. A local map of who is changing what

**Expected value: medium-high for this owner. Wacky: no.**

Proposed `ggh work` associates task, branch/worktree, agent session reference, claimed files/packages, and last observed revision. It warns when two active tasks overlap or when cleanup would remove another task's worktree. Agents can claim and release work explicitly; the human sees actual status and uncertainty.

Start from ggh's existing worktree/status information, not a new agent launcher. Claims are advisory coordination, not locks that constrain arbitrary tools. Do not scrape private agent transcripts by default. This could prevent duplicate work and shared-checkout mistakes before PR review exists at all.

### 7. Reenact the project's past failures against every major rewrite

**Expected value: medium. Wacky: moderately.**

Build a local regression collection from owner-confirmed incidents. Each entry records a failing input and its acceptance requirement, including lost recovery state, misleading success, or stale-head acceptance. A new agent or rewrite must face those same cases. When a failure occurs, preserve the smallest counterexample as another candidate case for owner review.

The advance beyond v1's three-line mutation is project memory expressed as executable behavior. Begin with the project's real incidents. Do not collect telemetry or claim a suite that covers past bugs proves future safety.

### 8. Ask the human to choose a behavior before choosing a patch

**Expected value: uncertain, potentially high. Wacky: yes.**

Proposed `ggh decide 42` runs owner-selected examples against base and candidate, then shows observable differences: CLI output, API responses, screenshots, or state transitions. The human can approve or reject the intended behavior and inspect implementation evidence separately. Candidate code and fixtures still require the selected execution trust mode.

For a formatting or API behavior change, reviewing five concrete old/new examples may be more informative than reading another AI summary. For security, concurrency, or migration correctness, those examples remain partial. Start with a deterministic CLI/API adapter and a saved fixture, not automatic browser control across every project.

This is the boldest interface departure. It makes behavior the entry point while preserving access to the code and limits. V1's Desk still assumes the PR list is the natural center of the experience.

## 7. Convergence: lock these now

- Humans and agents remain primary. Maintainers remain a supported secondary case.
- Open-source adoption is the goal. No business pivot is required.
- No telemetry ever, no ggh account, no phone approvals or app. Local process first; no server is justified by the current plan.
- Breaking pre-1.0 commands is allowed. Simplify around completed tasks.
- The owner can use trusted local execution explicitly. A worktree is not a security boundary.
- Deterministic observations before optional AI. AI may propose a test or interpretation; its output does not certify itself.
- Exact revisions, explicit limits, invalidation, and visible inconclusive outcomes are necessary.
- The agent feedback loop is worth building as provider-neutral convenience, with honest remote outcomes.
- Existing publication planning, snapshots, partial-outcome handling, and recovery are assets to reuse.
- Native stacks interoperate with GitHub's queue. A laptop does not replace it.
- Optional hooks stay low priority and retain the limited claim Claude already accepted.
- README focus, real dogfooding, public reproducible examples, and checks on changed supported behavior survive.

## 8. Remaining choices for the owner

Only preferences and authority belong here. Whether compile failure proves a fix, or whether a supplied SHA proves feedback was addressed, are technical questions. Do not send those back to Jonathan as matters of taste.

1. **Native Desk or integration-first human UI?** My recommendation is a compact ggh decision view plus gh-dash bindings first. Build the full Desk when its evidence/delta interactions justify it, or sooner if Jonathan explicitly wants to own that terminal experience.

2. **Which daily bottleneck should lead?** My recommendation is review deltas and integration rehearsal around the existing publication loop. If Jonathan's repeated pain is instead dirty-tree-to-PR publishing, lead with a simplified `ship`. The answer should come from a few actual tasks, not another generic strategy debate.

3. **How much human authorization should `--land` cover?** My recommendation is approval of a named operation against an exact head, with a clear distinction between arming auto-merge, entering a queue, and observing merge. Offer explicit unattended continuation within that scope. A green local observation alone grants no write authority.

4. **What should agents be allowed to resolve?** My recommendation is replies by default, resolution when explicitly authorized, and a supported disputed/needs-decision path. If Jonathan prefers automatic resolution of fixed threads in their repos, make that a deliberate user preference bound to fresh PR/thread state.

5. **Which peripheral workflows does Jonathan want to keep?** My recommendation is to retire team/triage and most gh-shaped families, keep named stash restoration under stash, and either preserve notification actions noninteractively or retire the promise explicitly. Retain release/changelog only if those are tasks they want ggh to own. No compatibility ceremony is required.

6. **How early should foreign-PR execution be supported?** My recommendation is to release the trusted local recipe first, clearly scoped, then add an isolated adapter when outside use or Jonathan's own work requires it. No silent fallback. This does not require a server or an enterprise product.

7. **How wide should the ambition run in parallel?** My recommendation is one daily loop, one bolder experiment, and one integration/review lane at a time. Many agents can implement more, but the owner's ability to assess their combined behavior is the limiting constraint. No deadline does not require one giant release.

## Evidence and limits

Fresh checks: repository source and commit inspection; all four debate inputs read; current primary-source competitor research; installed gh version, `gh secret set --help`, and noninteractive `gh stack --help`; three file-free semantic counterexamples; final artifact and clean-worktree checks.

I did not install gh-stack, enter a secret, execute GitHub mutations, run foreign code, benchmark competitors, rerun the repository suite, or claim that the proposed runner exists. Competitor claims above describe their documentation or inspected source, not independently qualified behavior. Research establishes overlap, not market absence or comparative product quality.

Only `/tmp/ggh-plan/r2-codex.md` was created. Repository source and Git history were left untouched. `$unslop` was explicitly invoked before drafting and applied to this artifact.

<oai-mem-citation>
<citation_entries>
MEMORY.md:911-916|note=[located earlier product contracts and checked current source while treating owner decisions as binding]
</citation_entries>
<rollout_ids>
01a13c1f-4290-78a3-92d5-447ef41c3065
</rollout_ids>
</oai-mem-citation>
