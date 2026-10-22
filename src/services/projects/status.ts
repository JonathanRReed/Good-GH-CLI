import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { projectGit, projectPool } from "./git.ts";
import type { Checkout, CheckoutStatus, Clone, CloneStatus, CommitSummary, FieldState } from "./types.ts";

function ok<T>(value: T): FieldState<T> { return { state: "ok", value, observedAt: new Date().toISOString() }; }
function unknown<T>(reason: string): FieldState<T> { return { state: "unknown", reason }; }
async function field<T>(read: () => Promise<T>): Promise<FieldState<T>> {
  try { return ok(await read()); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return /timed out|deadline/i.test(message) ? unknown("Status deadline exceeded") : { state: "error", message };
  }
}

export function parseCheckoutStatus(output: string): Pick<CheckoutStatus, "dirty" | "upstream"> {
  const dirty = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
  let name: string | null = null;
  let ahead = 0;
  let behind = 0;
  let hasDrift = false;
  let renameSource = false;
  for (const record of output.split("\0")) {
    if (renameSource) { renameSource = false; continue; }
    if (record.startsWith("# branch.upstream ")) name = record.slice(18);
    const ab = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
    if (ab) { hasDrift = true; ahead = Number(ab[1]); behind = Number(ab[2]); }
    if (record.startsWith("? ")) dirty.untracked++;
    else if (record.startsWith("u ")) dirty.conflicted++;
    else if (record.startsWith("1 ") || record.startsWith("2 ")) {
      const xy = record.slice(2, 4);
      if (xy.charAt(0) !== ".") dirty.staged++;
      if (xy.charAt(1) !== ".") dirty.unstaged++;
      if (record.startsWith("2 ")) renameSource = true;
    }
  }
  return { dirty: ok(dirty), upstream: name && !hasDrift ? unknown(`Upstream ${name} has no remote-tracking tip`) : ok(name ? { name, ahead, behind, fetchedAt: null } : null) };
}

function operation(checkout: Checkout): CheckoutStatus["operation"] {
  try {
    if (!existsSync(checkout.gitDir)) return unknown("Git directory is missing");
    for (const [file, name] of [["rebase-merge", "rebase"], ["rebase-apply", "rebase"], ["MERGE_HEAD", "merge"], ["CHERRY_PICK_HEAD", "cherry-pick"], ["REVERT_HEAD", "revert"], ["BISECT_LOG", "bisect"]] as const) {
      if (existsSync(join(checkout.gitDir, file))) return ok(name);
    }
    return ok(null);
  } catch { return unknown("Cannot inspect Git operation state"); }
}

