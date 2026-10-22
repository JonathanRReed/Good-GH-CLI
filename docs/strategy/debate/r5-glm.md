# Adversarial review of v5 (GLM-5.3 Max, round 5)

Read: decisions.md, v5-claude.md, all four research reports, v4-final.md skim. Verified v5's repo claims against the checkout at `32a3e4b` and probed the owner's real machine (`~/.t3/worktrees`: 5 project dirs, 45 worktree dirs, mixed `t3-<hash>` and semantic names; `~/Downloads`: repos interleaved with images/`.pptx`/`.provisionprofile` and near-duplicate clones such as `Doc-game-sites` + `Doc-game-sites-work`, `Inkling-Rollback-*`).

## 1. Fatal / critical

No fatal flaw. Three critical, all fixable by edit:

1. **Launch copy overclaims: "using 1% of the tokens" (v5 line 114).** The agent-pain report measured a 97.8–99.5% *byte* ceiling on two specimens and explicitly warns this is "not equivalent reductions in network traffic, elapsed time, billed tokens or repair errors," closing with "Do not claim universal token savings" (agent-pain-report.md §2, §Reproducibility). The plan's most public sentence commits the exact banned overclaim. Replace with the measured claim (bytes/calls + the blind-triage gate) or the launch undermines the one pillar whose entire rule is honesty about measurement.
2. **`ggh sync` name collision, unaddressed (v5 line 53).** `ggh sync` already exists: single-repo "Fetch, prune, and delete branches whose remote is gone," alias `prune` (`src/commands/sync.ts:21-26`). v5 silently reassigns the name to a different multi-project verb; the old verb's gone-branch deletion also loses its home when cleanup moves to `tidy`. Pre-1.0 breakage is licensed (Q4) but must be a *named* migration (e.g., fold gone-branch pruning into `tidy`, alias old behavior), not an accident.
3. **"`ggh new` (exists…)" is false as written (v5 line 55).** The flow exists as `ggh repo create --source <path> --push` (`src/commands/repo.ts:106-165`); no `new` command exists. Trivial fix (add alias or correct the sentence), but a plan asserting "exists" about a command that doesn't signals it wasn't checked against the binary — audit the remaining existence claims (I did: `clone` search/shallow/blobless is real, `clone.ts:46-48`; `ggh wt` real; `benchmark.py` real).

Adjacent: "state 5× porcelain" (line 60) is wrong in your favor's direction — porcelain=v2 is 121 B vs ggh `--json` 1,142/1,145 B ≈ **9.4×**; 5× is vs the 3-command raw *sequence*, a scope comparison (agent-pain §2). Understating the loss weakens the ≤1.5× target's meaning. Fix the number.

## 2. Fidelity to research

Unusually high. The agent rule is quoted nearly verbatim; `ci why` is ranked rec #1 including its blind-triage kill gate; `status --agent` local-only is rec #3; threads lossless-with-cursors is rec #4; T3 tricks 2/3/5/7 (thread node IDs, temp-index preview, PR-link cooperation, honest merge outcomes) and the merge/thread answers are all present; the review pillar follows diff-review's editor→web→tui ladder and its NOT-build list; white space #1–5 and #9 are each productized; cuts match competitors' "already solved" plus Q13. Deferred list correctly carries v4's residue.

**Unsupported claims:** the "1%" line (above). "GitHub's [since-last-review] exists only for submitted reviews" (line 84) is plausible but not stated in diff-review; mark verify-at-build. Demo numbers: the machine has 45 T3 worktree dirs, not 20; recount at record time.

**Ignored / under-used findings:**
- Competitors white space **#8** (rollback trail spanning git+GitHub ops) appears in neither plan nor Deferred — needs one line (op records stay static, or extend later).
- Competitors **#7** (multi-checkout state for hosts: "which of my 15 checkouts is clean / owns branch X") is present only as a table flag — yet it's the agent face of the new index and the top measured pain category (worktree confusion, 5/19 reports). Should be a named `--agent` JSON contract, not a display mode.
- T3 report trick #1 names the exact bug class (`feature` tracking `origin/main`, fork remotes — T3 issue #17312); v5's preflight doesn't list the wrong-upstream audit case among its correctness fixtures.
- Agent-pain's "a CLI cannot independently repair host thread-to-worktree bindings" is honored for watching but walked into by `tidy` (§3).

