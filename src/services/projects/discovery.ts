import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getConfig, type GoodGhConfig } from "../config.ts";
import { worktreeList } from "../git/worktree.ts";
import { parseGitHubRepositoryNameWithOwnerFromRemoteUrl } from "../github/client.ts";
import { gitLine, inventoryGitOptions, projectGit, projectPool } from "./git.ts";
import type { Checkout, CheckoutCreator, DiscoveryResult, DiscoverySource, IndexedClone, RemoteRepoId } from "./types.ts";

export function projectPath(path: string): string {
  const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  const absolute = resolve(expanded);
  try { return realpathSync(absolute); } catch { return absolute; }
}

export function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function projectExcluded(path: string, excluded: readonly string[], roots: readonly string[] = []): boolean {
  return excluded.some(pattern => {
    if (isAbsolute(pattern) || pattern.startsWith("~")) return within(projectPath(pattern), path);
    const glob = new Bun.Glob(pattern);
    return glob.match(path.replaceAll(sep, "/")) || glob.match(basename(path)) || roots.some(root => glob.match(relative(root, path).replaceAll(sep, "/")));
  });
}

export function redactRemoteUrl(value: string): string {
  if (!value.includes("://") && /^[^/]*@[^/:]+:/.test(value)) return value.replace(/^[^/]*@/, "").split(/[?#]/, 1)[0] ?? "";
  try {
    const url = new URL(value);
    url.username = ""; url.password = ""; url.search = ""; url.hash = "";
    return url.toString();
  } catch {
    return value.replace(/^[^/@\s]+@([^:]+:)/, "$1").replace(/\/\/[^/]*@/g, "//").split(/[?#]/, 1)[0] ?? "";
  }
}

export function remoteIdentity(url: string): RemoteRepoId | null {
  const safe = redactRemoteUrl(url);
  const parsed = parseGitHubRepositoryNameWithOwnerFromRemoteUrl(safe.startsWith("ssh://") ? safe.replace("ssh://", "ssh://git@") : /^[^/:]+:/.test(safe) && !safe.includes("://") ? `git@${safe}` : safe);
  if (!parsed) return null;
  const [owner, name] = (typeof parsed === "string" ? parsed : parsed.nameWithOwner).split("/");
  return owner && name ? { host: typeof parsed === "string" ? "github.com" : parsed.host.toLowerCase(), owner, name } : null;
}

export function checkoutCreator(path: string, config: GoodGhConfig, created: boolean): CheckoutCreator {
  for (const host of ["t3", "codex", "cursor", "claude"] as const) {
    const prefix = config.host_worktree_dirs?.[host];
    if (prefix && within(projectPath(prefix), path)) return host;
  }
  const portable = path.replaceAll(sep, "/");
  if (/\/\.claude\/worktrees\//.test(portable)) return "claude";
  if (/\/\.cursor\/worktrees[^/]*\//.test(portable)) return "cursor";
  return created ? "ggh" : "unknown";
}

const SKIP = new Set([".git", "node_modules", "vendor", ".cache", ".npm", ".bun", "__pycache__", ".next", ".venv", "target", "dist", "build", ".Trash"]);

function checkoutGitDir(path: string, bare: boolean): string {
  if (bare) return path;
  const marker = join(path, ".git");
  if (statSync(marker).isDirectory()) return projectPath(marker);
  const content = readFileSync(marker, "utf8");
  if (!content.startsWith("gitdir: ")) throw new Error("Invalid .git file");
  return projectPath(resolve(path, gitLine(content.slice(8))));
}

function prunableGitDir(path: string, commonDir: string): string {
  const directory = join(commonDir, "worktrees");
  if (existsSync(directory)) for (const entry of readdirSync(directory)) {
    const gitDir = join(directory, entry);
    const pointer = join(gitDir, "gitdir");
    if (existsSync(pointer) && projectPath(dirname(gitLine(readFileSync(pointer, "utf8")))) === path) return gitDir;
  }
  return commonDir;
}

export interface DiscoveryOptions {
  config?: GoodGhConfig;
  registered?: string[];
  excluded?: string[];
  known?: IndexedClone[];
  workers?: number;
}

export async function discoverProjects(options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const config = options.config ?? getConfig();
  const roots = (config.project_roots ?? []).map(projectPath);
  const excluded = [...config.project_exclude ?? [], ...options.excluded ?? []];
  const registered = new Set((options.registered ?? []).map(projectPath));
  const coverage: DiscoveryResult["coverage"] = { roots, skipped: [], truncated: false };
  const found = new Map<string, Set<DiscoverySource>>();
  const visited = new Set<string>();
  const depthLimit = config.project_scan_depth ?? 4;
  const add = (path: string, source: DiscoverySource) => {
    const sources = found.get(path) ?? new Set<DiscoverySource>();
    sources.add(source); found.set(path, sources);
  };
  function walk(path: string, root: string, depth: number, source: DiscoverySource): void {
    if (projectExcluded(path, excluded, roots)) return;
    try {
      const canonical = realpathSync(path);
      if (!within(root, canonical)) { coverage.skipped.push({ path, reason: "Symlink leaves scan root" }); return; }
      if (projectExcluded(canonical, excluded, roots)) return;
      const visitKey = `${root}\0${canonical}`;
      if (visited.has(visitKey)) { if (lstatSync(path).isSymbolicLink()) coverage.skipped.push({ path, reason: "Symlink loop or duplicate" }); return; }
      const info = statSync(canonical);
      if (!info.isDirectory()) return;
      visited.add(visitKey);
      const entries = readdirSync(canonical, { withFileTypes: true });
      const repo = entries.some(entry => entry.name === ".git") || (entries.some(entry => entry.name === "HEAD") && entries.some(entry => entry.name === "objects") && entries.some(entry => entry.name === "refs"));
      if (repo) {
        add(canonical, registered.has(canonical) ? "registered" : source);
        for (const host of [".claude", ".cursor"]) {
          const hostPath = join(canonical, host);
          if (!existsSync(hostPath)) continue;
          if (!within(root, realpathSync(hostPath))) { coverage.skipped.push({ path: hostPath, reason: "Symlink leaves scan root" }); continue; }
          for (const entry of readdirSync(hostPath)) {
            if (host === ".claude" ? entry === "worktrees" : entry.startsWith("worktrees")) walk(join(hostPath, entry), root, 0, "host-location");
          }
        }
        return;
      }
      const children = entries.filter(entry => !SKIP.has(entry.name) && (entry.isDirectory() || entry.isSymbolicLink()));
      if (depth >= depthLimit) { if (children.length) coverage.truncated = true; return; }
      for (const entry of children) walk(join(canonical, entry.name), root, depth + 1, source);
    } catch (error) {
      coverage.skipped.push({ path, reason: error instanceof Error && "code" in error ? String(error.code) : "Unreadable directory" });
    }
  }
  for (const root of roots) walk(root, root, 0, "root-scan");
  for (const prefix of Object.values(config.host_worktree_dirs ?? {})) {
    const root = projectPath(prefix);
    if (existsSync(root)) walk(root, root, 0, "host-location");
  }
  for (const path of registered) walk(path, path, 0, "registered");
  for (const clone of options.known ?? []) {
    for (const checkout of clone.checkouts) {
      if (!existsSync(checkout.path) || projectExcluded(checkout.path, excluded, roots)) continue;
      if (lstatSync(checkout.path).isSymbolicLink()) { coverage.skipped.push({ path: checkout.path, reason: "Indexed checkout was replaced by a symlink" }); continue; }
      const source = clone.sources.includes("ggh-clone") ? "ggh-clone" : "worktree-list";
      if (found.has(checkout.path)) add(checkout.path, source);
      else walk(checkout.path, checkout.path, 0, source);
    }
  }
  const knownPaths = new Map((options.known ?? []).flatMap(clone => clone.checkouts.map(checkout => [checkout.path, { commonDir: clone.commonDir, bare: checkout.bare }] as const)));
  const groups = new Map<string, { path: string; sources: Set<DiscoverySource> }>();
  await projectPool([...found], async ([path, sources]) => {
    try {
      const known = knownPaths.get(path);
      let commonDir: string;
      if (known) {
        const gitDir = realpathSync(checkoutGitDir(path, known.bare));
        const pointer = join(gitDir, "commondir");
        const current = existsSync(pointer) ? realpathSync(resolve(gitDir, gitLine(readFileSync(pointer, "utf8")))) : gitDir;
        commonDir = current === known.commonDir ? current : realpathSync(gitLine((await projectGit(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout));
      } else commonDir = realpathSync(gitLine((await projectGit(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout));
      if (!registered.has(path) && commonDir.replaceAll(sep, "/").includes("/.git/modules/")) return;
      const existing = groups.get(commonDir);
      if (existing) { for (const source of sources) existing.sources.add(source); }
      else groups.set(commonDir, { path, sources });
    } catch {
      coverage.skipped.push({ path, reason: "Broken checkout: cannot resolve Git common directory" });
    }
  }, options.workers);
  const now = new Date().toISOString();
  const clones = await projectPool([...groups], async ([commonDir, group]): Promise<IndexedClone | null> => {
    try {
      const [trees, local] = await Promise.all([
        worktreeList(group.path, { ...inventoryGitOptions, timeoutMs: 3000 }),
        projectGit(group.path, ["config", "--local", "--null", "--list"]),
      ]);
      const fields = local.stdout.split("\0").map(field => { const n = field.indexOf("\n"); return [field.slice(0, n), field.slice(n + 1)] as const; });
      const created = fields.some(([key, value]) => key === "ggh.created" && value === "true");
      if (created) group.sources.add("ggh-clone");
      const remotes = fields.flatMap(([key, url]) => {
        const name = /^remote\.(.+)\.url$/.exec(key)?.[1];
        return name ? [{ name, url: redactRemoteUrl(url), repo: remoteIdentity(url) }] : [];
      });
      const checkouts: Checkout[] = [];
      for (const tree of trees) {
        const path = projectPath(tree.path);
        if (projectExcluded(path, excluded, roots)) continue;
        const createdBy = checkoutCreator(path, config, created);
        let gitDir: string;
        try { gitDir = checkoutGitDir(path, tree.isBare); }
        catch { gitDir = prunableGitDir(path, commonDir); }
        checkouts.push({
          path, gitDir, branch: tree.branch, head: /^0+$/.test(tree.head) || !tree.head ? null : tree.head,
          bare: tree.isBare, locked: tree.locked ? { reason: tree.lockReason ?? "" } : null,
          prunable: tree.prunable ? { reason: tree.pruneReason ?? "" } : null, createdBy,
          hostClaims: createdBy !== "ggh" && createdBy !== "unknown" ? [{ host: createdBy, evidence: `Worktree path: ${path}` }] : [],
        });
      }
      group.sources.add("worktree-list");
      return { commonDir, displayName: basename(basename(commonDir) === ".git" ? dirname(commonDir) : commonDir), remotes, primary: remotes.find(remote => remote.name === "origin")?.repo ?? remotes.find(remote => remote.repo)?.repo ?? null, checkouts, sources: [...group.sources], lastSeen: now };
    } catch {
      coverage.skipped.push({ path: group.path, reason: "Cannot read clone metadata" });
      return null;
    }
  }, options.workers);
  return { clones: clones.filter((clone): clone is IndexedClone => clone !== null && clone.checkouts.length > 0), coverage };
}
