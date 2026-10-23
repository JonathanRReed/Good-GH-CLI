# Phase 1 design: project inventory

Shared contract for the Phase 1 lanes. Plan context: [PLAN.md](PLAN.md) §1.

## Observed host layouts (probed on the owner's machine, 2026-10-22)
- T3 Code: linked worktrees at `~/.t3/worktrees/<Project>/<name>` (two levels). The `.git` file points into the main clone's `.git/worktrees/<name>`. No `t3-merge-base-ref` config marker was present on the sampled branch, so provenance is path-based. T3 supports a custom worktrees directory; treat the prefix as configurable (`host_worktree_dirs.t3`).
- Claude Code: in-repo `<repo>/.claude/worktrees/<name>`. Directories can exist without any registered worktree (stale).
- Cursor: in-repo `.cursor/worktrees*` per research; none present on this machine.
- Codex: no worktree directory present on this machine; layout unverified. Do not hardcode a path; leave `createdBy: "codex"` reachable only via configured prefixes.
- Authoritative linked-worktree enumeration: `git -C <clone> worktree list --porcelain -z`.

## Types (to live in `src/services/projects/types.ts`)
```ts
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
}

export interface DiscoveryCoverage {
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
}
```

## Rules
- Discovery: explicit roots (config `project_roots`, default none; owner sets `~/Downloads`) + clones ggh creates + every discovered clone's own worktree list + configured host prefixes + registered paths. Stop descending at `.git` (dir or file) except registered nested repos; bounded depth (default 4); `exclude` list; skip `node_modules`, `.git` internals; never follow symlinks outside a root; detect loops. Record unreadable paths in coverage.
- Provenance: `createdBy` from path prefix rules (t3/claude/cursor/codex) and the local Git config marker `ggh.created=true` (with `ggh.createdAt`) that `ggh clone` writes into every clone it makes; `hostClaims` are observations only.
- Index file: `<configDir>/projects.json` written atomically with private permissions; stores no credentials (redact `user:pass@` from remote URLs before storing).
- Status: refresh locally with bounded metadata and checkout pools, each defaulting to min(16, available CPUs). Each checkout gets its own 3 s deadline when work starts; shared clone metadata has an independent 3 s budget. Cache the compact last snapshot in `<configDir>/projects-status.json`, with private permissions, atomic replacement, scope matching and `observedAt`. Warm terminal runs show stale rows within the viewport, then replace them once with fresh results. JSON and non-TTY output wait for fresh results. Each field reports ok/unknown/error independently. Disk size is opt-in.
- `unpublished` = commits reachable from any local branch or detached HEAD of any checkout but not from any `refs/remotes/*` ref. This is the input to `tidy` keep decisions and `ggh lost`.
