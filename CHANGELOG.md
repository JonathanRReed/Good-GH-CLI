# Changelog

All notable changes to this project are documented here.
This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added

- Add `ggh review <pr>` with safe reusable checkouts, detached GUI editors,
  tuicr/delta terminal fallbacks, explicit private inspection marks, incremental
  review with rewritten-history detection, and versioned JSON/agent results.

- Extend `ggh clone` with alias `get`, `clone_root`, `--to`, `--ask`, paginated
  account, organization, and star discovery, and versioned agent results.
- Verify origin identity before reusing a clone and write local provenance
  markers after cloning. Stream progress, report stalls, redact diagnostic URL
  credentials, disable hidden prompts, and protect existing content on cleanup.
- Add `--protocol ssh|https` and one HTTPS retry for SSH authentication or
  host-key failures when ggh derived the URL.

- Add read-only `ggh ci why` with PR-head-linked runs, failed steps, annotations,
  full-job fallback, bounded evidence, explicit truncation, and agent schema v1.
- Add an offline Bun agent benchmark with pinned Zod and VS Code captures,
  evidence recall, output bytes, token estimates, and a CI evidence gate.
- Add read-only `ggh pr threads` with full comment bodies, nested pagination,
  resolution and outdated state, revision SHAs, edited-comment cursors, compact
  agent output, a versioned result schema, and a read-only MCP tool.

### Fixed

- Pin PR merges to the reviewed head SHA, with `--match-head-commit` for an
  explicit override. Re-read GitHub state and report merged, queued,
  auto_merge_enabled, or unknown. Clean up branches only after a confirmed merge.
- Separate PR review checkouts from development worktree setup. Review checkouts
  skip env copying, submodule initialization, and shared branch-parent metadata.
  Development worktrees copy env files only with `ggh wt add --copy-env`.
- Preserve worktree paths, detached/bare state, locks, and prune reasons with
  NUL-delimited parsing. Recheck changes and checkout identity before removal;
  require `--force` to override safety checks.
- Add an opt-in subprocess environment allowlist that filters inherited values
  and caller overrides while retaining process essentials.
- Keep JSON and agent status local by default. Add `--remote` and `--providers`
  for optional probes. Include upstream, change counts, and operation state.
- Remove duplicated workflow jobs, fetch failed logs before JSON output, report
  unavailable logs, emit compact agent JSON, and describe these result schemas
  in `ggh agent schema`.

### Changed

- Replace `default_clone_dir` with `clone_root` and `--dir` with `--to`.
  The default destination remains `$PWD/<repo-name>`.

## 0.5.0-beta.2 - 2026-10-15

### Workflow and release qualification

- Parse repository targets in linear time, including long malformed arguments.
- Preserve existing fetch mappings for branch names containing literal dollar
  replacement tokens.

- Add versioned `--agent` output and schema discovery, exact approval snapshots,
  metadata-only publication recovery, and owner-aware operation locks.
- Add recoverable multiline PR editing through the configured Git editor.
- Fix stack PR head selection and branch upstream setup in single-branch clones.
- Require Git 2.31 before managed workflow effects. Detect installed `gh`
  capabilities and provide versioned platform installation and repair guidance.
- Bound optional provider checks during status. Keep normal AI availability
  checks independent, and preserve JSON and native escape output.
- Disable repository dotenv and Bun preload configuration in native builds and
  installed launchers so repository files cannot change user AI policy.
- Remove terminal control commands from managed human output while retaining
  styling, Unicode, and machine-readable values.
- Add real terminal, cross-user Windows storage, process-tree, native installation,
  offline demo, and validated packaged performance checks to release qualification.
- Audit regression coverage, remove redundant assertions, and retain behavioral
  protections for cancellation, partial publication, stale approval, and recovery.



### Added

- Add explicit `ggh git`, `ggh gh`, and `ggh --` escape commands. Unknown
  commands no longer run as Git. Disable AI generation by default, with
  user-owned `ai_enabled` and per-command `--ai` / `--no-ai` controls.
- Infer private repository creation from the current Git root, name, `origin`,
  and current branch. Add a one-confirmation repo flow and shared setup for
  PR creation and `commit --pr` when no GitHub remote exists.
- Add repeatable PR and issue media attachments with capability checks,
  configured public-only fallback, and partial-result reporting.
