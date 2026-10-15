# Good GH product improvement design

Status: approved and implemented. Local macOS acceptance passed. The acceptance receipt and release-readiness checklist record the remaining platform and live-service gates.

## Objective

Make `ggh` dependable enough for Jonathan to test daily, then prepare it for launch. The first audience is developers who use coding agents and manual terminal commands. macOS, Linux, and Windows have the same acceptance requirements.

There is no fixed deadline or artificial feature cap. Work proceeds through complete, verified workflows. An implemented command, passing source suite, installed artifact, authenticated GitHub flow, and published release are separate claims.

The three priorities are:

1. Make the daily repo, commit, PR, and stack workflows complete and predictable.
2. Make agent output, privacy, partial failure, interruption, and recovery dependable.
3. Prove installation, terminal behavior, performance, and built artifacts across all supported platforms.

## Agreed product decisions

- Keep `gh` as the GitHub transport dependency for this release.
- Infer repo name, source directory, private visibility, and `origin` for a local repo with commits and no remote.
- Show one creation-and-push confirmation by default. Offer a user-owned setting that skips this repo-creation confirmation.
- Use distinct `ggh` commands with explicit Git and `gh` escape commands.
- Use supported GitHub media uploads first. Allow configured storage as a fallback, preserving private access.
- Complete core workflows without AI. Enable generation through an explicit flag or user-owned setting.
- Automate local restacking. Update published branches only during explicit stack submission, using force-with-lease when needed.
- Report completed work and recovery instructions after interruption or partial failure.
- Let PR creation complete missing-remote setup in one confirmed plan. Use a valid existing base branch, and ask when the base is ambiguous.
- Keep local command metadata, outcomes, revisions, and verification-file references. Include raw prompts, transcripts, source content, or uploaded records only by explicit request.

## Current evidence

The inspected checkout is `main` at `4b1657e3d922e4feb73a73800615a315a84e8c42`. It was clean before this document. The local `origin/main` ref is one commit ahead, containing CI action updates. No pull, reset, commit, push, or remote write occurred during the audit.

Fresh checks on this revision passed:

- `bun run typecheck` exited 0.
- `bun run lint` exited 0.
- `bun test --timeout 30000` reported 470 passes and zero failures across 35 files.
- A PTY probe of `promptInput` returned `alpha` after typing `alpha beta` followed by ESC DEL and Enter.

Two additional probes exposed gaps:

- Queuing `alpha` and `bravo` for consecutive `promptInput` calls lost the second answer. The second prompt waited until the bounded probe stopped it.
- An isolated fake `gh` accepted `repo create demo --private -y --json`. `ggh` exited 0 with empty stdout and stderr.

These probes establish behavior on this macOS host. They do not establish every terminal's Option-Delete mapping or a real GitHub write.

Three Luna 6 workers mapped complaint coverage, agent recovery, and installation readiness. Their source findings include absent PR media support, no missing-remote bootstrap, inconsistent JSON output, and incomplete stack failure reporting.

## Complaint coverage

The supplied Theo Browne analysis is requirements input. Historical quotations, vendor performance claims, and video accounts were not independently verified.

- **Word deletion and typeahead.** Keep standard text editing, preserve queued input across prompt transitions, and restore terminal state on cancellation. Test text entry and pickers separately.
- **Context-aware repo creation.** Infer the current repo's name and source. Inspect local state before requesting answers. Do not ask for values already known.
- **Prompt count and network blockers.** Gather unresolved local choices before execution. The normal initialized-repo path has one final confirmation. Network progress never appears between already answerable questions.
- **Redundant remote and push choices.** The inferred plan includes `origin` and the current branch push. Explicit options override the plan. Existing remotes are inspected rather than overwritten.
- **The PR creation dead end.** Validate the local base and head, then offer repo creation, base push, head push, and PR creation as one operation.
- **PR screenshots and videos.** Attach files through supported `gh` commands without committing them to Git. Report partial uploads accurately.
- **Stacked branches.** Preserve parent tracking, restack descendants after a parent changes, submit against actual parents, and support conflict continuation and abort.
- **Unified daily work.** Make commit-to-PR work with and without a remote. Share publication behavior between `commit --pr`, `pr create`, and stack submission where their requirements overlap.
- **Agent invocation.** Never prompt in JSON or no-input mode. Return usable JSON for success, dry-run, required input, partial completion, and failure on commands that advertise it.
- **Smartlog.** Add an optional view that combines local branch relationships with PR review and CI status. Keep ordinary local stack reads offline. Show stale or unavailable remote data explicitly.
- **Usage reporting.** Record provider and model attempts and any reliable usage values returned by the provider. Unknown token counts and costs stay unknown. Do not estimate them from transcript length.
- **Agent provenance.** Link operation metadata and explicitly supplied verification files to a revision. Raw transcripts and prompts remain opt-in.
- **Stale-tool guidance.** Improve doctor output with installed versions, capability checks, and actionable errors. Do not write agent memory rules or invent permanent workarounds from one failed command.
- **Community backlash.** This is historical context rather than a product behavior to implement.
- **Forgejo, Pierre, Jujutsu, and Sapling comparisons.** Adopt the useful workflow lessons. GitHub uptime, another host's push-to-create support, and another VCS's conflict model remain outside this CLI's control.

