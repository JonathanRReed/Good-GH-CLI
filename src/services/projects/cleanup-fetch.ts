import { startOperation, updateOperation } from "../operations.ts";
import { acquireProcessLock } from "../process-lock.ts";
import { projectGit, projectLockPath, safeTrackingFetch } from "./git.ts";
import type { Clone } from "./types.ts";

/** Shared local lock, timeout and uncertainty journal for explicit cleanup fetches. */
export async function fetchCleanupClones(clones: readonly Clone[], command: "tidy" | "lost", signal: AbortSignal): Promise<void> {
  for (const clone of clones) {
    if (signal.aborted) break;
    const release = await acquireProcessLock(projectLockPath(clone.commonDir), 30000);
    try {
      if (signal.aborted) break;
      const operation = await startOperation({ command: `${command} fetch`, steps: ["fetch"], cwd: clone.commonDir });
      await updateOperation(operation.id, { steps: [{ name: "fetch", state: "uncertain" }] }, clone.commonDir);
      try {
        const deadline = Date.now() + 30000;
        const remotes = (await projectGit(clone.commonDir, ["remote"], deadline)).stdout.split(/\r?\n/).filter(Boolean);
        for (const remote of remotes) {
          if (signal.aborted) throw new Error("Cleanup fetch cancelled");
          await safeTrackingFetch(clone.commonDir, remote, deadline);
        }
        await updateOperation(operation.id, { steps: [{ name: "fetch", state: "completed" }], status: { state: "succeeded" } }, clone.commonDir);
      } catch (error) {
        await updateOperation(operation.id, { steps: [{ name: "fetch", state: "uncertain" }], status: { state: "partially_completed" } }, clone.commonDir);
        throw error;
      }
    } finally { await release(); }
  }
}
