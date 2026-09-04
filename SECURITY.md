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
  `--no-ai`, or set `ai_provider` to `ollama` so nothing leaves the machine.
- **The vendor's retention policy.** That is between you and whichever CLI you
  signed in to.

If you want the AI features with none of the network exposure, run a local model:

```bash
ggh config set ai_provider ollama
ggh config set ai_fallback false
```

Repository `.ggh.json` files cannot set the provider, fallback, model, or consent
because a cloned repository is untrusted input.

## Other things worth knowing

- **Prompts are written to a `0600` temp file**, not passed as an argument, so a
  diff never appears in `ps` output. The file is removed after the call.
- **Secrets and long-form GitHub bodies use stdin**, not process arguments.
- **`ggh` never asks for or stores an API key.** It drives CLIs you have already
  signed in to, and reads only whether an auth file exists.
- **Codex runs with `--ignore-user-config`**, so your MCP servers, hooks, and
  custom instructions are not loaded into commit-message generation.
- **Destructive commands refuse to guess.** Without a terminal, `ggh` cancels and
  exits non-zero rather than auto-answering a prompt. `--yes` is the only way to
  confirm non-interactively, and `--dry-run` previews without touching anything.

## Supported versions

The latest release is supported. Given the size of the project, fixes go into the
next release rather than being backported.

The repository-grounded attack assumptions and controls live in
[`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md).
