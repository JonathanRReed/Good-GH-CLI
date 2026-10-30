// Project inventory types. Three identities stay separate: a remote repository
// shares PR and CI metadata, a clone owns refs and stashes, and a checkout owns
// a working tree and HEAD. Collapsing them misattributes unpushed work.

export interface RemoteRepoId {
  host: string;
  owner: string;
  name: string;
}

export type CheckoutCreator = "ggh" | "t3" | "cursor" | "claude" | "codex" | "unknown";

/** Observed evidence that an agent host may be using a checkout. Never deletion authority. */
export interface HostClaim {
  host: Exclude<CheckoutCreator, "ggh" | "unknown">;
  evidence: string;
}

export interface Checkout {
  /** Canonical absolute path of the working tree. */
  path: string;
  gitDir: string;
  /** Branch name, or null when HEAD is detached. */
  branch: string | null;
  head: string | null;
  bare: boolean;
  locked: { reason: string } | null;
  prunable: { reason: string } | null;
  createdBy: CheckoutCreator;
  hostClaims: HostClaim[];
}

export interface Clone {
  /** Canonical absolute path of the shared Git common directory; the clone's identity. */
  commonDir: string;
  /** Path-keyed fallback name when no recognizable remote exists. */
  displayName: string;
  remotes: { name: string; url: string; repo: RemoteRepoId | null }[];
  /** The remote repository this clone primarily tracks, when one is recognizable. */
  primary: RemoteRepoId | null;
  checkouts: Checkout[];
}

export type DiscoverySource = "root-scan" | "ggh-clone" | "worktree-list" | "host-location" | "registered";

export interface IndexedClone extends Clone {
  sources: DiscoverySource[];
  lastSeen: string;
  missing?: boolean;
}

export interface DiscoveryCoverage {
  /** Broken checkouts outside the selected projects. */
  brokenElsewhere?: number;
  roots: string[];
  /** Paths that could not be read, with a short reason. */
  skipped: { path: string; reason: string }[];
  truncated: boolean;
}

export interface ProjectIndexFile {
  version: 1;
  updatedAt: string;
  roots: string[];
  excluded: string[];
  /** Clones registered explicitly, including nested repositories a scan would skip. */
  registered: string[];
  clones: IndexedClone[];
  coverage?: DiscoveryCoverage;
}

export type FieldState<T> =
  | { state: "ok"; value: T; observedAt: string }
  | { state: "unknown"; reason: string }
  | { state: "error"; message: string };

export interface CheckoutStatus {
  path: string;
  dirty: FieldState<{ staged: number; unstaged: number; untracked: number; conflicted: number }>;
  upstream: FieldState<{ name: string; ahead: number; behind: number; fetchedAt: string | null } | null>;
  operation: FieldState<"merge" | "rebase" | "cherry-pick" | "revert" | "bisect" | null>;
}

export interface CloneStatus {
  commonDir: string;
  checkouts: CheckoutStatus[];
  stashes: FieldState<number>;
  /** Commits reachable from a local ref or detached HEAD but from no remote-tracking ref. */
  unpublished: FieldState<{ ref: string; commits: number }[]>;
  mergedBranches: FieldState<string[]>;
  newestStash: FieldState<string | null>;
  lastCommit: FieldState<CommitSummary | null>;
}

export interface CommitSummary { oid: string; subject: string; committedAt: string }

export interface DiscoveryResult { clones: IndexedClone[]; coverage: DiscoveryCoverage }
