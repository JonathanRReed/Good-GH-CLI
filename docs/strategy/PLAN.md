# Good GH: final plan (v6)

2026-10-22. Claude Opus 5.5 vs GPT-6.1 Sol (Codex, high) as adversary over five rounds; three
/interrogate panels (GPT-6.1 Sol, SWE-2, GLM-5.3); four research reports
(/tmp/ggh-research/{t3code,competitors,diff-review,agent-pain}-report.md). Round-5 verdict from all
three reviewers: "ship to owner with edits"; those edits are applied below. Binding: decisions.md.
Open: Q19 (verify placement).

## Thesis
**The GitHub CLI it should have been: find the right checkout, understand its state, act on
GitHub safely, for you and your agents.**
Multi-repo tools exist (gita has discovery, ahead/behind, bulk fetch, jumping; ghq has layout).
gh, git-town, Graphite and `but` are single-repo. Agent hosts track tasks, not clone hygiene.
The open slot is the combination: GitHub-aware + local-state-aware + agent-host-aware, with
honest safety contracts. Agents inside T3 Code / Codex / Claude still need Git/GitHub shell
operations alongside host tools, so ggh is a better tool for them to call. Never an orchestrator.
Human-first, ~60/40.

One sequence, not four pillars: **Projects is the entry point; correctness is every command's
contract; agent and review features ride the same state.**

## P0 (first, regardless of everything else)
- Head-pinned merges (`--match-head-commit`), re-read after merge, report merged / queued /
  auto-merge-enabled / unknown (prs.ts:181-206, pr-lifecycle.ts:185).
- Checkout workspaces never via `worktreeAdd` (.env copy :137, submodules :153, metadata :166);
  worktree removal rechecks dirty + ownership (:179); env allowlists (exec.ts:145).
- Worktree parser rewritten on `git worktree list --porcelain -z` keeping locked/prunable
  (worktree.ts:51-81 drops them).
- Agent envelope diet: `run` JSON stops duplicating jobs and fetches logs before returning;
  status stops bundling auth/provider probes by default.

