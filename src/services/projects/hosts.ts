import { sep } from "node:path";
import type { GoodGhConfig } from "../config.ts";
import { projectPath, within } from "./paths.ts";
import type { CheckoutCreator, HostClaim } from "./types.ts";

const HOSTS = ["t3", "codex", "cursor", "claude"] as const;

export function checkoutHost(path: string, config: GoodGhConfig): HostClaim["host"] | null {
  const canonical = projectPath(path);
  for (const host of HOSTS) {
    const prefix = config.host_worktree_dirs?.[host];
    if (prefix && within(projectPath(prefix), canonical)) return host;
  }
  const portable = canonical.replaceAll(sep, "/");
  for (const host of HOSTS) {
    const pattern = host === "cursor" ? /\/\.cursor\/worktrees[^/]*(?:\/|$)/ : new RegExp(`/\\.${host}/worktrees(?:/|$)`);
    if (pattern.test(portable)) return host;
  }
  return null;
}

export function checkoutCreator(path: string, config: GoodGhConfig, created: boolean): CheckoutCreator {
  return checkoutHost(path, config) ?? (created ? "ggh" : "unknown");
}