## Command ownership

`ggh` owns its documented command behavior. `ggh git <args>` and `ggh gh <args>` explicitly invoke the underlying tools. `ggh -- <args>` remains an explicit Git escape.

Unknown commands and Git-specific flags on a `ggh` command fail with a useful suggestion. They do not silently switch tools. Existing examples such as `ggh add .` move to `ggh git add .`. Git configuration moves to `ggh git config`; `ggh config` remains the app's configuration.

Escape commands preserve the underlying tool's arguments, standard streams, exit status, and signal behavior. They do not reinterpret native flags as `ggh` JSON or dry-run promises. Resolve escapes before loading optional plugins or doing unrelated setup.

Update help, completions, the manual, README examples, and routing tests together. Keep aliases explicit and reject aliases that collide with reserved escape commands.

## Repo creation and PR setup

Local inspection produces a publication plan before mutation. The plan names the host, owner, repo, visibility, source, remote, base, head, and ordered steps that apply. Infer the name and source from the repository root when invoked from a subdirectory.

For `ggh repo create` inside a named local repo with commits and no remote, the default plan creates a private repo, adds `origin`, and pushes the current branch. An explicit name, owner, visibility, source, or remote overrides the relevant default.

The fast-mode setting applies only to repo creation. Store it in user configuration. A cloned repository cannot enable it. Explicit command flags take precedence. Fast mode still refuses ambiguous targets, conflicting remotes, detached HEAD, and invalid repository state.

For `ggh pr create`, a newly created repo is private unless the user explicitly selects another visibility. Choose the base from an explicit flag, valid recorded parent, or unambiguous existing default branch. Validate that base and head differ and that the head has changes before creating a remote repo. If no valid base exists, ask interactively or return an actionable needs-input result. Do not create an empty commit, split history, or reinterpret the head as its own base.

When creating the remote for a PR, push the intended base before the head so GitHub gets the correct default branch. The single confirmation covers the complete plan. Repo-creation fast mode does not silently bypass this PR confirmation.

Recheck branch tips and relevant remote state before execution. Refuse a plan whose source state changed. Reuse an existing matching repo, remote, branch, or PR after inspecting it. Never overwrite a conflicting remote as a retry strategy.

The no-input path requires enough explicit input and mutation authorization to execute. `--json` alone never means yes. Dry-run resolves safe defaults, reports missing decisions, and performs no mutation or AI request.

## Shared data and module boundaries

Use a narrow repository-publication service for repo creation and missing-remote PR setup. Keep Git mechanics in the existing Git services and GitHub transport in the existing GitHub services. Command handlers collect input and render results.

The core data shapes are:

- A local publication snapshot containing repository identity, named branches, branch tips, parent relationships, and remotes.
- A publication plan containing the chosen target and ordered domain actions.
- A plan result that is either ready or needs input. Do not represent both states with optional fields.
- An operation report with a discriminated status: planned, succeeded, needs input, cancelled, partially completed, or failed.
- A step result with a discriminated status: pending, completed, failed, or unknown after interruption.
- A typed attachment result that distinguishes no remote write, successful upload, and partial completion with an existing PR URL.

Command handlers do not duplicate target selection, private defaults, remote creation, or retry rules. The shared service hides these decisions behind a small interface. Preserve per-command validation and reports for unrelated commands instead of building a universal workflow engine.

The alternative is independent fixes inside each command handler. It has a smaller first diff, but repeats publication decisions in `repo create`, `pr create`, and `commit --pr`. Use the narrow shared service because those paths must agree after retries and partial failure.

The source ownership map is:

