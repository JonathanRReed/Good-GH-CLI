# Good GH: round 5 adversarial review

Plan references mean `/tmp/ggh-plan/v5-claude.md`; report references mean `/tmp/ggh-research/`. Owner decisions supersede the earlier task-centered thesis.

1. Fatal/critical problems

No fatal product-direction problem. Two high-severity implementation blockers remain.

**Clean does not mean abandoned.** Plan:47-52 permits removing any host's worktrees while promising to respect host metadata. A clean T3 checkout can belong to a live session or queued turn. Deleting it strands that session without violating any dirty-file check. T3 checks terminals, thread bindings, pending deletion effects and live provider sessions immediately before cleanup, [storageCleanup.ts:917-985](https://github.com/pingdotgg/t3code/blob/f460ddb23a49e459575f6dbcc0101212d8640a2e/apps/server/src/storageCleanup.ts#L917). A directory-name owner label supplies none of that authority.

Discover foreign worktrees freely. Remove them only through a supported host cleanup operation that owns those checks; otherwise report them as candidates for manual cleanup. Unknown ownership means keep. Do not edit hosts' databases. Catching case: a clean worktree with a queued agent turn survives the entire approved batch.

**Deletion proof is undefined.** Plan:49-52 names protected work but does not define “unpushed,” “merged,” or snapshot invalidation. A detached host HEAD can hold unpublished commits without a branch. A deleted upstream does not prove integration. A merged PR can have later commits. Remote deletion based on a preview can delete a newly advanced branch.

Bind each action to canonical checkout/common-dir identity, exact refs/OIDs, destination and relevant file state. Unknown publication or integration status means keep. Recheck immediately before each effect; reject changed items without widening the batch. Use expected-OID leases for remote deletes. Never force-delete based solely on a merged-PR badge. Explicit per-item overrides need separate renewed approval, not the ordinary batch confirmation. A ggh lock cannot stop arbitrary external writers, so promise guarded operations and honest refusals rather than universal race freedom. Catch detached commits, moved remote tips, ignored files added after approval and concurrent host activity.

2. Research fidelity

The pivot follows Q6 and Q14-Q18. Clone diagnostics, partial-staging preservation, honest merge outcomes, host registration receipts and bounded CI retrieval follow the reports well. Deferring task handoff and differential verification is deliberate and reasonable.

Several claims need correction:

