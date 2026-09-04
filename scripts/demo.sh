#!/usr/bin/env bash
# 60-second ggh tour. Hermetic: temp repo, no network, no gh auth, no AI calls.
# Usage: ./scripts/demo.sh  (runs `bun run bin/ggh.ts` from the repo root)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GGH="bun run $ROOT/bin/ggh.ts"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

say() { printf '\n\033[1;36m$ %s\033[0m\n' "$*"; }

say "ggh --help  # grouped, not a wall"
$GGH --help | head -30 || true

say "git init + ggh status --json  # stdout is data"
git init -qb main . && git config user.email demo@example.com && git config user.name Demo
echo hello > hello.txt
$GGH status --json | head -12 || true

say "ggh log  # colourised graph"
git add -A && git commit -qm "feat: hello" && echo world >> hello.txt && git add -A && git commit -qm "feat: world"
$GGH log 2>&1 | head -8 || true

say "ggh ignore  # .gitignore without ceremony"
$GGH ignore "*.log" ".env" 2>&1 | head -8 || true
$GGH ignore --list 2>&1 | head -6 || true

say "ggh alias  # shortcuts that actually expand"
XDG_CONFIG_HOME="$WORK/config" $GGH alias ci "commit --dry-run" 2>&1 | head -5 || true
XDG_CONFIG_HOME="$WORK/config" $GGH ci --help 2>&1 | head -4 || true

say "ggh hook  # git hooks in one line"
$GGH hook install pre-commit 2>&1 | head -5 || true
$GGH hook list 2>&1 | head -5 || true
$GGH hook remove pre-commit -y 2>&1 | head -4 || true

say "ggh draft --dry-run  # AI-described stash, previewed for free"
echo work-in-progress >> hello.txt
$GGH draft --dry-run 2>&1 | head -4 || true

say "ggh stash push/list  # now real subcommands"
$GGH stash push -m demo 2>&1 | head -3 || true
$GGH stash list 2>&1 | head -4 || true

say "ggh stack list --json  # the graph was in git config all along"
$GGH stack list --json 2>&1 | head -8 || true

say "ggh triage --help  # read-only AI inbox triage (needs auth to run)"
$GGH triage --help 2>&1 | head -8 || true

printf '\nDone. Everything above ran with no network, no gh auth, and no AI calls.\n'
