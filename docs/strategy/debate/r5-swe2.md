# Adversarial review of ggh v5 (SWE-2, read-only)

Repo verified at 32a3e4b. All file:line citations checked against the working tree.

## 1. Fatal/critical problems

None fatal. Four pre-build defects:

**a. `sync` collides and pruning now lives in three places.** `ggh sync` already exists: "Fetch, prune, and delete branches whose remote is gone" (src/commands/sync.ts:22-26). v5 redefines `sync` as multi-repo fetch + ff-only pull + fork sync, while `tidy` also prunes merged branches. Three verbs (existing `sync`/`prune`, new `sync`, `tidy`) now overlap on branch deletion with different scopes and different safety models. The plan never acknowledges the collision. Merge them: one prune path with one invariant, invoked per-repo (`sync`) or across the index (`tidy`).

**b. `tidy` on foreign-owned worktrees is the top correctness hazard.** "Remove dead worktrees (any owner kind, with that host's metadata respected)" is hand-wavy. A worktree can read as dead (branch merged, remote gone) while a T3 thread is still bound to it and will rebind on wake; T3's binding state is not queryable through `git worktree list`. ggh cannot portably ask T3/Codex/Claude "is a live session using this?" Default must be: host-owned worktrees are advisory-only unless a host-specific inactivity check exists (T3 stores binding/worktree metadata; Claude session dirs under `~/.claude/projects` map to worktree paths). Unknown-owner → keep. The batch confirmation helps but the classifier must not put live-appearing foreign worktrees in the prune set at all.

**c. Discovery spec is wrong about where agent worktrees live.** Verified locally: T3 worktrees nest two deep (`~/.t3/worktrees/<ProjectName>/t3-<hash>`, each a linked worktree). Claude Code worktrees live **inside the repo** (`~/Downloads/Personal-Site/.claude/worktrees/<name>`), not a global dir; Cursor likewise uses in-repo `.cursor/worktrees*`. No `~/.codex/worktrees` exists on this machine — the Codex local layout is unverified. "Known agent worktree dirs, shallow scan" must become: scan roots with a stop-at-`.git` rule, then per discovered repo check `.claude/worktrees`, `.cursor/worktrees`, and union with the repo's own `git worktree list --porcelain` — which is authoritative and the only thing that catches worktrees outside all scan roots. Probe each host's real layout rather than asserting paths.

**d. `ggh new` does not exist.** What exists is `ggh repo create [name] --source <path>` (src/commands/repo.ts:105-116, with `--push`, `--approve-plan`, confirmation options). Either rename it in the plan or correct the claim. Same class of issue: `get` is essentially existing `clone` (search + shallow/blobless already ship, src/commands/clone.ts:46-48) — extend `clone` and alias `get`; do not fork verbs pre-1.0.

## 2. Does v5 follow the research?

Mostly yes. Verified faithful:

- Head-pinned merges is genuinely missing today: `mergePullRequest` sends no `--match-head-commit` (src/services/github/prs.ts:190-209). P0 claim accurate.
- Stack recovery exists: `StackRecoveryCheckpoint`, locks, `refs/ggh/stack-recovery/*` (src/services/git/stack.ts:40,246). "Extend, don't start over" is right.
- Temp-index preview exists (src/services/git/split.ts:133). Partial-staging preservation is a real T3 gap (T3 report, staging row: resets the real index).
- The 97.8-99.5% CI figure is quoted with its gate intact (blind triage of 20 archived failures vs a strong native skill) — exactly the report's probe; benchmark.py exists at /tmp/ggh-research/agent-pain/benchmark.py.
- "T3 has no arbitrary baseline" and "GitHub's since-last-review exists only for submitted reviews" match both reports.
- White space mapping is complete: competitors (a)1-4 → projects/go/tidy/resume; (b)5-9 → status/preflight/index/ci-why. The "already solved" list is respected (no TUI dashboard, no worktree lifecycle manager, MCP stays narrow, stacks → gh-stack interop).

Claims the research does not support:

