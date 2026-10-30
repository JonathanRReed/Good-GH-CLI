# Agent evidence benchmark

Run `bun run bench:agent`. It replays the current CLI against pinned git/gh
responses, prints a table, and writes `results.json`. A missing expected evidence
item, CLI error, unexpected subprocess call, or stderr output fails the gate.
Both native and ggh must retain 100% of each case's declared evidence. Clean
status must also stay at or below 1.5 times the native porcelain-v2 byte count.

These are output-size measurements on two recorded CI failures, with status and
run-detail controls for each repository, plus two generated dirty repositories. They are not agent repair-success
claims. No blind diagnosis trial, latency comparison, network-traffic measurement,
or billed-token measurement has run.

| Case | Native bytes | ggh bytes | Native ~tokens | ggh ~tokens | Native / ggh recall | Native / ggh calls |
|---|---:|---:|---:|---:|---|---|
| Zod CI | 5,402 | 7,231 | 1,350.5 | 1,807.75 | 100% / 100% | 4 / 1 |
| Zod status | 121 | 181 | 30.25 | 45.25 | 100% / 100% | 1 / 1 |
| Zod run | 230,459 | 233,858 | 57,614.75 | 58,464.5 | 100% / 100% | 2 / 1 |
| VS Code CI | 133,470 | 8,625 | 33,367.5 | 2,156.25 | 100% / 100% | 5 / 1 |
| VS Code status | 121 | 181 | 30.25 | 45.25 | 100% / 100% | 1 / 1 |
| VS Code run | 11,533 | 11,846 | 2,883.25 | 2,961.5 | 100% / 100% | 2 / 1 |
| Good GH brief | 1,710 | 945 | 427.5 | 236.25 | 100% / 100% | 5 / 1 |

Tokens are UTF-8 bytes divided by four. No offline tokenizer is installed among
the project's dev dependencies. These estimates cannot establish tokenizer savings.

The native CI filter beats ggh on Zod output bytes. VS Code's bounded ggh bundle
is smaller and retains the missing-service error. Status is 1.496 times
porcelain, down from 331 bytes for Zod and 334 for VS Code at `4fa80f3`.
It now includes the full HEAD OID. Before counts retain the previous benchmark's
normalized `/recorded/<name>` root; current counts use untouched CLI output and
the documented cwd default. Run output still costs slightly more than native
retrieval. A native script can combine its command sequence into one tool call;
the calls column assumes separate native invocations and one ggh invocation.
`results.json` also records ggh's internal subprocess calls. This is not a claim
that ggh makes fewer GitHub requests.

## Fixtures and replay

`fixtures/manifest.json` pins the source commands, raw byte counts, and SHA-256
checksums from `/tmp/ggh-research/agent-pain/`, captured on 22 October 2026.
Fixtures over 64 KiB use gzip. The benchmark requires neither that directory nor
the original clones. Its implementation uses TypeScript and Bun throughout.

- Zod PR #5914, run 32274929243, head
  `611a961879eef8379c44f778b113316b084180fa`. Evidence includes both recursive
  `pipe` type errors and `recursive-types.test.ts:456:9` and `:457:14`.
- VS Code PR #343557, run 39818915094. The failed-step log defers to another
  step. The full-job fixture contains
  `SessionChatInputToolbar depends on UNKNOWN service quickInputService` at
  original line 685. The second failing job's full log was not captured.

The replay projects recorded PR and run JSON onto the CLI's requested fields,
splits combined failed logs by job, and derives a one-workflow run-list response
from the recorded run ID and head. Auth and annotation-unavailability responses
are synthetic. The research did not capture annotation API responses; the
benchmark reports them as unavailable. Synthetic regression tests cover
annotation pagination, stale SHAs, missing logs, clean runs, and byte limits.
These variants are regression coverage, not a held-out blind failure trial.

Status measures full HEAD identity, branch, upstream, drift, and cleanliness on
the two clean recorded clones. The replay adapts porcelain-v2 separators to
NULs. Synthetic config responses reproduce their origin/main routing. Output
bytes come directly from the CLI, including the final newline. No paths or
result fields are rewritten before measurement. The replay cwd equals the
checkout root, so the documented root default applies.

The compact agent result is flat. `branch` and full `head` are required, with
null for detached and unborn states respectively. Omitted counts mean zero;
`changes` defaults to an empty array; `upstream`, `operation`, `base`, and
`fetchedAt` default to null. An omitted `root` means the invocation cwd, otherwise
it is absolute. Omitted `push` means upstream. `base` is the explicit recorded
comparison base. `fetchedAt` is the local FETCH_HEAD mtime, not proof of current
remote state. `effects` may be omitted for read-only status when all arrays are
empty. Other commands retain effects. `ggh agent schema` documents these rules;
legacy `status --json` retains its nested payload and explicit counts.

