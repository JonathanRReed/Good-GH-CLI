# Good GH: v1 plan + rebuttal to GPT-6.1 Sol R1 (Claude Opus 5.5)

Inputs: v0-claude.md, r1-codex.md (adversary), decisions.md (owner answers, binding).

## Part A: Rebuttal of R1

### Conceded (v0 claims withdrawn)
- B1 as a security boundary: withdrawn. Hooks are a seatbelt, not a vault (THREAT-MODEL.md:90 already excludes hostile same-user processes). Repo policy may only tighten, never grant.
- B2 universal undo: withdrawn. Only named compensations with stated residual effects.
- B3 signatures: withdrawn as a trust claim. Signing an author's statement proves nothing about the tests.
- B4 "nobody does multi-model consensus" and "agreement = correctness": withdrawn.
- B5 daemon mirror: dropped (also owner Q3).
- B6 stacks as differentiator: dead. VERIFIED: GitHub shipped native stacked PRs GA 2026-10-06 with an official `gh stack` extension (gh 2.100.0 on this machine prompts to install it) and merge-queue groups. ggh must interoperate, not compete.
- "Most git invocations are agent-typed": unsourced; withdrawn as a premise.
- VERIFIED: src/services/git/worktree.ts:138 copies .env/.env.local/.env.development into new worktrees. Fine for trusted dev; disqualifying for executing foreign code.

### Rejected (R1 conflicts with binding owner decisions or misreads the situation)
1. **Maintainer-first customer.** Owner decided primary users are humans at a terminal AND agents; maintainers are secondary. R1 makes the secondary audience the whole product.
2. **"Recruit 5 teams, measure retained cohorts, 30% review-time reduction."** Owner is the only user, has no deadline, wants no telemetry, and wants to use the tool daily. A cohort research program is a startup playbook for a product the owner said is not a business. Validation = the owner's daily dogfooding across a real agent fleet, plus public release. Kill criteria stay, but measured on the owner's own repos.
3. **Preserve compatibility / deprecation cycles.** Owner explicitly: cut hard, break freely pre-1.0.
4. **Docker-required runner as the only mode.** Correct for strangers' PRs; wrong for the owner's dominant case: PRs written by *their own* agents on *their own* machine, where the code is already trusted enough to have been generated locally. Two trust modes, labeled honestly.
5. **"Command count is not user value."** True as a metric; but 45 commands where ~15 duplicate `gh` is reader load on README, completion, docs, tests. Cutting is about focus, not a number.

### Key fact R1 surfaced that reshapes everything
The owner's real loop (to confirm in grilling): many coding agents produce branches/PRs; the owner reviews and merges. The owner is simultaneously the human-at-terminal user AND a maintainer of agent output. So R1's reviewer-verification idea is not a pivot away from the owner; it's the owner's own bottleneck. That's the synthesis.

## Part B: v1 plan

### Thesis
**ggh is the cockpit for one developer working with a fleet of coding agents.** The scarce resource is no longer typing code; it is human attention per correctly merged change. ggh minimizes it: one honest loop from local change to merged PR, the same loop exposed to agents as a structured contract, and cheap deterministic evidence so the human can trust or reject an agent PR fast.

### Bets (ranked)

**1. The Desk (`ggh desk`, human-first)**: one keyboard-driven terminal queue of every PR awaiting *you* across your repos, ranked by readiness: checks, evidence verdict (bet 2), diff size, conflicts, stack position, staleness. Actions in one key: read diff, leave line comment, request changes, approve, merge (respecting native merge queue/stacks), check out into a worktree, close. On-demand GraphQL with short local cache, no daemon. Competitive reality: gh-dash exists; the differentiator is verdicts + the agent feedback loop (bet 3), not the list.

**2. Evidence verdicts (`ggh verify <pr>`)**: deterministic, AI-free first.
- *Fix-revert check*: split the PR diff into test files and non-test files. Run the PR's new/changed tests against (base code + PR tests). If they PASS without the fix, the tests don't test the fix → verdict "tests do not exercise the change". Then run on head → must pass. Zero configuration for any repo with a test command; catches the #1 agent-PR lie ("added tests, all green").
- Verdicts: `proven-fix` / `tests-dont-bite` / `fails-on-head` / `inconclusive (why)`. Zero tests, skipped tests, setup failure = inconclusive, never green.
- Trust modes: `--trusted` (own/agent PRs: local isolated worktree, NO .env copy unless `--with-env`) and `--isolated` (container, no host creds, network off) for foreign PRs. Mode is printed in every verdict.
- Results bound to exact base/head/test OIDs; invalidated when any change. Unsigned, local. Optional: post verdict as a PR comment (explicit action).
- Later: negative controls (R1 bet 2) and AI-proposed reproducer tests (R1 bet 3), only after the deterministic core earns daily use.

