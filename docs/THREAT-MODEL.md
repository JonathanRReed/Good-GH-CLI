# Threat model

This model covers `ggh` running as a user's normal account on macOS, Linux, or
Windows. It focuses on cloned repositories, subprocesses, credentials, and
remote mutations. Revisit it when a new command gains network, filesystem, or
code execution privileges.

## Assets

- Source code and uncommitted work
- Git and GitHub credentials held by `git`, `gh`, and AI CLIs
- Repository secrets and variables
- Git history, branches, issues, pull requests, releases, and workflows
- User config, aliases, cache entries, hooks, and plugins

## Trust boundaries

| Boundary | Rule |
| --- | --- |
| Command line to subprocess | Pass arguments as arrays. Do not use a shell. Send secrets and long-form bodies through stdin. |
| Repository to user config | Treat `.ggh.json` as untrusted. It may set only `commit_style`. |
| Repository content to hosted AI | Sanitize content and require user-owned consent before the first hosted call. Redaction is not a confidentiality guarantee. |
| Local plugin to `ggh` | Plugins are trusted code with full user privileges. Installation requires an explicit confirmation. |
| `ggh` to GitHub | Use the signed-in `gh` CLI. Confirm destructive or publishing actions and support `--dry-run`. |
| Interactive CLI to automation | Keep data on stdout, diagnostics on stderr, and fail instead of guessing when input is unavailable. |

## Main threats and controls

### Command injection

Repository names, branches, paths, issue text, and model output can contain
hostile shell characters. The shared runner starts programs with argument
arrays and no shell. The npm launcher follows the same rule on Windows.

### Credential disclosure

Secret prompts hide typed input. Secret values and GitHub bodies use stdin, so
they do not appear in process arguments. AI prompts use owner-only temporary
files where a provider requires a file and remove them after use. Config and
cache files use owner-only permissions on POSIX systems.

### Untrusted repository policy

A cloned repository must not choose a hosted provider, enable fallback, select
a model, record consent, or redirect user paths. The project config allowlist
contains only commit style.

### Destructive local changes

Discarding untracked files requires `--include-untracked` and confirmation.
Worktree creation refuses to replace an existing directory. Git operations pass
`--` before user-controlled paths where the command supports it.

### Remote mutation

Commands that create, delete, merge, publish, rerun, or transfer data support a
preview or explicit confirmation. Non-interactive runs must provide the matching
flag. JSON mode does not auto-confirm.

### Hosted AI disclosure

Sanitization drops known sensitive files and redacts recognizable credentials.
It can miss proprietary code and unknown secret formats. Users who need a hard
no-egress rule must use the local-only configuration and trusted-daemon checks
in SECURITY.md, or avoid AI with
manual flags such as `-m` and `--no-ai`.

### Plugin execution

Plugins are not sandboxed. A plugin can read files, use credentials, spawn
processes, and make network requests. `ggh` installs only local plugin files,
warns before installation, and documents the privilege boundary in help output.

## Deliberate non-goals

- Protecting a user from a malicious `git`, `gh`, AI CLI, or plugin they chose
  to install
- Defending against malicious processes already running as the same user, or
  privileged processes that can modify that user's files. Cache ownership and
  symlink checks prevent accidental redirection; they are not a filesystem
  sandbox against adversarial directory replacement between system calls.
- Guaranteeing that pattern-based AI redaction catches every secret
- Replacing GitHub permissions, branch protection, or organization policy
- Collecting telemetry or checking for updates automatically

## Verification

CI runs type checking, lint, source regressions, generated man-page freshness,
bundle/startup budgets and installation of the packed npm artifact. The release
pipeline also runs on PRs without publishing: each native artifact is verified
on its target OS/architecture, and POSIX binaries run the black-box regression
suite. CodeQL runs separately. The macOS DMG packager checks Developer ID
signatures, both architectures, mounting and isolated installation when invoked
with the maintainer's credentials; a successful source CI run does not attest
to notarization or live provider behavior. See RELEASE-READINESS.md.
