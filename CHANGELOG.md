# Changelog

All notable changes to this project are documented here.
This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