**3. The agent loop over PRs (`--agent` contract, extended)**: humans review in GitHub or the Desk; agents consume it structurally.
- `ggh pr feedback 42 --agent`: unresolved review threads as structured items (file, line range, body, thread id, requested change).
- `ggh pr address 42 --thread <id> --commit <sha>`: reply + resolve with the fixing commit.
- `ggh verify` verdicts feed into the envelope so an agent can self-check before asking for review.
- Ship as an MCP tool set + Claude Code / Codex skill. This is the agent-side wedge: any agent can close the review loop without scraping.

**4. One-command ship for humans (`ggh ship`)**: from dirty tree to open PR (or merged, with `--land`): branch if on default, commit (explicit msg or AI), push, PR, verify, wait for checks with a live compact view, merge via native queue, clean up branch/worktree. Built on existing publication plan + approval snapshot + recovery. Most of the parts exist; the product is the composition and the speed.

**5. Native stacks interop**: replace ggh's stack submit/remote view with GitHub native stacks (gh-stack extension or API). Keep only what native lacks (local restack with saved tips + continue/abort, if gh-stack lacks it; probe first).

**6. Seatbelt hooks (low priority)**: optional `ggh agent install claude-code|codex` that redirects a small set of raw commands (`git push --force*`, `gh pr merge`, `gh repo create --public`) to ggh equivalents for better previews and honest outcomes. Labeled "convenience seatbelt, not a security boundary." One integration first.

### Subtractions (break freely)
- Delete commands that only proxy gh: label, secret*, variable, gist, workflow, search, browse, release (browse/download/upload/delete), team, draft, triage, notifications (folded into Desk), changelog. Reachable via `ggh gh ...`. (*secret's hidden-input handling: check if gh already does this; if so delete.)
- Delete ggh-owned stack submit and `stack list --remote` once native interop lands.
- README: install, `ship`, `desk`, `verify`, agent loop. Command catalog moves to reference docs.
- Freeze new platform-matrix expansion; keep checks on changed behavior.

### Wacky / extreme ideas (ranked by expected value)
1. **`ggh race <issue> --agents codex,claude,devin`**: same issue + same acceptance test (written first, or reproduced from the issue) to N installed agents in N worktrees; ggh runs `verify` on each result and shows a leaderboard (verdict, diff size, time). Owner has many agents, so this is the fleet's natural primitive. Requires agentic provider mode (today's adapters are tool-disabled), so it's a later bet.
2. **Test-first issues**: `ggh issue repro 184` turns a bug report into a failing test PR before any fix; the fix PR must flip it. Makes every agent fix verifiable by construction.
3. **Diff budget**: agent PRs over N changed lines get flagged in the Desk with "split into a stack" (native stacks) suggestion.
4. **Mutation spot-check**: auto-mutate 3 lines touched by the fix; if the new tests still pass, flag weak tests. Cheap, deterministic, novel UX.
5. **`ggh why <file:line>`**: line → commit → PR → review threads → verify verdict → (if recorded) which agent produced it. Provenance for humans debugging agent code.
6. **Credential-separated executor** (R1 wacky #6): agents hold no GitHub write token; ggh executes approved plans. Only if someone wants enforcement. Parked.

### Validation (no cohort, no telemetry)
- Dogfood: the owner's agent fleet routes PRs through `verify` + Desk for 2 weeks on real repos. Kill a bet if the owner stops using it.
- Fixture suite (R1 experiment F): 24 tiny repos covering zero tests, skipped tests, fix-revert true/false, flaky, setup failure. Every verdict classified correctly.
- Public: launch with 3 real agent PRs where `verify` caught "tests don't bite", including at least one inconclusive. Metrics: release downloads, stars, issues from strangers, contributors.

### Sequencing
0. Probes: gh-stack capabilities vs ggh stack; gh secret hidden input; fix-revert check prototype on 10 of owner's real agent PRs.
1. Subtract (deletions + README rewrite).
2. `verify` deterministic core (trusted mode) + fixture suite.
3. Agent loop (`pr feedback` / `pr address`) + MCP/skill.
4. Desk.
5. `ship` composition.
6. Native stack interop.
7. Launch.
8. Isolated mode, negative controls, race, test-first issues.