## 3. Mechanism attacks: Projects pillar

**Discovery/identity.** The scan root is hostile: mixed content and near-duplicate *clones* (not worktrees) of one remote. The data shape handles worktrees (paths[]) but the plan never defines identity for: two independent clones of one remote (one Project with two `clone` paths? fork vs upstream?); remoteless backup clones (`id?` suggests yes, own Project). Specify: worktrees join by git-common-dir; clones join by normalized origin URL; forks are distinct Projects; remoteless is its own Project.

**"Shallow scan, cached" is a slogan, not a mechanism.** Must be: pruned walk (never descend `node_modules`/`.venv`/`target`), parallel, cache keyed on `.git` index/refs mtimes, and a defined `lastTouched` (index mtime? HEAD? worktree?). On 72 repos + 45 worktrees, "local fields instant" is a claim — set a target (warm <2s, background rescan) and a benchmark fixture.

**Cold start.** Scan roots default to none, so a fresh user's `ggh` shows an empty table and their pre-existing clones are invisible; your own validation ("uncoached outsider runs `ggh init && ggh get && ggh tidy`") walks into exactly this. First run of `ggh` should offer to configure a scan root (printed consent, matching the Q8 pattern). Otherwise the wedge's first impression is blank.

**Ownership detection.** Probes: T3 worktree names are mixed (`t3-0757c92e`, `opus-bleed-eval`, `review-0cf8c4ca`), so branch-prefix heuristics fail; location works today (`~/.t3/worktrees/<project>/<name>`) but T3 storage is configurable (t3 report, `GitVcsDriverCore.ts:3711`). State the rule explicitly: **ownership is advisory; no safety property may depend on it being correct.** v5 implies this; say it.

**`tidy` invariant is right but incomplete for host-owned worktrees.** Never-touch content (uncommitted/unpushed/stashed/.env) is correct. But deleting a T3 worktree whose branch is merged while its T3 thread is still live orphans that thread's binding — the t3 report documents T3 cleanup checking sessions/terminals/threads and warns ggh "cannot constrain an unrelated terminal" (opportunity #6; Handoff/cleanup row). "With that host's metadata respected" is doing enormous, unspecified work: T3 has no public settled-state API and its storage schema is private/versioned. Required edits: (a) host-owned worktrees **default to flag-not-delete**; removal only when ggh can read that host's settled state; (b) add "host thread active" to the never-touch invariant; (c) fixture: ggh must refuse a live T3-bound worktree even when its branch is merged. The `--audit` path is otherwise sound: AI sees metadata only; narrowing = intersection with the pinned snapshot; spec that subset execution re-validates item-by-item against the same snapshot. Expect marginal value from an AI on metadata alone — keep as owner-delight, not the launch centerpiece.

**`go` shell hook.** The wrapper must be a transparent passthrough for every non-`go` invocation (exit codes, stdio, TTY behavior) or it breaks scripted/agent use — spec the function contract; merge with existing `ggh completion [shell]` (`src/commands/completion.ts:60`) so there's one shell-setup verb. `--t3` correctly stays a probe — the t3 report documents no CLI/deep link to open a path.

**`get` default-to-cwd.** Matches Q16 for humans; but an agent cloning a URL from an arbitrary cwd litters. Agents (non-TTY / `--agent`) should require `--to` or `clone_root`. Also: `get` vs existing `clone` (search + shallow/blobless, real) are two doors to one action — merge (§5).

