# ggh competitive landscape — October 2026

Baseline: `ggh` 0.5.0-beta.2 already ships commits/PR/issues/CI/stacks/worktrees/notifications/releases, AI messages (multi-provider, off by default), `--json`/`--agent` envelope v1 + `ggh agent schema`, an MCP server, `--dry-run`/`--approve-plan` snapshots, and local operation records. Its only major coverage hole is **area 1: multi-project management** (no inventory/status across local clones or remote repos). Sources: README, repo source.

## Matrix (tool × area)

Legend: `·` none, `~` partial/manual, `+` good, `++` best-in-class. Areas: 1 acquire/multi-project, 2 repo-from-folder, 3 commit/branch/push(+AI), 4 PR lifecycle, 5 diff, 6 undo, 7 stacks, 8 worktrees, 9 agent interface, 10 CI/logs, 11 notifications, 12 forks/sync, 13 releases.

| Tool |1|2|3|4|5|6|7|8|9|10|11|12|13|
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **gh 2.103** (+gh-stack, agent-task, copilot) | ~ clone/list/search only | + `repo create --source` | · (delegates to git; Copilot CLI separate) | ++ full create/diff/review/merge | ~ patch → `$PAGER`/delta | · | + official `gh stack` ext | · | + `--json/--jq`, `agent-task`, `gh skill` | ++ run/checks/logs | · (exts only) | + fork+`repo sync` | ++ full |
| **GitHub Desktop 3.6** | ~ repo list, no status | + | + Copilot msgs (BYOK), AI conflicts | + create/view/status | ++ GUI | ~ undo last commit | · | + new in 3.6 | · | + check badges | · | + fork flow | ~ |
| **GitHub MCP server** | ~ API search/create/fork | + `create_repository` | ~ push_files API only | + full remote | ~ | · | ~ stacked links | · | ++ toolsets, `/readonly`, lockdown | + actions toolset | + notifications tools | + fork | + |
| **Codex app + CLI** | ~ projects = dirs; no inventory | · | + commit/push/PR in app; stage/revert chunks | ~ PR create in app | ++ diff pane + inline comments | ~ | · | ++ managed worktrees (`codex worktree`, threads) | + `exec`, JSONL, MCP | ~ | ~ cloud tasks | · | · |
| **Claude Code (CLI+desktop)** | ~ sessions by folder | · | ~ via agent running git/gh | + PR monitor, auto-fix CI, auto-merge | ++ diff view, line comments, Review btn | ~ | · | + `claude -w`, session worktrees | + Agent SDK, MCP host | ~ via gh | ~ | ~ | ~ |
| **Cursor (Agents Window)** | + multi-workspace across repos | · | ~ via agent | ++ Reviews/Commits/Changes tabs; split-into-PRs | ++ | ~ | ~ split changes→PRs | + session worktrees auto-cleaned, `.cursor/worktrees.json` | + agent CLI/JSON, Bugbot | ~ PR checks | ~ inbox-ish | ~ | · |
| **Conductor (Mac)** | + workspace-per-task model | · | ~ via nested agent | + diff→PR→merge→archive | + diff viewer | ~ archive | · | ++ worktree-per-workspace core | + Conductor API | + checks pane | ~ | ~ | · |
| **GitButler app + `but` CLI** | ~ per-repo projects only | ~ | ++ commit selected files/hunks by ID, `--ai` | + `but pr` GH/GitLab/BB, stack PRs, auto-merge | + | ++ oplog unlimited undo | ++ parallel+stacked branches | ~ virtual branches instead | ++ JSON-all, `but mcp`, `but agent setup` skills | · | · | ~ | · |
| **lazygit 0.66** | ~ recents | · | ++ hunk staging from main view | · (opens links) | + TUI | ~ reflog hints | · | ~ submodule/wt display | · | · | · | · | · |
| **gh-dash 4.26** | ~ per-repo sections | · | · | + PR browse/diff/checkout/CI | + delta diffs | · | · | · | ~ YAML/custom actions | + CI in TUI | ~ PR/issue queries | · | · |
| **Jujutsu 0.46** | ~ colocate | ~ | + change-IDs, describe | · (`jj git push` + gh) | + | ++ op-log undo | + implicit via revsets | + `jj workspace` | + stable IDs, `-T` templates | · | · | ~ | · |
| **Sapling (`sl`+ISL)** | ~ | ~ | + smartlog UX | ~ `sl pr submit` GH | + ISL web UI | + undo-ish | + native stacks | ~ `sl worktree list` | ~ | ~ | · | ~ | · |
| **git-town 24.1** | ~ | ~ | + hack/sync/propose/ship | ~ `propose` opens forge PR | ~ | + `town undo` | + append/prepend/compress | + worktree-aware | ~ detects non-interactive/agents | ~ | · | + multi-forge sync | · |
| **Graphite `gt` 1.8** | ~ | ~ | + create/track | ++ submit stack→PRs, merge queue, inbox | + (web) | + `gt undo` | ++ flagship | ~ | ~ | + per-PR checks | + PR inbox | ~ | · |
| **ghq / gita / mani** | + clone-org (ghq), status table (gita), clone-all+run (mani) | ~ | · | · | · | · | · | · | · | · | · | · | · |
| **Tower / Fork (GUIs)** | ~ repo list | + | + Tower undo ⌘Z; Fork i-rebase/hunks | ~ | ++ | + | · | + Tower | · | ~ | · | ~ | ~ |
| **git-branchless 0.11** | · | · | + record/split | ~ `git submit` (buggy) | ~ | ++ whole-repo `git undo` | + restack/smartlog | ~ | ~ | · | · | · | · |
| **ggh (baseline)** | ~ `ggh clone` search only | + `repo create` + `pr create` plan | ++ `--ai`, split, review-gates | ++ create/edit/review/merge + drafts/recovery | ~ git diff | + undo/discard/op records | + config-parented, restack | + `ggh wt` | ++ `--agent` envelope, schema, MCP | + checks/run logs | + `notifications`/`triage` | + `repo sync` | + release/changelog |