- Record local operation status, revisions, resources, reported AI usage, and
  explicit evidence references. Add list, view, evidence, and prune commands.
- Add resumable stack restack recovery with conflict continuation, abort,
  saved branch tips, and force-with-lease checks during explicit submission.
- Add opt-in `ggh stack list --remote` status for pull request review and CI,
  with bounded lookups, plus local Git and GitHub CLI checks in `config doctor`.

### Fixed

- Require `--yes` or an explicit message before a no-input squash rewrites
  history with an inferred commit message.
- Resolve selected Git paths from the repository root, including nested working
  directories, staged-object checks, split commits, conflict resolution and
  review patches. Treat selected filenames literally, not as Git pathspecs.
- Restore both sides of staged renames without overwriting untracked replacement
  files. Discard partially staged files once and emit the documented JSON result.
- Fail closed when Git cannot read status instead of reporting a clean tree.
- Honor explicit push destinations and branch names without publishing other
  matching branches. Preserve configured push-remote precedence and leave
  unqualified upstream pushes under Git's normal configuration.
- Collect squash messages before rewriting history, reject malformed counts and
  stale previews, support full-history squashes on named branches, and retain
  the original history under `refs/ggh/squash/<original-head>` for recovery.

- Confine cache cleanup to validated, owned entries; disable caching on unsafe
  roots and isolate responses by repository, host, and authenticated account.
  Environment-token sessions bypass disk caching.
- Split commits now validate the complete AI proposal and commit exact staged
  blobs through a private index. Unstaged edits remain untouched; partial
  failures retain completed commits, remaining staged work, and a checkpoint.
- Enforce AI deny/dry-run flags, forward `--no-verify`, and allow local explicit
  commits without gh. AI split failures now return a nonzero status.
- Replace recursive pre-commit workflows with a noninteractive `hook check`;
  resolve hooks and local excludes through Git, including linked worktrees
  and custom hooks paths. Validate hook edits as well as installation.
- Separate repository-default, PR-base, and local comparison references. Fix
  deep-stack submission, reject invalid/cyclic parent pointers, and ensure
  restack continuation/abort previews never modify a rebase.
- Check the staged object rather than its working copy for large-file limits.
- Preserve API argument boundaries, fix notification API routing, support
  explicit remote targets for PR/label/workflow reads, emit JSON for config
  values, and reject malformed numeric configuration.
- Validate and bound MCP envelopes, input lines, tool parameters and responses;
  implement the declared protocol's ping and initialization lifecycle.
- Decode quoted Git paths before sensitive-file filtering and fail closed on
  unparseable file identity. Bound subprocess output and preserve inherited
  environment keys when callers supply overrides.

- Follow-up review: support detached-HEAD splits and optional model body fields,
  validate plugin metadata, honor Enterprise hosts from GH_REPO, require a local
  worktree for PR checkout, and refuse publishing empty release notes.
- Parse custom hook commands as literal quoted arguments without shell expansion;
  preserve safe custom hook basenames and Windows path separators.

### Hardened

- Isolate each Git service test in its own repository. Extend native checks from
  52 to 64 cases and require positive evidence that custom hooks and valid
  plugins actually execute, while malformed plugins remain unloaded.
- Refuse remote/cloud Ollama endpoints and unverified model aliases before
  sending prompts. Isolate coding-client working directories and disable Claude
  tools, MCP discovery, customizations and session persistence.
- Add plugin-disabled recovery with GGH_NO_PLUGINS=1 and portable plugin URLs.
- Add native regression cases and cross-platform index-transaction tests.
- Build releases from one immutable tag commit with pinned Bun and action SHAs;
  verify the actual native binaries and packed npm artifact before publishing.
- Make npm publication explicit and independently verified. Remove unchecked
  post-merge lockfile changes; dependency PRs must include a frozen-valid lock.

## 0.4.0-beta.2 - 2026-09-04

### Security

- Replaced four regular-expression paths that CodeQL identified as potential
  denial-of-service risks. Private-key redaction, clone suffix trimming, clone
  directory extraction, and worktree directory naming now run in bounded or
  single-pass time on untrusted input.

## 0.4.0-beta.1 - 2026-09-04

### Added

