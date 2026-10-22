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
arrays and no shell. Human output strips terminal controls from repository
and PR text; JSON retains the raw data. The npm launcher follows the same rule
on Windows.

### Credential disclosure

Use native `gh secret set NAME` for masked input or stdin. The removed ggh secret
command is no longer part of this contract. GitHub bodies use stdin to keep
their contents out of process arguments. AI prompts use owner-only temporary
files where a provider requires a file and remove them after use. Config and
cache files use owner-only permissions on POSIX systems.

On Windows, `private-storage.ts` creates protected current-user DACLs and audits
existing owned trees before content access. It rejects ordinary-account access,
foreign owners, null DACLs, reparse points, and ancestors that another ordinary
account can replace. Successful tree audits are cached only within the current
process and invalidated when directory identity changes. SYSTEM and machine
administrators remain outside this isolation guarantee. Existing unsafe storage
is refused; caching is disabled when its private storage cannot be verified.
Provider workspaces use the same private temporary root. Windows PowerShell is
required for ACL inspection. The helper receives paths through stdin.

Cancellation waits for tracked subprocess trees to terminate. Windows uses the
system `taskkill /T /F` utility, with a bounded timeout and direct-child fallback;
Unix uses process groups where available. A failing tree utility cannot prove
that a helper stopped. Hosted child/grandchild checks verify the normal cleanup
path separately from the implementation.

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

### Bulk destructive operations

`ggh tidy` treats the preview as a fixed set of actions, not permission to find
more things to delete. Each action carries canonical common-directory identity,
checkout identity when relevant, exact refs and OIDs, destination, stash state,
and a file-state fingerprint. Stable IDs and the plan digest bind approval to
that set. A stale `--approve-plan` fails before cleanup; per-path ignored-file or
unknown-provenance overrides require a new approved plan.

A PR badge cannot prove integration. Tidy requires exact-tip ancestry and remote
reachability, including detached HEADs. Publication proofs require remote refs
no older than the user-owned tidy_max_fetch_age_days setting, default 30 days.
Unknown fetch ages keep the candidate. Branch and checkout HEAD reflogs are
checked for unpublished commits, including missing checkout metadata. Each scan
reads at most 1,000 entries; a longer log keeps the candidate because older work
is unknown. Lost reports commits reachable only through those reflogs.

Tidy keeps stashes at clone scope, dirty or ignored files, nested repositories, submodules, hidden index entries, shallow or
grafted histories, locked checkouts, and uncertain state. Local ref deletion uses
an expected-old-OID update. Remote deletion requires offline evidence of own-origin
ownership, a fresh server OID check, and an expected-OID push lease to one pinned
URL. No default preview contacts GitHub or a remote. `--fetch` explicitly updates
remote-tracking refs before the preview, even with `--dry-run`. Fetches use explicit
tracking-only refspecs and an empty refmap so mirror configuration cannot prune
local branches or refs/ggh pins. SSH network operations retain agent access and
force BatchMode to prevent password or passphrase prompts. Authentication denial
is a refusal; interrupted or ambiguous network effects remain uncertain.

Host ownership grants no deletion authority. A T3, Claude, Cursor, or Codex
checkout can be clean while a thread, terminal, provider session, or queued turn
still uses it. Such checkouts are always manual candidates for the host's cleanup.
Tidy does not read host transcripts, credentials, or databases to guess activity.
Unknown provenance defaults to keep; observed host claims override any ggh label
or user override.

Git metadata pruning affects a whole clone. Tidy therefore refuses it if any
prunable entry has unsafe or unknown state, an existing path, an unavailable
volume according to the mount table, a host claim, or unpublished HEAD. It
verifies the registry and Git's prune dry-run again, preserving configured expiry with a three-month default.
This operation never recursively removes an existing checkout.

Tidy, sync, and explicit cleanup fetches share <commonDir>/ggh.lock and wait
up to 30 seconds for another ggh mutation. They cannot lock out terminals, hosts, or other Git clients. Rechecks narrow races but cannot make
filesystem deletion atomic with file creation. Remote leases and local ref
compare-and-swap protect exact tips. Worktree removal protects ignored files
unless explicitly approved.
Tidy repeats the approved file-state check immediately before invoking
git worktree remove. Git retains its own dirty and untracked-file checks, but
ignores ignored files: an ignored file created after the final probe and before
Git removes the checkout can still be deleted. The Git CLI offers no atomic
file-state check and removal, so this residual window remains.

Effects are journaled before starting, with unresolved execution marked uncertain. Ctrl-C stops the next action after recording the current outcome;
a second interrupt or process death can leave an uncertain journal for inspection.
Already completed actions are not rolled back.

`ggh lost` is read-only unless invoked with `--fetch`. Its suggested commands are argv data, not automatically
executed scripts. Local tracking refs cannot prove absence from unfetched remotes
or PRs. Dirty host work means possible abandoned work, never a claim that the
host session ended. Both commands report discovery gaps rather than interpreting
missing evidence as permission to delete.

### Tidy audit recommendations

`tidy --audit` sends only a bounded metadata projection of the original safe plan.
The 32 KB prompt includes instructions, quoted clone and branch names, short OIDs,
fixed proof summaries, fetch age, creator, and commit subjects/dates when available.
It excludes file contents, diffs, environment values, transcripts, full paths,
and remote URLs. Recognized secrets and URLs in metadata text are removed.
Names and subjects remain untrusted, even after redaction. The prompt tells the
model to treat all JSON strings as data. Subjects never establish deletion proof.

Strict JSON schema validation runs before recommendation IDs are considered.
Invented IDs and IDs outside the sent safe subset are rejected. A `keep` verdict
wins over any duplicate `prune`; missing or unsent IDs become `keep-unaudited`.
Only explicit prune recommendations retain original actions. Output cannot add
an action, alter its destination or proof, or authorize unsafe candidates.
Reasons are redacted and quoted for display. Invalid output blocks cleanup,
including with `--yes`, unless the user explicitly chooses
`--proceed-without-audit` and approves the original plan.

AI enablement, hosted consent, redaction and timeouts still apply. Interactive
runs disclose the actual provider/model and exact metadata counts before sending,
even with `--quiet`. Non-interactive hosted audits need prior user consent.
An explicit provider stays within its own model chain. A local Ollama failure
never contacts a hosted provider. Audited dry runs explicitly permit metadata
inference and private approval-record writes, but perform no cleanup.

The audit has no access to ggh's executor. Claude disables tools and MCP; Grok
allows no built-in tools and denies tool execution for audits. Codex audits disable
shell, image-reading, subagent and web tools, retain the read-only sandbox, and
run in an empty private workspace with user config ignored. Ollama uses the
existing verified loopback/local-weights adapter. Provider CLIs and their
configured models remain trusted dependencies.

Audited snapshots bind the original plan, narrowed actions, provider/model,
input hash and normalized result hash. Private, atomic approval records store
IDs, counts, hashes and recommendations, excluding prompts and subjects. Applying
`--approve-plan` restores that result instead of rerunning a nondeterministic
model. Changes to the original plan or stored result invalidate approval. All
retained actions still pass the existing per-action checks and leases. An external
agent uses the same CLI approval paths, without agent orchestration in ggh.

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
