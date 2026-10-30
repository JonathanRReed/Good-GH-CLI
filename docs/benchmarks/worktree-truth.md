`lost` discovery and inventory took a median of 132.654 seconds before this fix
and 3.391 seconds after it in a disposable sandbox. These are five alternating
before/after pairs on the same fixture, with warm filesystem caches.

The fixture has 16 clones, 26 branches per clone, shared unpublished ancestry,
and 24 reset commits per clone recoverable through reflogs. Every run returned
800 items and 784 distinct unpublished commits, with no warnings or skipped
paths. All detected items, commit membership, counts, dates, and subjects match
between versions. Comparison ignores item order and recovery commands, which
this fix intentionally changes.

| Pair | Before, seconds | After, seconds |
| --- | ---: | ---: |
| 1 | 150.046 | 4.797 |
| 2 | 128.112 | 3.357 |
| 3 | 164.653 | 3.391 |
| 4 | 132.654 | 3.763 |
| 5 | 119.274 | 3.216 |
| Median | 132.654 | 3.391 |
| Range | 119.274 to 164.653 | 3.216 to 4.797 |

A separate piped `lost --all --agent` run, including CLI startup and JSON output,
took 133.234 seconds before and 3.800 seconds after. This was one pair. Both
commands exited zero, returned the same 800 items across 16 clones, and wrote
nothing to stderr.

The host ran macOS arm64, Bun 1.4.4-canary.1, and Apple Git 2.54.0. It had 14
logical CPUs and substantial competing compiler and test activity. Load
averages exceeded 99 before profiling and 178 during measurement. Alternating
runs reduces drift bias; these timings describe this sandbox on a busy host.

The initial profile took 199.785 seconds, including 0.674 seconds of discovery.
Repeated Git processes dominated the wait. Separate profiling runs counted:

| Git operation | Before calls | After calls |
| --- | ---: | ---: |
| rev-parse | 448 | 48 |
| worktree | 32 | 32 |
| config | 48 | 32 |
| for-each-ref | 16 | 16 |
| status | 16 | 16 |
| rev-list | 448 | 0 |
| log | 400 | 32 |
| reflog exists | 432 | 0 |
| reflog show | 432 | 16 |
| Total | 2,272 | 192 |

The fix uses one shared commit walk for unpublished tips and another for
reflog-only work, then propagates tip membership through each graph. It reads
reflogs in one Git call per clone and retains the 1,000-entry limit separately
for each branch and checkout. Four workers inspect clones. Refreshing one
clone no longer rescans unrelated host directories. Remaining time includes
Git startup, metadata reads, and checkout status.

The benchmark never fetches, syncs, tidies, stashes, or scans real repositories.
To repeat the five-pair comparison against the starting revision:

```sh
baseline_dir="$(mktemp -d)"
git archive e192b1e | tar -x -C "$baseline_dir"
ln -s "$PWD/node_modules" "$baseline_dir/node_modules"
bun scripts/bench-lost.ts "$baseline_dir"
```

The script creates and removes its own fixture. It rejects incomplete or
changed inventories. A two-clone smoke run of its fixture builder returned
16 items and no warnings.
