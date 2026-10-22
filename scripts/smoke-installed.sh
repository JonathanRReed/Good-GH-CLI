#!/usr/bin/env bash
set -euo pipefail

# Re-exec without caller Git/AI/auth settings before building or using fixtures.
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(cd -- "$script_dir/.." && pwd -P)
if [[ ${1:-} != --isolated ]]; then
  exec env -i PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
    /bin/bash "$script_dir/smoke-installed.sh" --isolated
fi

for tool in bun git make zsh jq; do
  command -v "$tool" >/dev/null || { printf 'Missing smoke dependency: %s\n' "$tool" >&2; exit 1; }
done

fixture=$(mktemp -d "${TMPDIR%/}/ggh-installed.XXXXXX")
trap 'rm -rf -- "$fixture"' EXIT
fixture=$(cd -- "$fixture" && pwd -P)
export HOME="$fixture/home" USERPROFILE="$fixture/home"
export XDG_CONFIG_HOME="$fixture/xdg" GGH_CONFIG_DIR="$fixture/ggh config"
export GH_CONFIG_DIR="$fixture/gh" ZDOTDIR="$HOME"
export GGH_NO_PLUGINS=1 GGH_NO_RECORDS=1 GIT_TERMINAL_PROMPT=0
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL="$HOME/.gitconfig"
export LC_ALL=C NO_COLOR=1
prefix="$fixture/install space"
repos="$fixture/projects space"
remote="$fixture/remotes/origin.git"
seed="$fixture/seed"
mkdir -p "$HOME" "$GGH_CONFIG_DIR" "$repos" "$fixture/remotes" "$fixture/guard"

# No inherited auth or hooks, and Git can use only local file transports.
git config --global user.name 'Installed smoke'
git config --global user.email 'smoke@example.invalid'
git config --global init.defaultBranch main
git config --global commit.gpgsign false
git config --global core.hooksPath /dev/null
git config --global protocol.allow never
git config --global protocol.file.allow always
cat > "$fixture/guard/gh" <<'SH'
#!/bin/sh
printf 'Unexpected gh call\n' >> "$HOME/gh-called"
exit 97
SH
chmod +x "$fixture/guard/gh"
export PATH="$prefix/bin:$fixture/guard:$PATH"
jq -n --arg root "$repos" '{project_roots:[$root],host_worktree_dirs:{},ai_enabled:false,ai_fallback:false,hosted_ai_consent:false,first_run_completed:true}' > "$GGH_CONFIG_DIR/config.json"

make -C "$repo_root" install "PREFIX=$prefix" DESTDIR=
ggh=("$prefix/bin/ggh")
expected_version=$(bun -e 'console.log(require(process.argv[1]).version)' "$repo_root/package.json")
[[ $(command -v ggh) == "${ggh[0]}" ]]
[[ $("${ggh[@]}" --version) == "$expected_version" ]]
for file in share/man/man1/ggh.1 share/zsh/site-functions/_ggh \
  share/bash-completion/completions/ggh share/fish/vendor_completions.d/ggh.fish; do
  [[ -s "$prefix/$file" ]]
done
printf 'PASS version and installed support files\n'

git init --bare "$remote" >/dev/null
git init "$seed" >/dev/null
printf 'initial\n' > "$seed/tracked.txt"
git -C "$seed" add -- tracked.txt
git -C "$seed" commit -m initial >/dev/null
git -C "$seed" remote add origin "file://$remote"
git -C "$seed" push -u origin main >/dev/null 2>&1
git clone "file://$remote" "$repos/example" >/dev/null 2>&1
# Publication proofs need a recorded fetch, which clone does not always create.
git -C "$repos/example" fetch origin >/dev/null 2>&1
git -C "$repos/example" branch merged-candidate
git -C "$repos/example" switch -c unpublished >/dev/null 2>&1
git -C "$repos/example" commit --allow-empty -m 'local unpublished work' >/dev/null
git -C "$repos/example" switch main >/dev/null 2>&1