- New commands: `ggh alias` (expanding shortcuts, wired into parsing),
  `ggh draft` (AI-described stashes), `ggh hook` (git hook management),
  `ggh ignore` (`.gitignore` management), `ggh mcp` (MCP server for AI tools),
  `ggh plugin` (community plugins), `ggh team` (stack sharing via secret
  gists), and `ggh triage` (read-only AI inbox triage)
- Real subcommands for `draft` (`create`, `list`, `resume|pop`,
  `drop|delete`), `hook` (`list`, `install`, `remove|delete`, `edit`),
  `alias` (`list`, `set`, `remove|delete`), `ignore` (`list`, `add`,
  `remove|delete`), `plugin` (`list`, `install`, `remove|uninstall|delete`),
  `team` (`publish`, `pull|view`, `list`), `secret`/`variable`
  (`list`, `set`, `delete`), `label` (`list`, `create`, `edit`, `delete`),
  `gist` (`list`, `view`, `create`, `edit`, `delete`), `workflow` (`list`,
  `view`, `run`, `enable`, `disable`), `notifications` (`list`, `view`,
  `mark`, `unsubscribe`), `release` (`list`, `view`, `create`, `delete`,
  `upload`, `download`), and `stash` (`push|save`, `list`) — legacy
  positional actions keep working, and `--help` now lists every action
  with examples
- `tests/safety-net.test.ts` — 11 hermetic black-box tests for the paths most
  likely to break: alias expansion, draft/hook `--dry-run` ordering, `--json`
  on empty results, mutating `api --dry-run`, and read-only lists under
  `--dry-run --json`
- `ggh triage -R/--repo` — scopes issues to another repository
  (notifications are account-global and ignore it)
- Developer-ID-signed universal macOS DMG packaging with arm64 and x86_64
  binaries, completions, a man page, and an isolated installer smoke test
- Windows CI and a Windows standalone release smoke test
- CodeQL analysis on main, pull requests, and a weekly schedule
- A repository-grounded threat model in `docs/THREAT-MODEL.md`

### Changed

- `src/services/git.ts` split into `git/exec.ts`, `git/branch.ts`,
  `git/stack.ts`, `git/worktree.ts`, and `git/stash.ts` behind the same
  facade; `src/services/github.ts` into `github/client.ts`, `repos.ts`,
  `prs.ts`, `issues.ts`, `runs.ts`, and `releases.ts`; prompts moved from
  `src/utils/ui.ts` to `src/utils/prompts.ts`. No import path changes for
  callers
- Test-only helpers (`hasRemote`, `getUnmergedCommits`) moved from
  `src/services/git.ts` to `tests/git-helpers.ts`
- Read-only lists (`pr`, `issue`, `run`, `release list/view`, `gist`,
  `workflow`, `notifications`, `label`, `stack`) no longer block on
  `--dry-run`, so `--dry-run --json` returns data instead of empty output
- Error IDs standardized: `PR #N not found.`, `No PR found for the current
  branch.`, `Invalid run ID`
- `ggh mcp` reports the real package version instead of a hardcoded one, and
  `ggh_checks` no longer advertises a `branch` parameter it ignored
- `ggh --help` groups commands (Status, Daily loop, GitHub, Local
  workflow, Extensions, Setup) instead of one 40-command wall
- `scripts/demo.sh` — hermetic 60-second tour (temp repo, no network, no
  auth, no AI calls)
- AI provider probing memoized for 60s, so `status --watch` stops
  respawning CLIs every cycle
- `ggh status` closes with "Setup incomplete" instead of "All systems
  operational." when GitHub/AI setup has warnings
- Typo forgiveness: `ggh prr` suggests `ggh pr` instead of forwarding to
  git's irrelevant guesses; git's own words and your git aliases always win
- Performance: `gh auth` memoized per process, submodule scan skipped
  without `.gitmodules` (`status --json` down ~20%), provider probing
  already memoized; budgets in CI and receipts in `docs/PERF.md`
- `process.on("SIGPIPE")` exits 0, so `ggh log | head` behaves like
  ripgrep under `set -o pipefail`
- Shared helpers replace hundreds of duplicated blocks: `jsonOut()` for the
  `--json` triplet (~90 sites), `confirmOrAbort()` for confirm+cancel flows
  (~60 sites, with `assumeYes` now compulsory), `unknownAction()` for the
  eleven "Unknown X action" errors (messages byte-identical)
