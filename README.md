# Good GH (`ggh`)

I hated the GitHub CLI. This makes it bearable.

`ggh` combines Git and GitHub into a single CLI with stacked actions, fast cloning, worktree management, and zero-key AI commit/PR generation using your existing local Codex (ChatGPT) or Grok login.

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

### Pull Requests & GitHub

```bash
# Browse open PRs, checkout locally, or view in browser
ggh pr
ggh pr 42 --checkout
ggh pr 42 --worktree   # checkout PR into isolated .worktrees/pr-42 without touching current branch

# Check GitHub Actions CI status for current branch/PR
ggh checks
ggh checks --watch     # live watch until CI completes

# Sync remote refs and prune deleted branches
ggh sync
ggh sync -y            # delete stale branches without prompting

# Draft and publish releases with AI changelog
ggh release
ggh release create v1.0.0
```

### Fast Clone & Discovery

```bash
ggh clone              # search your repos or all of GitHub
ggh clone owner/repo --fast   # blobless clone (much faster for large repos)
```

### Configuration & AI

Zero API keys needed. It hooks directly into your authenticated local CLI session (`codex` or `grok`).

```bash
ggh config
ggh config set ai_provider codex   # or grok
ggh config set commit_style conventional
```

### Shell Autocompletion

```bash
eval "$(ggh completion zsh)"   # add to ~/.zshrc
eval "$(ggh completion bash)"  # add to ~/.bashrc
```

## License

MIT