async function checkoutStatus(checkout: Checkout, commonDir: string, deadlineMs: number): Promise<CheckoutStatus> {
  if (checkout.bare) return { path: checkout.path, dirty: unknown("Bare repository has no working tree"), upstream: unknown("Bare repository has no working tree"), operation: ok(null) };
  if (!existsSync(checkout.path)) return { path: checkout.path, dirty: unknown("Checkout path is missing"), upstream: unknown("Checkout path is missing"), operation: operation(checkout) };
  const deadline = Date.now() + deadlineMs;
  const status = await field(async () => parseCheckoutStatus((await projectGit(checkout.path, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal", "--ignore-submodules=dirty"], deadline)).stdout));
  if (status.state !== "ok") return { path: checkout.path, dirty: status, upstream: status, operation: operation(checkout) };
  const upstream = status.value.upstream;
  if (upstream.state === "ok" && upstream.value) {
    try { upstream.value.fetchedAt = statSync(join(commonDir, "FETCH_HEAD")).mtime.toISOString(); }
    catch { /* No local fetch timestamp is known. */ }
  }
  return { path: checkout.path, ...status.value, operation: operation(checkout) };
}

interface Ref { name: string; oid: string; symbolic: string; committedAt: string; subject: string }
function parseRefs(text: string): Ref[] {
  return text.split("\n").filter(Boolean).map(line => {
    const [name = "", oid = "", symbolic = "", committedAt = "", subject = ""] = line.split("\0");
    return { name, oid, symbolic, committedAt, subject };
  });
}

async function readCloneFields(clone: Clone, options: { deadlineMs?: number }): Promise<Omit<CloneStatus, "checkouts">> {
  const deadline = Date.now() + (options.deadlineMs ?? 3000);
  const cwd = clone.checkouts.find(checkout => existsSync(checkout.path) && !checkout.bare)?.path ?? clone.commonDir;
  const refs = await field(async () => parseRefs((await projectGit(cwd, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)%00%(committerdate:iso-strict)%00%(subject)", "refs/heads/", "refs/remotes/", "refs/stash"], deadline)).stdout));
  const stashPromise = refs.state === "ok" && !refs.value.some(ref => ref.name === "refs/stash") ? Promise.resolve(ok<string[]>([]))
    : field(async () => (await projectGit(cwd, ["stash", "list", "--format=%s"], deadline)).stdout.split("\n").filter(Boolean));
  const unpublishedPromise: Promise<CloneStatus["unpublished"]> = refs.state === "ok" ? field(async () => {
    const targets = refs.value.filter(ref => ref.name.startsWith("refs/heads/")).map(ref => ({ ref: ref.name, target: ref.oid }));
    for (const checkout of clone.checkouts) if (!checkout.branch && checkout.head) targets.push({ ref: checkout.head, target: checkout.head });
    const unique = [...new Map(targets.map(target => [target.ref, target])).values()];
    if (!unique.length) return [];
    const graph = (await projectGit(cwd, ["rev-list", "--topo-order", "--parents", ...new Set(unique.map(target => target.target)), "--not", "--remotes", "--"], deadline)).stdout;
    return countUnpublished(unique, graph);
  }) : Promise.resolve(refs);
  const remoteDefault = refs.state === "ok" ? refs.value.find(ref => ref.name === "refs/remotes/origin/HEAD" && ref.symbolic)?.symbolic
    ?? refs.value.find(ref => ref.name.startsWith("refs/remotes/") && ref.name.endsWith("/HEAD") && ref.symbolic)?.symbolic : undefined;
  const mergedPromise: Promise<CloneStatus["mergedBranches"]> = refs.state !== "ok" ? Promise.resolve(refs)
    : !remoteDefault ? Promise.resolve(unknown("Remote default branch is unknown; set its remote-tracking HEAD after a fetch"))
      : field(async () => (await projectGit(cwd, ["for-each-ref", `--merged=${remoteDefault}`, "--format=%(refname:short)", "refs/heads/"], deadline)).stdout.split("\n").filter(Boolean));
  const head = clone.checkouts.find(checkout => checkout.head)?.head ?? (refs.state === "ok" ? refs.value.filter(ref => ref.name.startsWith("refs/heads/")).sort((a, b) => b.committedAt.localeCompare(a.committedAt))[0]?.oid : undefined);
  const ref = refs.state === "ok" ? refs.value.find(ref => ref.oid === head) : undefined;
  const lastPromise: Promise<CloneStatus["lastCommit"]> = !head ? Promise.resolve(refs.state === "ok" ? ok(null) : refs)
    : ref ? Promise.resolve(ok({ oid: ref.oid, subject: ref.subject, committedAt: ref.committedAt }))
      : field(async () => parseCommits((await projectGit(cwd, ["log", "-1", "--format=%H%x00%cI%x00%s", head, "--"], deadline)).stdout)[0] ?? null);
  const [stash, unpublished, mergedBranches, lastCommit] = await Promise.all([stashPromise, unpublishedPromise, mergedPromise, lastPromise]);
  return { commonDir: clone.commonDir, unpublished, mergedBranches, lastCommit,
    stashes: stash.state === "ok" ? ok(stash.value.length) : stash,
    newestStash: stash.state === "ok" ? ok(stash.value[0] ?? null) : stash };
}

export function parseCommits(text: string): CommitSummary[] {
  return text.split("\n").filter(Boolean).map(line => { const [oid = "", committedAt = "", subject = ""] = line.split("\0"); return { oid, committedAt, subject }; });
}

// Git emits children before parents. Propagate each tip's membership once through
// the shared graph; excluded remote ancestors never appear and are never counted.
export function countUnpublished(targets: { ref: string; target: string }[], graph: string): { ref: string; commits: number }[] {
  const reachable = new Map<string, bigint>();
  const counts = targets.map(target => ({ ref: target.ref, commits: 0 }));
  targets.forEach((target, i) => reachable.set(target.target, (reachable.get(target.target) ?? 0n) | (1n << BigInt(i))));
  for (const line of graph.split("\n")) {
    if (!line) continue;
    const [oid, ...parents] = line.split(" ");
    if (!oid) continue;
    const mask = reachable.get(oid) ?? 0n;
    reachable.delete(oid);
    for (let i = 0; i < counts.length; i++) {
      const count = counts[i];
      if (count && (mask & (1n << BigInt(i))) !== 0n) count.commits++;
    }
    for (const parent of parents) reachable.set(parent, (reachable.get(parent) ?? 0n) | mask);
  }
  return counts;
}

export async function readCloneStatus(clone: Clone, options: { workers?: number; deadlineMs?: number } = {}): Promise<CloneStatus> {
  const [status] = await readProjectStatuses([clone], options);
  if (!status) throw new Error("Missing clone status");
  return status;
}

export async function readProjectStatuses(clones: readonly Clone[], options: { workers?: number; deadlineMs?: number } = {}): Promise<CloneStatus[]> {
  const [fields, checkouts] = await Promise.all([
    projectPool(clones, clone => readCloneFields(clone, options), options.workers),
    projectPool(clones.flatMap(clone => clone.checkouts.map(checkout => ({ checkout, commonDir: clone.commonDir }))),
      async ({ checkout, commonDir }) => ({ commonDir, status: await checkoutStatus(checkout, commonDir, options.deadlineMs ?? 3000) }), options.workers),
  ]);
  const byClone = new Map<string, CheckoutStatus[]>();
  for (const { commonDir, status } of checkouts) {
    const list = byClone.get(commonDir) ?? [];
    list.push(status); byClone.set(commonDir, list);
  }
  return fields.map(status => ({ ...status, checkouts: byClone.get(status.commonDir) ?? [] }));
}

export async function projectHistory(clone: Clone, status: CloneStatus): Promise<{ recent: FieldState<CommitSummary[]>; unpublished: FieldState<CommitSummary[]> }> {
  const deadline = Date.now() + 3000;
  const head = clone.checkouts.find(checkout => checkout.head)?.head ?? (status.lastCommit.state === "ok" ? status.lastCommit.value?.oid : undefined);
  const refs = status.unpublished.state === "ok" ? status.unpublished.value.filter(ref => ref.commits > 0).map(ref => ref.ref) : [];
  const [recent, unpublished] = await Promise.all([
    head ? field(async () => parseCommits((await projectGit(clone.commonDir, ["log", "-5", "--format=%H%x00%cI%x00%s", head, "--"], deadline)).stdout)) : Promise.resolve(ok<CommitSummary[]>([])),
    refs.length ? field(async () => parseCommits((await projectGit(clone.commonDir, ["log", "-5", "--format=%H%x00%cI%x00%s", ...refs, "--not", "--remotes", "--"], deadline)).stdout)) : Promise.resolve(status.unpublished.state === "ok" ? ok<CommitSummary[]>([]) : status.unpublished),
  ]);
  return { recent, unpublished };
}
