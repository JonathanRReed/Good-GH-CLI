# Projects real-data check

2026-10-22. Baseline `cd9a003`, compared with this implementation in an isolated
worktree. No network or GitHub calls. Downloads and its linked checkouts were
read-only; every index, status snapshot and config used a temporary directory.

## Results

Five warm runs per side, alternating baseline and changed code after one warmup.
All times are milliseconds. The host has 14 available CPUs and was busy with
unrelated applications, with load averages rising from about 26 to 61.

| Dataset | Measurement | Before median [range] | After median [range] |
| --- | --- | --- | --- |
| Fixture | TTY first useful rows | 2227 [2112, 2575] | 50 [47, 59] |
| Downloads | TTY first useful rows | 6112 [5201, 6328] | 52 [49, 54] |
| Fixture | TTY invocation through fresh replacement | 2230 [2115, 2578] | 1731 [1605, 2097] |
| Downloads | TTY invocation through fresh replacement | 6118 [5206, 6334] | 2842 [2438, 3357] |
| Fixture | Discovery and fresh status only | 2064 [1697, 3076] | 1521 [1403, 2669] |
| Downloads | Discovery and fresh status only | 5720 [5346, 6566] | 2436 [2298, 2507] |

Warm first output meets the 300 ms target. Every changed warm TTY run showed stale
rows and then replaced them once with fresh rows. The whole refresh still takes
seconds. The fixture refresh medians overlap in range under host load; the
Downloads refresh has a clear separation in these runs.

The fixture has 70 clones and 150 checkouts. Ten clones each have eight linked T3
worktrees and ten additional branches. Three primary checkouts have 20,000 tracked
files each, including a dirty tracked file. All 70 clones have an untracked file.
No fixture checkout status was unavailable.

Downloads had 73 clones and 141 registered checkouts during the paired runs.
Fifteen checkout directories were missing and 14 discovery paths were skipped.
These 15 unavailable statuses were filesystem errors in the baseline, rather
than deadline expiry. The changed code names missing paths explicitly. A later
smoke run found 140 checkouts as the owner continued working, with the same 15
missing paths and zero checkout timeouts. No files in those repositories were
created, changed or removed by the benchmark.

## Git-call profile

A separate instrumented fixture run counted 170 unpublished `rev-list` calls in
the baseline and 70 after batching. Each of the ten clones with many branches
needs one shared refs query, nine checkout statuses and one commit-graph walk,
instead of eleven separate walks. Refs and stashes are read once per common
directory. A focused test verifies one refs query, one unpublished walk, one stash
read and four statuses for a clone with four checkouts.

The profile's slowest status subprocess fell from 243 ms to 150 ms. These are
profile observations, not the timing samples above. Process startup, filesystem
work and scheduling remain the refresh costs; increasing concurrency raises
aggregate child-process time even when it shortens the critical path. No speedup
claim assumes a clean or idle machine.

## Reproduce

Run `GGH_BENCH_REAL=1 bun scripts/bench-projects.ts`. It creates and deletes the
fixture and isolated config directories, reports unavailable fields separately
from timeouts, and measures cold and warm discovery/status, non-TTY CLI completion
and actual PTY first-row/replacement timing. PTY checks run on macOS and Linux.
Without `GGH_BENCH_REAL=1`, it only uses the disposable fixture.

For the paired comparison, an archive of `cd9a003` and the changed checkout used
the same fixture. Each side had its own temporary config. The terminal was 100
columns and 200 rows so the full table fit during timing. Normal terminals show
only the attention-first rows that fit while refreshing, then the full fresh
table. A separate 24-row PTY check showed 22 stale projects, one replacement and all
70 fresh projects, with every table line within 100 columns.

The paired discovery/status measurements exclude CLI startup, rendering and
snapshot persistence; terminal invocation measurements include all three. The
current script also reports cached formatting time and includes snapshot
persistence in its service total.

Five first-row samples, before then after:

- Fixture: `2575,2444,2227,2112,2134` and `59,50,47,47,56`.
- Downloads: `5201,5550,6194,6328,6112` and `49,52,49,53,54`.

A captured fixture table at width 100, first five rows:

```text
│  Name         Branch  State    ↑/↓  Unpublished       Stashes  Worktrees  Age
│  project-002  main    1 dirty  -    1 br / 2 commits  0        8 t3       5m
│  project-001  main    1 dirty  -    1 br / 2 commits  0        8 t3       6m
│  project-000  main    1 dirty  -    1 br / 2 commits  0        8 t3       6m
│  project-008  main    1 dirty  -    1 br / 1 commits  0        8 t3       6m
│  project-009  main    1 dirty  -    1 br / 1 commits  0        8 t3       6m
```

## Limits

This is source-CLI evidence on macOS. It does not qualify installed binaries or
Windows terminal behavior. A cold invocation without a snapshot waits for fresh
status. `--wide` deliberately allows long lines and waits for fresh output. JSON
and non-TTY output always wait for fresh status and retain their existing fields.