- “Multi-project management, which no tool does,” Plan:9-10, is false even in competitors-report.md:25,34. Its dismissal of gita is also too strong. [Gita's README](https://github.com/nosarthur/gita#readme) documents recursive discovery, ahead/behind/diverged state, stashes, bulk fetch, cwd clone and shell jumping. The opportunity is the combined GitHub/local/host-aware workflow, not invention of multi-repo management.
- “Agents ... run raw git/gh for every operation,” Plan:11, overstates t3code-report.md:27. That row lists substantial MCP operations alongside shell use. Say agents still need Git/GitHub shell operations.
- “State 5× porcelain,” Plan:59-60, mislabels a comparison against several human-readable commands. Agent-pain-report.md:56 gives porcelain separately and explicitly warns of unequal scope. Fix the label.
- “Using 1% of the tokens,” Plan:114, is unsupported. Agent-pain-report.md:37,58,67 measured bytes, estimated tokens by bytes/4 and used hand-built extracts from two failures. Neither agent consumption nor repair success was measured. Present the reduction as prototype output bytes versus verbose retrieval until the blind trial earns a stronger claim.

Missed findings: cross-platform installed-artifact gates from v4-final.md:172-173 disappeared again. Restore them for shell hooks, paths, cancellation and packaging. Lossless review reads are recommended now, agent-pain-report.md:83, but sequencing names only the later write path, Plan:132. Schedule reads explicitly. Also retain t3code-report.md:36's credential-scoped request budgeting, beyond concurrency and ETags.

3. Projects mechanism attacks

**Discovery and identity, Plan:26-38.** Separate three identities: logical remote repository, independent local clone/common directory, and worktree/gitdir. Two clones of one URL share PR metadata but have different refs, stashes and publication state. A path can be both ggh-created and T3-bound; replace the exclusive owner enum with provenance plus current host claims. Host claims must never imply deletion permission.

Discover `.git` files as well as directories; enumerate linked worktrees from each common directory using NUL-delimited Git output. The current parser loses locked/prunable state and does not request `-z`, src/services/git/worktree.ts:51-81; do not reuse it unchanged. [Git documents these fields](https://git-scm.com/docs/git-worktree#_list_output_format). Handle unborn/bare repositories and broken gitdirs explicitly.

“Shallow scan” needs a depth and coverage contract. Stopping at an outer repository misses nested repositories; descending everywhere traverses dependencies. Support bounded roots, exclusions and explicit nested registrations; display incomplete coverage. Resolve symlink aliases and loops without following paths outside consented roots. Discover custom and previous host locations: T3 already supports both, [worktreesDirectory.ts:34-48](https://github.com/pingdotgg/t3code/blob/f460ddb23a49e459575f6dbcc0101212d8640a2e/apps/server/src/worktreesDirectory.ts#L34). Four host families' locations and ownership formats have not been established by these reports.

“Local fields instant” is unearned. Dirty scans, disk usage and all-branch ancestry over 72 repos can be expensive. Render cached rows first, refresh with bounded workers and deadlines, defer recursive size calculation. Show timestamps and unknown/error states. Test cold discovery and warm refresh against large dirty repos, inaccessible paths and nested layouts. One giant table snapshot is insufficient performance evidence.

Private indexing requires user-approved host roots too. Store only needed metadata with private permissions, provide forget/exclude, redact credential-bearing remotes, and never read host transcripts or credentials to infer ownership.

**Tidy and AI, Plan:47-52.** Distinguish pruning missing-worktree metadata from deleting existing checkouts. Missing paths can be unmounted storage; honor locks and conservative expiry. [Git separates prune, remove and repair](https://git-scm.com/docs/git-worktree#_commands). Protect nested repos, submodules, ignored files and detached commits. Stashes belong to the common repository, so apply their protection deliberately rather than counting them independently per worktree.

Make `--audit` consume a bounded metadata plan and return validated action IDs plus keep/prune reasons. It gets no execution tools. Reject invented IDs; intersect recommendations with the original safe set. Repo names and reasons are untrusted model input. Show the selected provider and exact disclosure scope; do not send file contents, `.env`, transcripts or credential URLs. Honor existing hosted consent and fallback policy, src/services/config.ts:18-37. A local provider must not silently fall through to hosted AI. Let a user-selected external agent apply the approved snapshot through ggh. That satisfies Q18 without turning ggh into an agent supervisor.

**Go, Plan:43-44.** Use a shell function with a data-only path protocol and shell-specific quoting, never evaluation of repository-derived code. UI belongs on stderr. Handle spaces, newlines, leading hyphens and multiple clones with identical basenames. Cached exact local hits need no network. Ambiguous fuzzy results need selection; noninteractive calls return candidates instead of guessing. Define jump-or-get's clone destination and require explicit selection before a fuzzy miss creates files. Test Bash, Zsh, Fish and PowerShell from installed artifacts.

**Get, Plan:39-42.** “Into current directory” must mean `$PWD/<repo-name>`, with the exact destination visible. Keep `--to` semantics unambiguous. Refuse unrelated existing destinations and protect preexisting content during cancellation. Reuse matching indexed clones only after verifying identity. SSH fallback must preserve host/port semantics and explicit SSH choices. Owner/org/star enumeration needs pagination, host/account scope and ambiguity handling; today's picker caps account/star lists, src/commands/clone.ts:129-132.

**Sync, Plan:53-54.** Specify local fetch/fast-forward versus remote fork mutation. `gh repo sync` is not interchangeable with updating a local checkout. Default to selected local checkouts; require explicit remote publication targets. Skip dirty, detached, busy, merging or diverged checkouts. Fetch once per common directory, serialize its mutations, and never switch another worktree's branch. Preserve base/upstream/push distinctions. Record each project's completed, skipped, failed or uncertain effects; cancellation cannot roll back earlier projects. Test two worktrees sharing refs and a fork whose upstream differs from its push remote.

**Remote scale, Plan:37-38.** Deduplicate requests across clones, fetch only requested fields, cap pagination and request cost, and return partial results with per-field freshness. Scope caches to host and authorization context. Respect reset/retry headers and reserve budget for foreground operations. [GitHub documents shared quotas and secondary limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api). ETags help authorized REST GETs returning 304, not every request or arbitrary GraphQL query; they do not remove secondary limits. [GitHub's guidance](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api) recommends serialized requests to avoid secondary limits. Bounded concurrency alone is insufficient.

4. Agent pillar

Keep the empirical gate, change its logic. “Bytes, calls, OR correctness,” Plan:58-59, allows smaller wrong answers to pass. Require correctness/evidence parity first, then a material gain on a declared outcome without unacceptable latency or safety loss. P0 safety repairs ship regardless of compression scores.

Compare equivalent questions against skilled native commands, native skills and available host tooling. Count end-to-end calls, retrieval cost, latency and tokenizer-measured consumption separately from displayed bytes. Freeze a held-out failure set, include precursor-step and unavailable-log cases, and judge correct diagnosis as well as evidence recall. Twenty cases earn an experimental release, not a universal superiority claim. A native script can win; ship that skill when it does.

Move exact-scope preflight fixtures and unresolved-thread reads ahead of broad agent marketing. Run the small CI prototype alongside Projects phase one, rather than discovering after bulk upkeep that the advertised second demo fails. The ≤1.5× porcelain target must not force omission of identity or conflict state; tiny clean outputs make fixed-envelope ratios misleading.

5. Coherence and cuts

This can be one product: find the right checkout, understand its state, perform an explicit GitHub action safely. Four equal pillars obscure that sequence. Projects is the entry point; correctness is every command's contract.

Fold `resume` into `projects <name>` or `go --status`. Keep fork sync as upkeep, not differentiation. Launch with editor handoff and external tuicr/delta support. Defer custom web/TUI review and structural anchoring until users need the ledger outside existing tools. Borrowing a renderer still leaves a review application to maintain. Never infer viewed-file state from merely opening an editor. Keep the owner's requested bulk upkeep, with the deletion limits above.

6. The ceiling

No additional idea earns scope now. The hard, valuable demo is a cleanup plan that explains exactly why each candidate is safe, refuses a raced item and preserves every other host's live work. That would substantiate the existing promise.

7. Verdict

**Ship to owner with edits.** Require safe cleanup authority and deletion proofs, explicit scan/identity/privacy contracts, scoped sync and request budgets, corrected research claims, a correctness-first benchmark gate, installed-platform checks and a smaller review commitment. No further strategy round is necessary.

Evidence: all requested documents read; prior adversary review and current source inspected; official Git/GitHub and gita documentation checked. These are plan findings, not runtime reproductions. No repository edits, tests or GitHub writes. Only this report was created. `$unslop` invoked and applied.
