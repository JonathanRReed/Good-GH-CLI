# Good GH: v5 plan (Claude Opus 5.5)

Supersedes v4 after owner rounds 2-5 and four research reports:
/tmp/ggh-research/{t3code,competitors,diff-review,agent-pain}-report.md. Binding: decisions.md.

## What changed since v4
The owner's Q6 answer moved the center. T3 Code, the Codex app and Claude already own the agent
workflow (worktree-per-task, PR linking/watching, diff panes, thread handoff). v4's task-handoff
thesis overlapped with them. Research found the actual white space is (1) multi-project management,
which no tool does (competitors report, white space #1-4), and (2) agents inside those hosts still
run raw git/gh for every operation (T3 report), so ggh can be the better git/gh they call.
Human-first, ~60/40 (Q15).

## Thesis
**The GitHub CLI it should have been: every project you own, one command away, for you and
your agents.** Today's gh is single-repo, request-shaped, and unsafe by default. ggh is
project-shaped, honest about outcomes, and cheap for agents to read.

Distinct from: gh (single repo, no local state), ghq/gita/mani (no GitHub, no status depth),
lazygit (single-repo TUI), GitButler `but` (requires its workspace mode, thin GitHub, single repo),
agent hosts (task-scoped, not clone hygiene; agents still shell out to git/gh).

## Pillar 1: Projects (the wedge; human-first)
Data shape first:
```
ProjectIndex (local, private, user config dir)
  Project { id: host/owner/name?, paths[]: {path, kind: clone|worktree, owner: ggh|t3|codex|claude|cursor|unknown},
            remote: {defaultBranch, fork?, upstream?}, lastTouched, pinned? }
  Discovery: clones ggh made + configured scan roots (default: none; owner sets ~/Downloads)
             + known agent worktree dirs (~/.t3/worktrees, Codex/Claude/Cursor locations), shallow scan,
             cached; never moves anything.
ProjectStatus (derived on read, local first, remote optional):
  dirty, staged/unstaged/untracked counts, ahead/behind (with fetch freshness), unpushed branches,
  merged-but-undeleted branches, orphan/dead worktrees, stash count, open PRs, failing CI, disk size
```
Commands:
- `ggh` (no args) / `ggh projects`: one table across every project. Local fields instant; remote
  fields (`--remote`) bounded concurrency, cached with ETags, freshness shown. `--agent` compact.
- `ggh get <query|owner/repo|url>`: fuzzy search your repos, orgs, stars, then clone. Default
  destination = current directory (owner's `cd ~/Downloads && clone` habit); `clone_root` config
  or `--to` / `--ask` each time. Keeps existing search + shallow/blobless; adds T3-style progress,
  stall detection, SSH→HTTPS fallback with explicit protocol choice, credential redaction, cancel cleanup.
- `ggh go <name>`: jump-or-get. Shell hook via `ggh init zsh|bash|fish|pwsh` (zoxide-style).
  `--editor`, `--t3` (if T3 accepts a path/deep link; probe), configurable default.
- `ggh resume <name>`: context card for a project you left: branch, dirty summary, stashes,
  unpushed, open PRs, failing CI, last commits, worktrees.
- `ggh tidy`: one preview, one confirmation for the batch: prune merged branches (local + remote
  where owned), remove dead worktrees (any owner kind, with that host's metadata respected),
  flag stale repos, gc hints, fork drift. **Invariant: never touches uncommitted, unpushed,
  stashed, or ignored-but-present files (.env) without an explicit per-item override.**
  `ggh tidy --audit <provider>`: chosen AI reviews the plan, annotates keep/prune with reasons;
  execution still goes through the same approval snapshot; the AI can narrow, never widen.
- `ggh sync`: across selected projects: fetch, fast-forward-only pulls, fork upstream sync,
  report conflicts instead of resolving.
- `ggh new` (exists: folder → private repo → push in one confirmation).

## Pillar 2: Agent-grade git/gh (the 40%; measured, not asserted)
Rule from the agent-pain report: **no agent feature ships unless it beats skilled native
git/gh on bytes, calls, or correctness in a recorded benchmark.** Today ggh loses (state 5×
porcelain, run JSON 3.3× native). Fix that first.
- **Compact state:** `ggh status --agent` local-only by default, parity with
  `git status --porcelain=v2 --branch` plus base/push targets and fetch freshness; remote and
  provider probes opt-in. Target: ≤1.5× porcelain bytes, no network, <150 ms.
- **CI evidence bundles:** `ggh ci why <pr|run> --agent`: revision-linked, bounded, failed checks →
  failing steps → extracted evidence lines with line numbers, plus precursor steps when the failed
  step only points elsewhere (VS Code case), annotations, artifact links, explicit truncation.
  Measured ceiling 97.8-99.5% reduction. Gate: blind triage of 20 archived public failures vs a
  strong native skill; reject if evidence recall drops.
- **Exact-scope mutation preflight:** commits/pushes/publication bind to worktree, HEAD, index,
  base, destination (extends existing approval snapshots). Never `add -A` implicitly; preserve
  partial staging (T3 resets it). Recoverable outcomes (completed / pending / uncertain).
- **Review threads:** lossless read with cursors, reply and resolve as separate effects via GraphQL
  node ids, permission + `canResolve` checks, never auto-resolve on a fix (T3 semantics, Q12).
- **Host cooperation:** after creating PRs return canonical URL, host/repo, head SHA per layer so the
  agent calls `link_pull_request` / `watch_pull_request`. Never claim registration.
- **Skill pack** (Claude Code, Codex, T3 Code): when to use ggh vs raw git; pager/editor/prompt-free
  invocation; the envelope contract.
- Do NOT build: worktree lifecycle manager, bespoke CI polling, automatic conflict resolution,
  generic log JSON, a second GitHub MCP wrapper. MCP exposes only what ggh uniquely adds
  (local state, projects, CI evidence, plan/approve).

## Pillar 3: Review (state is ours, rendering is borrowed)
- Local review ledger: reviewed base/head SHAs per PR, viewed files, stale marks; `--since last`
  across pushes/rebases (T3 has no arbitrary baseline; GitHub's exists only for submitted reviews).
- `ggh review 42 --editor`: worktree checkout + open editor (VS Code + GitHub PR extension = full
  loop; `zed --diff` multi-file; `git difftool` fallback). Build first.
- `ggh review 42 --web`: local loopback page, random port + token, embedded @pierre/diffs (T3's
  renderer), comments post as real review comments. Second.
- `ggh review 42 --tui`: only first-class: OpenTUI + @pierre/diffs (verify bun --compile FFI
  embedding first); otherwise hand off to tuicr/delta. Third, gated.
- `--structural` (difftastic) experiment.

## Pillar 4: Correct by default (existing strength + P0)
- P0: head-pinned merges (`--match-head-commit`), re-read after merge, merged / queued /
  auto-merge-enabled / unknown; dedicated verifier/checkout workspaces without .env copy;
  worktree removal rechecks dirty + ownership; env allowlists; fix agent envelope bloat.
- Keep: approval snapshots, operation recovery, stack recovery checkpoints (T3 lacks durable
  stack resume), literal paths, honest partial outcomes.

## Deferred (named)
`verify` differential observations (not built into hosts, but large; revisit after Pillars 1-2
ship); task records/handoff (overlaps host thread handoff); integrate --rehearse; shrink;
acceptance packs; gauntlet (becomes the agent-benchmark artifact instead).

## Cuts
label, secret, variable, gist, search, browse, team, triage, workflow UI, release, changelog
(unless used to ship ggh); draft restore → stash; notifications kept (small, non-interactive)
until `projects --remote` covers it. Stack engine → gh-stack interop where equivalent.

## Distribution and launch
- One channel first (fix npm blocker), Homebrew next; `ggh init` shell setup.
- Launch demo: `ggh` across 72 real repos: "9 have uncommitted work, 2 unpushed, 20 agent
  worktrees, 14 merged branches to prune" → `ggh tidy --audit codex` → one confirmation.
  Second clip: agent fixes a red PR with `ggh ci why` using 1% of the tokens.
- Publish the agent benchmark (bytes, calls, evidence recall vs native) including losses.

## Validation
- Owner dogfood on ~/Downloads (72 repos, 20 T3 worktrees).
- Agent benchmark harness (from /tmp/ggh-research/agent-pain/benchmark.py) in-repo, run in CI.
- Fixtures: discovery (nested repos, submodules, worktrees of each host, broken gitdirs),
  tidy safety (unpushed, stashed, .env present, other-owner worktree, concurrent agent), sync
  (diverged, fork), status parity with porcelain.
- Uncoached outsider runs `ggh init && ggh get && ggh tidy`.

## Sequencing
0. P0 fixes; agent envelope diet; owner sample of tidy candidates (dry-run on ~/Downloads).
1. ProjectIndex + discovery + `ggh`/`projects` local + `get` + `go` + shell init.
2. `resume`, `tidy` (+ `--audit`), `sync`, `projects --remote`.
3. Agent: compact status, `ci why` prototype + blind-triage gate, skill pack.
4. Review ledger + `--editor`; cuts; README rewrite around projects.
5. Experimental release + launch demo.
6. `--web` review, review threads write path, gh-stack interop, `--tui` if earned.