Dirty agent status uses `[xy, path]` tuples, with `origPath` as a third item for
renames and copies. XY keeps index and worktree state separate, including conflict
codes such as `UU`. `submodules` holds `[path, S<c><m><u>]` markers. `--full` adds
`rawChanges` with the original porcelain-v2 records, including modes, object IDs,
conflict stages and separate rename sources. Generated tests cover newline and
space paths, renames, submodule markers, conflicts, detached/unborn HEAD,
subdirectories, operations, separate routing targets and fetch metadata.

## Session-start brief

`brief.ts` replays `ggh agent brief --agent` against Good-GH-CLI PR #17 at
`0b49791`, captured on 29 October 2026 from a clean checkout. The PR had 21
checks (17 pass, 1 pending, 3 skipping), two unresolved review threads, no
linked issues, and no native stack. Native and ggh read the same recorded
responses. The native side is five tuned calls: porcelain-v2 status, a
field-projected `gh pr view`, `gh pr checks --json name,bucket`, a GraphQL query
for only `isResolved`, and the stacks API. The 1,710 native bytes are their
concatenated stdout.

ggh also reads full review-thread comments to count them; it prints only the
count. Its output includes the absolute replay root, here 78 bytes, so the ggh
byte count varies with checkout path length. Twelve declared evidence items
cover branch, full HEAD, upstream, drift, cleanliness, PR number, state, head SHA,
mergeability, pending and failing checks, the unresolved count, linked issues, and
stack membership. One capture with no failing checks or linked issues is a single
data point, not a general size claim. A native `--jq` projection can be smaller.

## Dirty status comparison

`dirty-status.ts` creates real local repositories with 5 and 25 changed paths.
Each has a staged rename, an untracked file, an unresolved merge conflict, and
tracked files with index-only, worktree-only or combined modifications. The
5-path case has combined and index-only modifications. The 25-path case also has
worktree-only modifications. Git generates both native outputs and the NUL
porcelain-v2 response replayed through the current CLI. No network is used.

| Changed paths | Native v2 bytes | Native v1 bytes | Prior raw format bytes | Compact agent bytes | v2 / v1 / ggh recall |
|---|---:|---:|---:|---:|---|
| 5 | 707 | 119 | 843 | 371 | 100% / 100% / 100% |
| 25 | 3,200 | 412 | 3,378 | 786 | 100% / 100% / 100% |

Native commands are exactly `git status --porcelain=v2 --branch` and
`git status --porcelain=v1 -b`. Byte counts include untouched stdout and its final
newline. Prior-format bytes reconstruct the old raw-record `changes` payload
from the same Git response and current envelope. They do not run an older binary.

Each case declares evidence for branch/upstream, zero drift, both rename paths,
untracked state, the conflicting path and code, and each tracked path's exact
index/worktree code. `results.json` records every expected item and each missing
item. All three outputs must retain 100%; CLI errors, stderr and unexpected calls
also fail the gate. Full HEAD identity, modes, blob IDs and conflict stages are
outside this shared action-evidence list. Porcelain-v1 does not supply full HEAD
identity, while ggh retains it and v2 supplies it. `--full` supplies the detailed
records when needed. This gate does not claim byte-for-byte information parity
with raw v2 metadata.

Compact agent output reduces the prior format by 56.0% and 76.7% in these cases.
Porcelain-v1 wins on bytes. The 1.5 ratio gate still applies only to the two
pinned clean captures, not dirty repositories or all branch/upstream shapes.
These are deterministic byte counts, not latency or tokenizer measurements.
Run controls ask for run/jobs and failed-step text, including the complete raw
failed logs. They do not substitute for the CI precursor-step question.

The child process replaces git/gh execution with fixture responses and rejects
every unexpected process. It also denies `fetch` and synchronous subprocesses.
CI runs the benchmark in a Linux network namespace after dependency setup.

## Native reference

`native.ts` independently projects metadata and filters logs with error patterns,
one context line, original line numbers, and exact-text deduplication. It reads
the saved captures rather than the research's hand-built answer sketches. It
keeps all matching lines, including long error payloads, so a tuned native filter
can produce smaller answers. Full native command sequences and expected-evidence
patterns are stored per case in `results.json`.

The [native CI skill](native-ci-evidence/SKILL.md) provides the read-only workflow
and stdin filter. The filter can run on any saved gh log:

```bash
gzip -dc bench/agent/fixtures/zod-run-failed-log.stdout.gz | bun bench/agent/native.ts
```

Its log byte counts describe filtering omissions. It has no output byte cap.
The benchmark's two failure specimens remain development fixtures. Broader
evidence parity and agent outcome claims require additional archived failures
and a blind trial before promotion.

## Exact-scope correctness gate

Run `bun test tests/exact-scope.test.ts --timeout 30000`. The 20 generated local
fixtures use real Git repositories, bare local remotes and a fake split provider.
The same fixtures at `4fa80f3` reproduce four unintended-scope incidents; the
fixed code passes all 20 with zero incidents. See
[the fixture report](exact-scope.md) for the cases, failures and recovery contract.
