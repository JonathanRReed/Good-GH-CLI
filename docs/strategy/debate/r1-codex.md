# Good GH: adversarial review and rival plan

Review date: October 22, 2026. Repository inspected at `32a3e4b6a1848434e45aa7287bf0ab30d1867ce7`, version `0.5.0-beta.2`. I read v0 in full and all requested repository documents. Repository references below are relative to `/Users/jonathanreed/Downloads/Good-GH-CLI`.

Reject v0 as the roadmap. Its central promise requires a security boundary ggh does not have. Its other major bets enter markets that already have strong implementations. It postpones the one question that matters: will anyone use this on a real pull request twice?

My alternative starts with the reviewer. Let a maintainer take any PR, challenge its claims with executable checks, and get a reproducible counterexample or a precisely bounded result. The author installs nothing. That changes the adoption problem and gives ggh a useful job before it controls anyone's workflow.

Competitor capabilities below are documented capabilities, not hands-on qualifications. Proposed commands, dates, budgets, and targets are recommendations, not implemented behavior or measured results.

## 1. Kill list

### 1. "The bottleneck is no longer correctness"

**Severity: serious.** The repository has substantial qualification work. That does not establish correctness across the much larger product v0 proposes. `docs/COMPLAINT-COVERAGE.md` explicitly leaves organization/SSO, another account's fork workflow, and working SSH authentication unqualified. It identifies Jonathan as the sole user. The October 14 score is a dated assessment, not a current certification. Stop hardening imaginary workflows, but retain checks for behavior you actually change. "Above every competitor" has no comparative evidence.

### 2. "Most git/gh invocations are typed by agents"

**Severity: serious.** No denominator, population, or source supports this. Counting tool calls would also overweight an agent that retries the same failed command 20 times. Even if the statement were true, it would not establish that developers will install another approval layer. Build the market estimate from teams with a repeated, costly task. The repository's only observed user cannot establish this adoption thesis.

### 3. "Nobody owns the layer" and "gh is a thin API client"