**`sync` across projects.** ff-only + skip-dirty + report-conflicts is right. Add: no-upstream → skip; concurrent-agent-activity → skip (ggh can lock only its own ops, never external git — t3 #6); and the old `sync` migration (§1). The "concurrent agent" fixture in validation is good — make it a sync fixture too.

**Remote status at scale.** ETags are REST-only; GraphQL (PR lists, review threads) has no conditional requests — T3 needed persisted one-minute reads + a 10% quota reserve for this (t3 report, transport row). For 72 repos: aliased/batched GraphQL + REST ETags for checks, bounded concurrency, freshness label. Fine within hourly budget; don't claim ETag coverage it can't have. `disk size` is a du walk over 100+ trees — cache hard, refresh lazily.

## 4. Agent pillar rule

Right rule, insufficient as stated. Three amendments:

1. **Add latency and hang-freedom as gates.** Agent-pain's top categories were interactive hangs and destructive scope, and ggh *added* 0.76–2.05s vs raw; byte parity captures none of this. Every command passes a TTY-less, `GIT_TERMINAL_PROMPT=0`, no-`$PAGER` harness in CI; `status --agent <150ms` generalizes to a latency budget per command.
2. **Benchmark the live claimants, not just native.** Competitors is explicit: "measured against `but`'s JSON and zagi's token budgets so the claim is empirical." Native-only risks beating a strawman; `but`/zagi are the products agents will actually be compared against.
3. **"or correctness" needs named fixtures**, not vibes: partial staging preserved (T3 resets it — t3 report, staging row), wrong-upstream/wrong-base prevented (the #17312 class), exact publication scope. These are wins even at byte parity; say so.

Keep publishing losses — it's the credibility play. Move **up**: `projects --agent` JSON (competitors #7; index already exists by then). Move **out/merge**: skill pack → one doc + env template, not a peer of measured features.

## 5. Coherence and cuts

One product **if the index is the spine** — and it can be: `get/go/tidy/sync/resume` read/write ProjectIndex; `status`/preflight are per-repo but honest. Today Pillar 2 reads as a grab-bag; tie it to the index where possible and it coheres. Cuts/merges to sharpen:

- **Cut `--web` review** to a named stretch ("only if a non-T3 user story exists"). The owner has T3; diff-review's own ranking for this owner is editor > tui > web.
- **Cut `--structural` now** (difftastic's own perf caveats + anchor-mapping cost); keep the ledger.
- **Merge `clone` into `get`** (clone stays as alias) — otherwise two commands do one job.
- **Merge `resume` into `go --resume`** (print the card on jump; standalone only if `go` declined).
- **Fold `completion` into `init`**; **name the old-`sync` migration** (§1).
- Keep the MCP "only what ggh uniquely adds" line verbatim — it's load-bearing vs github-mcp-server.

## 6. The ceiling: `ggh lock`

Cooperative, machine-local **operation locks rooted in each repo's git common dir** (`.git/commondir/ggh/locks/`, flock + TTL + holder label), auto-acquired by ggh's own mutations (worktree add/remove, tidy, sync) and callable by any host's agent before touching a shared checkout: `ggh lock acquire|release|list <project>`.

Why it's the one bolder idea worth doing: it attacks the **top measured pain category** (worktree confusion, 5/19 reports — orphaned worktrees, shared-session collisions, app/agent disagreement); it is the t3 report's opportunity #6 *stated as an invitation* ("ggh can expose repository-common-directory operation locks… It cannot promise to serialize arbitrary external Git" — cooperative, not enforcement); it is pure tool-not-orchestrator (Q9), zero server/telemetry/account (Q3); and it turns the index from a report into live arbitration state — the thing no host can do because each only sees its own worktrees (competitors #7). Smallest demo: two terminals — A: `ggh lock acquire good-gh-cli` then `ggh worktree add`; B: `ggh worktree add` → refusal naming holder and expiry; `ggh lock list` shows both; a killed process self-heals via TTL. ~200 LOC on existing worktree plumbing, and a fixture class that hardens `tidy`/`sync` for free.

## 7. Verdict

**Ship to owner with edits:**

1. Kill "1% of the tokens"; state bytes/calls + gate only.
2. Fix "state 5×" → ~9.4× porcelain; set the baseline honestly.
3. `ggh new` — alias or correct the claim; audit other existence claims.
4. Name the `ggh sync` collision and migration (fold gone-branch pruning into `tidy`).
5. `tidy`: host-owned worktrees flag-not-delete by default; "host thread active" joins the never-touch invariant; live-T3-worktree refusal fixture.
6. Discovery spec: identity/dedupe rules, pruned walk, cache invalidation, lastTouched, cold-start scan-root prompt; "ownership is advisory" stated.
7. `go` function passthrough contract; merge `init`+`completion`.
8. Agent rule: add latency + hang-freedom gates; add `but`/zagi as benchmark opponents; name correctness fixtures (partial staging, wrong-upstream).
9. Cuts/merges per §5 (web → stretch, structural → cut, clone→get, resume→go, completion→init).
10. One line on competitors #8 (rollback trail) in Deferred; promote `projects --agent` JSON contract; recount demo numbers at record time.

None of these are architecture changes; the pillar structure, sequencing, and research grounding survive adversarial pressure. With these edits applied, v5 is ready for the owner.
