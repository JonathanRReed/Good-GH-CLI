---
name: native-ci-evidence
description: Retrieve revision-linked CI failure evidence with native gh commands and the local Bun log filter.
---

Resolve the PR with `gh pr view <pr> -R <repo> --json number,url,headRefOid`.
For the current branch, omit `<pr>`. Keep the returned head SHA with the evidence.

List runs with `gh run list -R <repo> --commit <sha> --json databaseId,workflowName,conclusion,headSha,url`.
Select the latest run for each workflow. Inspect each with
`gh run view <id> -R <repo> --json databaseId,headSha,url,workflowName,conclusion,jobs`.
Exclude evidence whose run SHA differs from the PR head and disclose the mismatch.

Save `gh run view <id> -R <repo> --log-failed` output. When a failed step points
elsewhere or only gives a summary, also save
`gh run view <id> -R <repo> --job <job-id> --log`. Successful precursor steps can
contain the actual error. Record missing or expired logs as unavailable.

Filter each saved log with `bun bench/agent/native.ts < saved-log.txt` from this
checkout. The filter retains error lines, source locations, one context line,
original line numbers, and byte counts. It has no output cap. Keep each excerpt
linked to its run, job, and log source. Report the observed error and location;
distinguish a suggested cause from a verified diagnosis. Stop after retrieval.
