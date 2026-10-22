# Exact-scope fixtures

Run `bun test tests/exact-scope.test.ts --timeout 30000`.

The suite generates 20 repositories under the system temporary directory. Git
runs locally. Pushes use bare local remotes. Split uses a fake provider process
boundary with explicit AI consent in the fixture config. No GitHub or provider
process runs. The fixtures are `tests/exact-scope.test.ts` and
`tests/fixtures/exact-scope.ts`.

The same fixture source was run against detached baseline `4fa80f3` and the
Phase 3B code. Baseline: 16 passed, 4 failed, with 4 unintended-scope incidents.
After: 20 passed, 0 failed, with 0 incidents. These counts apply to this synthetic
set. They do not estimate real-world incident rates.

1. Staged hunks with unstaged hunks in the same file. The committed tree equals
   the index tree and worktree bytes remain unchanged.
2. Untracked files stay out of staged-only commits.
3. Explicit `--all` includes selected new files and excludes ignored `.env`.
4. A staged rename preserves a recreated untracked source file.
5. A staged deletion preserves a recreated worktree file.
6. Binary staged blobs stay exact while worktree bytes differ.
7. Spaces in paths remain literal.
8. Newlines in paths remain literal.
9. Leading dashes in paths remain literal.
10. An index change during preflight must refuse. Baseline committed the newly
    staged unrelated file. Fixed by comparing the captured index under an
    exclusive lock before executing with a private index.
11. A HEAD change during preflight must refuse. Baseline created another commit
    on the concurrent tip. Fixed by rechecking captured HEAD and branch before
    execution. The concurrent commit remains intact.
12. Squash with staged, unstaged and untracked changes must refuse. Original
    HEAD, index tree and working files remain intact.
13. CLI split commits exact staged partitions and preserves unstaged and
    untracked work. The real index bytes remain intact.
14. Amend uses the staged tree and keeps unrelated worktree edits. Like native
    `git commit --amend`, explicitly staged changes are part of its scope.
15. Commit and push use the configured publish remote and the branch's own
    name, even when its comparison upstream names another branch.
16. Detached HEAD can commit locally. A later commit-and-push attempt preserves
    the local commit and refuses publication; named branches remain unchanged.
17. A submodule pointer keeps its 160000 mode and exact staged object ID.
18. A hook that stages unrelated paths must stop publication. Baseline committed
    and pushed those paths. Fixed by executing against a private index, checking
    the resulting tree, retaining a rejected-commit recovery ref and restoring
    the expected tip with a compare-and-swap.
19. SIGKILL before the second split group retains the first commit,
    original index bytes, remaining staged content and a recovery checkpoint.
    Retrying the remaining group completes the tree without duplicate commits.
20. An unqualified push with `push.default=matching` must publish only the chosen
    branch. Baseline also pushed another branch. Fixed by explicit source OID
    and destination refspecs, with mirror and follow-tags expansion disabled.

Additional tests cover hook-added paths in split and squash, clean message-only
amend, foreign index locks, full-history squash, stale squash previews, branch
switches and malformed split partitions. The full suite also exposed a stack-lock
initialization race: a concurrent reader could see an empty owner record. Lock
metadata now uses exclusive atomic publication, covered by the existing
concurrent-lock regression. This safe refusal was not one of the four scope
incidents.

## Execution and recovery contract

Commit captures the index before checks, prompts or generation. It never resets
partial staging. The only all-files staging path remains explicit `--all` or an
interactive selection. Ignored files stay excluded by Git's normal add rules.
There is no implicit `git add -A`.

Commit and split hold the real index lock while Git commits through a private
index. Ordinary failures retain a checkpoint under the checkout's Git directory.
Hook worktree edits remain visible. If a hook changes the commit tree, execution
stops before push or later split groups. The rejected commit stays reachable at
`refs/ggh/rejected/<OID>`; an expected-OID ref update restores the prior tip.

Squash requires a clean checkout, retains original history at
`refs/ggh/squash/<original-head>`, and checks the original index before moving the
expected tip. A final-commit failure leaves the squashed content staged on the
base and reports recovery refs. No worktree reset or automatic stash occurs.

Push resolves one branch and remote, pins the source OID, rejects multiple push
URLs and rechecks the destination URL before execution. Forced updates use an
explicit destination OID lease from the last observed remote-tracking ref. An
unobserved destination is expected to be absent. Git still runs user-installed hooks. These checks
do not serialize arbitrary external Git or make hooks a sandbox.

A split interrupted after one commit keeps the original index, so Git naturally
shows only the uncommitted remainder staged against the new HEAD. Read the
checkpoint's `state.json` and `original-index`, inspect `git status` and `git log`,
then retry only the remaining staged groups. Never blindly reset or replay the
full original plan. Process death can leave Git lock files; inspect their owner
before removing a stale lock. The fixture sends SIGKILL to its own CLI process, awaits its exit, verifies the
stale index lock and checkpoint, then removes that known fixture-owned lock
before retrying. Power-loss durability is not tested.

## Verification

- `bun run typecheck`: passed.
- `bun run lint`: passed.
- `bun test --timeout 30000`: 674 passed, 1 skipped, 0 failed across 69 files.
  The skipped test needs `pwsh`. The suite includes 29 new regression tests.
- `bun run bench:agent`: passed all six replay cases with 100% declared evidence
  recall. Both clean-status outputs are 181 bytes against 121-byte porcelain.

Checks ran locally with Bun 1.4.4-canary.1 and Git 2.54.0 on macOS. No GitHub
writes, provider calls or remote publication occurred. Bare test remotes were
local directories. Packaged binaries and other operating systems were not tested.
