## Findings

### 1. [critical] [Plan A] The verdict claims more than the experiment establishes

**Where**: Evidence verdicts, v1-claude.md:37-38.

**Finding**: Passing on base does not mean tests fail to exercise the change. Failing on base and passing on head does not establish a `proven-fix`.

**Evidence**: A behavior-preserving refactor should pass the same assertions on both revisions while executing the changed code. A performance fix may preserve functional outputs. Conversely, a new test can fail on base because an import is missing, a snapshot path moved, or a helper changed. A failing assertion can also concern the wrong behavior. Plan A excludes setup failures in words but gives no mechanism for identifying the expected behavioral failure. Running only changed tests also misses regressions elsewhere. Plan B explicitly distinguishes fixes, features, and refactors and includes preservation checks. [SWE-bench's harness](https://www.swebench.com/SWE-bench/api/harness/) already separates fail-to-pass and pass-to-pass results.

**Suggestion**: Report observations such as `expected-failure-to-pass`, `passes-on-both`, and `inconclusive`. Require an identified behavioral assertion before claiming a regression was reproduced. Show preservation checks separately. Never turn this into a general correctness badge or a default merge permission.

### 2. [warning] [Both] The test input is a dependency bundle, not a filename category

**Where**: Plan A's fix-revert split; Plan B's `challenge --test-file` interface, r1-codex.md:161-165.

**Finding**: A promises universal automatic extraction. B's proposed single-file import leaves ordinary test dependencies and path resolution unspecified.

**Evidence**: This repository already has tests importing a shared helper and new production exports at `tests/agent-contract.test.ts:3-5`. The helper locates the CLI relative to its own file at `tests/cli-fixture.ts:5`. Copying the test alone breaks it; relocating its helper can test the wrong checkout. More generally, a changed snapshot is test data, `conftest.py` is setup code, Rust unit tests can share a production file, and a new test can need a changed dependency manifest or generated client. Monorepos add package-specific commands and working directories. A test command cannot settle these choices.

**Suggestion**: Start with one supported runner and a previewable bundle manifest containing test identities, paths, fixtures, helpers, setup, and execution directory. Support reviewer overrides. Mixed production/test edits and incompatible base APIs should produce explicit unsupported results. B should preserve repository-relative imports or define a deliberate import mapping.

### 3. [warning] [Plan A] OIDs alone cannot identify or invalidate the evidence

**Where**: Evidence verdicts, v1-claude.md:40.

**Finding**: Base/head/test OIDs omit inputs that can change the result without changing any commit. The plan also leaves the meaning of base ambiguous.

**Evidence**: A changed test command, runtime, installed dependency tree, environment variable, or stale build artifact can reverse the outcome at identical OIDs. Reusing head dependencies on base can introduce a false failure or hide one. Comparing the current target tip instead of the merge-base mixes unrelated changes into the experiment. Plan B specifies these identities and separates contribution testing from a recorded synthetic merge. Existing PR acquisition does not yet supply the required identity: `PR_VIEW_FIELDS` at `src/services/github/prs.ts:160-161` omits base/head OIDs. Existing evidence records contain only path, time, and revision at `src/services/operations.ts:27-31`.

**Suggestion**: Adopt B's input record, including verifier version, actual tree/bundle digests, argv, dependency recipe, runtime, and declared environment inputs. Distinguish historical observations from currently applicable results. Define dependency-changing PRs explicitly rather than silently choosing one revision's environment.

### 4. [critical] [Plan A] Verification is not bound to the eventual merge

**Where**: Desk merge action and `ship --land`.

**Finding**: An agent can push a new head after verification and before merge. Current merge composition would accept that unverified head. A queued merge is also not a completed merge.

**Evidence**: `MergeOptions` at `src/services/github/prs.ts:181-187` has no expected-head field, and `mergePullRequest` at lines 195-206 sends no head precondition. Publication snapshots protect publication inputs, not later merge calls. [GitHub CLI already supports `--match-head-commit`](https://cli.github.com/manual/gh_pr_merge). The same manual explains that a successful command can enable auto-merge or enqueue a PR. Yet `src/commands/pr-lifecycle.ts:179-187` reports merged whenever `--auto` was not explicitly supplied.

**Suggestion**: Pass the reviewed head as an execution-time precondition. Record the tested baseline and defer integration checks to the native queue. Represent queued, waiting, merged, rejected, and uncertain outcomes separately. Clean up only after confirming the merge and checking that the branch/worktree has no newer work.

### 5. [warning] [Plan A] Ship requires a new recovery lifecycle

**Where**: One-command ship, v1-claude.md:49.

**Finding**: Existing publication recovery does not cover the whole proposed dirty-tree-to-merge workflow. Calling this mostly composition understates the difficult work.

**Evidence**: `PublicationStep` at `src/services/publication.ts:50-59` covers repository creation, pushes, PR creation, upstreams, and attachments. It contains no commit, verification, CI wait, queue wait, merge, or worktree cleanup. The saved resumable intent is publication-specific at `src/services/operations.ts:47`. After interruption, a retry must distinguish a completed commit from an uncommitted tree, a timed-out merge from an unmerged PR, and a worktree now used by another agent from one safe to remove. A generic call sequence does not provide those distinctions.

**Suggestion**: Ship the existing commit-to-PR path first. Add `--land` only with a persistent, revision-bound lifecycle and interruption checks at every new effect. Define whether verification failure leaves an open PR and which dirty files enter the commit. Do not infer ownership of all work from the directory being dirty.

### 6. [warning] [Plan A] Address lets the fixing agent certify closure

**Where**: Agent feedback loop, v1-claude.md:44-45.

**Finding**: Supplying a commit SHA is insufficient grounds to resolve a review thread automatically. Reply-plus-resolve also introduces two remote effects with partial failure and retry behavior.

**Evidence**: The commit may be unrelated, absent from the PR head, or superseded. The reviewer may have added an objection after the agent fetched feedback. A lost reply acknowledgement followed by retry can duplicate replies; successful reply followed by failed resolution leaves a partial result. Review text also does not contain a reliably extractable structured `requested change` field. Current review submission at `src/services/github/prs.ts:351-367` does not implement thread fetching, replying, resolving, or reconciliation.

**Suggestion**: Default to a proposed response with its commit and supporting evidence. Make resolution explicit. Validate thread membership, commit reachability, expected head, and the last observed comment before writing. Preserve outdated locations and raw comment text; label any interpretation as interpretation. Track reply and resolution independently so retries can reconcile them.

### 7. [warning] [Plan A] The owner's PRs may not fit GitHub's reviewer model

**Where**: Desk's PRs awaiting you and approve action.

**Finding**: Agents using Jonathan's `gh` identity create Jonathan-authored PRs. That differs from another contributor asking Jonathan for approval.

**Evidence**: [GitHub prohibits authors from approving their own PRs](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/approving-a-pull-request-with-required-reviews). The same restriction can apply to Copilot PRs initiated by the reviewer. A queue based only on review requests would also miss owned agent PRs that need inspection but cannot request a meaningful independent approval from their author. This is a conditional workflow problem; the plans have not established which identities the owner's fleet uses.

**Suggestion**: Probe author/reviewer identity during the first real PR exercise. Include owned PRs awaiting local inspection. Offer a local, head-bound reviewed checkpoint when GitHub approval is unavailable, and distinguish it from a branch-protection approval. Do not require a new bot account just to make the diagram work.

### 8. [warning] [Plan A] Structured review feedback already exists in GitHub MCP

**Where**: Agent-side wedge and MCP delivery, v1-claude.md:43-47.

**Finding**: Reading and closing review threads without scraping is already available. Shipping equivalent wrappers does not establish an adoption reason.

**Evidence**: [GitHub's official MCP server](https://github.com/github/github-mcp-server) documents paginated review-thread reads with current/original locations, replies, and thread resolution through `pull_request_review_write`. Ggh can still provide a better combined workflow, but the differentiator must be evidence binding, recovery, fewer calls, or lower setup cost. Its existing MCP entry points are expressly read-only at `src/commands/mcp.ts:6` and `src/services/mcp.ts:40`, so adding mutations changes an intentional boundary.

**Suggestion**: Deliver and measure a single useful feedback snapshot through the existing agent CLI first. Add MCP mutations only when their previews, authorization, partial outcomes, and retry behavior reuse the same command logic. Describe the workflow advantage rather than claiming exclusive API access.

### 9. [warning] [Plan A] Desk commits to a second product before proving its advantage

**Where**: Desk and sequencing, v1-claude.md:34, 75-82.

**Finding**: A cross-repository TUI with inline review and mutation actions is a large terminal application. Neither verdicts nor agent feedback requires building it before release.

**Evidence**: [gh-dash already offers configurable PR sections, keyboard actions, diffs, comments, checkout, and custom actions](https://github.com/dlvhdr/gh-dash). Ggh's present UI consists of prompts and output helpers, as seen in `src/utils/ui.ts:11-20,50-57`. There is no ready-made Desk in those helpers. Adding GraphQL pagination, selection stability during refresh, async jobs, resizing, cancellation, and mutation recovery creates substantial work. The October 15 keyboard-view prototype was excluded specifically because it did not improve an observed task, at `docs/quality/2026-10-15-prototype-decisions.md:12`.

**Suggestion**: Start with a one-shot PR queue and structured output, plus a gh-dash custom action or GitHub link. Prototype one actual review session. Build a dedicated TUI only if the session exposes a problem those options cannot solve. Move a useful release ahead of Desk, land automation, and wholesale stack replacement.

### 10. [warning] [Plan A] Withholding .env files does not make the trusted run clean

**Where**: Trusted verification mode, v1-claude.md:39.

**Finding**: A trusted local mode is legitimate, but the promised setup does not yet define its ambient credentials, side effects, or reproducibility. Agent authorship is not evidence that a patch has already run safely.

**Evidence**: `run` always inherits and merges `process.env` at `src/utils/exec.ts:143-145`. `worktreeAdd` copies environment files at `src/services/git/worktree.ts:137-150`, initializes recursive submodules at lines 153-163, and changes shared branch metadata at lines 166-172. Merely disabling the copy leaves inherited tokens, user configuration, filesystem access, and shared Git state available. Candidate install scripts and tests execute with those privileges. B correctly separates authenticated fetching, dependency preparation, and measurement; A has not supplied an equivalent preparation recipe.

**Suggestion**: Keep `--trusted` as explicit consent to host execution. Use a dedicated verifier workspace path, separate build/dependency directories, a declared environment policy, and no development-worktree side effects. State that local code has host privileges. Foreign-code mode must constrain dependency preparation as well as the final test process.

### 11. [warning] [Plan A] Three surviving mutations do not establish weak tests

**Where**: Mutation spot-check, v1-claude.md:65.

**Finding**: Arbitrary line mutations can preserve behavior or concern behavior outside the regression test's purpose. Survival alone cannot justify the proposed verdict. The mechanism is also established mutation testing.

**Evidence**: [Stryker supports file and line-range mutation selection, validity checking, test selection, and JSON reporting](https://stryker-mutator.io/docs/stryker-js/configuration/). Its [equivalent-mutant documentation](https://stryker-mutator.io/docs/mutation-testing-elements/equivalent-mutants/) explains why some valid mutations cannot be killed by correct tests. Removing an assertion, producing a type error, timing out, and preserving observable behavior require different interpretations. Three samples do not give a meaningful general test-strength score.

**Suggestion**: Borrow B's explicit known-wrong controls. Report the specific behavior a check failed to distinguish and the control's validity. Reuse an existing mutation engine where practical. The possible advantage is convenient review integration, which still needs a comparison against that engine.

### 12. [warning] [Plan B] The reviewer supplies the hardest missing ingredient

**Where**: Primary install reason, r1-codex.md:154-156; delayed test proposal, line 270.

**Finding**: Requiring the reviewer to write a trustworthy regression test can move the expensive part of agent review onto the person the product is supposed to help.

**Evidence**: Once a reviewer has reproduced the bug, understood its environment, and written the correct assertion, running it on two revisions may be the cheap part. B recognizes this possibility through its script comparison, but its first product depends on that work already being done. Deferring all test proposal until days 46-90 leaves the central assumption untested for too long. Human review of proposed tests remains necessary; generating them does not solve the oracle problem.

**Suggestion**: In the first owner trials, measure test creation separately from execution and interpretation. Support three inputs: existing PR tests, a reviewer-supplied reproducer bundle, and an optional agent-proposed bundle that the reviewer inspects. Keep one deterministic evaluator. If no useful input exists, report that instead of claiming to reduce review effort.

### 13. [warning] [Plan B] External-team milestones override the binding owner brief

**Where**: Primary user, sequencing, and compatibility recommendation, r1-codex.md:154, 269-282.

**Finding**: A maintainer-only pivot, recruitment gates, and mandatory deprecation cycles are not the stated assignment. They can block a useful personal release despite the owner's explicit priorities.

**Evidence**: `decisions.md:3-7` makes terminal humans and agents first-class, permits breaking changes, identifies open-source adoption as the goal, and asks for daily owner use. B instead conditions continuation on retained teams and proposes a multi-month recruitment program. Manual volunteer reports are compatible with no telemetry, so A's claim that cohort research inherently conflicts with that constraint is wrong. They are simply optional here. B's later phrase `no default telemetry` is also weaker than the owner's `NO telemetry, ever`.

**Suggestion**: Use the owner and independent agents for the first completion checks. Invite external users after a useful release without making recruitment a development dependency. Drop compatibility rules the owner waived. Retain B's comparative experiments and input discipline. Remove telemetry and business ambiguity from the roadmap.

### 14. [warning] [Plan A] The validation selects wins without measuring the common case

**Where**: Probes and launch cases, v1-claude.md:70-75.

**Finding**: Ten unspecified PRs, 24 tiny fixtures, and three selected catches cannot establish that automatic verification saves attention across the owner's actual workload.

**Evidence**: A correct refactor, feature, dependency update, or integration fix may legitimately yield no fail-to-pass result. High inconclusive rates and setup repair can cost more attention than the checker saves. Routing every PR through a dogfood requirement also makes usage alone a weak success signal. Stars and downloads measure distribution, not this task. B's matched comparison against ordinary `gh` plus a script tests the relevant alternative without requiring telemetry.

**Suggestion**: Classify an unselected sample of recent owner PRs before implementation. Report applicability, setup time, active reviewer time, false accusations, valid catches, and reasons for inconclusive results. Compare the same evidence through ggh and the current workflow. Keep every excluded case visible. Launch can still use short examples, but product decisions should use the full sample.

## Missed opportunities

1. **Review only what changed since the human last looked. Expected value: high.** Record a local review checkpoint containing host, repository, PR, and exact head. When an agent returns, show the new diff, new thread replies, changed check results, and which prior evidence became stale. Preserve a view of the full PR. Neither plan explicitly saves the reviewer's place across repeated agent revisions. This directly reduces repeated reading, works for self-authored PRs, needs no server, and produces the same useful delta for the next agent. A changed head must remain visibly changed; this checkpoint must not silently transfer GitHub approval.

2. **Detect fleet collisions before another agent rewrites shared state. Expected value: high.** Show which worktrees contain dirty work, which proposed changes overlap, and which operations touch the same refs. Require expected tips for mutations and avoid claiming cleanup authority over another worktree. This fits the owner better than a provider race launcher. The code already has a concrete shared constraint: `src/services/git/stack.ts:55-68,132-142` stores one active recovery checkpoint in the common Git directory. Make that limitation visible before launching conflicting operations. File overlap is a warning, not proof of a conflict.

3. **Show when a PR weakens the tests that would reject it. Expected value: high.** Beside the code diff, identify deleted tests, changed expected values, added skips, narrowed test selection, and altered setup/configuration. Preserve the raw changes and let the reviewer judge intent. A patch can pass its new regression test while deleting an older invariant. Neither plan makes that loss an explicit review object. Start with one test framework and configuration format. This can provide useful evidence before a general differential runner exists, without pretending assertion counting measures quality.

4. **[Wacky] Rehearse a batch of individually green agent PRs together. Expected value: medium.** In disposable snapshots, combine a selected batch and run a small owner-chosen invariant suite. If the batch fails, reduce the failing combination to identify interacting PRs, with a strict run budget. Two PRs can conflict semantically without touching the same lines or failing individually. The output is a local interaction counterexample before submission to GitHub's queue. Native queue rules remain authoritative. Begin with two PRs and one invariant rather than building a laptop merge queue or exhaustive subset search.

## A vs B verdict

**Audience.** A is right to serve the owner as both terminal user and agent operator. B's independent reviewer workflow is a useful capability, but narrowing the whole product to external maintainers contradicts the brief. Preserve the ability to inspect any PR without requiring its author to adopt ggh.

**Automatic fix-revert versus reviewer challenges.** B has the stronger evidence model. A has the better attempt at removing setup work. Use automatic discovery only as a proposal within a supported recipe, then apply B's explicit expected failures, preservation checks, and bounded conclusions. A's universal verdict and zero-configuration claims should be removed.

**Trusted versus isolated execution.** A is right that explicit local host execution can serve the owner's existing workflow. B is right that foreign code needs a constrained runtime, including preparation. B's own boundary section specifically rejects an unsafe fallback for untrusted execution; A's rebuttal overstates this as a prohibition on every trusted mode. Both modes can exist with separate guarantees.

**Subtractions and compatibility.** A wins on freedom to delete before 1.0. B wins on checking what a wrapper actually contributes. Remove duplicated behavior when the native alternative is qualified, without a ceremonial deprecation cycle. Do not put broad deletions and a README advertising unbuilt commands ahead of the first useful new capability.

**Desk and sequencing.** B's smaller first product is the better execution choice. A's full sequence combines a test runner, feedback client, MCP mutation interface, terminal application, publication lifecycle, and stack migration before launch. Release a narrow verifier and feedback snapshot first, using existing review interfaces. Let actual friction earn the next component.

**Validation.** Start with A's owner dogfooding and use B's comparative method. A selected demo does not prove saved attention, and B's recruitment calendar is unnecessary. Record local task evidence and accept voluntary user reports. Neither requires telemetry. Source tests, packaged behavior, foreign-code isolation, and live GitHub outcomes remain separate checks.

**Native stacks.** Both plans are right to interoperate. I independently confirmed the [October 6 GitHub announcement](https://github.blog/changelog/2026-10-06-stacked-pull-requests-generally-available/), including worktree support and stack merge groups. That removes the empty-market claim. It does not establish that every local recovery behavior or Enterprise host has an equivalent. Probe capability and migration behavior before replacing the existing commands.

Review evidence: I read all requested plans and context, inspected the relevant source at `32a3e4b6a1848434e45aa7287bf0ab30d1867ce7`, and checked the cited primary web sources. I did not execute candidate PR code, run a sandbox, qualify competitors hands-on, or call GitHub write APIs. No repository files were changed.
