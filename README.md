# Good GH

[![CI](https://github.com/JonathanRReed/Good-GH-CLI/actions/workflows/ci.yml/badge.svg)](https://github.com/JonathanRReed/Good-GH-CLI/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/JonathanRReed/Good-GH-CLI?include_prereleases&label=release)](https://github.com/JonathanRReed/Good-GH-CLI/releases)

I hated the GitHub CLI. This makes it bearable. `ggh` is the GitHub CLI it should have been: find the right checkout, understand its state, act on GitHub safely, for you and your agents. Start with one table across local clones and agent worktrees, jump to a project, find unpublished work, then review or publish from the right checkout. It uses your installed `git` and `gh`. AI is optional.

## Install

The source candidate is `0.6.0-beta.1`. It has not been published by this preparation step. For released binaries, checksums, PATH setup, and dependencies, follow the [installation guide](docs/INSTALL.md) and the selected version's [release notes](https://github.com/JonathanRReed/Good-GH-CLI/releases).

Standalone binaries need Git 2.31+, plus `gh` for GitHub operations. They need neither Bun nor Node. Bare macOS binaries are ad-hoc signed; a signed, notarized DMG is a separate artifact. Check that release's receipts.

Build this candidate from a checkout with Bun 1.4.4 (pinned in `.bun-version`):

```bash
bun install --frozen-lockfile
make install PREFIX="$HOME/.local"
export PATH="$HOME/.local/bin:$PATH"
ggh --version
```

Package tarballs need Node 22+, Bun 1.4+, and Git. Install a downloaded tarball with `bun add -g ./good-gh-cli-<version>.tgz`. Use the npm registry only when that version's release notes confirm publication. See [packaging](docs/PACKAGING.md) for lean installs and distribution gates.

## 60-second tour

Choose a scan root once. Roots start empty; ggh also remembers clones it creates.

```bash
ggh projects roots add ~/Downloads
ggh                                  # Projects table
eval "$(ggh init zsh)"                 # Add this line to ~/.zshrc
g Good-GH-CLI                         # Change this shell's directory
cd ~/Downloads
ggh clone owner/repo                  # Search queries also work; alias: get
ggh projects repo                    # Checkouts, unpublished work, stashes, history
ggh lost                             # Find work absent from local tracking refs
ggh tidy --dry-run                    # Preview cleanup in the current clone
ggh tidy --audit codex --ai --dry-run # Optional provider audit; requires consent
ggh sync --all                       # Fetch and fast-forward eligible checkouts
ggh review 42 --editor                # Prepare a review checkout and open it
ggh ci why                           # Bounded failure evidence for this branch's PR
```

`ggh clone <query>` searches your repositories, organizations, stars, and GitHub. The destination is `$PWD/<repo-name>` unless you set `clone_root` or pass `--to`. `--ask` chooses a destination; `--fast` uses a blobless clone and `--shallow` limits history. Reuse requires an origin identity check. Clone progress goes to stderr; cancellation cleanup protects preexisting content.

Projects gives each clone its own row and includes linked checkouts wherever Git lists them. Discovery stops at a repository, reports skipped paths, and never reads host transcripts. Warm terminal views show dated cached rows while refreshing; JSON and piped output wait for fresh local state. Unknown fields stay visible.

```bash
ggh projects --remote                 # Add PR counts, review requests, and CI
ggh projects repo --remote            # PRs and default-branch checks
ggh projects --remote --refresh       # Bypass the five-minute result cache
ggh projects --uncloned               # Also enumerate owned repos without clones
ggh projects register /work/outer/nested
ggh projects exclude /work/archive
ggh projects forget /work/old
ggh go repo --editor
ggh go repo --t3
ggh go repo --print                   # Path only
```

Remote reads share lookups across clones of the same host/repository. Requests serialize per host, preserve foreground quota, and return partial fields with ages and failure reasons. A 20-second deadline bounds remote work. These reads do not fetch local Git refs. `--uncloned` covers owned repositories, with bounded enumeration; incomplete counts remain explicit.

The shell hook also supports bash, fish, and PowerShell through `init bash`, `init fish`, and `init pwsh`. Identical project names require a choice or an exact checkout path. A missing name suggests cloning; it never clones automatically. Repository paths travel as data, including spaces and trailing newlines.

`lost` counts unpublished commits once per clone, with shared/exclusive branch counts and fetch age. It also reports stashes, dirty host checkouts, and broken gitdirs. Its suggested recovery commands are never executed. Tracking refs can be stale; the report cannot prove that a host session is abandoned. `lost --fetch` explicitly updates tracking refs first.

Bulk sync fetches each remote once per clone and fast-forwards eligible checkouts to their own upstream. It skips dirty, detached, busy, locked, diverged, upstreamless, and host-owned checkouts. It never switches branches, rebases, pushes, or deletes local branches. Select names with `ggh sync api web`. Remote fork updates require `--fork-upstream` and confirmation. Plain `ggh sync` retains single-repository stale-branch cleanup.

Review prepares a separate checkout without copying `.env` files or initializing submodules. `--editor` requires a supported GUI editor; plain review can fall back to terminal diff tools. `--mark` records inspected base/head SHAs explicitly; `--since last` compares against that mark. Opening an editor does not mark a review complete. Agent mode returns data without launching an editor, but can fetch refs and create the checkout.

`ci why` links failed checks, steps, annotations, and extracted log lines to a revision. It reads full-job logs when a failed step points elsewhere. Missing logs, stale runs, and truncation remain explicit. It is a read-only prototype; diagnosis accuracy has not passed a blind trial.

## For agents

Read the [ggh skill](skills/ggh/SKILL.md) and its [generated command reference](skills/ggh/reference.md). The pack covers Claude Code, Codex, T3 Code, and Cursor.

```bash
ggh agent brief --agent
ggh agent skill
ggh agent skill --install claude --dry-run --agent
ggh agent skill --install codex --yes --agent
ggh agent schema --agent
ggh status --agent
ggh projects repo --agent
ggh pr threads 42 --agent
ggh ci why 42 --agent --max-bytes 6144 --context 2
```

Start a session with `ggh agent brief --agent`. One call returns checkout identity, the branch PR, its CI counts and failing check names, the unresolved thread count, linked issues with their artifacts, and native stack position. Each GitHub section reports `available`, `none`, `unavailable` with a reason, or `skipped`, so one failed read never hides the rest. Remote reads share a 15-second deadline; `--local` makes no GitHub calls.

Skill installation copies both files, requires approval, and refuses differing files unless explicitly forced. `--install t3` explains provider directories; an explicit path names the final skill directory. Dry runs write nothing.

Managed `--agent` commands never prompt and return compact JSON with `contract: "ggh.agent"` and `version: 1`. Read `status`, `error.code`, `error.retryability`, `requiredInputs`, and `effects` before continuing. Inspect completed, pending, and uncertain effects after a partial failure. Read-only status may omit empty effects. Other results remain command-specific; discover their schemas from the installed version.

Agent status includes full HEAD identity and XY/path tuples, including rename sources and conflict codes. `--full` adds raw porcelain-v2 records. Omitted counts mean zero, omitted `root` means cwd, and omitted `push` means upstream. `fetchedAt` is local fetch metadata, not proof of current remote state. Status is local unless you request `--remote` or `--providers`.

Inspect the staged patch before committing. `ggh commit` preserves partial staging but has no `--approve-plan`. For PR publication, preview the exact inputs with `--dry-run --agent`, inspect the returned `snapshotId`, then use `--approve-plan` with identical inputs. Tidy requires its own exact approved snapshot in agent mode. `--yes` is not permission from a human.

After PR creation, the calling agent must register the returned URL with its host, such as T3 Code's `link_pull_request`. ggh does not register or monitor PRs on the host's behalf. Review-thread reads preserve full comments and cursors; fixing code does not resolve a thread.

### What the benchmark proves

The [offline benchmark](bench/agent/README.md) reports both wins and losses with 100% declared evidence recall across nine cases. VS Code CI output falls from 133,470 native bytes to 8,625 ggh bytes. A recorded session-start brief costs 945 bytes in one call versus 1,710 bytes across five tuned native calls. A tuned native Zod CI filter wins at 5,402 versus 7,231 bytes. Clean status costs 181 versus 121 porcelain-v2 bytes; dirty porcelain-v1 and native run-detail output are smaller too.

Use native `git log`, `diff`, and `blame` for ordinary history and patches. ggh earns its place when checkout identity, bounded CI evidence, structured project state, or guarded mutations save work. Benchmark tokens are bytes divided by four. No tokenizer, blind repair trial, or latency comparison supports broader savings claims. Native scripts can combine their commands into one tool call.

## Everyday commands

Use `ggh <command> --help` for options. These examples assume you have inspected the checkout and target.

### Commit and publish

```bash
ggh status
ggh git diff --cached
ggh commit -m "fix: handle empty input" # Commit the reviewed index
ggh commit --ai                       # Opt into message generation
ggh pr create --dry-run --agent       # Preview before publication
ggh pr                               # Browse pull requests
ggh pr 42
ggh pr threads 42 --agent
ggh pr merge 42
ggh operation list
ggh operation view <id>
ggh operation resume <id> --dry-run
```

Managed publication binds approval to the destination, visibility, revisions, content, and attachment bytes. Changed inputs require a fresh plan. Merge pins the reviewed head and rereads GitHub state; queued, auto-merge-enabled, unknown, and confirmed merged outcomes stay distinct. Cleanup follows only a confirmed merge.

Recovery records contain metadata and confirmed/pending/uncertain effects, without message bodies, prompts, or transcripts. Resume requires missing content again and refuses changed revisions. Set `GGH_NO_RECORDS=1` to disable recording. `ggh operation prune` removes old records after confirmation.

### Branches and stacks

```bash
ggh sw -c feat/login
ggh wt add "add dark mode"
ggh wt list
ggh stack next feat/api
ggh stack list
ggh stack list --remote
ggh stack restack
ggh stack restack --continue
ggh stack restack --abort
ggh stack submit
ggh stash push --name "login work"
ggh stash list --named
ggh stash restore "login work"
ggh log
ggh undo
ggh discard --all --dry-run
ggh squash 3 --message "feat: combine changes" --no-input
```

Stack parents live in Git config. Restack changes local branches; submit explicitly publishes, using expected-tip leases for rewritten branches. Plain stack list is offline. When the submitted branches form one chain, submit also links the PRs as a [GitHub stack](https://docs.github.com/en/pull-requests/how-tos/stacked-pull-requests): it creates one or appends to a matching one, never reorders a different one, and reports `nativeStack` (`--no-native-stack` opts out). `ggh pr merge` on a stacked PR lists every unmerged PR below it, rechecks their heads after confirmation, and merges them in one atomic step through the async merge API. Named stash restore pops after confirmation; legacy tagged stashes still work. Squash keeps original commits under a recovery ref. Inspect partial failures before retrying.

### Issues, CI, and repositories

```bash
ggh issue
ggh issue create
ggh issue 42                          # Includes plans and other issue artifacts
ggh issue develop 42
ggh checks
ggh checks --watch
ggh run 12345 --agent
ggh run rerun 12345 --failed
ggh repo create --source .
ggh notifications
ggh notifications mark
ggh mcp --list-tools
```

Local MCP tools expose their own protocol. GitHub operations use your installed `gh` authentication. For Enterprise, sign in with `gh auth login --hostname ghe.example.com` and select `GH_HOST` as appropriate.

Native escapes preserve their streams and exit codes:

```bash
ggh git status --short
ggh gh pr list
ggh -- log -5
```

They do not apply managed confirmations, dry runs, or agent envelopes. Unknown commands do not silently run as Git. Plugins are trusted local executables; `GGH_NO_PLUGINS=1` bypasses them.

## Moved to gh

Version 0.6 removes these wrappers. Use native gh arguments through the escape.

| Removed | Replacement |
| --- | --- |
| `label`, `secret`, `variable` | `ggh gh label`, `ggh gh secret`, `ggh gh variable` |
| `gist`, `search`, `browse` | `ggh gh gist`, `ggh gh search`, `ggh gh browse` |
| `workflow`, `release` | `ggh gh workflow`, `ggh gh release` |
| `changelog` | Native gh release-note generation; edit `CHANGELOG.md` by hand |
| `team`, `triage` | Snapshot sharing and AI grouping retired; native gh issue/gist reads remain |
| `draft` | `ggh stash list --named`, `ggh stash restore <name>` |

Notifications keeps list and mark-read operations. For native secret writes, use the masked prompt or stdin; keep values out of command arguments.

## Configuration

ggh uses `$XDG_CONFIG_HOME/good-gh`, defaulting to `~/.config/good-gh`. `GGH_CONFIG_DIR` names a separate ggh directory without moving gh's authentication. The project index and private status/cache files live there.

```bash
ggh config list
ggh config set project_roots '["~/Downloads", "/work"]'
ggh config set clone_root ~/work
ggh config set project_exclude '["**/archive/**"]'
ggh config set project_scan_depth 4
ggh config set host_worktree_dirs '{"t3":"~/.t3/worktrees","codex":"/work/codex"}'
ggh config set go_default cd
ggh config doctor
```

T3 defaults to `~/.t3/worktrees`; Claude and Cursor directories inside repositories are probed. Configure other host locations explicitly. Host labels describe observed path evidence, never authority to delete. Scan depth is bounded from 0 to 8. Forgetting or excluding a path removes it from discovery without deleting files.

Flags take precedence over `GGH_*` environment settings, project `.ggh.json`, user settings, then defaults. Project files may set only `commit_style`; they cannot grant AI consent or redirect providers and paths. Doctor checks local tools and capabilities, not live sign-in or model access.

### AI consent

AI generation is off by default. Use `--ai` for one invocation or deliberately set `ai_enabled`. Hosted-content consent, provider choice, and fallback are separate settings.

```bash
ggh config set ai_provider codex
ggh config set hosted_ai_consent true
ggh config set ai_enabled true
# For local-only generation instead:
ggh config set ai_provider ollama
ggh config set ai_fallback false
```

Hosted AI requires explicit consent. Diff generation excludes sensitive file classes and redacts recognized credentials, but source code can still leave your machine. Use an explicit message or `--no-ai` when it must stay local. Ollama requires verified local weights and a loopback daemon; enforce no-egress policy in that daemon too. See [SECURITY.md](SECURITY.md) for provider and redaction limits.

## Safety model

Tidy is the bulk deletion command. Preview with `--dry-run`; execution requires approval. A branch needs exact-tip ancestry and publication proofs, and cannot be checked out anywhere. A merged badge or gone upstream alone proves nothing. Unknown or incomplete history means keep.

Checkout removal requires a clean, unlocked, eligible checkout and guards ignored files, nested repositories, submodules, and clone stashes. Main and current checkouts stay. Unknown provenance stays unless an exact-path override is separately approved. T3, Claude, Cursor, and Codex worktrees are always manual-only, even when clean and merged. Neither `--allow-unknown` nor `--allow-ignored` permits removing them.

Every action rechecks identity, refs, OIDs, ancestry, ownership, and relevant file state immediately before its effect. Changed items are refused; ggh never widens an approved batch. Remote deletion requires ownership checks and an exact expected-OID lease. Missing-worktree metadata pruning is separate, honors locks and expiry, and refuses uncertain or apparently unmounted paths. Tidy never deletes repositories or runs GC.

Local previews use existing tracking refs. `--fetch` explicitly updates them, including during a dry run. An optional `--audit` sends at most 32 KB of metadata to the chosen provider after consent, without file contents, diffs, `.env`, transcripts, or remote URLs. The provider can only narrow safe candidates. Invented action IDs or invalid responses fail closed; bypassing a failed audit requires an explicit option. Audited approvals bind the plan and audit result.

Per-clone locks serialize ggh's own cleanup; they cannot stop an unrelated writer. Journals report completed, refused, failed, and uncertain effects. Cancellation leaves completed effects applied. Hooks, plugins, and provider executables remain trusted code.

There is no telemetry, ggh account, server, or automatic update check. GitHub reads and writes use `gh`; optional AI calls use your chosen provider.

## Development

[CONTRIBUTING.md](CONTRIBUTING.md) covers development. [Release readiness](docs/RELEASE-READINESS.md) records current gates and unverified behavior. Run `make smoke` to compile, temporarily install, and exercise the native binary against local bare remotes. It needs Bun, Git, make, zsh, and jq, with no network or GitHub authentication.

Completions come from the installed command tree:

```bash
eval "$(ggh completion zsh)"
eval "$(ggh completion bash)"
ggh completion fish > ~/.config/fish/completions/ggh.fish
```

PowerShell uses `ggh completion powershell | Out-String | Invoke-Expression`. Completion and MCP protocols reject `--agent`.

## License

MIT.