- `assumeYes` audit: `pr` merge/ready, `run` re-run, `plugin`
  install/remove, and new `worktree remove -y` all honour `-y` now
- `execGitWithRetry` takes `stdio`/`input` and is now the single policy for
  every mutating git call (push, pull, clone, apply, prune)
- Prompt frame math (`visibleWindow`, `terminalColumns`, `eraseFrame`)
  shared by all three pickers and covered by `tests/prompts.test.ts`
- Distro-ready: generated `man/ggh.1` (freshness enforced in CI), portable
  `Makefile` (`PREFIX`/`DESTDIR`, standalone + lean installs, completions,
  uninstall), `docs/PACKAGING.md` with an Arch PKGBUILD sketch, and man
  page + completions attached to GitHub releases
- Dead code removed: `paginateGhApi`, `stripLockfilesFromDiff`,
  `isValidBranchName` export (test-only surface moved into tests)
- The mutating-command contract test now covers the full helper surface
  instead of seven names, with method-call false positives excluded
- `noUncheckedIndexedAccess` enabled: 97 possibly-undefined indexing sites
  fixed with guards, defaults, and iterator refactors (zero `!` assertions);
  test-only surface adjusted to match
- `getAheadOfDefault` overlaps its branch probes instead of three sequential
  spawns
- Hosted AI now requires explicit user consent before repository content reaches
  Codex, Grok, or Claude. Ollama stays local
- Project `.ggh.json` files may set only commit style. They cannot change AI,
  fallback, consent, model, timeout, or user path policy
- Secrets and long-form GitHub bodies travel through stdin instead of process
  arguments
- CI startup and status budgets tightened to 2 seconds and 10 seconds

### Fixed

- Aliases were stored but never expanded (`ggh ci` fell through to git);
  expansion now happens before parsing, with recursion cap and debug tracing
- `ggh draft resume/drop --dry-run` prompted instead of previewing with
  multiple drafts; `ggh hook install --dry-run` prompted on overwrite;
  `ggh hook edit --command` ignored `--dry-run`
- `ggh pr` merge/close/reopen and `ggh run` re-run confirmations ignored
  `-y/--yes`, breaking scripts; `ggh commit --split --dry-run` billed AI
- `--json` paths that emitted empty stdout: `ignore --list` without a file,
  duplicate adds, `hook edit` display, `draft` create/resume/drop, `triage`
  empty/AI-failure, `team publish --dry-run`, `plugin` (flag unreachable)
- Raw `process.stdout.write` in `run`, `status --watch`, `config get`, and
  `changelog --json` replaced with the `data()`/`emitJson()` channels;
  `status --watch --interval abc` no longer busy-loops on `NaN`
- Mutating `api --dry-run` detection regex could never match (leading `\b`
  before `-`); `plugin` validation required only the substrings "export" and
  "register"
- Interactive secret entry echoed values into terminal scrollback
- The Node launcher used a shell on Windows, allowing metacharacters in CLI
  arguments to be interpreted by `cmd.exe`
- Duplicated parent and child options silently dropped explicit values such as
  `--yes`, filters, and bodies on nested commands
- Worktree creation recursively deleted an existing non-worktree directory
- Bare `ggh release` and `ggh workflow` invocations rejected their documented
  default list action

## 0.3.0 — 2026-09-03

### Added

- `ggh issue create --ai` — AI generates a structured issue body (Description,
  Steps to reproduce, Expected, Actual) from the title and optional `--notes`,
  with accept/edit/regenerate before opening, and the same provider fallback
  chain as `ggh commit`
- `ggh issue create --notes <text>` — reporter notes to steer AI body generation
- `ggh issue create --provider <provider>` — override the AI provider for one
  invocation
- `--json` support on `squash`, `undo`, `rename`, `resolve`, `discard`, and
  `switch`
- `--dry-run` support on `checks`, `clone`, `search`, `resolve`, and `status`;
  `run` and `switch` now advertise `--dry-run` through the global flag decorator
  (the dead checks already in their code now fire)
- `ggh stack submit` — push every branch in a stack and open one PR per branch
  against its real parent, with `--force-with-lease` when the remote is behind

### Changed

- `ggh sync` now deletes safe branches with `git branch -d` (not `-D`); only
  `--force` opts into `-D`. Failed deletions are reported instead of silently
  swallowed, and the JSON output includes a `failed` array
