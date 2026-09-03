# Changelog

All notable changes to this project are documented here.
This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

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
