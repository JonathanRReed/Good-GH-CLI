/**
 * GitHub API facade. Everything stays importable from here;
 * transport lives in ./github/client.ts, domains alongside it.
 */

export * from "./github/client.ts";
export { describeAttachmentPlan, prepareAttachmentPlan, readAttachmentBodyFile } from "./github/attachments.ts";
export type { AttachmentFile, AttachmentOperation, AttachmentPlan, AttachmentPlanInput, AttachmentVisibility } from "./github/attachments.ts";
export { PartialAttachmentOperationError, PartialGitHubMutationError } from "./github/attachments.ts";
export type { UploadedAttachment } from "./github/attachments.ts";
export type { RepositoryDetail, RepositoryItem } from "./github/repos.ts";
export { listUserRepositories, listStarredRepositories, searchRepositories, viewRepository, getRepositoryReadme, forkRepository, setDefaultRepository, createRepository } from "./github/repos.ts";
export type { ActivePullRequestInfo, CheckRunResult, MergeOutcome, MergeOptions, PullRequestDetail, PullRequestFilters, PullRequestItem, ReviewComment, ReviewFilterResult } from "./github/prs.ts";
export { listPullRequests, checkoutPullRequest, viewPullRequestInBrowser, getPullRequestDiff, getActivePullRequest, getPullRequestChecks, viewPullRequest, mergePullRequest, setPullRequestState, commentOnPullRequest, editPullRequest, filterReviewComments, submitPullRequestReview, createPullRequest } from "./github/prs.ts";
export type { NativeStack, NativeStackMember, NativeStackPlan, NativeStackRegistration, PullRequestTarget } from "./github/stacks.ts";
export { findNativeStack, mergeStackedPullRequest, parsePullRequestUrl, planNativeStack, registerNativeStack, stackMergeSet } from "./github/stacks.ts";
export type { IssueArtifact, IssueArtifacts, IssueDetail, IssueFilters, IssueItem, IssuePlanArtifact } from "./github/issues.ts";
export { listIssues, listIssueArtifacts, findIssuePlans, readIssuePlan, saveIssuePlan, IssuePlanTargetError, viewIssue, createIssue, setIssueState, commentOnIssue, commentOnIssueWithAttachments, editIssue } from "./github/issues.ts";
export type { WorkflowJob, WorkflowRun } from "./github/runs.ts";
export { listWorkflowRuns, viewWorkflowRun, getFailedRunLog, rerunWorkflowRun, cancelWorkflowRun } from "./github/runs.ts";