cd -- "$repos"
"${ggh[@]}" > "$fixture/table.stdout" 2> "$fixture/table.stderr"
[[ ! -s "$fixture/table.stdout" ]]
grep -q example "$fixture/table.stderr"
printf 'PASS bare ggh projects table\n'

"${ggh[@]}" init zsh > "$fixture/init.zsh"
zsh -f -c 'set -eu; source "$1"; g example; [[ "$PWD" == "$2" ]]' \
  smoke "$fixture/init.zsh" "$repos/example"
printf 'PASS zsh hook changes directory\n'

"${ggh[@]}" clone "file://$remote" > "$fixture/clone.stdout" 2> "$fixture/clone.stderr"
[[ -d "$repos/origin/.git" ]]
[[ $(git -C "$repos/origin" remote get-url origin) == "file://$remote" ]]
[[ $(git -C "$repos/origin" config --bool ggh.created) == true ]]
printf 'PASS clone into current directory\n'

"${ggh[@]}" projects example --agent > "$fixture/projects.json"
jq -e '.contract == "ggh.agent" and .status == "succeeded" and .result.schemaVersion == 1 and .result.project.name == "example" and (.result.project.checkouts | any(.branch == "main"))' "$fixture/projects.json" >/dev/null
printf 'PASS project agent context\n'

"${ggh[@]}" lost --agent > "$fixture/lost.json"
jq -e '.status == "succeeded" and .result.schemaVersion == 1 and (.result.items | any(.kind == "unpublished" and .branch == "unpublished" and .commits == 1))' "$fixture/lost.json" >/dev/null
printf 'PASS lost unpublished commit\n'

"${ggh[@]}" tidy --all --dry-run --agent > "$fixture/tidy.json"
jq -e '.status == "planned" and .result.status == "planned" and (.result.plan.snapshotId | length > 0) and ([.result.plan.clones[].actions[]] | length == 1 and all(.kind == "delete-local-branch" and .branch == "merged-candidate")) and (.effects.completed | length == 0)' "$fixture/tidy.json" >/dev/null
git -C "$repos/example" show-ref --verify --quiet refs/heads/merged-candidate
git -C "$repos/example" show-ref --verify --quiet refs/heads/unpublished
printf 'PASS tidy planned actions without deletion\n'

# Make sync prove a real fast-forward, rather than just accepting empty output.
printf 'remote update\n' >> "$seed/tracked.txt"
git -C "$seed" commit -am 'remote update' >/dev/null
git -C "$seed" push origin main >/dev/null 2>&1
new_head=$(git -C "$seed" rev-parse HEAD)
"${ggh[@]}" sync --all --agent > "$fixture/sync.json"
jq -e '.status == "succeeded" and .result.schemaVersion == 1 and (.result.clones | length == 2) and ([.result.clones[].checkouts[] | select(.outcome == "updated")] | length == 2)' "$fixture/sync.json" >/dev/null
for checkout in example origin; do
  [[ $(git -C "$repos/$checkout" rev-parse HEAD) == "$new_head" ]]
done
git -C "$repos/example" show-ref --verify --quiet refs/heads/unpublished
printf 'PASS sync fast-forwards both clones and preserves unpublished branch\n'

cd -- "$repos/origin"
"${ggh[@]}" status --agent > "$fixture/status.json"
jq -e --arg head "$new_head" '.status == "succeeded" and .result.branch == "main" and .result.head == $head and .result.upstream == "origin/main" and ((.result.changes // []) | length == 0)' "$fixture/status.json" >/dev/null
printf 'PASS clean status with exact HEAD\n'

"${ggh[@]}" agent skill --install claude --dry-run > "$fixture/skill.stdout" 2> "$fixture/skill.stderr"
[[ ! -e "$HOME/.claude/skills/ggh" ]]
grep -q 'SKILL.md' "$fixture/skill.stderr"
printf 'PASS skill install dry run writes no skill files\n'
[[ ! -e "$HOME/gh-called" ]]
printf 'Installed smoke: 10/10 checks passed (%s, %s/%s); no gh calls, local file remotes only.\n' \
  "$expected_version" "$(uname -s)" "$(uname -m)"
