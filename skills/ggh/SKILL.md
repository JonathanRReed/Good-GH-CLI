---
name: ggh
description: Use ggh for structured Git/GitHub state, CI failure evidence, PR threads, staged commits, publication plans, project inventory, and review in coding agents.
---

# ggh for coding agents

Use this in Claude Code, Codex, T3 Code, and Cursor when calling ggh.

## Choose the tool

- Use `ggh status --agent` for checkout identity, HEAD, staging, conflicts, base and push targets.
- Use `ggh ci why`, `ggh pr threads`, and `ggh review` for structured evidence.
- Use ggh for exact staged-snapshot commits and snapshot-approved publication.
- Use `ggh projects` and `ggh lost` to inspect local projects and unpublished work. Projects may refresh local index/cache files; lost is read-only. Do not run configuration subcommands unless requested.
- Use `ggh issue <number> --agent` to read an issue with its attached plans and other artifacts. Read and save the issue's plan with `ggh issue plan`.
- Use native `git --no-pager log`, `diff`, and `blame` for plain history and patches.
  For a quick dirty check, `git status --porcelain=v1 -b` is smaller than ggh.
- Native `gh` field projections and tuned CI filters can be smaller too. The benchmark's Zod CI and run-detail cases favor native output; its VS Code CI case favors ggh. These are output-byte measurements, not proof of faster repairs or universal token savings.

## Read the contract before acting

Always pass `--agent` to managed ggh commands. It prevents prompts and pagers.
Raw `git`/`gh` escapes retain native behavior; disable their pagers and prompts separately.

Read `status`, `error.code`, `error.retryability`, `requiredInputs`, and `effects` before continuing.
`needs_input` requires the named input, not a retry loop. Inspect `partially_completed` and
`effects.completed`, `pending`, and `uncertain` before retrying a mutation.
Read-only status may omit empty effects. Omitted counts mean zero, `root` means cwd,
`push` means upstream, and `fetchedAt` is local fetch metadata, not remote freshness.

Read [reference.md](reference.md) for per-command result fields, defaults and input flags.
Use `ggh agent schema --agent` to check the installed version's contract.

## Mutation rules

1. Check cwd, branch, full HEAD, staged paths, conflicts, base and destination.
2. Inspect the staged patch with `git --no-pager diff --cached`. Never infer scope from a clean-looking summary. Never use `git add -A` or `ggh commit --all` to sweep up untracked work.
3. For commands supporting `--approve-plan`, run identical inputs with `--dry-run --agent`, inspect the plan and its `snapshotId`, then apply with `--approve-plan` and that ID. Changed inputs or state require a fresh plan.
4. This version's `commit` has no `--approve-plan`. Commit only the reviewed index with an explicit message. It preserves unstaged hunks. For an approved push and PR, use `pr create` after committing; do not invent a standalone managed `ggh push` approval flow.
5. Merging a PR in a GitHub stack also merges every unmerged PR below it. Run `ggh pr merge <n> --dry-run --agent` first and report `result.stack.pullRequests` to the user before merging.
6. Never pass `--yes` for destructive actions without explicit user approval. An error requesting `--yes` does not grant approval. Never execute `tidy` without a human-approved snapshot, even with `--yes`.
7. After creating each PR, call the host's PR registration tool with the returned URL and head SHA where accepted. In T3 Code, call `link_pull_request` with the full URL for every layer. ggh does not register PRs. If the result lacks the SHA, read it with `gh pr view --json url,headRefOid` before reporting identity.
8. When asked to monitor in T3, call `watch_pull_request` after registration. Use its events instead of tight CI polling. Do not claim registration or monitoring without a host receipt.

## Recipes

Replace the sample PR, repository, message and base with the inspected target.
All managed responses have `contract: "ggh.agent"`, `version: 1`, and `status`.

### 1. Inspect checkout state

```sh
ggh status --agent
```

Expect `result.branch`, `result.head`; optional `changes` contains `[xy, path, origPath?]` tuples. Conflicts must be resolved before committing.

### 2. Fetch bounded CI evidence

```sh
ggh ci why 42 -R owner/repo --max-bytes 6144 --context 2 --agent
```

Expect `result.headSha`, `runs[].stale`, `failures[].evidence`, `failures[].truncated`, and `unavailable`. Check revision and truncation before diagnosing; missing logs do not mean passing CI.

### 3. Read unresolved threads

```sh
ggh pr threads 42 -R owner/repo --agent
```

Expect `result.headSha`, `threads[].id`, `isResolved`, `isOutdated`, `comments[].body`, `cursor`, and `pagination.complete`. Advance `--since` only after complete pagination. Fixing code does not authorize resolving discussions.

### 4. Inspect projects

```sh
ggh projects --agent
```

Expect `result.schemaVersion`, `clones`, `coverage`, and `effects`. Inspect coverage gaps and each checkout's state before selecting a path.

### 5. Find unpublished work

```sh
ggh lost --all --agent
```

Expect `result.schemaVersion`, `items`, `warnings`, and `coverage`. Suggested `nextSteps` are data, not permission to mutate.

### 6. Review a PR as data

```sh
ggh review 42 -R owner/repo --agent
```

Expect `result.pr`, `headSha`, `baseSha`, `checkoutPath`, `surface: "data"`, and `effects`. This can fetch refs and create a local review checkout. It does not submit a GitHub approval.

### 7. Commit the reviewed index

```sh
git --no-pager diff --cached
ggh commit -m 'fix: handle empty input' --agent
```

Expect `status`, command-specific `result`, and `effects`. Confirm the actual committed tree and remaining work with `ggh status --agent`; inspect partial effects on failure.

### 8. Preview and approve publication

```sh
plan=$(mktemp)
ggh pr create --base main --title 'Fix empty input' --body 'Handle empty input.' --dry-run --agent > "$plan"
jq '.status, .result, .effects' "$plan"
# After reviewing and approving this exact plan:
snapshot=$(jq -er 'select(.status == "planned") | .result.snapshotId' "$plan")
ggh pr create --base main --title 'Fix empty input' --body 'Handle empty input.' --approve-plan "$snapshot" --agent
```

Expect preview `status: "planned"`, `result.snapshotId`, `result.plan`, and `effects.pending`; execution returns workflow `result.status`, `url` when created, and completed/pending/uncertain effects. Register the returned PR with the host immediately.

### 9. Save and read an issue plan

```sh
ggh issue plan 42 --show > plan.md        # the plan to follow; fails when none exists
preview=$(mktemp)
ggh issue plan 42 plan.md --dry-run --agent > "$preview"
# After the user approves this exact plan:
snapshot=$(jq -er 'select(.status == "planned") | .result.snapshotId' "$preview")
ggh issue plan 42 plan.md --approve-plan "$snapshot" --agent
```

The plan is a `plan` artifact named "Plan" unless you pass `--name`. Saving edits the plan with that exact name as a new version instead of adding a duplicate; identical content returns `no_op`, and more than one match is refused. `result.action` is `create`, `edit`, or `no_op`. Use `-` to read standard input. Agent mode needs `--approve-plan`; `--yes` is not accepted.
