# Quality release continuation

## Objective and authority

Jonathan approved every item in `2026-10-14-path-to-ten.md` in order, the six prototypes, final cleanup/debloat/performance, commit, merge to main, and a new release. He clarified that he is the only user and outside human testers are not required. Use solo manual checks and independent agent tasks. Continue without repeated approval questions. Do not contact other people, spend money, rotate credentials, or change unrelated repositories.

## Checkout

`/Users/jonathanreed/Downloads/Good-GH-CLI`, branch `feat/quality-release`, base `4b1657e`. All existing 112 dirty entries belong to this session's earlier work and must be preserved. `origin/main` is `eab613e416846be59af5ff018e71127e559b22c2`, one CI-only commit ahead. No new commit/push/PR has been made yet. Final target should remain a beta, with version selected before exact-SHA qualification.

Baseline snapshot: `/var/folders/ph/7cfrg6mn3bj120hdsfs79d140000gn/T/ggh-quality-release-baseline-9xig7fmi`. It contains tracked.patch, untracked inventory, state.json, original `ggh-before` binary and `bundle-before.js` for alternating performance comparisons. The original compiled binary is 71,308,274 bytes; bundle 453,328 bytes.

## Verified tranches

1. `src/services/process-lock.ts` implements owner-identifying lock directories. Unique owner filenames carry host hash, PID, token before JSON metadata is written. Dead local owners can be reclaimed; known live writers cannot be unlocked; unknown legacy locks require explicit `operation unlock <id> --unknown-owner --yes`. Operations use it through withLock. The initial file+recoveryguard design was rejected after review found acquisition races and stranded guards. Replacement reviewed by `lock_review`, no remaining material race in stated threat model. `tests/process-lock.test.ts` plus operations suite: 18 pass. Includes actual killed writer, competing claims, incomplete metadata, legacy/empty locks, replacement owner preservation. Typecheck/lint passed. `/tmp/ggh-lock-after.log`.

2. Completion now uses one local `completionCandidates` resolver in services/completion.ts and thin shell wrappers. Hidden `completion --query -- <words>` uses actual command tree; handles nested options, aliases, files with spaces, branches and operation IDs. Wrappers invoke the actual command name. Actual Bash, zsh and Fish tests passed; PowerShell runtime case is prepared and skipped locally because pwsh is absent. Focused completion+smoke: 26 pass, 1 skip. Typecheck/lint passed. `/tmp/ggh-completion-after.log`. Fish 4.9.3 was installed with Homebrew for direct verification. README PowerShell instructions added.

## Verified tranches 03 through 05

03: Additive --agent version 1 envelopes preserve legacy JSON and native escapes. The schema command exposes supported commands and inputs. Stable errors, required inputs and effect states do not depend on English messages. Help/version capture and API payload status spoofing were fixed. Focused 27 checks passed, plus typecheck/lint. /tmp/ggh-agent-after.log.

04: Metadata-only publication intent supports recovery guidance and operation resume. Titles, bodies, descriptions and attachment paths are not retained. Recovery requires content resupply, preserves browser/draft mode, reconciles existing effects, and holds an execution claim through journal finalization. Ten focused recovery/codec cases passed. /tmp/ggh-publication-resume-final.log.

05: Publication snapshots bind target/visibility/destination/tips/effects, content hashes, and streaming attachment fingerprints. Repo create, PR create and operation resume accept --approve-plan from dry-run snapshotId. Content changes and remote movement stop before new effects. PR comparison uses the live remote base object if available locally, preserves the local branch, and requests explicit fetch when unavailable. Existing-target plans read actual GitHub visibility and execution rechecks it. Human and JSON previews show the material target details. Stale approval reports structured confirmation_required.

