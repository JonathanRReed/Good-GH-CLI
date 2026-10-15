# Good GH: path to a ten

My assessment is 7/10 for the current product. This is a judgment about a CLI for developers and coding agents on macOS, Linux, and Windows. A ten would mean the core workflows are obvious, fast, safe to retry, and proven on each platform. It would also require evidence from people using the product without its author's help.

The foundation is strong enough for focused testing. The current local receipts record 500 passing source tests and 71 passing native regressions on macOS. This assessment rechecked the source digest across 166 files and the native executable hash against that receipt; both matched. Those suites were not rerun for this assessment. The earlier receipt also records installed Node/Bun package and native hook checks. See the [test audit](../verification/2026-10-14-test-audit.md) and [implementation receipt](../verification/2026-10-14-local-acceptance.md).

Three independent Luna audits covered workflows, recovery and agent interfaces, and distribution. I checked their consequential claims against current code and ran isolated probes. The checkout remains dirty on `main`, based on `4b1657e3d922e4feb73a73800615a315a84e8c42`. No application code changed during this assessment.

## What already earns its place

- AI is optional. Explicit-message local commits work without a provider or `gh`.
- Repo creation defaults to private and derives useful context from local work.
- Commit-to-PR and missing-remote PR creation share a publication service.
- Local restacking, explicit submission, force-with-lease, conflict continuation, and abort have behavioral coverage.
- JSON output, literal filenames, staged snapshots, private metadata, and partial outcomes receive real regression checks.
- Source, compiled executable, and installed-package checks are separate. That distinction matters when something works in development but fails after installation.

These features address the supplied complaints. The next gains require harder failure cases and better first-use behavior, alongside selective additions.

## Findings checked in this assessment

| Finding | Evidence | Impact |
| --- | --- | --- |
| Nested completion is incomplete. | An actual native-generated Bash completion returned no candidates for `ggh pr create --ba`. The command specification collects subcommand names but omits their options in `src/commands/completion.ts:16`. Fish omits option completion; PowerShell's root candidates omit aliases. | Users must remember flags that completion should discover. Windows and Unix shell experiences differ. |
| An abandoned operation lock has no recovery path. | An isolated probe created a record, left its update lock behind, and attempted an update. It returned `Could not acquire operation update lock.` and left the lock present. `src/services/operations.ts:293` removes locks only in `finally`; the lock has no owner metadata. | A crash during a locked update can leave later updates or pruning blocked until manual cleanup. |
| JSON is parseable but lacks one stable agent contract. | Native `operation list --json` returned `[]`. Invalid config returned an object with `status` and `error.message`, without a stable error code or schema version. `src/utils/output.ts:25` confirms the fallback shape. | Agents need command-specific parsers and may have to interpret prose to choose their next action. |
| Generic operation recovery is inspection rather than resumption. | `src/commands/operation.ts:6` registers list, view, evidence, and prune. Stack-specific continue/abort exists elsewhere. Publication already reconciles existing repositories and PRs. | Existing recovery is useful, but users still assemble the next command after many partial failures. A generic resume feature would be an addition, not a fix for universally absent retries. |
| PR review content can be based on an older local base. | `src/services/publication.ts:535` reads the local base tip. It queries the remote base at line 581, but does not retain that remote tip in the PR plan. | This is a plan-freshness concern. Normal remote-base advancement is expected; the CLI should make its comparison snapshot clear and refresh when necessary. No destructive failure was reproduced. |
| Default-branch wording is broader than the behavior. | `src/commands/commit.ts:570` recognizes main/master and skips the branch-choice prompt with an explicit message. README describes the offer without that qualification. | Clarify deliberate direct commits and use the actual repository default for contextual guidance. An explicit-message commit on main is not automatically a defect. |
| The demo cannot serve as an acceptance test. | `scripts/demo.sh:7` uses a word-split command string, isolates config only for aliases, and masks most command failures with `|| true`. Its status command can use the user's GitHub setup. | Its no-network/no-auth claim is not enforced. Turn the tour into a controlled fixture with real assertions before using it as proof. This conclusion is source-based; I did not run the demo. |
| Equal platform quality remains unverified. | Current receipts are macOS-only. `.github/workflows/release.yml:181` skips the native regression harness on Windows. The harness is POSIX-only. | Source CI configuration does not establish Windows terminal, native process, installation, or filesystem privacy behavior. |

