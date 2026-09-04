# Security

## Reporting a vulnerability

Report privately through [GitHub Security Advisories](https://github.com/JonathanRReed/Good-GH-CLI/security/advisories/new).
Please do not open a public issue first.

This is a personal project, not a funded one. Expect an acknowledgement within a
week and a fix or a decision within a month. There is no bounty.

## What ggh sends off your machine

This is the part worth reading before you trust it with a private repository.

`ggh` sends your **staged diff, branch diff, or pull request diff** to whichever
AI CLI you have configured, whenever you use an AI feature: commit messages, pull
request bodies, reviews, branch names, release notes, issue bodies (`issue create
--ai`), and CI triage. That CLI then sends it to its vendor. `ggh` has no server
of its own and stores nothing remotely. Before the first hosted provider runs,
`ggh` asks for explicit consent. Non-interactive use must set
`hosted_ai_consent=true` deliberately.

Before any diff leaves the process it goes through `sanitizeDiffForAI`. The same
redaction is applied to reporter notes passed via `issue create --ai -n` before
they reach the provider:

**Whole files are dropped**, never sent at all — `.env` and its variants, `*.pem`,
`*.key`, anything matching `id_rsa`, `credentials.json`, `secrets.json`/`.yaml`,
lockfiles, minified bundles, source maps, and binaries.

**Remaining hunks are redacted** for OpenAI-style keys, GitHub classic and
fine-grained tokens, xAI keys, Slack tokens, AWS access key IDs, Google API keys,
GitLab and npm tokens, JWTs, PEM private key blocks, database URLs with embedded
credentials, and quoted or bare assignments to names like `password`,
`api_key`, `access_token`, and `client_secret`.

`ggh commit` tells you how many secrets it redacted before it sends anything.

### What that does not protect you from

- **Secrets that do not look like secrets.** A high-entropy string with no
  recognisable prefix in a file that is not on the ignore list will be sent.
- **Proprietary source code.** Redaction removes credentials, not your code. If
  your employer forbids sending source to third parties, use `ggh commit -m`,
  `--no-ai`, or follow the local-only configuration and daemon checks below.
- **The vendor's retention policy.** That is between you and whichever CLI you
  signed in to.

To use the local Ollama adapter without falling back to a hosted provider:

```bash
ggh config set ai_provider ollama
ggh config set ai_fallback false
```

The local adapter refuses non-loopback HTTP endpoints and model definitions
that do not identify a local weights blob, including cloud aliases. It inspects
metadata without a repository prompt before invoking the model. This is not a
sandbox: the Ollama executable and daemon must be trusted. For no-egress use,
disable cloud features in the daemon's `~/.ollama/server.json` with
`{"disable_ollama_cloud":true}` (or start the daemon with `OLLAMA_NO_CLOUD=1`),
restart it, and verify its logs. Setting an environment variable only on an
already-running client's invocation does not reconfigure its daemon.

Repository `.ggh.json` files cannot set the provider, fallback, model, or consent
because a cloned repository is untrusted input.

## Other things worth knowing

- **Prompts use stdin or a private `0600` temporary file**, not process arguments.
  Temporary provider directories are removed after the call.
- **Secrets and long-form GitHub bodies use stdin**, not process arguments.
- **`ggh` never asks for or stores an API key.** It drives CLIs you have already
  signed in to, and reads only whether an auth file exists.
- **Coding clients run outside the repository directory.** Codex also uses
  `--ignore-user-config` and its read-only sandbox. Claude uses `--safe-mode`,
  `--tools ""`, `--disallowedTools "*"`, an empty strict MCP configuration, and
  no session persistence. Grok disables web search and subagents. These clients
  remain trusted executables, not a ggh-controlled OS sandbox; vendor behavior
  and new CLI versions need separate compatibility checks.
- **AI deny flags are checked at the shared provider boundary.** `--no-ai`,
  an explicit commit message, and dry-run cannot invoke an AI client.
- **Captured subprocess output is bounded** and piped operations have a deadline.
  Interactive Git passthrough retains native terminal behavior.
- **Cache entries are private and namespaced** by host, account, repository and
  checkout. Environment-token sessions bypass disk caching. Cache failures do
  not fall back to shared temporary-directory cleanup.
- **Trusted plugins can be bypassed** with `GGH_NO_PLUGINS=1` for recovery.
- **Destructive commands refuse to guess.** Without a terminal, `ggh` cancels and
  exits non-zero rather than auto-answering a prompt. `--yes` is the only way to
  confirm non-interactively, and `--dry-run` previews without touching anything.

## Supported versions

The latest release is supported. Given the size of the project, fixes go into the
next release rather than being backported.

The repository-grounded attack assumptions and controls live in
[`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md).