- **Review threads under the agent pillar.** The report measured only 9-27% byte savings and says native `gh api graphql` "is already a strong one-command competitor." Under v5's own benchmark rule this feature loses on bytes; it can only ship on the *correctness* prong (lossless cursors, resolve/unresolve separation, `canResolve`). Say so explicitly or it fails its own gate.
- **"any owner kind" tidy removal** — no research supports safe cross-host worktree deletion; the T3 report shows cleanup defaults off with per-host checks even inside T3.
- **`--remote` feasibility at 72 repos via REST+ETag alone.** The T3 report recommends aliased GraphQL batches and credential-scoped request budgets (trick #6); v5 mentions ETags but drops the batching and the budget. ~200 REST calls works but is strictly worse than 1-3 aliased GraphQL calls. Not unsupported, just under-specified against its own research.

Ignored findings: multi-clone rollback trail (competitors #8) is half-addressed ("keep operation recovery") — name it deferred or dropped. T3's typed retry/background reserve is dropped (above). Acceptable, but name them.

## 3. Mechanism attacks on Projects

- **Correctness:** beyond 1c — `.git` can be a file (worktree/submodule) or dir; broken gitdirs (moved repo leaving a dangling gitfile) are your "dead worktree" signal, fixtures cover this. Nested repos: once a `.git` is found, stop descending except the designated in-repo agent dirs — otherwise vendored checkouts and node_modules repos pollute the index. Repos with no remote or non-GitHub remotes need path-keyed identity (`id` is already nullable — good).
- **Speed at 72+ repos:** "local fields instant" needs bounded local concurrency too, not just remote. ~6 git subprocesses per repo × 72 serial is seconds; 8-16 workers + per-repo timeout makes it real. `git status --porcelain=v2` on a dirty 20k-file repo is fine, but `du` for "disk size" is not instant on node_modules-heavy clones — make it lazy/opt-in.
- **Ownership detection:** strongest markers are host-config footprints, not paths: T3 writes `t3-merge-base-ref`/`gh-merge-base` config (T3 report worktree row); Cursor writes `.cursor/worktrees.json`; Claude/Codex in-repo dirs and session metadata. Path heuristics + `unknown` fallback is honest; commit to the config markers where they exist.
- **Privacy:** all local reads, local index, no telemetry — consistent.
- **`go` hook:** zoxide `init` is proven. Needs a non-hook fallback (print path for `cd "$(ggh go foo)"`). Jump-or-get must reuse `get`'s nonempty-dir rejection rather than inventing one.
- **`get` default-to-cwd:** fine and matches the owner habit; keep T3-style nonempty-dir rejection or explicit suffix, never silent overwrite.
- **`sync` across projects:** ff-only is the right default; report-conflicts-not-resolve is right. Fork sync is commodity (competitors: already solved) — keep it thin. Fix the collision (1a).
- **Remote status at scale:** single aliased GraphQL query over 72 `repository(owner,name)` fields beats ~200 REST calls and dodges secondary-rate-limit bursts; ETag-cache the per-repo PR/CI reads as second tier. T3's eight-slot budget and 304-noncounting pattern is the reference.

## 4. Agent pillar

The rule is right — it is the report's own conclusion ("no evidence that wrapping git/gh in JSON universally saves tokens") turned into a shipping gate, and it self-applies to ggh's current losses (state 5x porcelain, run JSON 3.3x). Two fixes:

- **Pin the baseline.** "Skilled native git/gh" is gameable. Name the artifact: the benchmark.py sketch outputs and a defined native-skill reference, versioned in-repo, run in CI (v5 already plans the harness — say what it competes against).
- **Bytes are the wrong metric for the safety features.** Exact-scope preflight's metric should be the report's own probe: 20 synthetic fixtures measuring unintended paths/history changes and duplicate publication attempts. v5 quotes the bytes/calls/correctness rule for everything; add "unintended-scope incidents" as the metric class for preflight, or the feature can't demonstrate its win.
- Move preflight + recoverable outcomes under Pillar 4 (it's correctness, not a measured agent win); keep Pillar 2 purely things that pass the benchmark. Threads: ship on correctness only (see 2). Host cooperation and the skill pack are cheap spec details — keep, they're not benchmark items.

## 5. Coherence and cuts

It is one product if the thesis stays "the GitHub CLI it should have been" — Projects is the wedge, agent-grade ops are the moat, Review rides the same honest-state spine. The review pillar is the weakest fit but is justified by Q7/Q8 and its ledger feeds `resume`.

Sharpen:

- **Merge `resume` into `go`.** `ggh go foo` lands and prints the context card; `ggh go foo --no-cd` prints it without jumping. One verb, and the card gets seen daily instead of on request.
- **One prune path** (see 1a). Existing `sync` keeps its name and gains `--all` multi-repo scope; `tidy` is the destructive surface (worktrees, merged branches, stale repos) sharing the same classifier and the same approval snapshot.
- **`ggh` bare printing the index replaces help** (index.ts:286-287 today) — good call, keep it; `ggh help` still exists via `-h`.
- Keep `--tui` gated last. The diff-review report ranked TUI flagship ahead of web; v5 silently reorders. The reorder is defensible (FFI-under-`bun build --compile` is unproven, owner reviews in editor/web anyway) but should be stated as a deviation with the reason.
- `notifications` "until projects --remote covers it" never fully happens — inbox-shaped vs repo-shaped. Either keep it permanently or define the exact replacement condition.

## 6. The ceiling

**`ggh lost` — stranded-work finder.** The index makes it nearly free: for every clone and worktree, report commits reachable from no remote branch or PR, stashes older than N days, and uncommitted hunks inside worktrees whose owning host session is gone. tidy guards disk; `lost` guards *work*. Nobody does this: hosts see only their own worktrees, gh sees no local state. The agent-era disaster is not a dirty repo, it is a finished fix that exists in exactly one orphaned checkout. Smallest demo: the same launch scan prints "3 worktrees contain commits that exist nowhere else" — a stronger hook than disk reclaimed. Fits every constraint: pure local git, read-only until you ask it to salvage, a tool not an orchestrator. If it feels thin alone, ship it as `tidy`'s "salvage" section — but it deserves the verb.

## 7. Verdict

Ship to owner **with edits**:

1. Resolve the `sync`/`tidy`/existing-`prune` three-way overlap into one prune path and classifier (1a).
2. tidy: foreign-owned worktrees default keep absent a host-specific inactivity check; `git worktree list --porcelain` as authoritative discovery union; define remote-branch "owned" and keep per-item confirmation for remote deletes (1b).
3. Fix discovery: stop-at-`.git` scan rule, in-repo `.claude`/`.cursor` worktree dirs, two-level `~/.t3/worktrees`, probe — don't assert — Codex's layout (1c).
4. Correct `new` → `repo create --source`; extend `clone` rather than forking `get` (1d).
5. `projects --remote`: single aliased GraphQL batch + credential-scoped budget before REST fallback; lazy disk size; bounded local concurrency with per-repo timeout (3).
6. Benchmark rule: pin the native baseline artifact; add the fixture metric for preflight; declare threads a correctness-prong ship (2, 4).
7. Merge `resume` into `go`; state the `--tui` demotion explicitly; decide `notifications` permanently or define the replacement (5).
8. Consider `ggh lost` for the launch demo (6) — optional, genuinely better hook.