The native probe outputs are preserved in [the assessment evidence](2026-10-14-assessment-probes.json).

## Ranked work

P0 is the next hardening pass. P1 is required launch qualification. P2 is additional product polish. These are priorities, not time estimates.

| Priority | Work | Acceptance check |
| --- | --- | --- |
| P0 | Recover abandoned operation locks safely. Record enough owner identity to distinguish a dead process from an active owner or reused PID. Give explicit recovery when ownership cannot be established. | Terminate a writer at each lock/write boundary. Recover the abandoned record while refusing to unlock a live writer. |
| P0 | Complete nested command and option completion in all four shells. Include aliases, argument values where useful, and PowerShell installation instructions. | Exercise actual shell completion for PR base, attachments, stack continuation, operation IDs, and aliases. |
| P0 | Publish a versioned agent contract. Define result schemas, error codes, retryability, required inputs, partial effects, and documented exit behavior. Preserve native escape semantics explicitly. | A small agent driver completes the core workflows using structured fields, without reading English error messages or scraping help. |
| P0 | Extend the journal into a recovery guide and then resumable execution. Keep confirmed, pending, and uncertain effects distinct. Reconcile remote state before repeating uncertain work. | Interrupt after every publication step. The next invocation identifies what happened and continues without duplicate commits, PRs, comments, or confirmed uploads. Preserve the existing metadata-only privacy default. |
| P0 | Make plan snapshots explicit. Bind approval to target host/repo, visibility, branch tips, remote destination, and intended effects. Revalidate material changes. | Move the local head, remote head, and remote base independently after planning. The CLI either proceeds under a documented rule or asks for approval of the updated plan. |
| P1 | Qualify clean installs on macOS, Linux, and Windows using exact release artifacts. Cover install, PATH, upgrade, rollback, uninstall, spaces, and non-ASCII usernames. | A fresh machine reaches a successful local commit and GitHub readiness without undocumented steps. Attach receipts to the exact source SHA and artifact hashes. |
| P1 | Verify Windows privacy and process cleanup directly. Unix file modes are deliberately bypassed on Windows in `operations.ts:234` and `operations.ts:257`. | Check config, cache, records, temporary files, and recovery files from another Windows user. Confirm cancelled subprocess trees stop. |
| P1 | Run live GitHub qualification in explicitly authorized disposable repositories. Include private/public targets, forks, branch protections, SSH/HTTPS, organization permissions, expired credentials, and attachment failures. | Record resource IDs, outcomes, reconciliation, access checks, and cleanup. Mocked success alone cannot close these cases. |
| P1 | Verify the exact macOS download's trust and installation behavior. Run the existing Developer ID/notarization packaging path. | Download, validate checksum/signature/notarization/staple/Gatekeeper, mount, install, launch, and run a local workflow. |
| P1 | Exercise real terminals across supported hosts. Include queued input, word deletion, Unicode, paste, resize, narrow windows, Ctrl-C, SIGTERM, closed pipes, and restored terminal state. | Inputs survive ordinary editing; cancellation leaves a usable shell and an accurate operation outcome. |
| P1 | Build an adversarial failure matrix. Inject process termination, disk-full/write failures, Git locks, hook rejection, authentication expiry, rate limits, and server-success/client-timeout ambiguity. | Every required scenario preserves local work, reports confirmed versus uncertain effects, and provides a tested next step. |
| P1 | Evaluate task completion with Jonathan and independent coding agents. Jonathan waived outside participants because this is a solo project. | Complete repo creation, commit-to-PR, stack conflict recovery, and evidence attachment through documented commands. Independent agent attempts use structured output without author coaching. Record mistakes, prompts, retries, and outcomes. |
| P2 | Improve manual editing. Offer explicit editor-based PR title/body editing, usable template selection, and a clear preview before publication. | A developer writes and revises a multiline PR with AI disabled, without awkward shell quoting. |
| P2 | Make installation and dependency repair specific. Show the correct asset, checksum and PATH commands, detected Git/gh state, and the next useful setup command. | Follow each platform's instructions from a clean environment. Missing optional AI tools do not block ordinary work. |
| P2 | Measure packaged performance under documented conditions. Separate cold/warm startup, local Git work, and remote waiting. Existing 2-second/10-second budgets detect major regressions but do not define a delightful experience. | Report repeatable distributions for small, large, and monorepo fixtures on each platform. Set tighter user-facing targets from that baseline and identify the cost of each slow stage. |
| P2 | Refactor around the execution model where it reduces risk. Commit, publication, and stack commands currently span large stateful files. Extract independently testable transitions and effects as needed. | Demonstrate that a new failure or resume case can be expressed once and reused by manual and agent entry points. Preserve observable behavior; file size alone is not a reason to rewrite. |
| P2 | Turn the demo into a trustworthy offline tour. Use argument arrays, isolated config and PATH, denied provider/GitHub calls, and assertions. | It works from a checkout path containing spaces, fails on a broken command, and proves no network/provider invocation occurred. |
| P2 | Keep dependency compatibility visible. Retain capability probes and test supported Git/gh/provider versions, including unsupported-version guidance. | Unsupported features fail during preflight with an actionable remedy, before local or remote mutation. |

