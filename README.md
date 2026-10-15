# Good GH

[![CI](https://github.com/JonathanRReed/Good-GH-CLI/actions/workflows/ci.yml/badge.svg)](https://github.com/JonathanRReed/Good-GH-CLI/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/JonathanRReed/Good-GH-CLI?label=release)](https://github.com/JonathanRReed/Good-GH-CLI/releases/latest)

I hated the GitHub CLI. This makes it bearable.

`ggh` provides commands for commits, pull requests, issues, CI, releases, and stacked branches. It uses your installed `git`, `gh`, and, when requested, AI provider CLI. `ggh` has no account, server, or telemetry.

Git and GitHub commands are explicit. Use `ggh git <args>` for Git, `ggh gh <args>` for GitHub CLI, or `ggh -- <git-args>` as a short Git escape. Unknown commands do not run as Git.

## Install

Follow the [platform installation and repair guide](docs/INSTALL.md) for checksum, PATH, and dependency steps.

Download your platform's binary from [Releases](https://github.com/JonathanRReed/Good-GH-CLI/releases), verify its SHA-256 file, and place it on your PATH as `ggh`.

Standalone binaries need Git, but not Bun or Node. GitHub operations also need `gh`. Local commits with an explicit message need neither a provider CLI nor `gh`; AI commands need a configured provider CLI.

Package installs require Node 22+, Bun 1.4+, and Git. Releases include a tarball even when npm publication is disabled:

```bash
bun add -g ./good-gh-cli-<version>.tgz
```

Use `bun add -g good-gh-cli@<version>` only when that release's notes confirm npm publication. Prereleases use the `beta` tag, not necessarily the default npm tag.

`main` contains the `0.4.0-beta.3` candidate. A source commit is not a published release. Signed and notarized macOS DMGs are separate uploads; bare macOS binaries have ad-hoc signatures, not Developer ID notarization. See [packaging](docs/PACKAGING.md).

To build from source:

```bash
git clone https://github.com/JonathanRReed/Good-GH-CLI.git
cd Good-GH-CLI
bun install --frozen-lockfile
bun run build
bun link
ggh status
```

## Commits

```bash
ggh commit                  # Alias: ggh c
ggh c -a                    # Stage everything first
ggh c --push                # Commit and push
ggh c --pr                  # Commit, push, and open a PR
ggh c --pr --branch feat/login --yes # Name the PR branch and approve publication
ggh c --amend
ggh c --review              # Check for console.log, debugger, and localhost
ggh c -m "fix: parser" -y   # Commit without AI or prompts
```

On `main`, `ggh` offers to create a feature branch. AI generation is disabled by default. Set `ai_enabled` in your user config or pass `--ai` for a command that supports it. `--no-ai` disables generation for one invocation. An explicit commit message never invokes AI. `ggh` rejects staged blobs over GitHub's 100 MB limit and blocks commits with unresolved conflicts.

`ggh c --split` proposes file groups from an index snapshot. It rejects missing, duplicate, or extra paths and preserves unstaged changes. It cannot run with `--no-ai`, `-m`, `--amend`, or `--fixup`.

If a split fails partway through, completed commits remain. The original index is preserved, with the remaining changes staged, and the error identifies a private recovery checkpoint. Check `git status` and `git log` before retrying. There is no automatic reset; Git hook side effects are not rolled back.

## Pull requests and reviews

```bash
ggh pr                      # Browse PRs
ggh pr create --draft --ai   # Generate a title and body
ggh pr create --editor --no-ai # Edit a multiline draft in your Git editor
ggh pr create --attach 'proof.png#Sign-in screen' # Attach media when supported
ggh pr view 42
ggh pr diff 42
ggh pr edit 42
ggh pr review 42 --ai        # Review and submit selected findings
ggh pr review --local        # Print a review without posting
ggh pr review --approve
ggh pr review --request-changes
ggh pr 42 --checkout
ggh pr 42 --worktree         # Leave the current branch untouched
ggh pr merge 42 --squash     # Merge and delete the branch
ggh pr merge 42 --squash --no-delete-branch
ggh pr merge 42 --auto       # Merge when required checks pass
ggh pr comment 42 -b "lgtm"
ggh pr ready | close | reopen
```

`--editor` opens your Git editor with a first-line title, a blank line, and the
Markdown body. It honors `GIT_EDITOR`, Git's `core.editor`, `VISUAL`, and `EDITOR`.
The publication preview follows the edit and identifies the target, draft state,
and effects before confirmation. `--template NAME` selects a named PR template.

If editing or publication stops, the private draft stays on disk. The recovery
command reopens it with its publication options. Successful direct creation
removes generated drafts. A file you supplied with `--editor FILE` stays intact.
Dry runs never launch an editor. Scripts can use `--title` and `--body-file`.

AI review findings must refer to lines added by the diff. `ggh` discards invalid locations, shows the remaining findings for selection, and posts the selected findings as a GitHub review.

Repeated `--attach` options accept validated images and videos. `ggh` checks
whether the installed `gh` supports native attachments. GitHub documents the
flag for PR and issue create, edit, and comment commands in its [attachment
guide](https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli)
and [`gh pr create` manual](https://cli.github.com/manual/gh_pr_create).

The local preflight accepts PNG, GIF, JPG, JPEG, SVG, WEBP, MP4, MOV, and WEBM.
It allows up to 50 files per operation, with ceilings of 10 MiB per image and
100 MiB per video. The GitHub CLI manual also lists 50 files per PR command.
GitHub's attachment docs list 10 MB images and videos up to 10 MB for free plans
or 100 MB for paid plans, with access requirements for uploads over 10 MB. The
local ceilings do not guarantee GitHub will accept a file. The [CLI attachment
reference](https://github.com/cli/cli/blob/trunk/skills/gh/SKILL.md) also lists WEBP.
Native uploads require GitHub.com or a GHE.com tenant and repository write
access. Other hosts can use configured storage for verified public targets.

Set `attachment_upload_command` to an absolute executable path for a fallback
on verified public repositories. Configured public storage is refused for
private repositories.

### Create a repository or PR from local work

Inside a named local repository with commits and no remote, `ggh repo create` infers the repository name and root, defaults to private visibility, adds `origin`, and pushes the current branch after one confirmation. Explicit flags can change visibility, source, remote, or the push choice. Set `ggh config set repo_create_confirm false` to skip this confirmation for unambiguous repo creation. `--confirm` restores it for one command.

`ggh pr create` can use the same setup plan when the local repository has no GitHub remote. It requires a valid base and head before remote changes, then creates the repository, pushes the base and head, and opens the PR in that order. `ggh commit --pr` runs the commit and PR workflow together. Noninteractive publication requires `--yes` or an exact `--approve-plan` snapshot. Configured fast mode also authorizes unambiguous repo creation.

## Issues and CI

```bash
ggh issue                   # Browse issues
ggh issue 42
ggh issue create --ai -n "failing on Safari, intermittent 500s"
ggh issue develop 42        # Create a branch and start work
ggh issue edit 42 --title "new title" --add-label bug
ggh issue close 42 | reopen 42 | comment 42
ggh issue lock 42 | unlock 42 | pin 42 | unpin 42
ggh issue transfer 42 owner/other-repo

ggh checks
ggh checks --watch          # Poll from 5s to 30s, stopping at --timeout
ggh run                     # Browse workflow runs
ggh run 12345               # Read failed-job logs and suggest a fix
ggh run rerun 12345 --failed
ggh run cancel 12345
```

With `--ai`, issue generation uses the title and optional `--notes` to draft a description, reproduction steps, and expected and actual results. Accept, edit, or regenerate before opening the issue.

## Stacked branches

Each new branch's parent is stored in Git config. `ggh stack` reads those relationships; it needs no separate service or account. Restacking updates local branches. `stack submit` is the explicit publication action and uses `--force-with-lease` when a rewritten branch must replace a remote tip. A changed remote tip stops the update.

Plain `ggh stack list` stays local and offline. `--remote` fetches PR review and CI status for the visible branches, uses at most five concurrent lookups, and checks no more than 25 branches per view. GitHub errors appear as unavailable status without hiding the local branch tree.

```bash
ggh stack next feat/api     # Stack a branch on the current one
ggh stack list              # Show parents and drift
ggh stack list --remote     # Add GitHub PR review and CI status
ggh stack restack           # Replay after amending a parent
ggh stack restack --continue # Resume after resolving a conflict
ggh stack restack --abort   # Restore saved local branch tips
ggh stack submit            # Push and open one PR per branch
ggh stack on main           # Adopt an existing branch
ggh stack checkout
```

## Branches and local work

```bash
ggh switch                  # Alias: ggh sw
ggh sw -c feat/login
ggh wt add "add dark mode"  # Uses a deterministic branch name by default
ggh wt add "add dark mode" --ai # Allow AI to name the branch
ggh wt list
ggh wt remove
ggh undo                    # Soft-reset HEAD~1; keep changes staged
ggh discard                 # Select files to revert
ggh stash                   # Alias: ggh sh
ggh resolve                 # Resolve conflicts file by file
ggh squash 3
ggh squash 3 --no-input --yes # Authorize an inferred message and history rewrite
ggh squash 3 --message "feat: combine changes" --no-input
ggh rename feat/new-name    # Rename locally and remotely
ggh sync                    # Fetch, prune, and delete stale branches
ggh log                     # Alias: ggh graph

ggh draft --ai              # Stash work with an AI description
ggh draft list
ggh draft resume
ggh draft drop
ggh ignore "*.log" ".env"
ggh ignore "*.key" --local  # Write .git/info/exclude instead
ggh hook install pre-commit
ggh hook edit pre-commit --command "hook check"
ggh hook list
ggh hook remove pre-commit
ggh alias ci "commit --pr --yes"
ggh alias --remove ci
```

## Other GitHub commands

| Command | Use |
| --- | --- |
| `ggh clone` | Search and clone; supports `--fast`, `--shallow`, and `-d` |
| `ggh repo` | View, create, fork, edit, rename, archive, delete, or sync repositories |
| `ggh release` | Browse, create, view, download, upload, or delete releases |
| `ggh changelog v1.0.0` | Write a generated changelog to `CHANGELOG.md` |
| `ggh search` | Search issues, PRs, repositories, or code |
| `ggh notifications` | Browse, triage, or mark notifications read |
| `ggh triage --ai` | Group notifications and issues without changing them |
| `ggh browse` | Open a repository, PR, or issue in the browser |
| `ggh label`, `ggh secret`, `ggh variable` | Manage repository labels, secrets, and variables |
| `ggh gist`, `ggh workflow` | Manage gists and workflow runs |
| `ggh team` | Publish a stack as a secret gist, or pull a shared stack |
| `ggh plugin` | Install, list, or remove local commands |
| `ggh mcp` | Start the MCP server; `--list-tools` lists its tools |
| `ggh api` | Call GitHub endpoints not wrapped by another command |

Plugins run with full privileges. Install only code you trust. To bypass a broken plugin:

```bash
GGH_NO_PLUGINS=1 ggh plugin list
GGH_NO_PLUGINS=1 ggh plugin remove <name> -y
```

For GitHub Enterprise, sign in with `gh auth login --hostname ghe.example.com`, then set `GH_HOST=ghe.example.com`. Check the host and account with `ggh status`.

## Scripting

These shared flags apply where the command advertises them:

| Flag | Effect |
| --- | --- |
| `--json` | Write only machine-readable output to stdout |
| `--agent` | Use the versioned agent envelope and never prompt |
| `--dry-run` | Describe changes without making them |
| `-y, --yes` | Accept every confirmation |
| `-q, --quiet` | Hide progress, not errors |
| `--no-input` | Never prompt; fail with instructions |
| `-R, --repo owner/name` | Use another repository |

Data goes to stdout; progress and errors go to stderr. Without a terminal, a command that needs an answer cancels and exits nonzero. It does not select a menu item or accept a destructive operation for you.

```bash
ggh status --json | jq '.ai.chain'
ggh pr --json | jq -r '.[] | "\(.number) \(.title)"'
ggh stack list --json | jq '.[] | select(.behind > 0) | .branch'
ggh discard --all --dry-run
```

`ggh agent schema` lists supported commands, inputs, and the version 1
`ggh.agent` envelope. With `--agent`, read `status`, `error.code`,
`error.retryability`, `requiredInputs`, and `effects` before continuing. Detailed
result schemas cover the core workflows; other `result` payloads remain
command-specific. Legacy `--json` shapes are preserved. Native `git`, `gh`, and
`--` escapes keep their native streams and exit codes. MCP and shell completion
use their own protocols and reject `--agent`.

For repo creation, PR creation, and publication recovery, `--dry-run` returns a
`snapshotId` alongside the plan. Review that plan, then supply
`--approve-plan <snapshotId>` with the same inputs. This approves the exact
target, visibility, destination, revisions, content, and attachment bytes.
Material changes require a fresh preview and approval. `--yes` still approves
the plan prepared by that invocation.

File selections from status are relative to the repository root, even when you
run `ggh` from a subdirectory. Selected filenames are literal, not glob patterns.
`discard --all` keeps untracked files unless you also pass `--include-untracked`;
restoring a rename refuses to overwrite a newly created, untracked source file.

In a no-input run, squash requires `--yes` to authorize an inferred message, or
an explicit `--message`. It collects the message before changing history and
keeps the original commits at `refs/ggh/squash/<original-head>`. If the final
commit fails, it reports that ref. Inspect `git status` and the saved history
before recovering.

Typos get command suggestions unless the word is a Git command or one of your Git aliases, which take precedence.

## Configuration

```bash
ggh config
ggh config list
ggh config set ai_provider codex        # codex | grok | claude | ollama
ggh config set codex_model gpt-5.6-luna
ggh config set ai_timeout_ms 120000
ggh config get ai_provider
ggh config unset ai_timeout_ms
ggh config doctor
ggh config cache-clear
ggh config set ai_enabled true
```

Precedence is flags, `GGH_*` environment variables, project `.ggh.json`, user file, then defaults. Project files may set only `commit_style`; they cannot override providers, models, consent, paths, fallback, or timeouts.

```json
{ "commit_style": "conventional" }
```

Environment variables use the corresponding key names, including `GGH_AI_PROVIDER`, `GGH_CODEX_MODEL`, `GGH_GROK_MODEL`, `GGH_AI_TIMEOUT_MS`, `GGH_COMMIT_STYLE`, `GGH_DEFAULT_CLONE_DIR`, `GGH_DEFAULT_CLONE_MODE`, and `GGH_HOSTED_AI_CONSENT`.

`ggh config cache-clear` removes only recognized cache entries. Cache errors disable caching rather than expand filesystem access.

`ggh config doctor` checks for Git and `gh`, reports their local versions, probes `gh` attachment flags, and checks provider CLI versions and capabilities. It does not verify sign-in, model access, or live provider availability.

## AI and privacy

`ggh` stores no provider API keys. AI generation is off by default, even when a provider is configured. Use `--ai` for a single command or set `ai_enabled` in your user config. Provider choice, fallback, and hosted-content consent remain separate settings. Ollama needs a running daemon and downloaded model.

An account-wide usage limit skips that provider for the rest of the run. When all providers fail, `ggh` reports each provider, model, and error, then opens the Conventional Commit wizard. `-m` and `--no-ai` make no AI calls.

Hosted AI requires explicit consent. In a noninteractive session, set it deliberately with `ggh config set hosted_ai_consent true`. Before sending a diff, `ggh` excludes `.env` files, keys, lockfiles, and binaries, then scans remaining hunks for credentials. It reports the redaction count.

Redaction removes recognized credentials, not your source code. Use `-m`, `--no-ai`, or local-only AI when source must not leave your machine:

```bash
ggh config set ai_provider ollama
ggh config set ai_fallback false
```

The Ollama adapter requires a loopback HTTP endpoint and a Modelfile that identifies local weights. It rejects remote endpoints, cloud aliases, and unverifiable models before sending a prompt. For a no-egress policy, also disable cloud features in the running Ollama daemon, restart it, and verify its settings. `ggh` does not sandbox provider CLIs or modified daemons.

Codex runs with `--ignore-user-config`. Claude runs in an isolated directory with safe mode, no built-in or MCP tools, and no session persistence. Older Claude CLIs must support those flags; `ggh` does not retry with weaker permissions. See [SECURITY.md](SECURITY.md) for limits.

### Local operation records

Mutating and AI-assisted commands can record command identity, status, revision, completed steps, resource URLs, and provider-reported usage in local Git metadata or user configuration. Records exclude prompts, source content, message bodies, transcripts, and raw output. `ggh operation list`, `view`, and `evidence` inspect records or associate an existing local file by reference. Evidence files are not copied or checked. Use `ggh operation prune` to remove old records after confirmation. Set `GGH_NO_RECORDS=1` to disable recording.

`ggh operation recover <id>` shows confirmed, pending, and uncertain effects
with inspection commands. `ggh operation resume <id> --dry-run` reconciles a
saved publication plan. Supply PR title/body, unconfirmed attachment files,
and any unconfirmed repository description again, then approve the remaining
work. Recovery refuses changed targets or revisions and does not recreate
commits, comments, or confirmed uploads from missing content. Stack recovery
uses `ggh stack restack --continue` or `--abort`.

A crashed local writer's lock is reclaimed when its process is proven dead.
`ggh operation unlock <id> --unknown-owner --yes` is available for legacy or
unknown locks after you have stopped other writers. Known live writers cannot
be unlocked.

## Development and completion

[CONTRIBUTING.md](CONTRIBUTING.md) covers development. Report bugs or send small fixes; open an issue before a large feature. `./scripts/demo.sh` runs a 60-second tour in a temporary repository without network access or authentication.

[Release readiness](docs/RELEASE-READINESS.md) lists regression commands and checks that need external accounts. [Packaging](docs/PACKAGING.md) covers distribution and `make install`.

```bash
eval "$(ggh completion zsh)"    # Add to ~/.zshrc
eval "$(ggh completion bash)"   # Add to ~/.bashrc
ggh completion fish > ~/.config/fish/completions/ggh.fish
```

Completions are generated from the command tree.

For PowerShell, add this to your `$PROFILE`:

```powershell
ggh completion powershell | Out-String | Invoke-Expression
```

All four shells resolve nested commands, aliases, and flags from the installed
CLI. Branch and file suggestions use local state and do not contact GitHub.

## License

MIT.
