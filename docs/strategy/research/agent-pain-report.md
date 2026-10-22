# Where agents waste git/gh work, and whether ggh helps

**As of 22 October 2026. Verdict:** there is credible evidence of avoidable failures, but no evidence that wrapping git/gh in JSON universally saves tokens. The strongest opportunity is **bounded, revision-linked CI evidence retrieval**. Existing ggh outputs sometimes cost substantially more than competent native commands.

## 1. Failure evidence

This is a targeted convenience sample, not an incidence study. I inspected 20 GitHub issue bodies and one Cursor thread. After excluding one retracted attribution and one overlapping umbrella report, **19 distinct reports remain**. Counts below overlap. They count reports, not users, failures, or independently reproduced bugs. Historical reports do not establish that October versions still fail.

| Category | Count | Direct evidence |
|---|---:|---|
| Interactive hangs | 1 | Cursor Composer waits for the user to quit the pager after `git stash list`: [Cursor #39958](https://forum.cursor.com/t/dealing-with-agent-terminal-commands-that-trigger-a-pager/39958). |
| Destructive operations / unintended publication scope | 2 | Claude reportedly discarded work with `reset --hard` and `checkout -- .`: [#7232](https://github.com/anthropics/claude-code/issues/7232). A squash used `reset --soft` followed by `add -A`, publishing previously uncommitted/untracked work: [#97842](https://github.com/anthropics/claude-code/issues/97842). |
| Committing secrets / oversized files | 1 / 0 | Production values reportedly copied into a committed example file: [Claude #7921](https://github.com/anthropics/claude-code/issues/7921). Separately, [Codex #29388](https://github.com/openai/codex/issues/29388) reports 102 GB of checkpoint objects, **not** oversized-file commits. |
| Wrong branch/base | 2 | Codex assumed `main` in a repository without it: [#12346](https://github.com/openai/codex/issues/12346). T3 fetched the fork rather than the selected branch's tracking upstream: [#17312](https://github.com/pingdotgg/t3code/issues/17312), explicitly a source-analysis report, not a live reproduction. |
| Merge-conflict mishandling | 1 | A reporter supplied a shared-closing-brace reproduction and reported 0/19 successful resolutions on that pattern: [Claude #28312](https://github.com/anthropics/claude-code/issues/28312). This experiment was not independently reproduced here; closure was for inactivity. |
| Huge output/context | 2 | Git diff chunks exceeded Codex's context: [#3967](https://github.com/openai/codex/issues/3967). [#16664](https://github.com/openai/codex/issues/16664) reports extreme output/quota amplification, but its concrete reproduction is `rg`, not git. |
| Misreading state/upstream freshness | 2 | T3 displayed repository-sized changes against the wrong remote: [#15314](https://github.com/pingdotgg/t3code/issues/15314); stale-base selection: [#17312](https://github.com/pingdotgg/t3code/issues/17312). |
| PR/CI loops | 1 | Claude generated delay-free `gh run view` loops and exhausted the API limit: [#65985](https://github.com/anthropics/claude-code/issues/65985). The reporter identifies existing `gh run watch --exit-status` as the remedy. |
| Worktree confusion/lifecycle | 5 | Orphan after successful Git creation: [Codex #16936](https://github.com/openai/codex/issues/16936); invalid base: [#12346](https://github.com/openai/codex/issues/12346); partial creation/config-lock failure: [T3 #11735](https://github.com/pingdotgg/t3code/issues/11735); app/agent checkout disagreement: [#14343](https://github.com/pingdotgg/t3code/issues/14343); shared session worktree: [Claude #90146](https://github.com/anthropics/claude-code/issues/90146). |
| Auth/host confusion | 1 | Valid terminal authentication reportedly appeared invalid inside Codex: [#19262](https://github.com/openai/codex/issues/19262). T3's [#17314](https://github.com/pingdotgg/t3code/issues/17314) explains overlapping remote-resolution inconsistencies; excluded from distinct counts. |

Additional host-side waste: [Claude #10078](https://github.com/anthropics/claude-code/issues/10078) reports zombie Git processes; [T3 #21858](https://github.com/pingdotgg/t3code/issues/21858) reports approximately 21 seconds for `diff --minimal --numstat` versus 0.49 seconds without `--minimal`. A maintainer accepted the latter issue. Neither is inherently fixed by another CLI.

**Negative controls matter.** [Claude #40710](https://github.com/anthropics/claude-code/issues/40710) was explicitly retracted: another local tool caused the resets. [Answer.AI's Devin postmortem](https://www.answer.ai/posts/2025-01-08-devin.html) documents broader task failures, but does not establish a git/gh-specific failure count. No qualifying Devin git/gh incident was established here. No directly inspected evidence established editor, interactive-rebase, gh-prompt, credential-prompt, or branch-deletion subtypes.

## 2. Local measurements

### Method

Two fresh `--depth 2 --filter=blob:none` clones:

- `colinhacks/zod`: 742 tracked files, HEAD `afdac65e0f80c0ccf9e8909da97c411567908b57`.
- `microsoft/vscode`: 21,123 tracked files, HEAD `58173d0ebc1838579e3c331e0a47e365904a6456`.

Git 2.54.0, gh 2.100.0; ggh source `32a3e4b`, version `0.5.0-beta.2`, invoked through Bun. Repositories remained clean. Public PR specimens were [Zod #5914](https://github.com/colinhacks/zod/pull/5914) and [VS Code #343557](https://github.com/microsoft/vscode/pull/343557); their sampled CI run SHAs matched their PR heads. These PRs are diagnostic specimens, not the clones' checked-out revisions.

Bytes include stdout plus stderr; successful measurements had empty stderr. Tokens are **bytes/4**, rounded, not tokenizer counts. `gh pr checks` exit 1 means failed checks, not measurement failure. An initial config-isolation attempt hid gh credentials; those failed attempts were corrected and excluded.

| Task / repository | Raw bytes (~tokens) | Alternative bytes (~tokens) |
|---|---:|---:|
| Core state, Zod | 278 (70) | Existing ggh agent: 1,455 (364) |
| Core state, VS Code | 243 (61) | Existing ggh agent: 1,458 (364) |
| Change overview, Zod | 3,551 (888) | **Sketch:** 241 (60) |
| Change overview, VS Code | 13,455 (3,364) | **Sketch:** 566 (142) |
| PR + CI evidence, Zod | 242,687 (60,672) | **Sketch:** 5,422 (1,356) |
| PR + CI evidence, VS Code | 561,642 (140,410) | **Sketch:** 2,982 (746) |
| Unresolved reviews, Zod | 3,247 (812) | **Sketch:** 2,945 (736) |
| Unresolved reviews, VS Code | 3,616 (904) | **Sketch:** 2,628 (657) |
| Same PR-view fields, Zod | Native JSON: 2,431 (608) | Existing ggh agent: 2,766 (692) |
| Same PR-view fields, VS Code | Native JSON: 4,798 (1,200) | Existing ggh agent: 5,133 (1,283) |
| Same run-detail fields, Zod | Native JSON: 12,216 (3,054) | Existing ggh agent: 40,155 (10,039) |
| Same run-detail fields, VS Code | Native JSON: 8,736 (2,184) | Existing ggh agent: 28,804 (7,201) |

**What each comparison actually means:**

- **State:** raw sequence was `git status`, `git branch -vv`, `git worktree list`. ggh additionally reports authentication, PR and AI-provider configuration, so this is a scope comparison, not equivalent information. Native `git status --porcelain=v2 --branch` was only **121 bytes** in either clone; ggh `--json` was 1,142/1,145 bytes. Illustrative sequential state times were 0.092/0.484 seconds raw versus 2.142/1.240 seconds for ggh agent. Single runs, network and cache effects prevent general speed claims.
- **Changes:** raw was `git log -2 --oneline`, `git diff --stat HEAD~1 HEAD`, and the full patch. The sketch preserves full base/head SHAs and per-file counts, but **omits code**. Its 93.2%/95.8% savings apply only to overview questions. Native `--numstat` alone was 34/260 bytes. There is no measured advantage over a competent summary-first native workflow, or for full code review.
- **CI:** raw sequence was `gh pr view --comments`, `gh pr checks`, `gh run view --json …,jobs`, and `gh run view --log-failed`. VS Code additionally required `--job 119964605506 --log`. Sketches preserve PR/run revisions, failed checks/steps, evidence lines, URLs and truncation disclosure. They are hand-built/extractive prototypes, **not existing ggh functionality or validated diagnoses**.
- **Reviews:** one GraphQL query retrieved thread resolution/outdated state, locations, bodies and pagination metadata. All 1/4 threads were unresolved; thread/comment pagination was complete. Sketches retain every comment body. Savings were only 9.3%/27.3%, mostly metadata removal. A native `gh api graphql --jq` projection can perform the same filtering.

### The important CI finding

[Zod run 32274929243](https://github.com/colinhacks/zod/actions/runs/32274929243) produced **218,243 bytes** of failed-step logs. A small extract retained the `pipe` recursive type errors and source locations.

[VS Code run 39818915094](https://github.com/microsoft/vscode/actions/runs/39818915094) produced only **2,797 bytes** with `--log-failed`, but these said essentially “fixtures failed; see another step.” The **536,918-byte full-job log** contained the actionable symptom: `SessionChatInputToolbar depends on UNKNOWN service quickInputService`, first captured at line 685. Blindly summarizing only failed steps would miss it.

This demonstrates output-reduction potential of **97.8%/99.5%**, not equivalent reductions in network traffic, elapsed time, billed tokens or repair errors. Extraction still needs the evidence. Tuned native scripts can produce the same compact output.

### Existing ggh is not yet that solution

The [Scripting contract](https://github.com/JonathanRReed/Good-GH-CLI/blob/32a3e4b/README.md#scripting) and [envelope implementation](https://github.com/JonathanRReed/Good-GH-CLI/blob/32a3e4b/src/services/agent-contract.ts) offer useful status, retryability, required inputs and completed/pending/uncertain effects. However, result-schema coverage is partial.

The [run command](https://github.com/JonathanRReed/Good-GH-CLI/blob/32a3e4b/src/commands/run.ts) returns JSON **before** log retrieval. The [run service](https://github.com/JonathanRReed/Good-GH-CLI/blob/32a3e4b/src/services/github/runs.ts) duplicates jobs in `run.jobs` and top-level `jobs`; pretty-printing further expands output. Existing run envelopes were approximately **3.3× native JSON**. Smaller ggh PR views omit checks and head SHA, so they cannot substitute for complete PR/CI answers.

## 3. Ranked investment recommendations

1. **Revision-linked, bounded CI evidence bundles.** Metric: evidence recall, output bytes, agent tool calls, and correct diagnosis. Observed output ceiling: **97.8–99.5% reduction versus verbose retrieval**, but no intrinsic advantage over equally good native filtering. Include successful precursor steps, annotations and artifact links; never silently truncate. Cheap probe: blind-triage 20 archived public failures with ggh prototype, a strong git/gh skill, and available host CI tooling. Reject the feature if evidence recall drops.

2. **Exact-scope mutation preflight and recoverable outcomes.** Bind approval to repository/worktree, HEAD, index, base and publication destination; distinguish partial success from safe-to-retry failure. Metric: unintended paths/history changes and duplicate publication attempts. **Effect size unmeasured**; destructive and secret reports justify testing, not a prevention percentage. Cheap probe: 20 synthetic local fixtures covering staged/unstaged mixtures, concurrent changes and interrupted operations. Existing ggh plans/envelopes provide a foundation, but do not constrain agents that bypass them with raw Git.

3. **Explicit, cheap repository identity/state snapshots.** Return local state separately from optional remote/provider probes, with fetch freshness and distinct base/push targets. Metric: wrong-target choices and state latency. Current ggh lost the byte comparison and added roughly 0.76–2.05 seconds in these runs. Cheap probe: fork/upstream, no-upstream, detached-HEAD and shallow fixtures. Require parity with porcelain and no unnecessary network requests before claiming a win.

4. **Complete unresolved-review retrieval.** Metric: missed unresolved threads, correct locations, pagination completeness and tool calls. Expected byte savings here were only **9–27%**, and all threads were unresolved, so larger savings are speculative. Cheap probe: ten PRs with resolved/outdated threads and more than 100 comments/threads. Prefer lossless bodies plus cursors over AI summaries. Native GraphQL is already a strong one-command competitor.

**Do not prioritize** another worktree lifecycle manager, generic log JSON, automatic conflict resolution, or bespoke CI polling. [Codex already owns worktree creation/handoff and intentionally uses detached HEAD](https://learn.chatgpt.com/docs/environments/git-worktrees); [Claude Code exposes worktree/session isolation](https://code.claude.com/docs/en/worktrees). This T3 session provides workspace-bound launching and event-driven PR watching. A CLI cannot independently repair host thread-to-worktree bindings. [Devin also exposes CI status integrations](https://docs.devin.ai/release-notes/2026); their equivalence to the proposed evidence bundle was not tested.

Likewise, AI-input redaction is not commit-secret prevention, and removing conflict markers does not prove a correct merge. Test those outcomes separately.

## Reproducibility and limits

Scripts, commands, stdout/stderr, exit codes, durations, source captures and measurements are under `/tmp/ggh-research/agent-pain/`, especially `benchmark.py`, `measurements.json`, `exact-comparisons.json` and `research-ledger.json`. Shallow history and clean checkouts limit generalization. No agent A/B outcome trial, tokenizer benchmark, destructive operation, GitHub write, or existing-repository modification was performed.

Research stopped at the decision threshold: 37 substantive sources within a 40-source budget. The ledger links 46/46 factual claim records, including 3/3 decision-critical records, to evidence. This is citation coverage, not independent validation of reporter allegations.

**Decision:** pursue a small CI-evidence prototype and compare it against skilled native usage. Do not claim universal token savings or host replacement.
