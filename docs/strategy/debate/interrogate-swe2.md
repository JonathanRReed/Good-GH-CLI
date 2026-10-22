# Interrogation: ggh v1 plans (SWE-2 reviewer)

Read in full: v1-claude.md (A), r1-codex.md (B), v0, decisions.md, README, THREAT-MODEL, both quality docs. Verified code claims against `32a3e4b` and ran read-only `gh` probes on this machine (gh 2.100.0, gh-copilot ext only).

## Findings

### 1. [critical] [Plan A] `proven-fix` cannot distinguish "test failed" from "test could not run"
**Where**: Bet 2, fix-revert check.
**Finding**: The check treats a nonzero exit on (base + PR tests) as evidence the test exercises the fix. But the dominant failure mode on the base tree is that the test can't run at all: it imports a symbol the fix adds (every feature PR), it needs a helper/fixture the classifier filed as "non-test" (`conftest.py`, `testutils/`, `__fixtures__/`), or it needs a dev-dependency the PR added in `package.json`/lockfile (non-test file, so absent on base). In all of these the harness exits nonzero → recorded "fails on base" → head passes → verdict `proven-fix`, when the correct answer is `inconclusive`. The mechanism also can't detect a *wrong* fix: fail→pass proves the tests are coupled to the diff, not that they reproduce the reported bug or that the fix is correct. The name `proven-fix` overstates what was measured.
**Evidence**: Mechanism trace. `bun test`/`vitest`/`jest` exit nonzero on module-load failure identical to assertion failure unless you parse test-level results — Plan B explicitly requires "test-level results as well as process exit status" and "missing imports, failed setup, zero discovered tests … produce `inconclusive`" (r1 lines 177, 183, 187). A has no slot in its verdict vocabulary for "couldn't run." Additionally, "bound to exact base/head" should mean recorded merge-base vs head, with a separate synthetic-merge run for integration; B states this precisely, A does not.
**Suggestion**: Per-runner result parsing; classify each base run as {assertion-failed, could-not-execute, passed}; only assertion-failed supports the positive verdict; rename the verdict to something honest (`fix-required-for-tests` / `tests-coupled-to-diff`). Report feature-PR absence explicitly (adopt B's rule). Bind merge-base + head + test-set OIDs; report which tests ran, not just that a command exited.

### 2. [critical] [Plan A] Trusted mode + Desk auto-verdicts = executing strangers' code as a feature
**Where**: Bet 2 trust modes; Bet 1 Desk ("ranked by … evidence verdict").
**Finding**: "Trusted" mode runs the PR's own test code in a worktree on the host with the user's full ambient authority — `gh auth token`, SSH agent, cloud creds. `--with-env` gating `.env` files is cosmetic against code that can `subprocess gh auth token`. Worse, Desk ranks "every PR awaiting you" by verdict — the moment an external/drive-by PR lands in the queue, auto-running verify in trusted mode is RCE-by-design. The plan never says whether Desk verdicts are auto-run or explicit, and never says what the default mode is. Launch is sequenced (step 7) *before* isolated mode (step 8): the product goes public able to safely check only PRs the user already trusts.
**Evidence**: `src/services/git/worktree.ts:137-151` copies `.env`/`.env.local`/`.env.development` into new worktrees (verified — A's own concession flags it). THREAT-MODEL.md:92-97 excludes same-user hostile code from scope; running PR test code on host imports exactly that threat.
**Suggestion**: Mode should default from the *author's* trust relationship (own repos/agent-authored allowlist), not a flag. Desk must auto-run verdicts only inside the trusted set; foreign PRs get explicit per-run confirmation or isolated mode. Either ship `--isolated` (or CI execution, see missed opp #2) before public launch, or make verify refuse non-allowlisted authors. Also rename "local isolated worktree" — a worktree is not isolation (B #15 is right).

### 3. [warning] [Plan A] "Zero configuration for any repo with a test command" is unsound
**Where**: Bet 2.
**Finding**: Running *the PR's new/changed tests* requires per-ecosystem machinery the plan pretends away: enumerating tests from a diff (file-level works for jest/vitest files; pytest needs `file::id`; `go test -run` needs name extraction that breaks on `s.Run`/table tests; Rust `#[cfg(test)]` tests live *inside* source files and can't be split at file granularity at all), choosing install/test commands per repo (monorepo package roots, `npm test` vs `vitest run` vs `pytest` vs `cargo test`), classifying non-obvious test inputs (snapshots, test config, fixtures, `conftest.py`, lockfiles). A file-level split also mis-handles *modified* test files: `git checkout head -- testfile` brings assertions updated to match new behavior, which fail on base for the right reason only if the whole updated file still applies.
**Evidence**: SWE-bench, which this technique descends from, requires a per-repo environment spec; the rubric's own edge-case list (shared helpers, snapshot tests, monorepos, non-JS) is exactly where the heuristic dies. Two full env constructions (install + test on base-tree and head-tree) also make the "cheap deterministic evidence" minutes-scale with no caching story mentioned.
**Suggestion**: Supported-recipe model — ship TS/Bun+vitest/bun-test first, then pytest/go; mark everything else `inconclusive`. Add explicit overrides as a first-class escape hatch — `ggh verify 42 --test path -- <argv>` — i.e., absorb B's `--test-file`/argv interface into A's auto-detect default. Change the claim to "zero-config for supported repos." Cache installs across runs.

### 4. [warning] [Plan A] Desk is ranked #1 but is the most commoditized and most expensive bet — and the plan admits it
**Where**: Bet 1.
**Finding**: "The differentiator is verdicts + the agent feedback loop, not the list." Then the list shouldn't be the #1-ranked bet. The commodity parts already exist: `gh pr status` natively lists relevant PRs with CI/review state (verified on this machine); `gh search prs --review-requested=@me` covers cross-repo acquisition; gh-dash ships PR views, built-in checkout/diff/watchChecks/comment, and custom keybindings that shell out per-PR (`gh pr merge {{.PrNumber}}`, gh-dash.dev/configuration/keybindings). A keyboard-driven TUI queue is the largest single new surface in the plan and a notorious maintenance tar pit for a solo project — the thing most likely to ship half-finished, which the plan's own rubric calls worse than missing.
**Evidence**: gh-dash docs (custom `prs:` keybindings run arbitrary commands with `{{.PrNumber}}`, `{{.RepoName}}`, `{{.RepoPath}}`); local `gh pr status --help`.
**Suggestion**: Build `ggh desk` as a non-interactive ranked report first — JSON + pretty output, agent-consumable via `--agent`, verdict column included. Ship a gh-dash config/keybinding pack that wires `ggh verify`, checkout-to-worktree, and merge into gh-dash's existing TUI. Full TUI only if two weeks of dogfooding show the ranked report isn't enough.

### 5. [warning] [Plan A] The agent feedback loop is partially commoditized by the official GitHub MCP server
**Where**: Bet 3.
**Finding**: "Any agent can close the review loop without scraping" was true a year ago. github-mcp-server merged `resolve_thread`/`unresolve_thread` into `pull_request_review_write` (PR #1919, 2026-03-13), returns review-thread node IDs in `get_review_comments` (PR #2515, 2026-05-21), and has `add_pull_request_review_comment` for replies. An agent with the GitHub MCP server can already list review threads and resolve them. What remains genuinely uncovered: the *unresolved-only filtered view* shaped for fixing, the thread→fixing-commit binding (`--commit <sha>`), and verify verdicts in the envelope — those are worth building, but they're workflow sugar on existing APIs, not an unowned layer.
**Evidence**: github/github-mcp-server PRs #1919, #2515, issue #2437 (deepwiki tool list confirms `resolve_review_thread`, `add_comment_to_pending_review`). Also verified locally: `gh pr view --json` has no `reviewThreads` field, so the *gh-only* path still requires raw GraphQL — ggh's real wedge is serving CLI-only agents plus the verdict integration, not novelty.
**Suggestion**: Keep `pr feedback`/`pr address` (cheap, completes the owner's loop) but reposition honestly. Note that the skill/adapter layer (teaching agents the envelope) carries most of the value.

### 6. [warning] [Plan B] The validation apparatus is a startup research program bolted onto a solo, no-telemetry project
**Where**: "Primary user," success metric, days 1–90 sequencing, decision list.
**Finding**: Recruit five teams, enroll ten maintainers, gate the feature on six retained users, target 50 teams/500 challenges a week, measure 30% median review-time reduction with matched tasks. This contradicts every binding constraint: sole user is the owner (decisions Q2/Q5), no telemetry ever (Q3), no deadline, agents implement. "Voluntary local summaries" is still a human-instrumentation program requiring participants who don't exist. The plan's own admission — "The repository's only observed user cannot establish this adoption thesis" — applies to its own remedy: the owner cannot run this program.
**Evidence**: decisions.md Q1/Q3/Q5; r1 lines 154, 261-273.
**Suggestion**: Keep B's *discipline* — explicit stop conditions, fixture suite F (24 repos — A already stole it), script-baseline experiment D, hostile-case probe E — recast as dogfood gates on the owner's own repos and PRs. A's "kill a bet if the owner stops using it" + B's "if a script does it just as well, ship the script" is the right combined validation.

### 7. [warning] [Plan B] Reviewer-supplied tests as the only interface misses the dominant case
**Where**: `ggh challenge 42 --test-file … -- argv`.
**Finding**: B requires the reviewer to author a regression test per PR. The owner's actual fleet produces PRs that *already contain* tests whose honesty is the open question. Auto-detecting the PR's own tests (A) covers the high-frequency case; B's explicit interface is the right escape hatch for "the agent wrote no test" or "I don't trust its test," not the whole product. B also quietly assumes the same per-repo recipe problem exists — reviewer argv still needs dependency preparation inside the runtime (B at least says this explicitly).
**Evidence**: B's own install reason is "one troublesome bug-fix PR" — a narrow trigger. A's probe (fix-revert on 10 real agent PRs) will quickly measure which interface the owner's fleet actually needs.
**Suggestion**: Merge: `ggh verify <pr>` auto-detects; `--test`/`--` overrides take B's explicit form. Reviewer-written tests become an *option*, preserving B's stronger guarantee where it's wanted.

### 8. [warning] [Plan A] Subtraction list misclassifies features as proxies and creates a gap
**Where**: Subtractions.
**Finding**: `changelog` writes CHANGELOG.md from local history — `gh` has no equivalent (not a proxy). `triage` is AI notification grouping — no `gh` equivalent. `notifications` has no native `gh` command (gh has no notifications subcommand; ggh's wraps `gh api`), and its stated replacement (Desk) doesn't exist until step 4 while deletion lands in step 1 — a functionality gap of weeks even for the sole user. `secret`'s hidden-input worry is resolvable now: `gh secret set` already prompts with masked input and accepts stdin, so deletion is safe.
**Evidence**: README lines 201-205; `gh secret set --help` behavior (masked paste prompt is standard gh).
**Suggestion**: Split the list: true proxies (label, secret, variable, gist, workflow, search, browse, release browse/download/upload/delete, team) → delete now; features subsumed by Desk (notifications, triage) → delete *with* Desk; changelog → keep or explicitly kill as out-of-scope, not miscounted as a proxy.

### 9. [warning] [Both] Neither plan answers "why isn't this a GitHub Action?"
**Where**: A bet 2 / B execution boundary.
**Finding**: The fix-revert check is a per-PR differential test run — precisely what a CI job can do, and CI runners *are* the isolated runtime B insists on. A reusable composite Action would: (a) solve the trust boundary for strangers' PRs without shipping a container runner, (b) reach users who will never install ggh, (c) produce the "trusted runner" results B wants to attest later, (d) turn the verdict into a check on the PR where reviewers already look. The local CLI remains right for the owner's instant loop, but as an OSS distribution and isolation story, the Action beats the container bet.
**Evidence**: B's runner requires Docker-compatible prerequisites most laptops won't satisfy; GitHub-hosted runners provide the pinned-image, network-controlled, credential-free environment for free. SWE-bench-style fail-to-pass in CI is proven pattern.
**Suggestion**: Design `ggh verify` so its core (tree construction + recipe + verdict) is callable identically locally and in a composite `ggh-verify-action`. That also reorders sequencing: the Action *is* isolated mode, shipping before launch instead of after.

### 10. [warning] [Plan A] Mutation spot-check is a broken mechanism as specified; adopt B's negative controls instead
**Where**: A wacky #4 vs B bet 2.
**Finding**: "Auto-mutate 3 lines touched by the fix" — mutating arbitrary lines produces mostly uncompilable or semantically inert mutants; a mutant that fails to build proves nothing, a mutant in dead config proves nothing. Real mutation testing is per-language operator sets with applicability guarantees (Stryker for TS, mutmut, PIT). B's version — inject one *applicable* known-wrong behavior, cap at 5 controls / 2 minutes, expose each control's applicability check — is the sounder mechanism at the same budget.
**Evidence**: Mutation-testing literature and tool design; B r1 lines 191-195.
**Suggestion**: For TS/Bun repos, shell out to Stryker scoped to changed lines rather than writing a mutator; frame output as "tests did not detect K of N applicable faults," never a score.

### 11. [nit] [Plan A] Snapshot tests self-certify; verdicts should flag them
**Where**: Bet 2 edge case.
**Finding**: A PR updating `__snapshots__/*.snap` fails on base by construction (old code ≠ new snapshot) → trivially "bites" → `proven-fix` on a change class that carries almost no evidence about correctness.
**Suggestion**: Classify snapshot files separately; emit "self-certifying change" rather than the positive verdict.

### 12. [nit] [Plan A] Posting the verdict as a PR comment undersells it
**Where**: Bet 2, "Optional: post verdict as a PR comment."
**Finding**: Comments are un-gated noise agents must parse. A commit status (`gh api repos/{o}/{r}/statuses/{sha} -f context=ggh/verify`) appears in the checks UI and merge box, can be required via branch protection, works with ordinary `gh` auth (no Checks-API/GitHub-App gymnastics B worried about in #17), and is itself agent-readable.
**Suggestion**: Status-first publishing; comment only for detail/expiry notes.

### 13. [nit] [Plan A] Desk before `ship` in sequencing is backwards for daily use
**Where**: Sequencing 4 vs 5.
**Finding**: `ggh c --pr` already does commit→push→PR (README:47). `ship`'s remaining delta — wait-for-checks, queue merge, cleanup — is small and daily-useful; Desk is the biggest build. Dogfooding reaches steady state faster with ship at step 4 and Desk at 5 (or Desk-as-report per finding 4).

### 14. [nit] [Plan A] `ggh why`'s provenance leg is unbuilt but cheap
**Where**: Wacky #5.
**Finding**: "which agent produced it" isn't recorded anywhere. Cheap path: when `ggh c` runs under a detectable agent environment (CLAUDECODE, CODEX_*, T3, etc.), add an `Agent-Tool:` commit trailer — the operation journal already records command identity, the trailer gives blame→PR→agent provenance for free.
**Evidence**: `src/services/operations.ts` records command identity per operation; trailer needs one env check at commit time.

### 15. [nit] [Plan B] Monetization framing contradicts the binding goal
**Where**: B "Distribution and launch" tail.
**Finding**: "Sell optional execution infrastructure" anchors design decisions (open schema as market play) on a business the owner explicitly excluded (Q1: adoption, not a business). The open format is right; the revenue narrative is noise for this plan.

### 16. [nit] [Plan A] `ggh race` inherits the .env copy behavior
**Where**: Wacky #1 + worktreeAdd.
**Finding**: Race worktrees created via `worktreeAdd` silently receive `.env`/`.env.local`/`.env.development` (worktree.ts:137-151) — each competing agent run sees host dev secrets. Consistent with "trusted own agents," but should be an explicit flag, not inheritance.
**Suggestion**: `worktreeAdd` gains `copyEnv: false` option; race passes false by default.

## Missed opportunities

1. **Verdict as commit status / required check (high).** Publish `ggh verify` results via the Commit Statuses API under `context: ggh/verify`. Turns the local verdict into shared, gate-able, agent-queryable state; requires no Checks-API app and no comment spam. This is the piece that makes verify a *protocol* rather than a tool — the owner's agents can then be required to carry a fresh verdict to get reviewed.
2. **`ggh verify` as a reusable GitHub Action (high).** CI runners are the isolated runtime both plans circle. A composite action implements the same fail-to-pass core, gives strangers' PRs a safe executor, gives the verdict check-run visibility, and is the single best OSS distribution channel for the check ("add one workflow" >> "install my CLI"). Resolves the trusted/isolated sequencing conflict.
3. **Author-side mandate: the full protocol (high).** A touches it in one bullet ("verify verdicts feed into the envelope") but the thesis demands more: the owner controls *both* ends of the loop. The product is "every agent PR carries a fresh `ggh verify` verdict envelope (in PR body footer or status) before requesting review; the Desk ranks by it." Make that the spine, not a sub-bullet — it's the differentiator no competitor (Bugbot/TREX are hosted, GitHub-native agent loop is preview) fills for *local multi-vendor* fleets.
4. **`ggh fleet` — the in-flight half of the cockpit (med-high, mildly wacky).** Desk covers remote PRs; nothing shows what the owner's agents have *in progress* — local worktrees, uncommitted branches, running operations across repos. A cross-repo registry (~/.config/ggh state) + one view of "all agent worktrees + their PR state" is the real cockpit and is differentiated: gh-dash can't see uncommitted local work.
5. **gh-dash integration pack instead of Desk TUI (med).** Ship documented `keybindings.prs` entries + `repoPaths` config wiring `ggh verify`, worktree-checkout, and merge into gh-dash. ~80% of Desk's interaction value at ~5% of the cost; keeps ggh's TUI surface at zero.
6. **`ggh desk --agent` (med).** The agent-facing queue: "which of my PRs need attention" — failed checks, unresolved threads, stale verdicts — one structured call. Natural once ranking exists; makes the Desk a fleet primitive, not just a UI.
7. **Changed-line coverage verdict (med).** Where coverage exists (`bun test --coverage`, vitest): report % of changed lines executed. Catches "tests exist but don't touch the diff" even when tests are green — deterministic, cheaper than mutation, complements fail-to-pass.
8. **Agent provenance trailer (med, wacky).** `Agent-Tool: claude-code` trailers under detectable agent envs → powers `ggh why`, gives the owner a per-agent quality ledger (which agent's PRs most often get `tests-dont-bite`). A vendor-neutral agent-quality signal is itself a future feature.
9. **PR-split advisor (med).** Both plans have "diff budget" as wacky; promote: `ggh split-plan` proposes a native-stack decomposition (`gh stack` handles submission post-GA) for oversized agent diffs — closes the loop with wacky #3 and the stack interop bet.

## A vs B verdict

- **Primary customer**: A is right. B builds for "maintainers reviewing ≥10 PRs/week" when the binding decision is humans-at-terminal + agents first-class, maintainers "a little." B's product amputates the half of the audience the owner *is*. A's synthesis (the owner IS a reviewer of agent output) correctly reconciles this.
- **Validation**: A is right on *who* validates (owner dogfood + fixture suite + public launch); B is right on *how* (explicit stop conditions, fixture classification targets, the script-baseline test, hostile-case probe). Merge: A's audience with B's gates.
- **Verify mechanism rigor**: B is right on the details that matter — merge-base vs synthetic merge, run-vs-build classification, test-level results, flake repetition, feature-absence reporting. A ships the better product framing but its verdict vocabulary will lie (finding 1) until it imports B's distinctions.
- **Interface**: hybrid. A's auto-detect is the right default for agent-authored PRs that already carry tests; B's explicit `--test-file`/argv is the right escape hatch and the stronger guarantee. Build A's interface with B's flags.
- **Isolation & sequencing**: A is right for the owner's dominant case (own agents' code is already trusted enough to have run locally); B is right for strangers — and B's boundary work is moot if finding 9 lands, since CI execution gives the isolated runtime for free. Resolve by author-aware defaults + Action-as-isolated-mode before public launch.
- **Negative controls**: B's bounded, applicability-checked controls are sound; A's "mutate 3 lines" is a broken mechanism — adopt B's framing (or Stryker for TS) whenever this bet lands.
- **Scope**: A is right — B is not a rival product plan, it's a well-engineered *specification for A's bet 2*. `challenge` is a feature inside the cockpit, not a company. B's real contribution is rigor; A's is product shape. The merged plan is A's skeleton with B's verify internals, B's explicit interface as the escape hatch, B's fixtures/probes as the quality gates, and both plans' distribution gaps closed by status-verdicts + a CI Action.
