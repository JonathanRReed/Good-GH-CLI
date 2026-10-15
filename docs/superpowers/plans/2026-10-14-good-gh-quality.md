# Good GH quality implementation plan

> For agentic workers: use `superpowers:executing-plans` task by task. Keep each worker within its assigned files. Do not commit or publish.

**Goal:** Implement the approved daily workflows, agent contracts, recovery, media support, and verification requirements.

**Architecture:** Commands collect input and render domain results. A narrow publication service shares repo setup and PR creation. Existing Git and GitHub services retain transport ownership.

**Tech stack:** TypeScript, Bun, Commander, Git, and GitHub CLI.

**Spec:** [Approved design](../specs/2026-10-14-good-gh-quality-design.md).

## Global constraints

- Keep `gh` as the GitHub transport dependency.
- Support macOS, Linux, and Windows equally.
- AI generation is opt-in. Project config cannot grant user policy.
- Repo creation defaults to private, infers local context, and confirms once.
- Explicit submission controls published stack rewrites, using force-with-lease.
- Default records contain metadata. Raw content and uploads require explicit inclusion.
- No commits, pushes, PR creation, publication, spending, or production mutations during this implementation run.

## Review focus

- Queued terminal input survives prompt validation and transitions without exposing secrets.
- JSON and no-input failures report actual partial effects rather than fabricate success.
- Lost remote responses and changed branch tips do not cause duplicate resources or unsafe retries.
- A private target cannot silently use public storage.
- Windows process, filesystem, and terminal behavior require Windows evidence.

## Task 1. Prompt and output contracts

Files: `src/utils/prompts.ts`, a focused line-input module if needed, `src/services/runtime.ts`, `src/utils/output.ts`, `src/utils/ui.ts`, `src/utils/flags.ts`, `bin/ggh.ts`, and command-level tests.

- [x] Reproduce queued-answer loss and successful empty repo JSON in focused regressions.
- [x] Preserve queued lines across text prompts, cancellation, and validation.
- [x] Track JSON emission per invocation and supply structured failure and dry-run results without duplicate documents.
- [x] Add explicit JSON success output to affected commands.
- [x] Verify prompt tests, command fixtures, typecheck, and lint.

## Task 2. Routing and AI policy

Files: `src/index.ts`, `src/utils/passthrough.ts`, `src/services/config.ts`, `src/services/runtime.ts`, AI callers, routing and config tests, README, completions, and manual.

- [x] Make `ggh git`, `ggh gh`, and `ggh --` explicit escape routes. Reject implicit forwarding.
- [x] Add user-owned `ai_enabled`, with explicit `--ai` and `--no-ai` overrides.
- [x] Keep explicit messages and non-AI core workflows free of provider setup and calls.
- [x] Update behavioral tests and documentation for the intentional routing change.
- [x] Verify local workflows with providers and `gh` unavailable.

## Task 3. Publication

Files: `src/services/publication.ts`, Git and GitHub repo services, `src/commands/repo.ts`, `src/commands/pr-create.ts`, `src/commands/commit.ts`, publication fixtures, and user configuration.

- [x] Define publication snapshots, ready or needs-input plans, and operation results.
- [x] Implement root-aware name and source inference, private defaults, one confirmation, and a user-owned repo fast mode.
- [x] Share missing-remote setup across repo, PR, and commit-to-PR flows.
- [x] Validate base and head before remote mutation. Push the base before the head.
- [x] Verify conflicts, nested directories, missing bases, retries, changed tips, and no-input behavior with isolated Git and fake GitHub fixtures.

## Task 4. Records and stacks

Files: `src/services/operations.ts`, its command module, `src/services/git/stack.ts`, `src/commands/stack.ts`, and recovery tests.

- [x] Store atomic per-operation metadata outside tracked source.
- [x] Expose record inspection and explicit verification-file association.
- [x] Record stack plans, completed resources, failures, and safe resume instructions.
- [x] Restore the original branch when safe. Preserve conflict state when restoration is unsafe.
- [x] Verify parent amendments, conflict continue and abort, partial submit, lost responses, and lease rejection.

## Task 5. Attachments

Files: attachment helpers, GitHub PR and issue services, their command handlers, and media fixtures.

- [x] Add repeatable `--attach` and body-file input using supported GitHub CLI capabilities.
- [x] Validate files before writes and preserve PR URLs after partial upload failure.
- [x] Retry attachments against an existing resource rather than create duplicates.
- [x] Provide an explicit configured fallback adapter that refuses unverified private destinations.
- [x] Verify argv, input transport, dry-run, older capabilities, private targets, and partial failures without real account writes.

## Task 6. Stack status and diagnostics

Files: stack and status commands, config doctor, AI result metadata, and focused tests.

- [x] Add optional PR review and CI data to the local stack view.
- [x] Keep ordinary local reads offline and label unavailable remote data.
- [x] Report installed versions, attachment capabilities, and reliable provider usage values.
- [x] Keep unknown token counts and costs unknown.

## Task 7. Whole-product verification

Files: command contract fixtures, existing scripts and CI, README, packaging and readiness docs, completions, and manual.

- [x] Audit advertised flag contracts and exercise the covered JSON, dry-run, no-input, and confirmation paths.
- [x] Run typecheck, lint, the source suite, build, manual freshness, performance budgets, and exact-artifact regressions.
- [x] Verify installed package and local native artifact flows.
- [x] Record platform, live-account, provider, signing, and publication checks separately. Unavailable checks remain unverified.
- [x] Reconcile the approved spec with the final implementation and list any unmet requirements.

## Acceptance

Local implementation and verification are complete. See [the receipt](../../verification/2026-10-14-local-acceptance.md). Linux and Windows native execution, live service checks, and release trust remain unverified. No project commit or publication occurred.
