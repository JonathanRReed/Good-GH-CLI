import { Command } from "commander";
import { header, p } from "../utils/ui.ts";

const ZSH_COMPLETION = `#compdef ggh good-gh

_ggh() {
  local -a commands
  commands=(
    'clone:Search, add, or clone repositories'
    'commit:Interactive commit with AI and stacked actions'
    'c:Alias for commit'
    'undo:Soft-reset the last commit while keeping changes'
    'resolve:Interactively resolve merge conflicts'
    'stash:Git stash assistant (push, pop, browse, drop)'
    'st:Alias for stash'
    'switch:Switch branches or worktrees'
    'sw:Alias for switch'
    'worktree:Manage isolated git worktrees'
    'wt:Alias for worktree'
    'pr:Browse, checkout, and AI-review GitHub Pull Requests'
    'prs:Alias for pr'
    'sync:Fetch, prune remote refs, and delete stale merged branches'
    'prune:Alias for sync'
    'squash:Interactive commit squash assistant'
    'release:Browse GitHub releases or create new release with AI changelog'
    'rel:Alias for release'
    'checks:View GitHub Actions CI status checks'
    'discard:Discard changes to working tree files'
    'restore:Alias for discard'
    'rename:Rename current branch locally and update remote tracking'
    'log:Display colorized Git commit DAG graph'
    'graph:Alias for log'
    'config:Configure good-gh settings and AI provider'
    'status:Check repo, worktree, and AI model health'
    'completion:Generate shell autocompletion script'
  )

  if (( CURRENT == 2 )); then
    _describe -t commands 'ggh command' commands
  else
    case $words[2] in
      commit|c)
        _arguments \
          '(-a --all)'{-a,--all}'[Stage all modified and untracked files]' \
          '--amend[Amend previous commit]' \
          '(-m --message)'{-m,--message}'[Commit message]:message:' \
          '--push[Commit and push to remote]' \
          '--pr[Commit, push, and create GitHub PR]' \
          '(-n --no-verify)'{-n,--no-verify}'[Bypass pre-commit hooks]' \
          '(-i --issue)'{-i,--issue}'[Link GitHub issue number]:issue:' \
          '--review[Run pre-commit hygiene scan]' \
          '--no-ai[Disable AI commit generation]'
        ;;
      switch|sw)
        local -a branches
        branches=($(git branch --format='%(refname:short)' 2>/dev/null))
        _describe -t branches 'branches' branches
        ;;
      worktree|wt)
        _arguments \
          '1:action:(add list remove)'
        ;;
      stash|st)
        _arguments \
          '1:action:(push pop list drop)'
        ;;
      pr|prs)
        _arguments \
          '--checkout[Directly checkout specified PR]' \
          '(-w --worktree)'{-w,--worktree}'[Checkout PR into an isolated worktree]' \
          '--web[Open PR in browser]'
        ;;
      checks)
        _arguments \
          '(-w --watch)'{-w,--watch}'[Continuously watch checks until completion]'
        ;;
      discard|restore)
        _arguments \
          '(-a --all)'{-a,--all}'[Discard all changes in repository]'
        ;;
      release|rel)
        _arguments \
          '1:action:(create)' \
          '(-t --title)'{-t,--title}'[Release title]:title:' \
          '(-n --notes)'{-n,--notes}'[Release notes]:notes:' \
          '--draft[Create as draft]' \
          '--prerelease[Create as prerelease]'
        ;;
    esac
  fi
}

_ggh
`;

const BASH_COMPLETION = `_ggh_completions() {
  local cur prev commands
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  commands="clone commit c undo resolve stash st switch sw worktree wt pr prs sync prune squash release rel checks discard restore rename log graph config status completion"

  if [ $COMP_CWORD -eq 1 ]; then
    COMPREPLY=( $(compgen -W "\${commands}" -- \${cur}) )
    return 0
  fi

  case "\${prev}" in
    switch|sw)
      local branches
      branches=$(git branch --format='%(refname:short)' 2>/dev/null)
      COMPREPLY=( $(compgen -W "\${branches}" -- \${cur}) )
      return 0
      ;;
    worktree|wt)
      COMPREPLY=( $(compgen -W "add list remove" -- \${cur}) )
      return 0
      ;;
    stash|st)
      COMPREPLY=( $(compgen -W "push pop list drop" -- \${cur}) )
      return 0
      ;;
    release|rel)
      COMPREPLY=( $(compgen -W "create" -- \${cur}) )
      return 0
      ;;
  esac
}

complete -F _ggh_completions ggh
complete -F _ggh_completions good-gh
`;