## WHITE SPACE (ranked)

### (a) Human at a terminal managing many personal projects

1. **Cross-repo "mission control"** — one command answering: which of my N local clones is dirty, behind, has unpushed commits, stale branches, orphaned worktrees — *and* which repos exist on GitHub but aren't cloned, plus open-in-editor/agent and archive/cleanup. **Who lacks it:** everyone. gita shows a static branch/dirty table (git-only, no remotes/worktrees/GitHub, near-dormant); mani runs ad-hoc commands but computes no status; ghq is directory layout only; gh/git-town/graphite/but are all single-repo; agent hosts (Codex app, Cursor Agents Window, Conductor) track *tasks*, not clone hygiene. **Why CLI:** it's a metadata join over `~/*/.git` + `gh api user/repos` — instant, scriptable, no GUI needed. ggh has every primitive except the inventory layer.
2. **Fuzzy project jump/clone** — `ggh open foo` → cd if cloned, search+clone+cd if not. Who lacks it: ghq+fzf solves it only as hand-rolled shell snippets; nothing ships it integrated with GitHub search. CLI-native by definition.
3. **Worktree/branch garbage collection across all clones** — agent-era checkouts leak constantly; no tool finds dead worktrees, merged branches, or disk hogs across repos. GitHub Desktop 3.6 flags missing worktree folders *per repo* only.
4. **"Resume context" per project** — last active branch, dirty summary, open PR + failing CI for a repo you haven't touched in weeks. Nothing composes this; ggh has each field already.

### (b) Coding agent inside a host (T3/Codex/Claude)

5. **Compact structured *local* git state in one call** — `{branch, ahead/behind, staged/unstaged/conflicts, PR link, CI}` at a fraction of `git status --porcelain`+N calls' tokens. **Contested but unowned:** zagi ("a better git interface for agents", succinct/--json modes, ~50% smaller output), Pare `@paretools/git` MCP (claims ~92% token cut on `git log`), gitsift (hunk IDs, TOON output), `but` (JSON on everything). But zagi/Pare/gitsift are *local-only slices* — no forge ops, no multi-repo; `but` needs its own workspace-mode branch model. GitHub MCP is remote-only — it cannot read a local checkout at all. gh has `--json` but nothing for local state. A single binary doing compact local state **+** GitHub ops is unclaimed. Evidence: github.com/mattzcarey/zagi, npm @paretools/git, github.com/MonteYin/gitsift.
6. **Plan→approve handoff for mutating ops** — dry-run returns a signed snapshot; agent submits `--approve-plan <id>` to execute exactly what was previewed. Who lacks it: git/gh entirely; but has force-push protection only. ggh already ships this (`--dry-run`/`snapshotId`/`--approve-plan`) — genuinely novel, worth marketing as the safety primitive.
7. **Multi-clone/worktree state for hosts** — "which of my 15 checkouts is clean / already has branch X / owns worktree Y" in one JSON call. Hosts manage only worktrees they created; Codex `codex worktree list` scopes to Codex-managed only. Nobody does repo-agnostic multi-clone state.
8. **Undo/rollback across git+GitHub ops** — jj op-log, branchless `git undo`, `but` oplog all cover *local* mutations only; nothing undoes "opened PR, pushed branch, created repo". ggh `operation records`/`recover` is the right skeleton; extending it to an auditable rollback trail is open ground.
9. **Tight "why did CI fail" primitive** — `gh run view --log-failed` is verbose text; MCP actions tools are heavyweight. A compact structured failure digest (job → failing step → relevant log tail → suspected cause) for agents isn't shipped by anyone.

