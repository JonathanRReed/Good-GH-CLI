# Remote projects verification

Verified locally on 2026-10-22 from `t3/5fad826a`, based on `b7fe8b8` and
merge `42f161b`. No push, PR, GitHub mutation, or owner-repository write.

## Query and recovery

The old query already used the last PR commit's check state. Its slow part was
issuing two search aliases for every repository. The new query groups authored
PR and review-request searches across up to 100 repositories, with 100 results
per page and at most ten pages. Counts are assigned only after all search
results arrive. Incomplete searches retain unavailable reasons in JSON.

A second query reads review decisions and
`commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`
for only the latest three authored PRs per repository. Metadata and search
queries estimate one point using
[GitHub's connection-cost formula](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api#predicting-the-point-value-of-a-query).
Check-query estimates scale with the selected PR count. Every response includes
`rateLimit { remaining resetAt cost }`; the live pair below returned cost 1
for each of its two requests.

Timeouts, HTTP 502/504, and transient GraphQL resource errors split the failed
batch in half. Singleton failures do not stop later batches. Requests take a
size-based timeout, capped by the remaining 20-second remote deadline. Auth and
lock waits share that deadline. Quota reserve, retry delays, and a 200-request
cap stop scheduling. Unknown failed-request costs cannot be reported; known
budgets deduct an estimated cost before each attempt.

Successful fields use a private cache keyed by host, active login, and repo.
Each field retains its observation time and expires after five minutes, even
if the cache file is read or rewritten. Unavailable fields are never stored.
Changing repo sets or selected fields reuses existing successes. Environment
token credentials still disable result caching.

## Live receipt

Cold and warm used the same fresh config and cache directories. `gh` read the
owner's existing credentials. Both processes ran the source CLI against
`~/Downloads` and exited 0 with no stderr.

```sh
ggh_remote_home=$(mktemp -d)
export XDG_CONFIG_HOME="$ggh_remote_home"
export XDG_CACHE_HOME="$ggh_remote_home/cache"
export GH_CONFIG_DIR="$HOME/.config/gh"
export GGH_PROJECT_ROOTS="[\"$HOME/Downloads\"]"
export GGH_NO_PLUGINS=1
time bun run bin/ggh.ts projects --remote --json > "$ggh_remote_home/cold.json"
time bun run bin/ggh.ts projects --remote --json > "$ggh_remote_home/warm.json"
```

| Run | Wall time | GraphQL requests | Returned total cost | Complete remotes | Unavailable |
|---|---:|---:|---:|---:|---:|
| Cold | 8.527 s | 2 | 2 | 35 | 0 |
| Warm | 2.574 s | 0 | 0 | 35 | 0 |

The current tree contains 73 clones, 69 with recognized remotes. Those clones
share 35 distinct remote identities. Four clones have no recognized remote,
so no GitHub request was made for them. There were no partial remote results
or unavailable reasons. Warm field values and observation times matched cold.

The cold target of about five seconds was **not met**. An earlier successful
pair took 7.741 s cold and 2.405 s warm. A separate trace measured 5.033 s for
the metadata/search request and 3.544 s for selected PR checks. The Mac had a
load average around 29 on 14 cores. These are individual runs, not a typical
connection latency guarantee or a controlled speedup measurement.

## Rendering

These rows use the final formatter at width 140 with the live warm JSON.
The three-character log prefix fits within that width. Local state comes from
the read-only scan; `Seen` shows the retained remote observation age.

```text
Name           Branch              State             ↑/↓    Unpublished          Stashes  Worktrees  Age  Remote         Seen
Good-GH-CLI    feat/v0.6-projects  2 dirty, merge    -      22 br / 395 commits  1        14 t3      11m  PR 0 review 0  58s
Ticket-Pigeon  main                1 dirty, unknown  ↑0 ↓0  0 br / 0 commits     0        1 other    10h  PR 0 review 0  58s
Apple-MCPs     main                clean             ↑0 ↓0  5 br / 23 commits    0        -          18h  PR 0 review 0  58s
```

Fully unavailable rows render `—` and a single reason footer, for example
`remote unavailable for 1 repos: deadline`. This case uses a fixture because
the final live pair had no failures.

## Checks

Focused regressions cover transient batch failures through a single failing
repo, subsequent batches, real subprocess timeouts, JSON 502 bodies, deadlines,
quota stops during bisection, partial check-node errors, exact paginated counts,
search caps, per-field cache reuse and expiry, and unavailable rows at width 140.

Final gates passed on the source changes:

- `bun run typecheck`
- `bun run lint`
- `bun test --timeout 30000`: 816 pass, 1 skip, 0 fail, 817 tests across 77 files.
- `git diff --check`

The skipped test requires PowerShell. Live cache inspection found 35 repository
entries, each containing seven successful fields, with directory mode 0700 and
file mode 0600. Failed-cache and recovery cases use the subprocess fixtures.
These checks cover the source CLI, not a packaged release.