const FISH_COMPLETION = `function __fish_ggh_branches
  git branch --format='%(refname:short)' 2>/dev/null
end

complete -c ggh -f -n '__fish_use_subcommand' -a 'clone' -d 'Search, add, or clone repositories'
complete -c ggh -f -n '__fish_use_subcommand' -a 'commit' -d 'Interactive commit with AI and stacked actions'
complete -c ggh -f -n '__fish_use_subcommand' -a 'c' -d 'Alias for commit'
complete -c ggh -f -n '__fish_use_subcommand' -a 'undo' -d 'Soft-reset last commit'
complete -c ggh -f -n '__fish_use_subcommand' -a 'resolve' -d 'Interactively resolve merge conflicts'
complete -c ggh -f -n '__fish_use_subcommand' -a 'stash' -d 'Git stash assistant'
complete -c ggh -f -n '__fish_use_subcommand' -a 'st' -d 'Alias for stash'
complete -c ggh -f -n '__fish_use_subcommand' -a 'switch' -d 'Switch branches or worktrees'
complete -c ggh -f -n '__fish_use_subcommand' -a 'sw' -d 'Alias for switch'
complete -c ggh -f -n '__fish_use_subcommand' -a 'worktree' -d 'Manage git worktrees'
complete -c ggh -f -n '__fish_use_subcommand' -a 'wt' -d 'Alias for worktree'
complete -c ggh -f -n '__fish_use_subcommand' -a 'pr' -d 'Browse, checkout, and AI-review Pull Requests'
complete -c ggh -f -n '__fish_use_subcommand' -a 'prs' -d 'Alias for pr'
complete -c ggh -f -n '__fish_use_subcommand' -a 'sync' -d 'Fetch, prune, and delete stale branches'
complete -c ggh -f -n '__fish_use_subcommand' -a 'prune' -d 'Alias for sync'
complete -c ggh -f -n '__fish_use_subcommand' -a 'squash' -d 'Interactive commit squash assistant'
complete -c ggh -f -n '__fish_use_subcommand' -a 'release' -d 'Browse or create GitHub releases'
complete -c ggh -f -n '__fish_use_subcommand' -a 'rel' -d 'Alias for release'
complete -c ggh -f -n '__fish_use_subcommand' -a 'checks' -d 'View CI status checks'
complete -c ggh -f -n '__fish_use_subcommand' -a 'discard' -d 'Discard file changes'
complete -c ggh -f -n '__fish_use_subcommand' -a 'restore' -d 'Alias for discard'
complete -c ggh -f -n '__fish_use_subcommand' -a 'rename' -d 'Rename current branch'
complete -c ggh -f -n '__fish_use_subcommand' -a 'log' -d 'Display Git DAG graph'
complete -c ggh -f -n '__fish_use_subcommand' -a 'graph' -d 'Alias for log'
complete -c ggh -f -n '__fish_use_subcommand' -a 'config' -d 'Configure good-gh'
complete -c ggh -f -n '__fish_use_subcommand' -a 'status' -d 'Check repo and AI health'
complete -c ggh -f -n '__fish_use_subcommand' -a 'completion' -d 'Generate shell completions'

complete -c ggh -n '__fish_seen_subcommand_from switch sw' -a '(__fish_ggh_branches)'
`;

export function registerCompletionCommand(program: Command): void {
  program
    .command("completion [shell]")
    .description("Generate shell tab-completion script for zsh, bash, or fish")
    .action((shell?: string) => {
      const userShell = shell || process.env.SHELL?.split("/").pop() || "zsh";

      if (userShell.includes("zsh")) {
        console.log(ZSH_COMPLETION);
      } else if (userShell.includes("bash")) {
        console.log(BASH_COMPLETION);
      } else if (userShell.includes("fish")) {
        console.log(FISH_COMPLETION);
      } else {
        header("Shell Completion");
        p.log.warn(`Unsupported shell: ${userShell}. Supported shells: zsh, bash, fish.`);
        p.log.message("\nExample usage:\n  eval \"$(ggh completion zsh)\"\n");
      }
    });
}