## Ambitious experiments worth prototyping

These are proposed additions, not current capabilities or launch requirements.

1. **A recovery timeline.** Show the operation as a short sequence of confirmed, uncertain, and remaining effects. Let the developer inspect the exact safe next command, with an explicit approval before new writes.
2. **A local rehearsal.** Run the local portion of a proposed workflow in a temporary repository with hooks, providers, and network disabled. Show the resulting history and files. Label remote effects as unexecuted; rehearsal cannot prove GitHub permissions or server acceptance.
3. **A contextual next-command assistant.** Suggest up to three deterministic actions from repository state. Explain each action and its effects. Keep execution explicit and AI optional.
4. **An agent handoff file.** Export the branch/revision, operation outcomes, pending work, and verification references. Content inclusion and uploads stay explicit. Another agent should continue without guessing from a transcript.
5. **A local incident fixture generator.** Build a previewable, minimal reproduction package from selected metadata and synthetic data. Require explicit inclusion of source, prompts, paths, or other content before export.
6. **A keyboard-first stack view.** Show local drift, PR review, CI, and recovery state together. Make selection lead to a visible plan, rather than an immediate rewrite or push.

Prototype the first two against real failed workflows. Keep them only if they reduce recovery mistakes or effort.

## What should distinguish this product

GitHub already documents native attachments and partial-upload behavior in [`gh pr create`](https://cli.github.com/manual/gh_pr_create). Attachment access requires repository push access in its [attachment guide](https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli). Media support is useful, but it no longer establishes the whole product's advantage.

The stronger promise is that one clear workflow carries local work through publication, tells humans and agents exactly what happened, and recovers without making them reconstruct the internals. Keep `gh` as the first-release dependency, as approved. There is no current evidence that a language rewrite or replacing all GitHub transport would improve that promise faster than the work above.

Safe preview is another useful distinction. GitHub's [`gh pr create --dry-run`](https://cli.github.com/manual/gh_pr_create) may still push Git changes. Keep ggh's own workflow previews free of mutations, prompts, and AI calls, and make clear that explicit native escapes retain the native tool's semantics. GitHub's [exit-code contract](https://cli.github.com/manual/gh_help_exit-codes) is also an existing precedent for documented machine behavior.

## The bar for a ten

The five core journeys are local repo creation, commit-to-PR, stacked work, interrupted-work recovery, and an agent handoff with verification references. Run every applicable journey manually and through structured agent commands on all three platforms. A ten requires clean installation, clear target/effects before approval, no unnecessary prompts, no unintended history changes or private uploads, accurate partial outcomes, tested recovery, and independent task-completion evidence.

Experience First shaped the priority order: complete and polish those journeys before expanding the command catalog. Prove It Works shaped the evidence standard: current source and artifact checks support local confidence; they do not close unrun platform, permission, or service checks.