- `ggh discard` now requires `--include-untracked` to delete untracked files
  named as explicit arguments, not just when `--all` is used
- `ggh worktree add` no longer calls the AI provider in `--dry-run` mode; it
  produces a best-effort slug from the input instead
- `ggh commit` feature-branch prompt now validates the branch name with
  `validateBranchName` (rejects spaces, leading dashes, `HEAD`, `..`, etc.)
  before passing it to `git checkout -b`
- `ggh commit --provider` help text now lists all four providers (codex, grok,
  claude, ollama) instead of only two
- README now documents `issue create --ai`, `pr review --approve`, `pr merge
  --auto`/`--no-delete-branch`, `pr diff`/`edit`, `repo list`/`delete`/`archive`/
  `unarchive`/`rename`/`edit`/`sync`, `release view`/`download`/`upload`/`delete`,
  `config doctor`/`get`/`unset`, `search`, `notifications`, `browse`, `label`,
  `secret`, `variable`, `gist`, `workflow`, and GitHub Enterprise (GHES) setup

### Fixed

- `ggh stack restack`, `stack next`, and `stack submit` now guard against
  detached HEAD instead of producing confusing failures or branches named `HEAD`
- `ggh sync` always force-deleted (`-D`) every stale branch even without
  `--force`, defeating the safe/unsafe split it advertised
- `ggh discard <file>` could delete untracked files without `--include-untracked`
  when they were named as explicit arguments
- `ggh worktree add --dry-run` made a network call to the AI provider before
  deciding not to create the worktree
- `ggh commit` accepted invalid branch names (spaces, leading `-`, `HEAD`, `..`)
  in the feature-branch prompt, which then reached `git checkout -b`

## 0.2.0 — 2026-09-03

### Added

- Pull request lifecycle: `create`, `view`, `merge`, `ready`, `close`, `reopen`,
  `comment`, `edit`
- `ggh pr review` — AI findings anchored to real diff lines, submitted as a
  genuine GitHub review rather than terminal output
- `ggh issue` — list, view, create, close, reopen, comment, and `develop` to
  branch from an issue
- `ggh run` — workflow runs, with AI triage of the failing job's log
- `ggh repo` — view, fork, create, set-default
- `ggh stack` — stacked branches built on the `gh-merge-base` pointers ggh
  already recorded: `list`, `next`, `on`, `restack`, `submit`, `checkout`
- `ggh changelog` — keeps the release notes it used to discard
- `ggh api` — passthrough escape hatch to `gh api`
- Claude Code and Ollama providers; the local one is last in the chain, so
  running out of credits everywhere still leaves something that answers
- `--json` on 13 commands, `--dry-run` on 12, plus `--quiet`, `--no-input`,
  and `-R/--repo`
- Layered configuration: flags > `GGH_*` environment > project `.ggh.json` >
  user file > defaults, with `ggh config list` naming the winning layer
- Disk cache for GitHub responses, and `ggh config cache-clear`

### Changed

- **stdout is now data and stderr is everything else.** `ggh log | grep` no
  longer matches its own banner, and redirecting stdout no longer hides errors
- Shell completions are generated from the command tree instead of maintained by
  hand in three scripts
- `checks --watch` backs off from 5s to 30s and stops at `--timeout`
- Aliases: `st` now means `status`; stash moved to `sh`, stack took `stk`
- Dropped `@clack/prompts`; the output layer is now first-party

### Fixed

- Ctrl-C during AI generation did nothing at all. It now exits 130, kills the
  provider subprocess, and restores the cursor
- `ggh add <file>` searched GitHub and cloned a stranger's repository, because
  `add` was an alias of `clone`. It now falls through to `git add`
- Interactive prompts silently auto-answered without a TTY, so `ggh resolve` in
  a script discarded the incoming side of every conflict and reported success
- `ggh clone --fast` prompted for a clone mode anyway, discarding the flag
- `ggh commit --pr` described the wrong changes, building the body from an index
  its own commit had just emptied
- `getCurrentBranch` reported `HEAD` in a repository with no commits, tripping
  the detached-HEAD guards on a first push
- Eight commands reported failures and exited 0
- Secret redaction missed Slack, Google, GitLab, npm, and fine-grained GitHub
  tokens, JWTs, database URLs, and unquoted assignments

## 0.1.0

Initial release.