Root final snapshot/codec checks: 14 passed in /tmp/ggh-05-snapshots-final.log. Fixture worker repaired only explicit repository responses and the affected call count; 66 focused publication/recovery/commit/media cases passed. Typecheck/lint passed. Native build ran 71 regressions successfully, /tmp/ggh-05-native.json. The full source run had 539 passes, one local PowerShell skip, and two stale recovery fixture failures; both fixtures were repaired and all five recovery cases passed afterward. Run full suite again before checkpoint.

## Active and next work

06 local gate passed, hosted gate pending checkpoint commit/PR. 541 source tests passed, one local PowerShell skip; typecheck, lint, man freshness, actionlint, diff whitespace and targeted source secret scans passed. Exact native and installed package receipts are in docs/verification/2026-10-14-quality-checkpoint.json. Current compiled ggh SHA256 is recorded there; root binaries are ignored build outputs. No active implementation worker.

The published beta.2 raw darwin-arm64 asset has a matching checksum but invalid Mach-O signature and is killed on this host. Do not re-sign and call that an exact old artifact. Its published signed universal DMG verifies; the extracted Developer ID binary runs beta.2 and is the honest prior rollback target. Local beta.2-to-beta.3-to-beta.2-to-beta.3 installation passed. macOS workflow uses that verified DMG; Linux/Windows use prior raw artifacts. Prior inputs remain /tmp/ggh-previous-beta2-dmg and /tmp/ggh-beta2-signed/ggh. Old invalid raw input is retained /tmp/ggh-previous-beta2.

Commit this checkpoint, integrate origin/main without discarding edits, push a draft PR and link it with T3. PR-triggered workflow builds and tests but never publishes. While hosted06 runs, proceed to07 Windows privacy and subprocess-tree cleanup. Windows design agent returned no code. Proposed shared private-storage boundary should create current-SID-owned protected DACL roots, batch-audit existing root descendants once per process, reject unsafe legacy ACLs/reparse/foreign owners before content access, cache only verified root identities, and cover config/cache/records/locks/stack/split/provider temp directories. Do not add per-file PowerShell startup overhead. Actual Windows cross-user and tree-cancellation checks are required. taskkill must address only tracked child PIDs via a trusted system path.

Then continue08–18, six prototypes, cleanup/performance and final release. User explicitly waived outside human testing. Do not tag or dispatch publishing release for validation. Final intended version can be0.5.0-beta.1; not bumped or tagged yet.

## External state checked live

GitHub account JonathanRReed is authenticated with repo/workflow scopes, repository ADMIN. Public repo default main. Main ruleset requires Ubuntu and macOS CI; Windows must also pass our release bar. No open PR. Latest remote public release is v0.4.0-beta.2; beta.3 tag absent despite local package version beta.3. PR workflow safely builds/verifies artifacts without publishing; do not dispatch release workflow for validation because non-PR dispatch publishes. Link any created PR with available T3 link_pull_request.

Developer ID identity is available. Existing Keychain profile `waves-notary` was discovered in memory and validated with `notarytool history`; no credentials were extracted or displayed. `/tmp/ggh-notary-preflight.json`. Use GGH_NOTARY_PROFILE=waves-notary for the final exact DMG, then verify submission, staple, Gatekeeper, mount/install separately.

`npm whoami` is unauthenticated, repository variables/secrets are empty. Existing release workflow treats npm publishing as explicit optional opt-in. GitHub assets and installable npm tarball can release without registry publication. OAuth scopes do not include delete_repo; avoid creating disposable repositories whose deletion would require broadening credentials. Prefer explicitly tracked reusable synthetic private/public QA repositories with contents/branches/PR cleanup, or resolve scope if deletion is required. Never alter real project visibility.

## Final gates

Do not claim completion before full source, native, package, platform, privacy, signing, live-service, terminal, failure, agent-task, cleanup and performance checks. Preserve each receipt separately. User authorized checkpoint commits as necessary for exact-SHA PR CI before final merge. Do not stage compiled ggh/ggh.sha256 or temp artifacts as source. Final commit/tag and public release require exact revision/artifact checks.
