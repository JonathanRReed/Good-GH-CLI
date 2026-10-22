# Good GH

[![CI](https://github.com/JonathanRReed/Good-GH-CLI/actions/workflows/ci.yml/badge.svg)](https://github.com/JonathanRReed/Good-GH-CLI/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/JonathanRReed/Good-GH-CLI?include_prereleases&label=release)](https://github.com/JonathanRReed/Good-GH-CLI/releases)

I hated the GitHub CLI. This makes it bearable.

`ggh` provides commands for commits, pull requests, issues, CI, releases, and stacked branches. It uses your installed `git`, `gh`, and, when requested, AI provider CLI. `ggh` has no account, server, or telemetry.

Git and GitHub commands are explicit. Use `ggh git <args>` for Git, `ggh gh <args>` for GitHub CLI, or `ggh -- <git-args>` as a short Git escape. Unknown commands do not run as Git.

## Projects

```bash
ggh projects roots add ~/Downloads
ggh                         # All indexed local projects
ggh projects                # Same table
ggh projects Good-GH-CLI     # Checkouts, unpublished work, stashes, history
ggh projects --agent         # Compact, versioned JSON; no network
ggh --remote                 # Add GitHub PR counts, review requests and CI
ggh projects Good-GH-CLI --remote  # Authored PRs and default-branch checks
ggh projects --remote --refresh   # Bypass the five-minute remote cache
ggh projects --uncloned       # Also count owned repos without local clones
ggh go Good-GH-CLI           # Context on stderr, path on stdout
ggh go Good-GH-CLI --editor  # VISUAL, EDITOR, code, cursor, or zed
ggh go Good-GH-CLI --t3      # Probe an installed T3 launcher
ggh go Good-GH-CLI --print   # Path only
ggh projects roots list
ggh projects roots remove ~/Downloads
ggh projects exclude ~/Downloads/archive
ggh projects forget ~/Downloads/old-project
ggh projects register ~/Downloads/parent/nested-repo
```

Bare `ggh` lists projects, including without a terminal. Help stays at `ggh --help`.
Scan roots start empty. Discovery stops at a repository, includes its linked
worktrees wherever Git lists them, and checks configured host worktree directories.
T3 defaults to `~/.t3/worktrees`; Claude and Cursor directories inside a repository
are included. Codex directories require configuration. Host labels describe path
evidence, not permission to delete a checkout.

Each clone gets its own row, even when several clones share a remote. Status is
local and read on demand, with eight clone workers and a three-second deadline per
clone. Unknown and failed fields stay visible. Unpublished counts include every
local branch and detached checkout HEAD, measured against all remote-tracking refs.
Merged branches require a known remote default branch. Nothing fetches or reads
host transcripts. Discovery reports unreadable and depth-limited paths.

`--remote` uses your active `gh` account on each remote host. Independent clones
share one remote lookup; fork and upstream repositories remain separate. The table
shows authored open PR counts, failed checks among the three displayed PRs, review
requests, archive and fork flags, and remote age. Context cards list up to three
authored PRs with their branches, checks and review decisions, plus default-branch
CI. Terminal runs show local status before waiting for GitHub.

Requests use serialized GraphQL batches of 25 repositories, with a ten-second
batch timeout, at most 40 requests per host per run, and a 500-point foreground
reserve. Every query reads its rate-limit cost and remaining quota. Reset times
and retry delays persist across invocations for the same host and login;
`--refresh` bypasses result caching but keeps those limits. Failed or inaccessible
fields report `unavailable` with a reason instead of becoming zero counts.

Remote snapshots live in the private ggh cache for five minutes, scoped to the
host, login, repository set and requested fields. Environment tokens bypass result
caching because two tokens for one login can grant different access. GraphQL reads
use the TTL cache; ETag revalidation applies to REST GETs, not these queries.
`--uncloned` implies `--remote` and enumerates owned repositories, excludes every
indexed local remote, and shows the ten most recently pushed. Enumeration stops at
1,000 repositories or the request budget; incomplete counts remain unavailable.
Organization repositories are not included. Nothing fetches local Git refs.

JSON and agent results put remote fields under each clone's `remote` array, with
`state`, `value` and `observedAt` for successful fields. Unavailable fields carry a
`reason` and, when known, `retryAt`. Top-level `remote` metadata reports GraphQL
request count, cost and uncloned results. `ggh agent schema` describes these fields.

The private index lives at `<configDir>/projects.json`. It stores checkout metadata
and redacted remote URLs, never status. Missing clones remain flagged for one
refresh before removal. `forget` and `exclude` remove paths from discovery without
deleting their files. Registering a path clears an exact index exclusion; remove
any matching `project_exclude` rule separately to include an excluded path again.

Configure discovery with `ggh config set` using JSON for lists and objects:

```bash
ggh config set project_roots '["~/Downloads", "/work"]'
ggh config set project_exclude '["**/archive/**", "/work/old"]'
ggh config set project_scan_depth 4  # Range: 0 through 8
ggh config set host_worktree_dirs '{"t3":"~/.t3/worktrees","codex":"/work/codex"}'
ggh config set go_default editor    # cd, editor, or t3; default cd
```

Install the shell function to change your current shell's directory:

```bash
# Add to ~/.zshrc, or use bash in ~/.bashrc:
eval "$(ggh init zsh)"
g Good-GH-CLI
# Choose another function name:
eval "$(ggh init zsh --cmd jump)"
```

For fish, add `ggh init fish | source` to `config.fish`. For PowerShell, add
`Invoke-Expression (ggh init pwsh | Out-String)` to your profile. Only the generated
function is sourced. Repository paths are passed as data and never evaluated.
The hook calls `ggh go --print --shell`; its path ends in `/.` so command
substitution preserves trailing newlines. Failed lookups leave the directory
unchanged. Identical basenames require a choice or an exact checkout path.
Noninteractive ambiguous or missing lookups return JSON candidates and exit
nonzero. A missing local project suggests `ggh clone`; it never clones for you.

Run `bun run scripts/bench-projects.ts` for a disposable 70-repository cold/warm
benchmark. Set `GGH_BENCH_REAL=1` to also measure `~/Downloads` and T3 worktrees.
The benchmark writes its index under a temporary directory and leaves repositories
unchanged. Timings include discovery, index refresh, and local status.

## Install

Follow the [platform installation and repair guide](docs/INSTALL.md) for checksum, PATH, and dependency steps. See [dependency compatibility](docs/COMPATIBILITY.md) for the supported Git floor and tested GitHub CLI capabilities.

Download your platform's binary from [Releases](https://github.com/JonathanRReed/Good-GH-CLI/releases), verify its SHA-256 file, and place it on your PATH as `ggh`.

Standalone binaries need Git 2.31 or newer, but not Bun or Node. GitHub operations also need `gh`. Local commits with an explicit message need neither a provider CLI nor `gh`; AI commands need a configured provider CLI.

Package installs require Node 22+, Bun 1.4+, and Git. Releases include a tarball even when npm publication is disabled:

```bash
bun add -g ./good-gh-cli-<version>.tgz
```

Use `bun add -g good-gh-cli@<version>` only when that release's notes confirm npm publication. Prereleases use the `beta` tag, not necessarily the default npm tag.

The source version is `0.5.0-beta.2`. A source commit is not a published release. Signed and notarized macOS DMGs are separate uploads; bare macOS binaries have ad-hoc signatures, not Developer ID notarization. See [packaging](docs/PACKAGING.md).

To build from source:

```bash
git clone https://github.com/JonathanRReed/Good-GH-CLI.git
cd Good-GH-CLI
bun install --frozen-lockfile
bun run build
bun link
ggh status
```

## Clone

```bash
cd ~/Downloads
ggh clone owner/repo         # Alias: ggh get
ggh clone                   # Pick from your repos, organizations, and stars
ggh clone project-name      # Search all sources and GitHub
ggh get owner/repo --to ~/work/repo
ggh clone owner/repo --ask
ggh clone owner/repo --fast  # Blobless; --blobless also works
ggh clone owner/repo --shallow
ggh clone owner/repo --protocol ssh
ggh clone owner/repo --dry-run --agent
```

Clones go into `$PWD/<repo-name>`. Set `ggh config set clone_root ~/work` to use
another root. `--to` chooses the exact destination, and `--ask` prompts for it.
The destination appears before cloning and in JSON and agent results.
Noninteractive calls use the configured clone mode, defaulting to standard.
`--ask` requires an interactive terminal.

Discovery paginates up to 1,000 repositories per source, with a combined limit
of 1,000 organization repositories. Lists use the host and account cache;
`--refresh` reloads them. Ambiguous noninteractive searches return candidates
with destinations so callers can choose an exact `OWNER/REPO`.

An existing clone with the same origin is reused. Other non-empty destinations
are refused. Successful clones receive local `ggh.created` and `ggh.createdAt`
Git config markers. Failed or cancelled clones remove only the destination
directory created by that invocation.

Progress marks a clone stalled after 20 silent seconds and keeps waiting.
Ctrl-C cancels. SSH authentication or host-key failures retry once over HTTPS
only when ggh derived the URL. Explicit URLs and `--protocol ssh` suppress
fallback. Custom hosts and ports are preserved, URL credentials are redacted
from diagnostics, and Git credential prompts are disabled.

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
ggh pr threads 42 --agent    # Read unresolved review threads with full bodies
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

`pr threads` reads all threads by default; `--agent` defaults to unresolved threads.
Use `--all` to include resolved threads, `--since <ISO|cursor>` for threads with
new or edited comments, and `--max-body <n>` for explicitly flagged truncation.
JSON includes head/base SHAs and fetched thread/comment counts before filtering.
The cursor is the latest comment `updatedAt` read, including filtered threads.
Pagination stops after 200 GraphQL requests. Reuse the cursor only when
`pagination.complete` is true. Both JSON modes are compact; bodies stay verbatim.

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

PR merges pin the head SHA read before confirmation. Use
`ggh pr merge 42 --squash --match-head-commit <sha>` to require a specific reviewed
commit. A changed head fails. After the request, ggh checks GitHub and reports
`merged`, `queued`, `auto_merge_enabled`, or `unknown`. Branch cleanup runs only
after a confirmed merge.

`ggh pr 42 --worktree` creates a review checkout without copying local env files,
initializing submodules, or recording shared branch-parent metadata.
`ggh wt add feature` keeps development worktree setup; add `--copy-env` to copy
`.env`, `.env.local`, and `.env.development` from the current checkout.
Worktree removal rechecks local changes, locks, and current/main checkout
identity. Overriding a refusal requires `--force`; `--yes` does not force removal.

## Review

```bash
ggh review 42                 # Open a detected GUI editor, otherwise use the terminal
ggh review 42 --editor
ggh review 42 --pager
ggh review 42 --mark           # Explicitly record a local inspection
ggh review 42 --since last     # Changes since your last local mark
ggh review 42 --since <sha>    # Compare against a full commit SHA
ggh review 42 --since last --agent
```

Review fetches the PR's head and base into `.worktrees/review-42`. It reuses a
clean, detached checkout and refuses tracked or untracked changes. It never
copies local `.env` files, initializes submodules, or writes branch-parent
metadata. Run it from a clone with a remote matching the PR's repository.

Editor detection checks `GGH_REVIEW_EDITOR`, then GUI-capable `VISUAL` and
`EDITOR`, then `code`, `cursor`, `zed`, and `idea` on PATH. VS Code and Cursor
open the checkout folder and suggest the GitHub Pull Requests extension when
it is missing. With `--since`, they also open each changed file pair. Zed opens
all changed file pairs in one invocation. Other GUI editors use
`git difftool -y --dir-diff` with your configured `diff.tool` and
`difftool.<tool>.cmd`. IDEA defaults to its `diff` command. GUI launches detach
so ggh returns without waiting for the editor to close.

`--pager` uses `tuicr pr 42`, then delta, then ggh's diff renderer. Incremental
reviews use delta or ggh's renderer to preserve the requested revision range.
External tools retain their own controls for submitting GitHub reviews.

`--mark` stores an inspection record under your config directory's private
`reviews/` folder, keyed by host, owner, repository, and PR. Opening an editor
never creates a mark. A local mark is never a GitHub approval and sends nothing
to GitHub. Mark only after inspecting the changes. `--since last` requires a
prior mark and lists added commits, changed files, and review threads with new
or edited comments since that mark. Rewritten history includes a range-diff
and a warning that patch matching is heuristic. An explicit SHA has no review
time, so its thread list includes all threads.

`--json` and `--agent` return revision SHAs, checkout path, and incremental
review data without launching editors or pagers. They still fetch Git objects
and prepare the checkout. `--mark` remains explicit in both modes. Editor diff
snapshots stay in a private temporary directory so detached editors can read
them after ggh exits. They may be removed after closing the editor.

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

### CI failure evidence

`ggh ci why` is a read-only prototype that links CI evidence to a PR's head SHA.
It fetches the latest run per workflow for that revision, failing jobs and steps,
check-run annotations, and failed-step logs. When those logs defer to another
step or contain only a summary, it reads the full job log.

```bash
ggh ci why                         # Current branch's PR
ggh ci why 42                      # PR number, or run ID if no PR matches
ggh ci why https://github.com/owner/repo/pull/42
ggh ci why 12345 --run -R owner/repo # Explicit run ID
ggh ci why 42 --agent --max-bytes 6144 --context 2
```

The deterministic extractor keeps errors, assertions, exceptions, TypeScript
errors, and source locations with context and original log line numbers.
`--agent` returns compact JSON with result `schemaVersion: 1`, described by
`ggh agent schema`. Stale runs are flagged and their evidence excluded.
Missing logs, annotations, and incomplete pagination appear in `unavailable`.

The default evidence budget is 6 KiB per failing job, shared by annotations and
log excerpts. Failure identity and other metadata are extra. Every failure has
`truncated: {bytesTotal, bytesShown}` for the selected log source and a separate
`annotationsTruncated` count. Log totals count original UTF-8 bytes; shown bytes
count displayed text after prefix removal and deduplication. Counts disclose
extraction omissions as well as budget cuts. `--context` supplies nearby lines
after matching evidence receives its budget.

The [offline benchmark](bench/agent/README.md) records output size and evidence
recall on two archived failures. It includes losses against native commands.
Agent repair success and blind diagnosis accuracy remain unmeasured.

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

## Sync

```bash
ggh sync                        # Current repo: fetch, prune, and clean up gone branches
ggh sync --all                  # Every clone in the project index
ggh sync api web                # Indexed names, paths, or fuzzy matches, like go
ggh sync --all --concurrency 4 --timeout 120000
ggh sync api --include-host-worktrees
ggh sync my-fork --fork-upstream --yes --agent
```

Run `ggh projects` to populate the index. Bulk sync reads that index, fetches each
remote once per clone, and fast-forwards each eligible checkout to its own
upstream. It never switches branches, rebases, pushes, or deletes local branches.
Ambiguous project names require selection or an exact checkout path.

Dirty, detached, busy, diverged, locked, and upstreamless checkouts are skipped
with a reason. Agent-host worktree directories are skipped unless you pass
`--include-host-worktrees`. The timeout covers an entire clone, and at most four
clones run at once by default. Fetches disable credential prompts and use SSH
BatchMode. Failed fetches prevent checkout updates for that clone.

`--fork-upstream` also runs `gh repo sync` for each selected fork's default branch.
The confirmation names the remote targets. Non-interactive use requires `--yes`.
This is the only bulk-sync option that mutates a remote repository.

`--json` emits a compact result with `schemaVersion: 1`; `--agent` wraps it in the
agent envelope. `ggh agent schema` describes both. Results include each clone,
remote fetch, and checkout, with old and new commit IDs for fast-forwards.
Ctrl-C stops new work, lets in-flight commands finish within their deadlines,
and reports completed and pending effects. Earlier updates remain applied.

Plain `ggh sync` keeps its single-repo cleanup. Even with `--force`, it keeps
branches checked out in any worktree and branches containing commits unreachable
from every remote-tracking ref. Unknown deletion proof also means keep.

## Other GitHub commands

| Command | Use |
| --- | --- |
| `ggh clone`, `ggh get` | Search and clone with `--to`, `--ask`, `--fast`, `--shallow`, and `--agent` |
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
ggh status --agent
ggh status --json --remote --providers
ggh pr --json | jq -r '.[] | "\(.number) \(.title)"'
ggh stack list --json | jq '.[] | select(.behind > 0) | .branch'
ggh discard --all --dry-run
```

`ggh agent schema` lists supported commands, inputs, and the version 1
`ggh.agent` envelope. With `--agent`, read `status`, `error.code`,
`error.retryability`, `requiredInputs`, and `effects` before continuing. Detailed
result schemas cover the core workflows; other `result` payloads remain
command-specific. Read-only status may omit `effects` when all arrays are empty.
Agent output is compact JSON. Native `git`, `gh`, and
`--` escapes keep their native streams and exit codes. MCP and shell completion
use their own protocols and reject `--agent`.

`ggh status --json` and `--agent` read local Git state only. They report the
checkout root, branch, upstream, ahead/behind counts, staged/unstaged/untracked
and conflict counts, detached state, and operation in progress. Add `--remote`
for GitHub authentication and PR checks, or `--providers` for AI provider checks.
Agent status uses a flat result with full `head` OID and lossless porcelain-v2
`changes`. Omitted counts mean zero, omitted `root` means cwd, and omitted
`operation` means null. `ggh agent schema` defines all defaults, comparison base,
push destination and local fetch timestamp. Legacy `--json` remains nested.
`ggh run <id> --json` and `--agent` return one `jobs` array alongside `run`,
`log`, and `logStatus`. Failed logs are fetched before output; expired or
inaccessible logs have `logStatus: "unavailable"`.

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
