import { getConfig } from "../config.ts";
import { acquireProcessLock } from "../process-lock.ts";
import { startOperation, updateOperation, type StepState } from "../operations.ts";
import { ExecError, run } from "../../utils/exec.ts";
import { inventoryGitOptions, projectLockPath, projectNetworkOptions } from "./git.ts";
import { checkoutFileState, classifyTidyClone, directoryIdentity, remoteOwnership, tidyDigest, tidySnapshot, type TidyAction, type TidyPlan } from "./tidy-plan.ts";
import type { Clone } from "./types.ts";

export interface TidyOutcome { id: string; kind: TidyAction["kind"]; commonDir: string; state: "completed" | "skipped" | "refused" | "failed" | "uncertain"; reason: string; operationId: string }
export function assertTidyApproval(provided: string, plan: TidyPlan): void {
  if (!/^[a-f0-9]{64}$/.test(provided) || provided !== plan.snapshotId || tidySnapshot(plan) !== plan.snapshotId) throw new Error("Tidy snapshot does not match --approve-plan. Review a fresh --dry-run and approve its snapshotId.");
}
export const tidyLockPath = projectLockPath;
async function effect(action: TidyAction): Promise<void> {
  const cwd = action.proof.commonDir;
  const options = { ...inventoryGitOptions, cwd, timeoutMs: 30000 };
  switch (action.kind) {
    case "delete-local-branch":
      // update-ref supplies an atomic expected-old-OID check. No branch -D race.
      await run("git", ["-c", "core.hooksPath=", "update-ref", "--no-deref", "-d", `refs/heads/${action.branch}`, action.tip], options);
      return;
    case "delete-remote-branch": {
      const owned = await remoteOwnership(cwd, action.branch);
      if (!owned || owned.destination !== action.destination || owned.login !== action.login) throw new Error("Remote ownership or destination changed");
      const networkOptions = { ...projectNetworkOptions, cwd, timeoutMs: 30000 };
      const remote = await run("git", ["ls-remote", "--refs", "--", action.destination, `refs/heads/${action.branch}`], networkOptions);
      if (remote.stdout.trim() !== `${action.tip}\trefs/heads/${action.branch}`) throw new Error("Remote tip changed after preview");
      // Send to the pinned URL, so a concurrent origin URL edit cannot redirect it.
      await run("git", ["-c", "core.hooksPath=", "push", "--no-follow-tags", "--no-mirror", `--force-with-lease=refs/heads/${action.branch}:${action.tip}`, "--", action.destination, `:refs/heads/${action.branch}`], networkOptions);
      return;
    }
    case "remove-checkout":
      if (await checkoutFileState(action.checkout, action.allowIgnored) !== action.fileState) throw new Error("Checkout file state changed after preview");
      await run("git", ["worktree", "remove", "--", action.checkout.path], options);
      return;
    case "prune-worktree-metadata":
      await run("git", ["worktree", "prune", "--verbose", `--expire=${action.expire}`], options);
      return;
  }
}
export async function executeTidyPlan(plan: TidyPlan, clones: readonly Clone[], options: { approvedSnapshot: string; signal?: AbortSignal; config?: ReturnType<typeof getConfig> }): Promise<TidyOutcome[]> {
  assertTidyApproval(options.approvedSnapshot, plan);
  const outcomes: TidyOutcome[] = [];
  const config = options.config ?? getConfig();
  for (const group of plan.clones) {
    if (!group.actions.length) continue;
    const input = clones.find(clone => clone.commonDir === group.commonDir);
    if (!input) throw new Error("Approved clone is missing");
    // Verify before creating any lock or journal in a possibly replaced clone.
    const identity = directoryIdentity(group.commonDir);
    if (group.actions.some(action => action.proof.cloneIdentity !== identity)) throw new Error("Clone directory identity changed after approval");
    const release = await acquireProcessLock(tidyLockPath(group.commonDir), 30000);
    try {
      for (const action of group.actions) {
        const target = action.kind === "remove-checkout" ? action.checkout.path : action.kind === "prune-worktree-metadata" ? action.entries.map(entry => entry.path).join(", ") : action.branch;
        const operation = await startOperation({ command: "tidy", target: JSON.stringify(target).slice(0, 512), revision: plan.snapshotId, steps: [`${action.kind} ${action.id}`], cwd: group.commonDir });
        let state: TidyOutcome["state"] = "refused";
        let message = "Proof changed after approval; review a fresh plan";
        if (options.signal?.aborted) { state = "skipped"; message = "Interrupted before action"; }
        else {
          try {
            const fresh = await classifyTidyClone(input, plan.options, config);
            const current = fresh.actions.find(candidate => candidate.id === action.id);
            if (!current || tidyDigest(current) !== tidyDigest(action)) {
              message = `${message}. ${fresh.kept.map(item => item.reason).join("; ")}`;
            } else if (options.signal?.aborted) { state = "skipped"; message = "Interrupted before effect"; }
            else {
              // Persist an uncertain step before starting a subprocess. Process death
              // must never leave a journal that implies the action did not start.
              await updateOperation(operation.id, { steps: [{ name: `${action.kind} ${action.id}`, state: "uncertain" }] }, group.commonDir);
              try { await effect(action); state = "completed"; message = "Approved effect completed"; }
              catch (error) {
                message = error instanceof Error ? error.message : "Effect failed";
                state = /authentication failed|permission denied|could not read (?:username|password)|terminal prompts disabled|publickey/i.test(message) ? "refused" : /changed after preview|ownership or destination changed|Ignored files present/.test(message) ? "refused" : /timed out|signal|killed/i.test(message) || (error instanceof ExecError && error.exitCode >= 128) || action.kind === "delete-remote-branch" ? "uncertain" : "failed";
              }
            }
          } catch (error) { message = error instanceof Error ? error.message : "Cannot reverify proof"; }
        }
        const step: StepState = state;
        await updateOperation(operation.id, { steps: [{ name: `${action.kind} ${action.id}`, state: step }], status: { state: state === "completed" ? "succeeded" : state === "skipped" ? "cancelled" : state === "refused" ? "needs_input" : state === "uncertain" ? "partially_completed" : "failed" } }, group.commonDir);
        outcomes.push({ id: action.id, kind: action.kind, commonDir: group.commonDir, state, reason: message, operationId: operation.id });
      }
    } finally { await release(); }
  }
  return outcomes;
}