**Severity: fatal to the claimed empty market.** GitHub exposes task creation and session-log following through [`gh agent-task create`](https://cli.github.com/manual/gh_agent-task_create). Cursor's [Graphite announcement](https://cursor.com/blog/graphite) explicitly targets the connection between coding, reviewing, and merging. GitButler already ships a CLI with MCP and agent hooks, documented in its [0.19 announcement](https://blog.gitbutler.com/gitbutler-0-19). These products differ from ggh, but all occupy parts of the supposedly unowned space. Vendor neutrality is a possible advantage. Absence of competitors is fiction.

### 4. B1: "Intercept, don't ask agents to opt in"

**Severity: fatal to the guarantee.** A hook that recognizes `git push` does not mediate a Python HTTP client, libgit2, an SSH process, a script, another MCP server, or a process already running. A process with the same user's credentials can bypass ggh entirely. `docs/THREAT-MODEL.md:90` explicitly excludes hostile same-user processes and replacement of GitHub permissions. A genuine enforcement product must remove write credentials from the agent and put an executor across an isolation boundary. That is a separate architecture, not an installer flag.

### 5. B1: "Nobody else ships this"

**Severity: serious.** Risk gating through hooks is already a platform capability. [Claude Code](https://code.claude.com/docs/en/hooks) provides tool decision hooks. [Cursor](https://cursor.com/docs/hooks) provides shell and MCP hooks. [Factory](https://docs.factory.com/harness/hooks) provides `PreToolUse` decisions. [Devin security profiles](https://docs.devin.ai/product-guides/security-profiles) can restrict Git access and remove the machine's GitHub CLI token. Packaging a good common policy could still help. It is an integration product whose advantage must be demonstrated, not a new enforcement category.

### 6. B1: Seven agents through one local install

**Severity: serious.** Hooks, rules, remote workers, and managed policies have different authority and deployment semantics. Cursor documents that user hooks do not travel to cloud agents in its [hooks documentation](https://cursor.com/docs/hooks). OpenAI's [plugin packaging documentation](https://developers.openai.com/plugins/build/plugins) requires hook scripts in the execution environment and review of non-managed hook definitions. A rule file is guidance, not an intercept. The Devin documentation I checked establishes security profiles, not the proposed universal local hook adapter. Publish a versioned support matrix; begin with one verified integration.

### 7. B1: Repo-controlled allow/approve/deny policy

**Severity: fatal if repo policy can grant authority.** An agent or cloned repository could relax the rule that supposedly restrains it. Current `src/services/config.ts:172` allows project configuration to set only `commit_style`. V0 crosses that boundary without discussing it. User or administrator policy must set the maximum authority. Repository policy may request stricter restrictions, subject to trusted interpretation. It must never enable hosted disclosure, approve publication, or relax a denial.

### 8. B1: Existing snapshots become out-of-band authorization

**Severity: fatal without a new approval design.** `src/services/publication-approval.ts:20` hashes a plan and content. It does not authenticate an approver. `src/commands/pr-create.ts:118` also accepts `--yes`. An agent can compute its own snapshot and supply the flag. That is valid for today's caller-authorized CLI, but insufficient for independent authorization. A broker would need authenticated approval, expiry, replay protection, execution-time revalidation, and authority the agent cannot edit. Do not market a checksum as a permission boundary.

### 9. B1: Phone approval and asynchronous status are small additions

**Severity: serious.** Returning `awaiting_approval` is sensible. Completing the operation afterward introduces durable requests, cancellation, duplicate delivery, approver identity, stale branch tips, executor restarts, and lost acknowledgements. Phone notifications must not expose private diffs or contain reusable authorization. Pick one local approval channel and one supported action first. `src/services/agent-contract.ts:4` does not currently define the proposed broker lifecycle.

### 10. B1: Secret-bearing commits can be safely intercepted

**Severity: serious.** Recognition cannot establish absence of secrets. Encoded values, unknown credential formats, generated artifacts, and deliberate exfiltration escape pattern checks. `docs/THREAT-MODEL.md` already says redaction is not a confidentiality guarantee. Use established push protection and scanners as inputs. Report which scanner examined which tree. A green scanner result cannot justify the broader "every agent is safer" claim without a stated threat model.

### 11. B2: Universal remote undo

**Severity: fatal.** Reopening a PR does not retract notifications. Deleting a public repository does not erase clones. Deleting a comment does not erase email. Reverting a merge does not reverse a deployment, migration, webhook, or payment. Those are compensating actions with their own failures and permissions. Name each supported compensation and its residual effects. "Whatever it was" is a promise you cannot keep.

### 12. B2: Every effect has an inverse in the existing journal

**Severity: serious.** `src/services/operations.ts:22` records step names and states. Its evidence records are paths, times, and revisions. The record does not contain full prior GitHub objects or inverse specifications. `src/services/publication-intent.ts:13` describes resumable publication. A deleted branch also needs a retained reachable Git object, not merely its printed OID. `src/commands/undo.ts:14` currently means soft-resetting the latest commit. Universal compensation requires new state capture, retention, ownership checks, and command semantics.

### 13. B2: "GitHub has no undo button"

**Severity: serious.** [`gh pr revert`](https://cli.github.com/manual/gh_pr_revert) already creates a revert PR. Local recovery also has established competition: [Jujutsu's operation log](https://docs.jj-vcs.dev/latest/operation-log/), [Sapling undo](https://sapling-scm.com/docs/commands/undo/), [Git Town undo](https://www.git-town.com/all-commands), and [lazygit's reflog-based recovery](https://github.com/jesseduffield/lazygit/blob/master/docs/Undoing.md). Sapling explicitly limits undo to local effects. Learn from that honesty. Ggh might win on explaining a partial publication failure, not inventing reversibility.

### 14. B3: A signed receipt proves the agent and tests

**Severity: fatal to the trust claim as written.** Signing an author's statement identifies the signer and binds bytes. It does not prove the claimed model authored the patch, a test ran honestly, or the tests exercised the requirement. GitHub's [attestation documentation](https://docs.github.com/en/actions/concepts/security/artifact-attestations) explicitly distinguishes provenance from security. [in-toto](https://in-toto.io/) already defines supply-chain metadata, and [Cosign](https://docs.sigstore.dev/cosign/verifying/attestation/) already verifies signed predicates. The missing product is trustworthy measurement and useful interpretation. Another signature format will not supply either.

### 15. B3: A "sandboxed worktree" safely replays commands

**Severity: fatal.** Worktrees share Git metadata and execute with the user's permissions. Worse, `src/services/git/worktree.ts:137` copies `.env`, `.env.local`, and `.env.development` into a new worktree. That helper is designed for trusted development. Reusing it to execute a stranger's verification command would import precisely the credentials the verifier should lack. Use an isolated checkout inside a constrained runtime, with no host credential mounts. An extra directory is not isolation.

### 16. B3: Replaying the declared command establishes reproducibility

**Severity: serious.** A command without its dependency graph, toolchain, environment, fixture inputs, network assumptions, and test identities is incomplete. It might run zero tests and exit successfully. A different base or changed external service can change the outcome. Existing `src/services/operations.ts:27` does not hash evidence contents or record an execution environment. Define what was observed and on which inputs before choosing a signature or PR badge.

### 17. B3: Check-runs and git notes give free distribution

**Severity: serious.** Ordinary `gh` authentication does not establish permission to publish arbitrary check-runs. The [Checks API reference](https://docs.github.com/en/rest/checks/runs) requires checks-write authority and contains differing guidance around GitHub Apps and fine-grained tokens. Choose a supported Actions or App path and probe it. Git notes also require an explicit fetch/distribution convention. Neither storage choice establishes that the reviewer will see or trust the receipt. Start with a local result; add one deliberate publishing path after demand exists.

### 18. B4: "No tool ... free multi-model consensus"

**Severity: serious.** [agent-council](https://github.com/yogirk/agent-council) already coordinates CLI-based Claude Code, Codex, and Gemini deliberation. [claude-code-review-council](https://github.com/yeameen/claude-code-review-council) already advertises parallel cross-model code review. Those projects do not establish equivalent quality, but their existence defeats the novelty claim. Subscriptions also have quotas and opportunity costs. The repo already recognizes exhausted quotas in `src/services/ai/index.ts:70`. "No separate API key" is accurate. "Free" is not.

### 19. B4: Agreement is the ranking signal

**Severity: serious.** Three models can repeat the same false positive. A single model can find the only real race. Agreement gives no calibrated probability of correctness. Worse, today's review supplies a title and sanitized diff in `src/commands/pr-review.ts:127`; the Claude adapter disables tools in `src/services/ai/claude.ts:39`. Parallelizing that pathway gives several opinions without execution evidence. Rank findings by reproducible failure, reachable code path, impact, and uncertainty. Keep lone findings when the evidence warrants them.

### 20. B4: Fan out to every installed provider

**Severity: serious.** Installed does not mean authorized to receive this repository. The current provider factory implements Codex, Grok, Claude, and Ollama in `src/services/ai/index.ts:46`, not Devin and Droid. Each new provider adds authentication, output, cancellation, timeout, version, and privacy work. Use one explicitly selected provider with a time budget. Add a second only when it finds enough additional confirmed bugs to justify its cost. [Claude Code Review](https://code.claude.com/docs/en/code-review) already uses multiple agents and verifies findings, so "more reviewers" is weak differentiation too.

### 21. B5: Every read is instant, offline, and cheap

**Severity: serious.** Only previously synchronized data is available offline. Every displayed result needs freshness and coverage. Permission revocation, deleted private objects, account changes, and multiple GitHub hosts complicate retention. GitHub's [REST guidance](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api) exempts correctly authenticated conditional requests only when they return 304. Its [GraphQL limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api) are separate. A daemon does not make synchronization free. Cached data must never authorize a destructive action or prove the current remote tip. "Fastest GitHub UI" needs measurements against a defined task.

### 22. B6: Stacks are the differentiator

**Severity: fatal to the proposed competitive story.** GitHub made native stacked PRs generally available on October 6, 2026, including stack merge groups and a worktree-capable `gh stack` extension. That is in its [GA announcement](https://github.blog/changelog/2026-10-06-stacked-pull-requests-generally-available/). [Aviator](https://www.aviator.co/stacked-prs) offers an open-source stacked-PR CLI and stack-aware merging. [Git Town](https://www.git-town.com/all-commands) already handles local stacked workflows. Keep ggh's useful existing stack commands. Make native interoperability a requirement. Do not make everyone adopt stacks to obtain the new product's value.

### 23. B6: Automatic restacking has jj semantics

**Severity: serious.** Replaying Git branches after amend does not inherit Jujutsu's commit and operation model. The parent may be checked out in another worktree, a descendant may contain someone else's work, and rebasing can conflict. `src/services/git/stack.ts` already has its own recovery machinery. Extend that deliberately. Do not claim a new VCS's semantics because two commands appear similar.

### 24. B6: A laptop is a merge queue

**Severity: serious.** A sleeping laptop cannot coordinate all writers, preserve availability, or define server-side rules. Passing CI on yesterday's branch is insufficient after retargeting and rebasing. A local assistant can sequence submissions and defer to GitHub's authoritative merge requirements. It cannot replace a hosted queue's coordination by polling more patiently. GitHub's [stack GA release](https://github.blog/changelog/2026-10-06-stacked-pull-requests-generally-available/) already places stacks into the native queue as a merge group.

### 25. Subtract to 20 commands before learning anything

**Severity: serious.** Command count is a maintenance metric, not user value. `secret` has purpose-built hidden input and stdin handling, documented in `docs/THREAT-MODEL.md`. Calling every wrapper thin misses behavior worth keeping. Stop promoting peripheral commands. Deprecate only after migration paths exist. Do not spend the next release breaking scripts to satisfy an arbitrary count. `team` and `draft` can disappear from the main pitch without immediate deletion.

### 26. Freeze platform qualification

**Severity: serious.** Freeze expansion of the test matrix, not checks on changed behavior. Hook installation, desktop approvals, subprocess cancellation, and sandbox execution are especially platform-dependent. Current accepted requirements explicitly give macOS, Linux, and Windows the same acceptance bar in `docs/superpowers/specs/2026-10-14-good-gh-quality-design.md:7`. A Linux-only experiment is fine if labeled as such. Quietly weakening the existing supported product is not.

### 27. Rename, gh extension, and dropping gh

**Severity: minor for the name, serious for the other claims.** A new name will not settle product value. A [`gh` extension](https://cli.github.com/manual/gh_extension_install) is a sensible installation channel, but requires extension packaging and compatible release assets. "gh's 40M users" is unsourced here, and installation access does not equal distribution reach. Dropping `gh` would recreate authentication, host behavior, transport, and error handling before a latency profile establishes the need. The accepted design explicitly keeps `gh` in `docs/superpowers/specs/2026-10-14-good-gh-quality-design.md:19`.

### 28. Shadow mode and the incident corpus prove safety

**Severity: serious.** A blocked force-push to an owned feature branch may be appropriate work. Counting it as an averted disaster manufactures demand. Observe effect, ownership, destination, authorization, and outcome; redact command secrets. The October 15 incident prototype covered a foreign index lock, not remote disasters. `docs/quality/2026-10-15-prototype-decisions.md` also shows that synthetic success did not establish task value. A public corpus is useful if it includes bypasses, harmless lookalikes, unsupported cases, and competitors run under equal conditions. Otherwise it is a demo arranged to win.

### 29. The launch and metric validate the plan

**Severity: fatal to the learning sequence.** A force-push block and revert PR demonstrate selected mechanics, not a reason to keep ggh installed. Shipping Gate, phone approvals, and universal undo before external testing delays the cheapest rejection. Stars cannot measure weekly active machines; one person can star once and never install. Three contributors and a vendor link are distribution signals, not repeated use. Pick one completed task, measure repeat use by a consented cohort, and launch after it helps that cohort. The six excluded synthetic prototypes do not justify either abandoning ambition or building eight more unvalidated systems.

## 2. Steelman

Four things survive.

1. Vendor neutrality is worth testing. A team using several coding agents may value one consistent way to inspect their results. The customer must experience that consistency on a real task.
2. Exact target/content snapshots and honest partial outcomes are valuable existing work. `src/services/publication-approval.ts`, `publication.ts`, and `publication-recovery.ts` give the next product a better starting point than a generic command wrapper.
3. The review burden is a plausible place to compete. V0 correctly notices that an agent saying "tests pass" leaves the reviewer with work. It then spends too much of the roadmap on everything surrounding that problem.
4. Cut roadmap scope and publish reproducible examples. Keep those examples representative enough to lose. A comparison that cannot expose a ggh failure is marketing, not evidence.

I would retain B3's concern, a sharply limited recovery feature, and installation through existing agent ecosystems. I would remove B1 as the initial promise, B4 as a differentiator, B5 entirely, and B6 as the product thesis.

## 3. Rival plan

### Thesis

Make ggh the tool a maintainer uses to challenge a proposed change before accepting it. It should produce an executable counterexample, or a bounded observation of the intended behavior on exact revisions. Every assertion stays tied to the test and environment that support it.

The long-term ambition is to make executable acceptance requirements portable across agents. A maintainer defines the behavior; any agent may propose an implementation; an independent runner measures it. Code generation becomes replaceable. The acceptance history remains useful when the team switches providers.

This explicitly converges with B3 on revisions and evidence. It differs in customer, adoption, execution, and sequence. The reviewer can use an existing PR whose author never touched ggh. Independent challenges come first. Signed author receipts come much later, if anyone needs them.

I am not claiming differential testing is new. [SWE-bench](https://www.swebench.com/SWE-bench/api/harness/) already distinguishes tests that must change from failing to passing and tests that must keep passing. Nor is AI verification empty territory: [Claude Code Review](https://code.claude.com/docs/en/code-review) verifies findings, and [Devin](https://docs.devin.ai/work-with-devin/testing-and-recordings) offers testing with recordings. Ggh must win on a specific, portable reviewer workflow and lower setup cost. If a script does it just as well, ship the script.

### Primary user and this week's install reason

Start with maintainers of TypeScript/Bun or Node projects who review at least 10 PRs a week, including agent-authored work, and already have repeatable tests. Recruit five small teams. Avoid the first month disappearing into arbitrary monorepo setup or production-service credentials.

The install reason is one troublesome bug-fix PR. The maintainer supplies a regression test. Ggh runs that same test against the old and proposed behavior, rejects empty or broken verification, and preserves a reproduction someone else can inspect. Existing CI alone can pass even when the supposed regression test never exercised the bug.

Proposed interface, not a current command:

```bash
ggh challenge 42 --test-file ./review/bug-184.test.ts -- bun test /review/bug-184.test.ts
ggh challenge view <run-id> --agent
```

`--test-file` imports a reviewer-selected file into an isolated runtime. The argv after `--` runs there. No shell interpretation is implied. The local path and test contents are explicitly supplied, not discovered from private files. The command never posts, pushes, or approves a PR.

For a bug-fix claim, useful output looks like this:

```text
PR #42, base 8f4c1a2, head 91be7d3
bug-184: base failed the expected assertion; head passed
preservation checks: 28 passed on both revisions
execution: pinned Linux image; network disabled; no host credentials
limitations: production service behavior untested
```

Those OIDs and counts are illustrative. Missing imports, failed setup, zero discovered tests, skipped required tests, timeout, or incompatible harnesses produce `inconclusive`. They never become proof that the bug existed or was fixed.

### Ranked bets

#### 1. Reviewer-controlled differential execution

Deliver a deterministic runner before any AI feature. Pin base, head, test bytes, argv, toolchain image digest, dependency inputs, limits, and expected result. Run the same reviewer-controlled checks in fresh environments. Use test-level results as well as process exit status. Repeat discrepant results to expose obvious flakes.

Default to the recorded merge-base versus PR head to isolate the contribution. Label this comparison explicitly. Testing integration with today's target branch is a separate run against a recorded synthetic merge result. A conflict makes that run inconclusive. Passing the contribution check must never imply that the current target branch accepts the patch.

For a fix, require the expected behavioral failure on base and success on head. For a refactor, require selected behavior to remain stable. For a new feature absent on base, report that absence explicitly; do not treat a compilation failure as the expected red test. Let the maintainer choose a meaningful acceptance strategy.

Reuse `src/services/github/prs.ts` for acquisition and existing structured-output conventions for reporting. Add a focused `src/services/challenge/` module. Do not turn publication into a universal transaction framework.

#### 2. Test whether the evidence can detect a wrong implementation

After the deterministic workflow earns use, add bounded negative controls. Remove the intended fix, inject one applicable known-wrong behavior, or disable the asserted side effect. If the challenge still passes, report that the check does not distinguish that fault.

Expose each control and its result. An invalid mutation proves nothing. Run only controls whose applicability can be checked, and cap the initial budget at five controls or two minutes per run. One failed negative control is more useful than four models saying the test looks good.

#### 3. Turn a suspected bug into a reusable counterexample

Offer one opt-in provider to propose a reproducer from the issue, relevant code, and reviewer guidance. Give it at most five minutes. Review its test before execution; preserve the test bytes for both revisions. Minimize a successful failing input when practical.

The provider proposes tests. It cannot certify its own claim. An unreproduced suspicion remains a suspicion, and some design or concurrency issues will still require human reasoning. Exporting a regression test into the contributor's branch is a separate approved action.

Today's safe, tool-disabled AI adapters can propose text. They are not a ready-made autonomous test engineer. Keep that distinction in implementation estimates.

#### 4. A challenge that survives an agent change and expires when inputs change

Record the exact acceptance inputs and outcomes. Invalidate the result when the relevant head, base, test, configuration, or environment changes. Another agent can consume the same challenge through CLI JSON or a later read-only MCP tool.

Extend `src/services/operations.ts` with a separately versioned observation type rather than pretending an evidence-file path is verified content. Keep source, raw logs, and generated tests out of generic metadata by default. Explicit evidence retention and export must show what bytes will be kept or shared.

Start unsigned. Add trusted CI-produced in-toto attestations only when teams want results enforced remotely. Label locally observed, author-reported, and trusted-runner results distinctly. Unknown model identity stays unknown.

#### 5. Connect acceptance to existing safe publication

Once teams repeatedly use challenges, bind an exact publication plan to its acceptance result. Reuse `src/services/publication-approval.ts` and revalidation. Changing the patch after testing invalidates the binding. Human authorization and GitHub branch rules still decide whether publication or merge may happen.

This converges with v0's exact approvals, but adds them after a useful independent workflow. Do not make the first customer install global hooks, change credential storage, or replace their stack manager.

### Execution boundary

This is the hardest part of my plan. It cannot be hand-waved away.

Fetch with the host's authenticated client, then export exact source snapshots into disposable storage. Execute inside a supported constrained runtime. Do not mount the source checkout, home directory, SSH agent, credential helpers, Docker socket, or `.env` files. Apply resource and process limits. Disable network during measurement. Dependency preparation runs separately under explicit rules, with pinned inputs and its own recorded limits.

A container is a chosen trust boundary, not a claim of immunity to a malicious kernel exploit. Initially support a pinned Linux runtime with documented Docker-compatible prerequisites. The existing CLI remains supported on its current platforms. If a machine cannot supply the required runner, report that before executing code. A plain worktree fallback would silently erase the product's trust claim.

Keep the comparison harness outside candidate-controlled configuration. Run the same harness against both exported revisions. Even then, malicious code can behave differently under tests. Human-selected behavioral checks support bounded confidence; they do not prove arbitrary program correctness.

### Subtractions

- Freeze new inbox, daemon, council, phone-push, stack-queue, and remote-compensation projects.
- Keep `gh` as transport and keep existing native escapes.
- Reduce the main README to installation, one existing commit-to-PR journey, and the new challenge journey after it exists. Move the command catalog to reference documentation.
- Stop advertising `team`, `draft`, broad AI convenience, and wrapper count as reasons to adopt. Preserve compatibility until a justified deprecation.
- Keep existing platform checks. Qualify the new runner only where its stated boundary is implemented.
- No default background processes, telemetry, hosted account, or automatic PR comments.

### Wacky and extreme ideas, ranked by expected value

These ranks are judgments about payoff versus effort, not measured probabilities.

1. **High: make a bug claim executable before asking for a code fix.** Let maintainers accept test-only contributions as the first step. An issue starts with an observed failing behavior, then any agent competes to fix it. Begin with 10 real issues. This could change what maintainers ask contributors to submit.
2. **High: try to defeat every accepted test.** A small scheduled set of valid wrong implementations challenges the acceptance suite. If they pass, the report says the test is weak. This borrows mutation testing deliberately. The product opportunity is putting the result into the review decision with almost no extra work.
3. **Medium-high: turn the project's past bugs into its entrance exam.** Convert 20 historical regressions into reusable challenges, then run a proposed refactor or new agent against them. Keep a held-out subset during evaluation so tuning to the visible examples does not masquerade as improvement. Every confirmed new bug can improve the exam.
4. **Medium: a maintainer-owned challenge service with hidden inputs.** A runner evaluates an untrusted candidate against owner-controlled checks the coding agent cannot rewrite. Publish enough detail for disputed results to be reproduced; distinguish confidential fixtures. This is worth trying for private teams only after local adoption. It adds operational and trust costs.
5. **Medium: audition implementations, not model personalities.** Give two existing agents the same bounded task and acceptance requirements. Compare observed behavior, patch size, runtime cost, and untested scope. Reject both when neither meets the requirement. Start as a manual experiment; ggh should not become another fleet orchestrator.
6. **Low near-term, high possible ceiling: take write credentials away from coding agents entirely.** An isolated agent emits a proposed Git/GitHub effect. A separate principal executes approved plans. This explicitly converges with B1's goal while replacing hooks with an actual authority boundary. It requires credential separation, a tiny non-shell executor, authenticated approvals, and platform-specific work. Pursue it only if retained customers want enforcement enough to accept that setup.

Do not launch a financial warranty for agent code or promise "unhackable" acceptance. Ggh cannot measure the whole loss, prove every behavior, or recover a disclosed secret.

### Distribution and launch

Recruit five maintainers with a recent disputed or misleadingly green PR. With permission, reproduce it through ggh and through their current `gh` plus test-script workflow. The first acquisition channel is a useful regression test that the maintainer can keep.

Launch with three short, reproducible cases: a green PR that does not fix its reported bug, a passing test that survives removal of the fix, and a correct patch that passes a meaningful challenge. Show setup time, limits, and at least one inconclusive result. Nobody needs another edited force-push scare video.

Ship verified standalone assets first. Publish an actual npm package before recommending an npm install command. Consider `gh extension install JonathanRReed/gh-challenge` only after that extension and its release assets exist. That repository name is a proposal, not a current resource. Add a small skill that tells agents how to run and interpret the challenge. Keep it optional.

Longer term, the portable challenge schema should let other reviewers and CI systems produce compatible results. Give the protocol away. If there is a business, charge for managed isolated execution and organization retention, not access to a local JSON file.

### Success metric and sequencing

The main metric is weekly retained teams completing meaningful challenges, accompanied by saved reviewer time. A meaningful challenge reaches an interpretable behavioral result or confirmed counterexample on a real PR. Installation, stars, zero-test success, and fixture demos do not count.

Use voluntary local summaries from the recruited cohort. Do not add an anonymous ping while calling the product telemetry-free.

- **Days 1-7:** Run five real cases with existing commands and a disposable prototype. Build no general broker. Stop if maintainers would not repeat the task or an ordinary script is equally convenient.
- **Days 8-21:** Implement deterministic execution for one supported project/runtime recipe and exact result identities. Require the isolation probe below before asking users to execute foreign code.
- **Days 22-45:** Ten enrolled maintainers or teams, each trying at least three real PRs. Continue only if six use it in two consecutive weeks and report a useful result without author coaching.
- **Days 46-90:** Add negative controls and one optional test-proposal provider if earlier use supports them. Target a 30% reduction in median active reviewer time on matched tasks, with no increase in observed mistaken acceptances. Publish sample sizes and exclusions.
- **Months 4-6:** Target 50 retained teams and 500 meaningful challenges a week. Add CI publishing and trusted receipts only if requested. Consider the credential-separated executor only after five teams commit to piloting its operational burden.

These are decision thresholds, not forecasts. Zero observed harmful outcomes in a pilot is a report about that sample, not proof of safety. If deterministic challenges do not earn repeat use, retain the useful recovery CLI and kill this pivot too.

## 4. Decisions only the owner can make

1. **What kind of product does Jonathan want to own?** A convenient personal CLI, an independent verification product, and enterprise enforcement have different obligations. My recommendation is independent verification with the existing CLI as its entry point. Usage experiments can test demand; they cannot choose the owner's ambition.
2. **How much adoption friction is acceptable for a real execution boundary?** My recommendation is to require a supported isolated runner for untrusted execution, even if that costs installs. Never disguise ordinary worktree execution as equivalent.
3. **Who controls permission to publish?** My recommendation is the human or a deliberately authorized external principal. Ggh may report acceptance evidence, but it should not infer permission to merge from a passing test or model vote.
4. **What is the privacy promise?** My recommendation is metadata-only defaults, explicit content retention/export, no default telemetry, and no public transparency-log submission for private work. This is a commitment about handling user data, not an A/B test.
5. **How should open source and revenue fit together?** My recommendation is an MIT local CLI and open challenge format. Sell optional execution infrastructure if a business is wanted. Do not create a hosted dependency merely to create a billing point.
6. **How much compatibility debt should the project tolerate?** My recommendation is to preserve existing supported commands through a documented deprecation cycle and keep platform parity for them. An experimental runner can have a narrower stated support matrix. Do not silently redefine the current contract.
7. **Should the project rename now?** My recommendation is no. Keep `ggh` until repeated use tells you what users call the thing they value. The owner may dislike the name enough to change it anyway; that is a preference, not a technical discovery.

## 5. Cheap experiments

These are proposed probes. None was executed during this read-only review. Any remote writes require separate authorization and disposable targets.

### A. Can Agent Gate actually mediate an effect?

Build one Claude Code hook adapter in an isolated disposable environment. Try 30 authorized test cases, including direct Git, `git -C`, aliases, shell scripts, Python/libgit2, GitHub HTTP, MCP writes, hook failure, and detached child execution. Include 100 harmless commands.

Pass for a narrowly labeled convenience integration: all supported direct forms are handled correctly, less than 1% harmless blocking, and every unsupported route is disclosed. Pass for a universal enforcement claim: no allowed execution path can write outside the broker. Any bypass kills that claim. Do not respond by adding another regex.

### B. Can independent approval survive races and replay?

Use a local fake effect executor. Approve a plan, then independently change the head, target, visibility, attachment, and policy. Retry approvals, restart the executor, deliver the notification twice, and cancel before execution. Run at least 40 transitions.

Pass only if every material change invalidates authority, each authorized effect executes at most once within the supported model, and uncertain outcomes require inspection. A snapshot supplied by the agent must not count as an independent approver. Failure blocks phone approvals and broker marketing.

### C. Do reviewers want challenges more than another review opinion?

For five maintainers, use 20 real historical PRs with permission, including correct fixes, ineffective fixes, and regressions. Compare current CI plus reviewer practice, a single-provider review, and the deterministic challenge prototype. Counterbalance the order and use different matched tasks to limit learning effects.

Pass if at least three maintainers request use on a new live PR, median active review time drops at least 30%, and useful counterexamples are independently accepted as valid. Record setup separately. Wrong high-confidence acceptance on a seeded failure blocks expansion until explained. This small probe screens usefulness; it does not estimate a rare failure rate.

### D. Does ggh beat a small gh script?

Implement the baseline with `gh pr view`, pinned source snapshots, and the same isolated test runner. Give both interfaces to the same cohort on matched tasks.

Pass if ggh cuts median setup or interpretation time by at least half, or prevents a concrete mistake the script repeatedly permits. If the only difference is colored output and a JSON wrapper, publish the script and drop the product claim.

### E. Is the runner separated from host secrets?

Use 12 synthetic hostile cases that try to read host canaries, contact an external sink, access an SSH agent or Docker socket, rewrite host Git metadata, mutate the independent harness, exhaust resources, and survive cancellation. Include a `.env` canary to catch accidental reuse of `worktreeAdd`.

Pass only if every forbidden action is denied in the supported runtime and the external supervisor observes cleanup. Verify independently of candidate-produced logs. A same-user writable control file is a failure. This is a minimum launch gate for the selected boundary, not a complete sandbox audit.

### F. Can the checker recognize empty and misleading success?

Make 24 tiny fixtures covering zero tests, skipped tests, ignored exit codes, syntax failure on base, missing dependencies, a correct fail-to-pass result, a pre-existing failure, changed test configuration, a stale head, and a passing test that imports no implementation. Repeat flaky cases three times.

Pass only if all valid outcomes are classified correctly and every unsupported case is inconclusive. At least 90% of applicable deliberately wrong implementations must be rejected by the chosen challenge set. Report the denominator and inspect every miss. Unsupported negative controls cannot inflate that number.

### G. Does a second model improve confirmed findings?

Take 30 already-adjudicated bugs and 30 clean changes. Compare one provider with full relevant context against two providers using the same total time budget. Keep reviewers blind to which system produced each finding. Validate unique claims by execution or direct code tracing.

Pass only if the second provider adds at least 20% more confirmed important findings without reducing precision below 80% or doubling reviewer triage time. Otherwise keep one provider. Consensus alone gets no credit.

### H. Is compensation valuable enough to build?

Interview five maintainers about their last three recovery incidents. Reproduce the top two effect types with local fixtures first; use authorized disposable GitHub resources only if needed. Compare `ggh operation recover` plus explicit commands against a proposed `ggh operation compensate <id> --dry-run`.

Pass if the planned compensation cuts recovery steps by half, refuses intervening foreign changes, preserves confirmed resources, and names irreversible residual effects. A merge-revert wrapper that merely saves typing over `gh pr revert` does not justify a universal undo project.

### I. Does proof need signatures or a GitHub App?

Show five teams the same result as local JSON, an explicitly shared Markdown report, and a trusted CI-produced attestation. Ask what actual acceptance decision each format permits. Probe check-run publication with the intended credential type in an authorized disposable repository, including forks.

Pass for cryptographic investment only if at least three teams require a named runner identity or enforceable policy that ordinary local output cannot provide. Pass for an App only if its permission and setup cost earns repeat use. Do not build cryptography to make an untrusted test result look official.

Verification of this review: source and documentation inspection plus current primary-source web research. I did not rerun the product test suite, execute agent hooks, run a sandbox probe, or qualify competitors. The repository was clean at entry. Only `/tmp/ggh-plan/r1-codex.md` was created for this task; no repository files or GitHub resources were changed.

<oai-mem-citation>
<citation_entries>
MEMORY.md:911-919|note=[located prior product constraints and rechecked them in the current approved design]
</citation_entries>
<rollout_ids>
01a13c1f-4290-78a3-92d5-447ef41c3065
</rollout_ids>
</oai-mem-citation>
