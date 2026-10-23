# Contributing

Bug reports and small fixes are welcome. For anything larger, open an issue
first — I would rather talk about the shape of a feature before you write it.

## Setup

```bash
git clone https://github.com/JonathanRReed/Good-GH-CLI.git
cd Good-GH-CLI
bun install
bun link          # now `ggh` on your PATH is this checkout
bun run dev status
```

## Before you open a pull request

```bash
bun run typecheck
bun run lint
bun test --timeout 30000
```

CI runs the same three on Linux and macOS, then builds and checks the bundle
stays under 400 KB.

The 30-second timeout is not decoration: the suite spawns a lot of real `git`
processes in temporary repositories, and the default 5 seconds is not enough
under concurrency.

## Conventions that are not negotiable

These are the rules the audit that produced this tool was built around. A change
that breaks one of them will be sent back.

**stdout is data, stderr is everything else.** Banners, progress, prompts, and
errors go to stderr via `p.log.*` and `fail()`. Only real output — `--json`
payloads, completion scripts, git passthrough — goes to stdout via `data()` or
`emitJson()`. `ggh log | grep` must never match a banner.

**Never guess when you cannot prompt.** With no TTY, `--no-input`, or `--json`,
prompts cancel and exit non-zero. They do not fall back to the first menu option
or to `initialValue`. If a command needs to run unattended, give it a flag.

**Destructive commands preview.** `--dry-run` describes and exits, *before* any
confirmation prompt. Checking it after the prompt means a dry run cancels in a
script and prints nothing.

**Errors say why and what to do.** `catch {}` that swallows a provider error is
the bug this project started with. Classify it, name the provider and model, and
suggest a next step.

**Every command exits non-zero when it fails.** Use `fail()`, which sets the exit
code for you.

**Register new actions as subcommands**, such as `ggh stash restore <name>`.
Subcommands get their own options such as `-y` and `--limit`. The global
decorator adds supported `--json`, `--dry-run`, `-R`, `-q`, and `--no-input` flags.

**Use the shared helpers.** `jsonOut(v)` instead of the `--json` triplet,
`confirmOrAbort()` instead of hand-rolled confirms (it forces you to pass
`assumeYes`), `unknownAction()` for unknown subcommand words,
`failFromGitHub()` for `gh` errors. Duplicating one of these by hand will be
sent back.

**`noUncheckedIndexedAccess` is on.** Indexing widens to `T | undefined`.
Reach for iterators (`.entries()`), `charAt`, and guards — never `!`.

**Generated files stay generated.** `man/ggh.1` comes from `bun run man`,
completions from the command tree. CI fails when they drift, so regenerate
instead of hand-editing.

## Layout

```
src/commands/    one file per command; registers itself on the program
src/services/    facades (git.ts, github.ts) over domain modules in git/, github/
src/services/ai/ provider chain: base.ts is shared, one file per provider
src/utils/       exec, output, ui, prompts, suggest, diff, flags, conventions
tests/           bun:test, real git repositories in temp dirs
```

Adding an AI provider means extending `CliAIProvider` and implementing
`invoke()`, `isAvailable()`, and a model chain. The fallback logic, prompt
building, JSON recovery, and error classification are inherited.

## Tests

Prefer a test that fails without your change. For anything touching git, build a
real repository in a temp directory — the existing tests in `tests/git.test.ts`
and `tests/platform.test.ts` show the pattern.

Do not put a literal that matches a real secret pattern in a test fixture, even
an invented one. GitHub's push protection blocks it. Assemble it at runtime:

```ts
const fakeGitHubToken = `gh${"p"}_${"a".repeat(36)}`;
```

## Releasing

Maintainer only:

```bash
bun run release 0.4.0
```

The script verifies the tree, bumps `package.json`, promotes the manually written
Unreleased changelog entry, regenerates the man page, commits, and creates a local
tag. Review the commit and tag before publishing. See [PACKAGING](docs/PACKAGING.md)
for the release workflow and npm publication gates.


## Release-safety regressions

Use Bun 1.4.4 and `bun install --frozen-lockfile`. Dependency changes must include
an updated `bun.lock` on the reviewed branch; no workflow rewrites main's lock
file after merge. Regenerate it with `bun install`, then run the frozen install
and full checks before committing.

On Linux/macOS, compile the executable and run the black-box suite:

```sh
bun build bin/ggh.ts --compile --minify --outfile /tmp/ggh-audit
python3 scripts/audit-regressions.py --binary /tmp/ggh-audit --results /tmp/ggh-audit-results.json
```

The suite uses disposable repositories and mocked GitHub/model CLIs. Never point
it at a production checkout or replace its mocks with authenticated live clients.
The source tests in `tests/split-safety.test.ts` also cover index transactions on
Windows. See `docs/RELEASE-READINESS.md` before tagging.
