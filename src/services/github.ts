/**
 * GitHub API facade. Everything stays importable from here;
 * transport lives in ./github/client.ts, domains alongside it.
 */

export * from "./github/client.ts";
export type { RepositoryDetail, RepositoryItem } from "./github/repos.ts";
export { listUserRepositories, listStarredRepositories, searchRepositories, viewRepository, getRepositoryReadme, forkRepository, setDefaultRepository, createRepository } from "./github/repos.ts";
export type { ActivePullRequestInfo, CheckRunResult, MergeOptions, PullRequestDetail, PullRequestFilters, PullRequestItem, ReviewComment, ReviewFilterResult } from "./github/prs.ts";
export { listPullRequests, checkoutPullRequest, viewPullRequestInBrowser, getPullRequestDiff, getActivePullRequest, getPullRequestChecks, viewPullRequest, mergePullRequest, setPullRequestState, commentOnPullRequest, editPullRequest, filterReviewComments, submitPullRequestReview, createPullRequest } from "./github/prs.ts";
export type { IssueDetail, IssueFilters, IssueItem } from "./github/issues.ts";
export { listIssues, viewIssue, createIssue, setIssueState, commentOnIssue } from "./github/issues.ts";
export type { WorkflowJob, WorkflowRun } from "./github/runs.ts";
export { listWorkflowRuns, viewWorkflowRun, getFailedRunLog, rerunWorkflowRun, cancelWorkflowRun } from "./github/runs.ts";
export type { ReleaseItem } from "./github/releases.ts";
export { listReleases, viewRelease, createRelease, deleteRelease, downloadRelease, uploadRelease, getCommitsSinceTag } from "./github/releases.ts";
