# Good GH (`ggh`)

I hated the GitHub CLI. This makes it bearable.

`ggh` is a full replacement for `gh` and a nicer front end for `git`: pull requests, issues,
CI runs, releases, repositories, **stacked branches**, and zero-key AI throughout, using the
CLI you are already signed in to (Codex, Grok, Claude Code, or a local model via Ollama).

Anything `ggh` does not recognise is forwarded to `git`, so `ggh add .`, `ggh push`, and
`ggh rebase -i` behave exactly as `git` does.

## Install

Ensure you have [Bun](https://bun.sh) installed.

```bash
# Clone & link locally:
git clone https://github.com/JonathanRReed/Good-GH-CLI.git
cd Good-GH-CLI
bun install
bun link
```

Now `ggh` and `good-gh` are available globally.

## How It Works

### Daily Flow

```bash
# 1. Check repo status, remote sync, and active PRs
ggh status

# 2. Stage changes & commit (with interactive stacked actions)
ggh commit            # or: ggh c
ggh c -a              # stage all and commit
ggh c --push          # commit and push
ggh c --pr            # commit, push, and open PR (or update active PR)
ggh c --amend         # amend last commit
ggh c --review        # check for console.log / debugger / localhost before committing
ggh c -m "fix: x" -y  # fully non-interactive: message given, confirmations pre-answered

# 3. Undo a mistake
ggh undo              # soft-resets HEAD~1, keeps all files staged
ggh discard           # interactively revert files (Lazygit-style)
ggh stash             # interactive stash list, push, pop, and drop
ggh resolve           # resolve merge conflicts interactively (ours/theirs/mark)

# 4. View recent commit graph
ggh log               # or: ggh graph
ggh log -n 50         # control how many commits to show

# 5. Check the installed version
ggh --version
```

### Branches & Worktrees

```bash
# Switch branches or active worktrees interactively
ggh switch            # or: ggh sw
ggh sw -c feat/login  # create and switch to new branch
ggh checkout main     # checkout works too

# Rename current branch (updates local + remote)
ggh rename feat/new-name

# Squash last N commits into one with AI summary
ggh squash 3

# Isolated parallel worktrees (T3 Code style)
ggh wt add "feature description"
ggh wt list
ggh wt remove
```

### Pull Requests

```bash
ggh pr                      # browse open PRs
ggh pr create               # open a PR with an AI-written title and body
ggh pr create --draft       # ...as a draft
ggh pr view 42              # state, review decision, size, body
ggh pr review 42            # AI review that posts real line-anchored comments
ggh pr review --local       # ...printed locally, nothing posted
ggh pr merge 42 --squash    # merge and delete the branch
ggh pr ready | close | reopen
ggh pr comment 42 -b "lgtm"
ggh pr edit 42 --base main
ggh pr 42 --checkout        # check out locally
ggh pr 42 --worktree        # check out into .worktrees/pr-42
```

`ggh pr review` asks the model for findings anchored to specific files and lines,
drops anything that does not land on a line the diff actually adds, lets you pick
which survive, and submits them as a genuine GitHub review — not terminal output
that nobody else sees.

### Issues

```bash
ggh issue                   # browse and read
ggh issue 42                # view one
ggh issue create
ggh issue develop 42        # branch named from the issue, then start work
ggh issue close 42 | reopen 42 | comment 42
```

### CI and GitHub Actions

```bash
ggh checks                  # CI status for the current branch's PR
ggh checks --watch          # backs off 5s → 30s, stops at --timeout
ggh run                     # browse workflow runs
ggh run 12345               # jobs, failing steps, and an AI explanation of why
ggh run rerun 12345 --failed
ggh run cancel 12345
```

`ggh run` pulls the failing job's log and has the model name the failing step, quote
the real error, and propose a fix — so a red build does not send you to the browser.

### Stacked branches

```bash
ggh stack next feat/api     # branch stacked on the current one
ggh stack list              # the tree, with drift marked
ggh stack restack           # replay the stack after amending a parent
ggh stack submit            # push the chain, one PR per branch against its real parent
ggh stack on main           # adopt an existing branch into a stack
ggh stack checkout          # jump around the stack
```

Every branch `ggh` creates already records its parent in git config. `ggh stack` reads
those pointers as a tree, so stacking needs no extra state and no service.

### Repositories and releases

```bash
ggh repo                    # view the current repository
ggh repo octocat/hello --readme
ggh repo fork octocat/hello
ggh repo create my-app --private --source . --push
ggh repo set-default owner/name

ggh release                 # browse releases
ggh release create v1.0.0   # publish with an AI changelog
ggh changelog v1.0.0        # write that changelog into CHANGELOG.md instead

ggh sync                    # fetch, prune, and delete stale branches
ggh api repos/{owner}/{repo}/topics   # escape hatch for anything unwrapped
```

### Fast Clone & Discovery

```bash
ggh clone              # search your repos or all of GitHub
ggh clone owner/repo --fast   # blobless clone (much faster for large repos)
```

### Scripts, CI, and non-interactive use

Every command follows the same conventions:

| Flag | Effect |
| --- | --- |
| `--json` | Machine-readable output on stdout, nothing else |
| `--dry-run` | Describe what would happen; change nothing |
| `-y, --yes` | Answer every confirmation with yes |
| `-q, --quiet` | Suppress progress; errors still print |
| `--no-input` | Never prompt; fail with instructions |
| `-R, --repo owner/name` | Act on another repository from anywhere |

**stdout is data, stderr is everything else.** `ggh log | grep fix` matches commits,
not banners; `ggh pr --json | jq '.[].number'` gets pure JSON; and `ggh x > /dev/null`
never hides an error.

```bash
ggh status --json | jq '.ai.chain'
ggh pr --json | jq -r '.[] | "\(.number) \(.title)"'
ggh discard --all --dry-run
ggh sync --dry-run
```

When `ggh` needs an answer and stdin is not a terminal, it **cancels and exits
non-zero** rather than guessing. It will never pick the first menu item for you —
the first option can be destructive (`ggh resolve` offers "accept ours") and a
default-yes confirmation can publish a release or open a Pull Request.

To run non-interactively, be explicit:

```bash
ggh commit -m "fix: broken parser" --push   # no prompts needed at all
ggh commit -a -y --pr                       # AI message, every confirmation answered yes
ggh discard --all --yes
ggh sync -y
ggh release create v1.2.0 --yes
```

`-y, --yes` answers every confirmation for that command. Without it, a
non-interactive run leaves your repository untouched.

### Configuration & AI

Zero API keys needed. It hooks directly into your authenticated local CLI session (`codex` or `grok`).

```bash
ggh config                              # interactive
ggh config list                         # every value, and which layer set it
ggh config set ai_provider codex        # codex | grok | claude | ollama
ggh config set codex_model gpt-5.6-luna # gpt-5.6-sol | gpt-5.6-terra | gpt-5.6-luna
ggh config set ai_timeout_ms 120000     # per-attempt limit
ggh config cache-clear                  # drop cached GitHub responses
```

Configuration resolves in the order every CLI is expected to honour:

**flags > environment > project `.ggh.json` > user file > defaults**

So a work repository can pin a provider without touching your global setup:

```jsonc
// .ggh.json, committed at the repo root
{ "ai_provider": "ollama", "commit_style": "conventional" }
```

Environment variables are named after the keys: `GGH_AI_PROVIDER`, `GGH_CODEX_MODEL`,
`GGH_GROK_MODEL`, `GGH_AI_TIMEOUT_MS`, `GGH_COMMIT_STYLE`, `GGH_DEFAULT_CLONE_DIR`,
`GGH_DEFAULT_CLONE_MODE`.

#### How the fallback works

Every AI feature (commit messages, PR titles and bodies, PR reviews, branch names,
release notes) runs through the same chain and takes the first result it gets:

1. Your preferred provider's configured model — by default Codex on `gpt-5.6-luna`.
2. The remaining Codex tiers (`gpt-5.6-terra`, `gpt-5.6-luna`), so a single model
   being unavailable never costs you the whole provider.
3. Grok, then Claude Code, then **Ollama running locally** — which needs no account
   and no credits, so the chain has a floor it cannot fall through.

If a provider reports that your account is out of credits or rate limited, its
remaining tiers are skipped — the quota is account-wide, so retrying them only
wastes time — and the chain moves straight to the next provider. Codex runs with
`--ignore-user-config` so your `~/.codex/config.toml` (MCP servers, hooks, skills,
custom instructions) does not slow down or steer commit-message generation.

When everything fails, `ggh` prints the exact provider, model, and reason for each
attempt rather than a generic "AI unavailable", and falls back to the Conventional
Commit wizard. `ggh commit -m "..."` and `ggh commit --no-ai` never touch AI at all.

```
✖ Codex (ChatGPT) [gpt-5.6-luna] — usage limit or credits exhausted
✖ xAI Grok [grok-4.5] — not signed in
→ Wait for your quota to reset, buy more credits, or switch providers with `ggh config set ai_provider grok`.
→ Sign in with `codex login` or `grok login`.
```

`ggh status` shows which providers are detected, and prints the exact chain that will be tried.

### Shell Autocompletion

```bash
eval "$(ggh completion zsh)"   # add to ~/.zshrc
eval "$(ggh completion bash)"  # add to ~/.bashrc
```

## License

MIT
