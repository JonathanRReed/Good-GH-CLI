# Release readiness

The source candidate is **0.6.0-beta.1**, prepared from `feat/v0.6-projects`
commit `4d01687` in the isolated Phase 4B worktree. This is release preparation,
with no tag, publication, or GitHub writes. Source, installed artifacts, live
providers, platform security, and distribution remain separate gates.

## v0.6 gates, 2026-10-22

| Gate | Command | Phase 4B receipt |
| --- | --- | --- |
| Typecheck | `bun run typecheck` | Passed |
| Lint | `bun run lint` | Passed |
| Source tests | `bun test --timeout 30000` | 921 pass, one skip, zero failures; 922 tests across 82 files |
| Agent evidence | `bun run bench:agent` | Passed, eight cases, 100% declared evidence recall |
| Lean bundle | `bun run build` | 667,901 bytes; below CI limit of 714,271 |
| Manual freshness | `bun run man --check` | Passed |
| Skill/reference freshness | `bun run skill:reference --check` | Passed |
| Installed native smoke | `make smoke` | Passed, 10/10 checks, macOS arm64 |
| README command examples | Installed `ggh <command> --help` | Passed, 82 help/version invocations; four native escapes inspected |

The bundle limit and retained subsystem costs are explained in
[packaging](PACKAGING.md). The manual now embeds `0.6.0-beta.1`; the agent wire
contract remains version 1. These receipts cover this worktree; rerun the gates
against the integrated revision before release. The skipped test requires
PowerShell for nested completion; this macOS run does not qualify that shell.

### Installed macOS smoke

`scripts/smoke-installed.sh`, invoked by `make smoke`, compiles the standalone
binary through `make install PREFIX=<temporary prefix>`. The Makefile ad-hoc
signs macOS builds. The prefix, HOME, config, and project paths are temporary;
prefix and project names include spaces. Required tools are Bun, Git, make,
zsh, and jq. The script clears caller auth/Git/AI settings, disables hooks and
plugins, and permits only Git's local file transport. A rejecting gh executable
records unexpected calls and fails the smoke if called.

Ten checks exercise the installed executable:

1. Version, PATH selection, manual, and installed completion files.
2. Bare `ggh` projects table, with human output on stderr.
3. `ggh init zsh` sourced in zsh; `g example` changes the shell directory.
4. `ggh clone file://...` into cwd, with origin and provenance checks.
5. `ggh projects example --agent` with schema and checkout assertions.
6. `ggh lost --agent` finding exactly one unpublished branch commit.
7. `ggh tidy --all --dry-run --agent` proposing only the merged candidate,
   with no completed effects or deleted branches.
8. `ggh sync --all --agent` fast-forwarding both clones to a new local-remote
   commit while preserving the unpublished branch.
9. `ggh status --agent` reporting clean main and the exact new HEAD.
10. `ggh agent skill --install claude --dry-run` leaving no installed skill files.

JSON checks use `jq -e`; failures stop the script. The EXIT trap removes the
fixture and install prefix. Smoke result: **10/10 passed** on macOS arm64,
Bun 1.4.4-canary.1, version `0.6.0-beta.1`; no gh calls occurred.
The compiled native binary SHA-256 was
`511c32c611d97207169a9f78f7f7094d678a096fb05a4d50bc9f168042fb008c`.
This smoke does not exercise tidy execution, providers,
notarization, cancellation, upgrade/rollback, or every shell.

### Existing real-data checks

These dated receipts come from the [full progress log](strategy/progress.md),
not a new Phase 4B scan. They describe earlier v0.6 revisions and must be rerun
against the integrated candidate before making current runtime claims.

- Initial read-only Downloads discovery found 73 clones / 139 checkouts in
  4.7-5.3 seconds, with 15 checkout deadlines and 14 skipped paths. After local
  status fixes, paired runs covered 73 clones / 141 checkouts, with 15 missing
  checkout paths and 14 discovery skips. Warm first-row median changed from
  6,112 to 52 ms; fresh TTY completion from 6,118 to 2,842 ms. The 70-repo fixture
  changed from 2,227 to 50 ms for first rows and 2,230 to 1,731 ms for completion.
  See [measurement conditions](strategy/projects-performance.md).
- Real tidy preview used isolated config and `GGH_NO_RECORDS=1`. Repository
  fingerprints matched before/after. All 20 proposed local-branch deletions
  were independently checked for ancestry of origin/main and absence from
  checkouts. No checkout removals were proposed; host worktrees stayed manual.
  A later dry run was rechecked after the view/path/deduplication fixes.
