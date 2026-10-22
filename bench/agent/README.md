# Agent evidence benchmark

Run `bun run bench:agent`. It replays the current CLI against pinned git/gh
responses, prints a table, and writes `results.json`. A missing expected evidence
item, CLI error, unexpected subprocess call, or stderr output fails the gate.
Both native and ggh must retain 100% of each case's declared evidence.

These are output-size measurements on two recorded CI failures, with status and
run-detail controls for each repository. They are not agent repair-success
claims. No blind diagnosis trial, latency comparison, network-traffic measurement,
or billed-token measurement has run.

| Case | Native bytes | ggh bytes | Native ~tokens | ggh ~tokens | Native / ggh recall | Native / ggh calls |
|---|---:|---:|---:|---:|---|---|
| Zod CI | 5,402 | 7,231 | 1,350.5 | 1,807.75 | 100% / 100% | 4 / 1 |
| Zod status | 121 | 331 | 30.25 | 82.75 | 100% / 100% | 1 / 1 |
| Zod run | 230,459 | 233,858 | 57,614.75 | 58,464.5 | 100% / 100% | 2 / 1 |
| VS Code CI | 133,470 | 8,625 | 33,367.5 | 2,156.25 | 100% / 100% | 5 / 1 |
| VS Code status | 121 | 334 | 30.25 | 83.5 | 100% / 100% | 1 / 1 |
| VS Code run | 11,533 | 11,846 | 2,883.25 | 2,961.5 | 100% / 100% | 2 / 1 |

Tokens are UTF-8 bytes divided by four. No offline tokenizer is installed among
the project's dev dependencies. These estimates cannot establish tokenizer savings.

The native CI filter beats ggh on Zod output bytes. VS Code's bounded ggh bundle
is smaller and retains the missing-service error. Status still costs more than
porcelain, and run output still costs slightly more than native retrieval after
Phase 0. A native script can combine its command sequence into one tool call;
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

Status measures branch, tracking branch, drift, and cleanliness on the two clean
recorded clones. The replay derives empty porcelain v1 output from those clean
captures and adapts porcelain v2 separators to NULs. Only the checkout root is
normalized to `/recorded/<name>`. This question does not test full porcelain
parity: native output includes HEAD's OID, while current ggh status omits it.
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