## Already solved — do not build

- **AI commit messages / PR bodies**: GitHub Desktop (Copilot SDK + BYOK + repo-instructions), `but --ai`, ggh `--ai`. Covered thrice over.
- **Stacked PR machinery**: four solid implementations — official `gh stack` ext, Graphite `gt`, git-town, `but`. ggh's exists. Don't invest further here.
- **Worktree-per-agent-task**: every host owns it (Codex app threads, Claude `--worktree`/desktop sessions, Cursor worktrees, Conductor workspaces). ggh `wt` should stay a utility, not a product pillar.
- **AI PR review**: Claude `/code-review` + Code Review on PRs, Codex `codex review`, Cursor Bugbot, Graphite AI reviews, ggh `pr review --ai`. Saturated.
- **Local-git TUI**: lazygit owns it; gh-dash owns PR/issue TUI. Don't build a dashboard; ggh should stay script-first.
- **GitHub-over-MCP**: official github-mcp-server is deep (toolsets, readonly, lockdown). ggh's MCP should expose only what it uniquely adds (local git state, projects, approve-plan) — not a second GitHub API wrapper.
- **Fork/upstream sync**: `gh repo sync`, `repo fork`, git-town sync. Commodity.
- **Releases**: `gh release` CRUD is complete; ggh `release`+`changelog` parity is enough.

## Is "the agent-optimal git interface" an unclaimed niche?

**Contested, not owned.** The positioning is now a real category — GitButler markets `but` explicitly at agents (vcbench.dev claims ~80% fewer commands than git), plus zagi, Pare, and gitsift as narrow entrants. But the claim is fragmented:

- **`but` comes closest** on the local-VC side: JSON on all commands, `but mcp`, `but agent setup` writing skills into Codex/Claude/Cursor, oplog safety. Gaps: requires GitButler workspace-mode repo (not drop-in on a plain checkout), thin GitHub breadth (PR create/auto-merge only — no issues, CI, notifications, releases, search), single-repo.
- **zagi** is closest to "drop-in git replacement" (succinct/--json/--compat, agent detection) but is local-only, ~zero GitHub ops, early.
- **gh** owns remote-side structure (`--json` everywhere) and is becoming agent-aware (agent-task, gh skill, agent-invocation help) — but will never model local clones or multi-project state.
- **GitHub MCP** owns remote ops for agents — zero local git.

Nobody ships, in one binary: compact structured **local** state + a safety envelope for mutations + full GitHub ops + multi-project inventory. That composite — not "JSON for git" alone — is the unclaimed slot, and ggh is unusually close to it already (`--agent` schema + MCP + approve-plan + op records). The differentiation path is the pieces competitors structurally can't add: cross-clone state, plan/approve tokens, and operation recovery spanning git *and* GitHub — measured against `but`'s JSON and zagi's token budgets so the claim is empirical, not marketing.

## Sources (selected)

- gh 2.100–2.103 releases: github.com/cli/cli/releases; `gh agent-task`: cli.github.com/manual/gh_agent-task; `gh copilot` shim: github.blog/changelog/2026-01-21-install-and-use-github-copilot-cli-directly-from-the-github-cli/
- gh stack ext + skill: github.com/github/gh-stack, docs.github.com/en/pull-requests/reference/stacked-prs-cli-commands
- GitHub MCP: github.com/github/github-mcp-server (tools.go, remote-server.md, server-configuration.md)
- Codex app/CLI: openai.com/index/introducing-the-codex-app, learn.chatgpt.com/docs/environments/git-worktrees, developers.openai.com/codex/cli/slash-commands, github.com/openai/codex PR #21435
- Claude Code: code.claude.com/docs/en/desktop, /worktrees, /code-review; claude.com/resources/articles/preview-review-and-merge-with-claude-code
- Cursor: cursor.com/docs/configuration/worktrees, /docs/agent/agents-window.md, changelog 05-07-26; cursor.com/blog/graphite (acquisition Dec 2025)
- Conductor: conductor.build/docs (workspaces, git-worktrees, parallel-agents)
- GitButler: blog.gitbutler.com/but-cli, /using-gb-mcp; docs.gitbutler.com/cli-guides/cli-tutorial/{ai-stuff,forges,branching-and-commiting}, docs.gitbutler.com/ai-agents/{overview,getting-started}
- lazygit v0.66.2, gh-dash v4.26.2 releases; jj v0.46 release notes; sapling releases; git-town v23/24 CHANGELOG + commands; Graphite CLI changelog 1.8.6; git-branchless v0.11.1
- Agent-git niche: github.com/mattzcarey/zagi, npmjs.com/@paretools/git, github.com/Dave-London/Pare, github.com/MonteYin/gitsift, agentfirstcli.github.io
- Multi-repo: github.com/x-motemen/ghq, nosarthur/gita, alajmo/mani, manicli.com
