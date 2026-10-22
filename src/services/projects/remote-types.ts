import type { FieldState, RemoteRepoId } from "./types.ts";

export type RemoteField<T> = FieldState<T> | { state: "unavailable"; reason: string; retryAt?: string };
export interface RemotePullRequest {
  number: number;
  title: string;
  headRefName: string;
  statusCheckRollup: string | null;
  reviewDecision: string | null;
}
export interface RemoteFields {
  defaultBranch: { name: string; oid: string } | null;
  archived: boolean;
  fork: { isFork: boolean; parent: string | null };
  permission: string | null;
  authored: { count: number; pullRequests: RemotePullRequest[] };
  reviewRequested: number;
  defaultCi: string | null;
}
export type RemoteFieldName = keyof RemoteFields;
export type RemoteRepository = { repo: RemoteRepoId; login: string | null } & { [K in RemoteFieldName]?: RemoteField<RemoteFields[K]> };
export interface UnclonedRepository { nameWithOwner: string; pushedAt: string | null }
export interface UnclonedResult {
  host: string;
  login: string | null;
  count: RemoteField<number>;
  repositories: RemoteField<UnclonedRepository[]>;
  scanned: number;
  complete: boolean;
}
export interface RemoteResult { repositories: RemoteRepository[]; uncloned: UnclonedResult[]; requests: number; cost: number }
