# Local acceptance

The October 14 implementation passed local acceptance on macOS. It remains uncommitted on `main`, based on `4b1657e3d922e4feb73a73800615a315a84e8c42`. The [receipt](2026-10-14-local-acceptance.json) binds the source digest, native binary, bundle, and npm tarball to these checks.

This receipt predates the [regression test audit](2026-10-14-test-audit.md). The audit retained 500 source tests and 71 native cases, reran them successfully, and preserved the artifact hashes below.

| Layer | Fresh result |
| --- | --- |
| Source | Typecheck, lint, and 604 tests across 50 files passed. |
| Compiled native CLI | All 72 regressions passed. GitHub was mocked; pushes used local bare Git repositories. |
| Terminal | Actual macOS PTY checks passed ESC DEL word deletion and Ctrl-C exit 130. Queued text and cleanup also have source regressions. |
| Installed npm package | Node and Bun launchers passed version, help, JSON, and two real local commits from the exact tarball. |
| Native package behavior | Checksum, startup, local commit, and installed pre-commit hook smoke passed. |
| Help and size | Generated manual is fresh. The bundle is 453,328 bytes against a 500,000-byte ceiling. |
| Runtime budgets | Startup and status passed their 2-second and 10-second budgets on the final retry. One earlier startup timed out during severe host load. These runs establish budget acceptance, not a speed comparison. |
| Installed dependencies | Git 2.54.0 and gh 2.100.0 were observed. Doctor found all six native attachment flags. It did not establish sign-in, repository permissions, or model access. |

The regressions cover confirmation and fast mode, missing-remote PR setup, base-before-head pushes, explicit branch creation, clean PR retries, force-with-lease, restack conflict continuation and abort, concurrent recovery ownership, JSON results, numeric targets, credential-safe remote parsing, nested media paths, private fallback refusal, and partial effects. Operation records retain metadata and resource references without copying PR bodies or source content.

The package check is repeatable with `scripts/smoke-package.cjs`; CI and release preparation now call it. The native regression harness also drives terminal editing and publication flows against the actual compiled executable.

## Launch gates

Linux and Windows still need native execution at this source revision. Windows private filesystem permissions need direct verification. Live GitHub publication, private attachment access, account permissions, upload recovery, and provider generation remain unverified. Signing, notarization, quarantine acceptance, and public publication are separate gates. No project commit, push, pull request, or release was created during this implementation.
