# Release readiness

This is a release checklist, not a claim of perfect software or a security
certification. The 0.4.0-beta.3 candidate addresses the September 4 pre-adoption
audit and the September 7 completion pass. Published assets and registry versions are separate from code on main.

## Audit closure map

| Audit concern | Implementation / regression evidence |
| --- | --- |
| A01 cache deletion boundary | cache.ts; release-safety.test.ts; native case 03 |
| A02 cache identity | github/cache.ts; native cases 04, 31-34 |
| A03 staged split contents | git/split.ts; split-safety.test.ts; native 11-12, 25-29, 37 |
| A04 AI deny policy | runtime.ts and AI shared boundary; native 13 |
| A05 pre-commit behavior | hook check; native 05; exact-artifact commit/hook smoke |
| A06 rebase dry-run | stack command; native 15 |
| A07 true default / PR parent | git/sync.ts and branch.ts; native 16, 40-41 |
| A08 staged large-file limit | git.ts; release-safety.test.ts; native 14 |
| A09 negated flag forwarding | commit verify=false normalization; native 09, 29 |
| A10 repository layouts | git/paths.ts; native 06-08 |
| A11 local commits without gh | lazy GitHub lookup; native 10 |
| A12 notifications transport | account-global gh api transport; native 18 |
| A13 remote target reads | remote-aware guards; native 19 |
| A14 config JSON | config command; native 20 |
| A15 MCP protocol | mcp service; native 21-22, 30 |
| A16 numeric config validation | config service; native 23; release-safety.test.ts |

Additional cases cover API argv/dry-run, quoted secret paths, bounded subprocess
output, Claude tool isolation, local Ollama verification, and plugin recovery. Follow-up cases 44-52 cover detached splitting, optional AI
fields, malformed plugin metadata, GH_REPO host precedence, literal hook
arguments, custom hook names, preserved restack pointers and local PR checkout.
Release-note extraction and cache replacement during asynchronous fetches have
source-level regressions. Adversarial same-user filesystem mutation remains an
explicit non-goal in THREAT-MODEL.md, not a claimed isolation guarantee.

## Completion regression coverage

`git-path-safety.test.ts`, `push-target.test.ts` and `squash-safety.test.ts`
cover root-relative and literal path handling, conflict resolution, staged
rename recovery, protected untracked files, explicit push destinations,
corrupt-index failures and squash preflight/recovery. Each Git service test
now uses its own repository instead of inheriting dirty state from earlier tests.

Native cases 53-64 exercise nested discard and split operations, literal
filenames, staged renames, partially staged additions, corrupt indexes,
branch-scoped pushing, cancelled/invalid/full-history squash operations,
untracked rename sources and hook-failure recovery. Cases 45, 46 and 49 also
assert actual commit messages, successful plugin loading and successful hook
execution, not merely the absence of an error or canary.

`makefile.test.ts` checks that nested source, package version and lockfile
changes rebuild the binary and manual. It also installs, runs and uninstalls
the lean CLI under a prefix containing spaces. These Makefile tests run on
POSIX hosts with `make` installed.

## Required automated gates

Run typecheck, lint, all Bun tests, build, man --check and performance budgets.
On POSIX systems run scripts/audit-regressions.py against the newly compiled
binary, not an older release. The release workflow runs on PRs without publishing:
it packs/installs the npm artifact, compiles native binaries at the same SHA,
and downloads and tests those exact assets on Linux x64/arm64, macOS x64/arm64,
and Windows x64. The source suite independently runs Linux/macOS/Windows.

Do not weaken a failed assertion merely to make CI green. Check the fixture and
root cause, retain the failure, and verify the fix against the same expectation.

## External release checks

Automated mock tests do not establish live GitHub account/Enterprise permissions,
current provider authentication/model availability, or future CLI compatibility.
Before promoting a stable release, exercise an explicitly authorized disposable
GitHub repository and the supported installed provider versions. Never use
private production source as a compatibility fixture.

Developer ID signing and notarization require the maintainer's macOS credentials.
The raw Mac binaries are ad-hoc signed; do not describe them as notarized. Run
the DMG packager with a valid signing identity and notary profile and validate
the resulting exact asset before uploading it. npm publication requires an
explicit PUBLISH_NPM=true setting and valid credentials; disabled publication
must remain visible in release notes.

## Operational limits

Redaction is pattern-based, not a secret-detection guarantee. Providers, Git
hooks and installed plugins remain trusted executables. Ollama local verification
assumes a trusted daemon and unchanged model metadata; enforce no-egress policy
at the daemon/OS boundary as well. A split checkpoint is diagnostic/recovery
material, not an automatic rollback of arbitrary hooks. Stop after a partial
failure and inspect status/history before retrying.

Squash keeps the original commits reachable at `refs/ggh/squash/<original-head>`.
Message selection and AI requests finish before the reset. If a commit hook
fails after the reset, inspect `git status` and the recovery ref before taking
further action; arbitrary hook changes are not automatically rolled back.
Squashing an entire history requires a named branch. A partial range that would
include more commits through a merge than the requested count is refused.
