# Good GH

[![CI](https://github.com/JonathanRReed/Good-GH-CLI/actions/workflows/ci.yml/badge.svg)](https://github.com/JonathanRReed/Good-GH-CLI/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/JonathanRReed/Good-GH-CLI?label=release)](https://github.com/JonathanRReed/Good-GH-CLI/releases/latest)

I hated the GitHub CLI. This makes it bearable.

`ggh` wraps `git` and `gh` for commits, pull requests, issues, CI, releases, and stacked branches. Optional AI uses provider CLIs you are already signed in to. `ggh` has no account, server, or telemetry.

Unrecognized commands pass through to Git. `ggh add .`, `ggh push`, and `ggh rebase -i` behave as their Git equivalents do.

## Install

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
ggh c --amend
ggh c --review              # Check for console.log, debugger, and localhost
ggh c -m "fix: parser" -y   # Commit without AI or prompts
```

On `main`, `ggh` offers to create a feature branch. It reads the last ten commits to match their style, rejects staged blobs over GitHub's 100 MB limit, and blocks commits with unresolved conflicts.

`ggh c --split` proposes file groups from an index snapshot. It rejects missing, duplicate, or extra paths and preserves unstaged changes. It cannot run with `--no-ai`, `-m`, `--amend`, or `--fixup`.

If a split fails partway through, completed commits remain. The original index is preserved, with the remaining changes staged, and the error identifies a private recovery checkpoint. Check `git status` and `git log` before retrying. There is no automatic reset; Git hook side effects are not rolled back.

## Pull requests and reviews

```bash
ggh pr                      # Browse PRs
ggh pr create --draft        # Generate a title and body
ggh pr view 42
ggh pr diff 42
ggh pr edit 42
ggh pr review 42             # Review and submit selected findings
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

AI review findings must refer to lines added by the diff. `ggh` discards invalid locations, shows the remaining findings for selection, and posts the selected findings as a GitHub review.

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

Issue generation uses the title and optional `--notes` to draft a description, reproduction steps, and expected and actual results. Accept, edit, or regenerate before opening the issue.

## Stacked branches

`ggh` records each new branch's parent in Git config. `ggh stack` reads those relationships; it needs no separate service or account.

```bash
ggh stack next feat/api     # Stack a branch on the current one
ggh stack list              # Show parents and drift
ggh stack restack           # Replay after amending a parent
ggh stack submit            # Push and open one PR per branch
ggh stack on main           # Adopt an existing branch
ggh stack checkout
```

## Branches and local work

```bash
ggh switch                  # Alias: ggh sw
ggh sw -c feat/login
ggh wt add "add dark mode"  # AI names the branch; copies .env files
ggh wt list
ggh wt remove
ggh undo                    # Soft-reset HEAD~1; keep changes staged
ggh discard                 # Select files to revert
ggh stash                   # Alias: ggh sh
ggh resolve                 # Resolve conflicts file by file
ggh squash 3
ggh rename feat/new-name    # Rename locally and remotely
ggh sync                    # Fetch, prune, and delete stale branches
ggh log                     # Alias: ggh graph

ggh draft                   # Stash work with an AI description
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
| `ggh triage` | Group notifications and issues with AI, without changing them |
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
```

Precedence is flags, `GGH_*` environment variables, project `.ggh.json`, user file, then defaults. Project files may set only `commit_style`; they cannot override providers, models, consent, paths, fallback, or timeouts.

```json
{ "commit_style": "conventional" }
```

Environment variables use the corresponding key names, including `GGH_AI_PROVIDER`, `GGH_CODEX_MODEL`, `GGH_GROK_MODEL`, `GGH_AI_TIMEOUT_MS`, `GGH_COMMIT_STYLE`, `GGH_DEFAULT_CLONE_DIR`, `GGH_DEFAULT_CLONE_MODE`, and `GGH_HOSTED_AI_CONSENT`.

`ggh config cache-clear` removes only recognized cache entries. Cache errors disable caching rather than expand filesystem access.

## AI and privacy

`ggh` stores no provider API keys. It uses the configured CLI, then tries the remaining Codex tiers, Grok, Claude Code, and local Ollama. The default is Codex with `gpt-5.6-luna`; the Codex tiers are `gpt-5.6-terra` and `gpt-5.6-luna`. Ollama needs a running daemon and downloaded model.

An account-wide usage limit skips that provider for the rest of the run. When all providers fail, `ggh` reports each provider, model, and error, then opens the Conventional Commit wizard. `-m` and `--no-ai` make no AI calls.

Hosted AI requires explicit consent. In a noninteractive session, set it deliberately with `ggh config set hosted_ai_consent true`. Before sending a diff, `ggh` excludes `.env` files, keys, lockfiles, and binaries, then scans remaining hunks for credentials. It reports the redaction count.

Redaction removes recognized credentials, not your source code. Use `-m`, `--no-ai`, or local-only AI when source must not leave your machine:

```bash
ggh config set ai_provider ollama
ggh config set ai_fallback false
```

The Ollama adapter requires a loopback HTTP endpoint and a Modelfile that identifies local weights. It rejects remote endpoints, cloud aliases, and unverifiable models before sending a prompt. For a no-egress policy, also disable cloud features in the running Ollama daemon, restart it, and verify its settings. `ggh` does not sandbox provider CLIs or modified daemons.

Codex runs with `--ignore-user-config`. Claude runs in an isolated directory with safe mode, no built-in or MCP tools, and no session persistence. Older Claude CLIs must support those flags; `ggh` does not retry with weaker permissions. See [SECURITY.md](SECURITY.md) for limits.

## Development and completion

[CONTRIBUTING.md](CONTRIBUTING.md) covers development. Report bugs or send small fixes; open an issue before a large feature. `./scripts/demo.sh` runs a 60-second tour in a temporary repository without network access or authentication.

[Release readiness](docs/RELEASE-READINESS.md) lists regression commands and checks that need external accounts. [Packaging](docs/PACKAGING.md) covers distribution and `make install`.

```bash
eval "$(ggh completion zsh)"    # Add to ~/.zshrc
eval "$(ggh completion bash)"   # Add to ~/.bashrc
ggh completion fish > ~/.config/fish/completions/ggh.fish
```

Completions are generated from the command tree.

## License

MIT.