- Remote read-only checks covered 73 clones and 35 distinct remotes across 69
  clones; four clones lacked recognized remotes. All 35 remotes returned complete
  fields. Cold: 8.527 s, two requests, cost two. Warm: 2.574 s, zero requests,
  cost zero. The cold target of about 5 s remains unmet. See
  [remote receipts](strategy/projects-remote-verification.md).
- Live review of PR #14 checked checkout creation without `.env`, explicit
  marking, and `--since last`. Agent mode launched no editor. Later fixture
  checks cover effect reporting; that later behavior has no fresh live receipt.
- Exact-scope fixtures at the earlier baseline reproduced four unintended-scope
  incidents in 20 cases. Fixed source passes all 20 with zero incidents.
  [Fixture report](../bench/agent/exact-scope.md).

The [agent benchmark](../bench/agent/README.md) uses eight offline cases. Its
100% declared evidence recall is not blind diagnosis or repair-success proof.
VS Code CI output measures 133,470 native bytes versus 8,625 ggh bytes; Zod CI
favors native at 5,402 versus 7,231. Clean status costs 181 versus 121 bytes;
dirty ggh costs 371/786 bytes for 5/25 paths versus native v2's 707/3,200 and
native v1's smaller 119/412. Tokens are byte estimates, not tokenizer results.

### Still unverified for v0.6

- Linux and Windows installed behavior, plus macOS Intel and the signed,
  notarized universal DMG. Earlier v0.5 receipts below do not qualify v0.6.
- Live tidy execution on real repositories. Fixture proofs and read-only plans
  do not establish real deletion behavior.
- Live `tidy --audit` with a real provider. It has not run; sending metadata
  requires owner consent. Adapter fixtures do not prove current model access.
- Remote cold latency at or below 5 seconds; observed 8.5 seconds is over target.
- Real bulk sync on the owner's repositories, other shell/profile installation,
  cancellation, and platform packaging/upgrade/privacy qualification for v0.6.
- A blind agent diagnosis/repair trial and the uncoached outsider workflow.
- npm registry publication, Homebrew availability, downloaded-release checksums,
  and GitHub release assets for this candidate. Preparation proves none of them.

## Historical v0.5 qualification

The entries below retain the older evidence and regression map. Their revisions,
platform receipts, and published artifacts are separate from this candidate.
The [execution plan](quality/quality-release-plan.md) and
[continuation record](quality/quality-release-continuation.md) track that work.

## October 15 candidate qualification

All three source platforms and all five native artifact pipelines passed at
`3f6f325`. The [platform receipt](verification/2026-10-15-platform-qualification.json)
binds their artifact hashes and checks to the tested merge. The final tag runs
those gates again. Published checksums and the release qualification asset
establish the distributed files, separately from this dated checkpoint.

- Local source verification passed 569 tests across 62 files. Typecheck, lint,
  build, manual freshness, actionlint, and source secret scans passed.
- Each of four POSIX artifacts passed 71 native regressions and six terminal
  cases. Windows passed eight actual ConPTY cases, 83 cross-user privacy checks,
  and process-tree qualification. The temporary test account was removed.
- All five artifacts passed clean install, PATH, upgrade, rollback, restore,
  local commit/hook and uninstall checks, fourteen offline demo commands, and
  eleven validated performance workloads with five warm samples per side.
- Installed Node/Bun packages and the actual npm, Bun-global and lean launchers
  passed local qualification. Hostile project dotenv/preload files were blocked;
  explicit caller environment settings remained available.
- Live private/public setup, protected-push rejection, partial recovery,
  private PNG access, independent commit/stack journeys, and actual vi editing
  passed. Synthetic PRs/branches were cleaned and both QA repositories archived.
- Six ordered experiments were completed and excluded where they added no
  demonstrated task benefit. The initial audit removed 104 redundant source
  cases and one duplicate native case. Final review retained distinct coverage.

The GitHub workflow prepares a draft. Publication requires the exact signed,
notarized universal macOS DMG, checksum and downloaded-artifact verification.
Apple acceptance, stapling and Gatekeeper are separate checks. npm registry
publication remains explicitly disabled; the tested package tarball is included.

Jonathan is the sole user and waived outside human testing. Organization/SSO,
a second-account fork, and working SSH credentials were unavailable and are not
reported as passes. Provider model generation was not needed for qualification.

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