## 1. Projects
### Identity (three levels, never conflated)
```
RemoteRepo { host, owner/name }                      // shared PR/CI metadata
Clone      { commonDir (canonical), remotes[], identity: path-keyed if no remote }
Checkout   { gitdir, path, head (branch | detached OID), locked?, prunable?,
             provenance: created-by (ggh|t3|cursor|claude|codex|unknown, from config markers
             e.g. t3-merge-base-ref, .cursor/worktrees.json, in-repo .claude/worktrees),
             hostClaims[] (observed, never authority to delete) }
```
### Discovery contract
- Roots are explicit and user-approved (owner: ~/Downloads); plus clones ggh made; plus each
  discovered clone's own `git worktree list --porcelain -z` (authoritative; catches worktrees
  outside every root); plus host locations probed, not assumed: `~/.t3/worktrees/<Project>/*`
  (two levels, and T3's custom/previous dirs), in-repo `.claude/worktrees`, `.cursor/worktrees*`;
  Codex layout to be probed.
- Stop descending at `.git` (dir or file) except registered nested repos and host in-repo dirs;
  bounded depth; exclusions; symlink-loop safe; never leave consented roots. Show coverage gaps.
- Handle bare, unborn, broken-gitdir, submodule cases explicitly.
- Privacy: index stores minimal metadata with private permissions; `forget`/`exclude`; credential
  URLs redacted; never reads host transcripts, databases or credentials.
### Status and performance
- Render cached rows first, refresh with bounded workers + per-repo deadlines; timestamps and
  unknown/error states shown. Disk size lazy/opt-in. Benchmarks: cold discovery and warm refresh
  on the owner's 72 repos + 45 T3 worktree dirs, large dirty repos, inaccessible paths.
- `--remote`: deduplicate across clones; aliased GraphQL batches for requested fields only;
  credential-scoped budget with foreground reserve; respect reset/retry headers; serialize to
  avoid secondary limits; partial results with per-field freshness.
### Commands
- `ggh` / `ggh projects [name]`: the table; `projects <name>` = context card (absorbs `resume`).
- `ggh clone` (alias `get`): extend existing clone (search, shallow/blobless already ship).
  Destination `$PWD/<repo>` shown before acting (owner's habit), `clone_root` config, `--to`,
  `--ask`. Paginated owner/org/star enumeration (today capped, clone.ts:129-132). T3-style
  progress, stall detection, SSH→HTTPS fallback preserving explicit SSH and host/port, credential
  redaction, cancel cleanup that protects preexisting content. Reuse an indexed clone only after
  identity check.
- `ggh go <name>`: shell function from `ggh init zsh|bash|fish|pwsh`; data-only path protocol,
  UI on stderr; spaces/newlines/leading-hyphen safe; identical basenames → selection; fuzzy miss
  requires explicit selection before cloning; non-interactive returns candidates. Prints the
  context card on arrival. `--editor`, `--t3` (probe deep link), `cd "$(ggh go --print x)"` fallback.
- `ggh sync [--all|names]`: existing per-repo sync gains multi-repo scope. Local only by default:
  fetch once per common dir, fast-forward-only, skip dirty/detached/busy/merging/diverged, never
  switch another worktree's branch. Fork upstream sync (remote mutation) only with explicit target.
  Per-project completed/skipped/failed/uncertain outcomes.
- `ggh tidy`: the only destructive bulk surface; shares one classifier with `sync`'s prune.
  - **Deletion proof per action:** bound to canonical clone/checkout identity, exact refs/OIDs,
    destination, relevant file state. "Unpushed" = any commit not reachable from a remote ref or
    PR head, including detached HEADs. "Merged" proven by ancestry or PR merge commit containing
    the exact tip, never a badge alone. Unknown = keep.
  - Recheck immediately before each effect; changed items are refused, never widen the batch.
    Remote branch deletes use expected-OID leases. Per-item overrides need separate approval.
  - Separates `git worktree prune` (missing metadata; honors locks and expiry, missing paths may be
    unmounted) from removing existing checkouts.
  - **Foreign checkouts:** discovered and reported; removed only through that host's own cleanup
    operation if one is supported; otherwise listed as manual candidates. Unknown provenance = keep.
  - Protects nested repos, submodules, ignored files (.env), detached commits; stashes protected at
    the clone level.
  - `--audit <provider>`: bounded metadata plan in, validated action IDs + keep/prune reasons out;
    no execution tools; invented IDs rejected; output intersected with the safe set; repo names and
    reasons treated as untrusted; disclosure scope shown; never sends file contents, .env,
    transcripts or credential URLs; honors hosted-AI consent and no silent local→hosted fallback.
    A user-chosen agent may apply the approved snapshot through ggh.
  - **Salvage section (`ggh lost`):** the inverse view of the same classifier: commits reachable
    from no remote ref or PR, stale stashes, uncommitted work in checkouts whose host session is
    gone. Read-only until you choose to push, branch, or stash-export. Launch hook.
- `ggh repo create --source` (existing; folder → private repo → push).

## 2. Agents (gate first, features second)
**Gate:** correctness and evidence parity with skilled native git/gh first; then a material gain
on a declared outcome (end-to-end calls, retrieval cost, latency, tokenizer-measured consumption,
diagnosis accuracy) without latency or safety loss. Baseline artifact pinned in-repo (from
agent-pain/benchmark.py plus a native-skill reference), held-out failure set, run in CI. If a
native script wins, ship the script as a skill. P0 safety repairs ship regardless.
- Compact local status: parity with `git status --porcelain=v2 --branch` plus base/push targets
  and fetch freshness; never omit identity or conflict state to hit a ratio; no network by default.
- `ggh ci why <pr|run>`: revision-linked bounded evidence (failed checks → steps → extracted lines,
  precursor steps when the failed step defers elsewhere, unavailable-log cases, explicit truncation).
  Prototype runs alongside Projects phase 1; blind-triage gate before it is advertised.
- Exact-scope preflight for mutations (index/HEAD/base/destination; never implicit `add -A`;
  preserve partial staging). Metric: unintended-scope incidents on 20 synthetic fixtures.
- Review threads: lossless reads with cursors early (correctness-prong feature; byte savings were
  only 9-27%); reply and resolve later as separate GraphQL effects with permission + canResolve;
  never auto-resolve on a fix.
- Host cooperation: return URL, host/repo, head SHA per PR layer for `link_pull_request` /
  `watch_pull_request`; never claim registration. Skill pack for Claude Code, Codex, T3 Code.
- MCP exposes only local state, projects, CI evidence, plan/approve. Not a second GitHub wrapper.

## 3. Review (smaller commitment)
- Launch: `ggh review 42 --editor` (worktree checkout via the safe path + editor; VS Code GitHub PR
  extension gives the full loop; `zed --diff`; `git difftool` fallback) and external tuicr/delta
  support when installed.
- Local review ledger (reviewed base/head SHAs) for `--since last`; viewed state is never inferred
  from opening an editor.
- Deferred until the ledger is needed outside existing tools: `--web` (@pierre/diffs, loopback +
  token), `--tui` (OpenTUI; FFI under bun --compile unproven; reordered behind web deliberately),
  `--structural` (difftastic).

## Deferred (named)
verify differential observations (Q19); task records/handoff; integrate --rehearse; shrink;
acceptance packs; git+GitHub rollback trail beyond existing operation recovery; `ggh lock`
(cooperative locks cannot stop external writers; revisit if worktree races show up in dogfooding).

## Cuts
label, secret, variable, gist, search, browse, team, triage, workflow UI, release, changelog
(unless used to ship ggh); draft restore → stash; notifications kept permanently as a small
non-interactive inbox (it is inbox-shaped, projects is repo-shaped). Stack engine → gh-stack
interop where equivalent; keep durable stack recovery.

## Distribution and launch
- One install channel first (fix npm blocker), Homebrew next; `ggh init <shell>`.
- Demo: `ggh` across the owner's real repos → `ggh lost` ("N checkouts hold commits that exist
  nowhere else") → `ggh tidy --audit codex` explaining why each candidate is safe, refusing one
  raced item, leaving a live T3 worktree alone.
- Agent claims only as measured: "prototype output bytes vs verbose retrieval" until the blind
  trial earns more. Publish the benchmark including losses.

## Validation
- Owner dogfood on ~/Downloads (72 repos) + ~/.t3/worktrees (45 dirs).
- Fixtures: discovery (nested, submodule, bare, unborn, broken gitdir, symlink loop, identical
  basenames, host in-repo dirs), tidy proofs (detached commits, moved remote tip, ignored file added
  after approval, queued host turn on a clean worktree, unmounted path, locked worktree), sync
  (two worktrees sharing refs, fork with different upstream/push remotes), status parity.
- Installed-artifact checks on macOS, Linux, Windows for shell hooks, paths, cancellation,
  packaging, storage permissions.
- Uncoached outsider: `ggh init && ggh clone && ggh tidy`.

## Sequencing
0. P0. Dry-run classifier on the owner's machine (read-only) to size the problem honestly.
1. Identity + discovery + index + `ggh`/`projects` + `clone` extensions + `go` + `init`.
   In parallel: `ci why` prototype + gate harness; review-thread lossless reads.
2. `sync --all`, `tidy` with proofs, `lost`, `--audit`, `projects --remote`.
3. Compact status, preflight fixtures, skill pack, `review --editor` + ledger.
4. Cuts, README rewrite around projects, experimental release + demo.
5. Thread writes, gh-stack interop, deferred items by observed need.