- `src/index.ts` and `src/utils/passthrough.ts` own command routing and explicit escapes.
- `src/utils/prompts.ts`, `src/utils/output.ts`, and `src/utils/flags.ts` own input, rendering, and advertised flag behavior.
- `src/services/config.ts` and `src/services/runtime.ts` own validated user policy and per-invocation options.
- A narrow `src/services/publication.ts` owns shared repo-publication plans and results. `repo.ts`, `pr-create.ts`, and `commit.ts` call it.
- `src/services/git/stack.ts` and `src/commands/stack.ts` own local stack mechanics and the stack workflow.
- A local `src/services/operations.ts` owns operation records. A command module exposes record inspection and explicit evidence association.
- `src/services/github/prs.ts`, `src/services/github/issues.ts`, and their command handlers own supported attachments and remote resource results.
- `tests`, `scripts`, and the existing CI workflows own behavior fixtures and exact-artifact verification. Help, completions, the manual, and docs change with their owning commands.

## Output and prompt contracts

Each JSON-capable invocation emits one complete JSON document on stdout. Keep established successful read-only payloads where possible. Mutation and dry-run results include operation status, target, completed steps, remaining work, and recoverable resource URLs.

Failures have a nonzero exit status. In JSON mode, their machine result remains parseable, and human diagnostics stay on stderr. Do not report full failure when a remote resource exists, and do not report success when a requested upload or push failed.

Replace domain-level lexical checks as the primary evidence with behavior checks for individual advertised subcommands. Exercise JSON, dry-run, no-input, confirmation, and their meaningful combinations against isolated fixtures.

Give each interactive invocation one owner for input buffering and terminal cleanup. Preserve queued answers across text prompts. Suspend or transfer ownership explicitly for raw-mode pickers. Cancellation must close readers, restore cursor and terminal modes, and terminate children.

Use POSIX PTYs for automated terminal behavior checks. Exercise native Windows terminal behavior on a Windows host. Piped stdin tests do not establish interactive editing behavior.

## AI policy

Add an explicit AI opt-in policy separate from provider choice. A configured provider alone does not enable generation. A project config cannot turn AI on, switch providers, enable hosted fallback, or grant hosted-content consent.

Explicit commit messages never invoke AI. Non-AI PR generation uses commits and templates. Interactive commits offer manual message entry without provider setup. No-input commits require a message rather than fabricate one.

Commands explicitly requested for AI work may invoke AI, subject to existing consent and local-only policy. Generation failure reports the attempted provider and model, then follows a documented manual or commit-history fallback. It never silently sends local-only content to a hosted provider.

Remove first-run provider setup from ordinary non-AI workflows. Keep provider and capability diagnostics in setup and doctor commands.

## Media and verification files

The installed `gh` 2.100.0 advertises `--attach`. Current GitHub documentation supports attachments on PR and issue creation, editing, and comments. Use capability detection to support older installations with an actionable upgrade or configured-fallback path.

Expose repeatable attachments and body-file input on the relevant `ggh` commands. Pass long bodies through stdin or files rather than shell interpolation. Validate files and supported capabilities before any remote write. Dry-run lists intended files and destinations without uploading.

GitHub can create a PR even when an attachment upload fails, returning a nonzero status while printing the new PR URL. Preserve that resource in the operation result. Retry the failed attachment against the existing PR instead of recreating the PR.

Configured fallback storage is explicit and user-owned. A private target must not silently use public hosting. If access cannot be established, retain the local file and report the upload as incomplete. Do not make public release assets or public gists an implicit fallback for private evidence.

Verification records distinguish a supplied file reference from a verification result actually produced by the tool. Attaching a screenshot does not certify the screenshot's claim.

Sources:

- [Attaching files with GitHub CLI](https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli)
- [Attachment access rules and limits](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files)
- [PR creation and partial attachment failure](https://cli.github.com/manual/gh_pr_create)

## Stack recovery

Build and display a complete restack or submission plan before execution. Submit the selected branch, its required ancestors, and its recorded descendants in parent-first order. Exclude unrelated side stacks. The plan makes the exact branch set visible before approval.

Record original branch, expected branch tips, ordered steps, and completed resources. Remote branches and PRs created before a later failure remain visible in the report. Restore the original branch when Git can safely switch. If a conflict requires staying in a rebase, report that state instead of hiding it with a checkout attempt.

Continue and abort validate the actual Git rebase state. Resume inspects remote resources before repeating a step. Lost responses produce an unknown step status until inspection establishes what happened.

Published rewrites require explicit submission and force-with-lease. A changed remote tip causes a refusal with recovery guidance. Recovery does not force-reset work or delete remote resources.

## Local operation records

Use one file per operation with a unique ID. Store records outside tracked source in Git metadata or the private user config directory. Shared worktrees can discover records without sharing a mutable append file.

Records for mutating and AI-assisted operations contain command identity, target, timestamps, revision identifiers, classified outcomes, completed resources, and explicit verification-file references. They omit message bodies, raw arguments containing secrets, raw process output, prompts, transcripts, and source content by default. Dry-run returns a preview without creating or updating an operation record.

Write updates atomically and validate records before reading them. Restrict file permissions where the platform supports them. Recording failure must be visible, and commands promising resumable execution must establish their record before mutation.

Provide commands to list and inspect records, associate explicit evidence, and prune records by explicit request. Never transmit the operation history automatically. Raw-content inclusion and PR publication are distinct explicit actions.

## Work order

Each unit ends with direct behavioral evidence before the next begins.

1. Establish command-level fixture checks and fix prompt typeahead, cancellation, empty JSON, and structured dry-run behavior.
2. Make routing explicit and core workflows independent of AI. Update help, manual, completions, and examples with those changes.
3. Complete context-aware repo creation and missing-remote commit-to-PR publication through the shared service.
4. Add operation records and verify stack interruption, conflict, retry, partial submission, and branch restoration.
5. Add supported attachments, body files, verification references, and private configured fallback handling.
6. Add the optional PR-and-CI stack view, capability diagnostics, and reliable provider usage fields.
7. Audit remaining advertised commands for consistent contracts, then verify installed packages and native artifacts on all supported platforms.

During implementation, independently assign bounded discovery, fixture extraction, and mechanical work to Luna 6 where it saves time. Keep shared workflow integration under one owner. Do not run parallel writers against the same files.

## Acceptance requirements

- A normal local repo creation requires one confirmation, infers the agreed defaults, and preserves existing files and history.
- Repo creation fast mode skips that confirmation only when the plan is unambiguous and locally authorized.
- A valid local feature branch with no remote reaches an existing or newly created PR through one confirmed setup plan.
- Ambiguous or invalid PR bases cause no remote creation, branch push, or invented commit.
- Repeating a publication after a simulated lost response discovers the existing resource and avoids duplicate creation.
- Unknown and ambiguous command routing invokes no unintended Git command.
- Core local and PR workflows complete with provider executables absent. Explicit AI flags and settings enable generation without weakening consent policy.
- Every advertised JSON path emits parseable output with the correct status. Every dry-run leaves repository, config, index, remote, and files unchanged.
- Missing interactive input fails without mutation or waiting indefinitely.
- Text editing, typeahead, cancellation, Unicode input, and picker transitions pass their terminal checks.
- A parent amendment restacks descendant-only work correctly. A conflict supports continue and abort without losing branch tips or parent relationships.
- A late stack failure reports earlier pushes and PRs, retains recovery state, and restores the original branch when safe.
- A changed remote tip fails force-with-lease rather than overwriting another writer's work.
- Media reaches the intended PR without entering Git history. Partial upload retains the PR URL and supports an attachment-only retry.
- Private evidence stays within a verified private destination, or the upload fails without public fallback.
- Default local records exclude source, credentials, message bodies, and transcripts. Explicit evidence publication names the files and destination.
- Local-only commands make no GitHub or provider request. Help and version perform no account probes.
- Preserve the current CI budgets of 2 seconds for startup, 10 seconds for status, and a 400,000-byte bundle until measurements justify a change. New measurements name the artifact, host, sample method, and limiting operation.
- Source checks, command fixtures, package-install checks, and exact native-artifact checks pass on macOS, Linux, and Windows. Windows terminal checks require Windows execution, not a cross-compiled artifact alone.

Authenticated acceptance uses a separately authorized disposable repo and harmless fixtures. Check private attachment access both with and without access to that repo. Test installed provider versions using explicit AI consent and nonprivate fixture content.

## Completion and authority

Development is complete only when the required workflow and artifact checks establish readiness for Jonathan's testing. A failed or unavailable platform or live-account check remains visible. Source checks do not substitute for it.

Launch work also needs a clear install channel, accurate runtime requirements, current downloadable assets, and precise macOS trust claims. Prepare package and installer artifacts and documentation without claiming publication. Signing, notarization, registry publication, installer-channel submission, and live release availability need their own receipts.

Local design work is authorized. Product implementation follows the shared-understanding checkpoint requested through `/grill-me`. Commit, push, pull request creation, publication, deployment, spending, credential changes, and production mutations are not authorized by this design.

Broader ideas remain eligible after the core workflows are verified. Assess each against an observed user problem and a measurable result. A new feature does not replace a failed acceptance requirement.
