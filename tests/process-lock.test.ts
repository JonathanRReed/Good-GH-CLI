import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireProcessLock, inspectProcessLock, recoverProcessLock } from "../src/services/process-lock.ts";

const roots: string[] = [];
async function lockPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ggh-process-lock-"));
  roots.push(root);
  return join(root, "operation.lock");
}
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe("process ownership locks", () => {
  test("refuses a live writer and preserves its lock until release", async () => {
    const path = await lockPath();
    const release = await acquireProcessLock(path);
    try {
      const ownerFile = (await readdir(path))[0]!;
      const owner = JSON.parse(await readFile(join(path, ownerFile), "utf8"));
      expect(owner.pid).toBe(process.pid);
      expect((await inspectProcessLock(path)).state).toBe("active");
      await expect(acquireProcessLock(path, 0)).rejects.toThrow("active");
      await expect(recoverProcessLock(path, { allowUnknown: true })).rejects.toThrow("active");
      expect(JSON.parse(await readFile(join(path, ownerFile), "utf8"))).toEqual(owner);
      await writeFile(join(path, ownerFile), "");
      expect((await inspectProcessLock(path)).state).toBe("active");
      await expect(recoverProcessLock(path, { allowUnknown: true })).rejects.toThrow("active");
    } finally { await release(); }
    expect(await inspectProcessLock(path)).toEqual({ state: "unlocked" });
  });

  test("recovers after a real writer is terminated without releasing", async () => {
    const path = await lockPath();
    const module = new URL("../src/services/process-lock.ts", import.meta.url).href;
    const child = Bun.spawn([process.execPath, "-e", `const { acquireProcessLock } = await import(process.argv[1]); await acquireProcessLock(process.argv[2]); console.log('locked'); setInterval(() => {}, 1000);`, module, path], { stdout: "pipe", stderr: "pipe" });
    try {
      const ready = await child.stdout.getReader().read();
      expect(new TextDecoder().decode(ready.value)).toContain("locked");
      child.kill("SIGKILL");
      await child.exited;
      expect((await inspectProcessLock(path)).state).toBe("abandoned");
      const attempts = await Promise.allSettled([acquireProcessLock(path, 0), acquireProcessLock(path, 0)]);
      const acquired = attempts.filter((item): item is PromiseFulfilledResult<() => Promise<void>> => item.status === "fulfilled");
      expect(acquired).toHaveLength(1);
      expect(attempts.filter(item => item.status === "rejected")).toHaveLength(1);
      expect((await inspectProcessLock(path)).state).toBe("active");
      await acquired[0]?.value();
      expect(await inspectProcessLock(path)).toEqual({ state: "unlocked" });
    } finally { child.kill(); await child.exited; }
  });

  test("keeps unknown ownership explicit and never deletes a replaced owner's lock", async () => {
    const path = await lockPath();
    await writeFile(path, "legacy lock", { mode: 0o600 });
    expect((await inspectProcessLock(path)).state).toBe("unknown");
    await expect(acquireProcessLock(path, 0)).rejects.toThrow("unknown");
    await expect(recoverProcessLock(path)).rejects.toThrow("unknown");
    await recoverProcessLock(path, { allowUnknown: true });
    await mkdir(path, { mode: 0o700 });
    expect((await inspectProcessLock(path)).state).toBe("unknown");
    await recoverProcessLock(path, { allowUnknown: true });
    const release = await acquireProcessLock(path);
    await rm(path, { recursive: true });
    const releaseNext = await acquireProcessLock(path);
    const nextOwner = (await readdir(path))[0]!;
    const next = await readFile(join(path, nextOwner), "utf8");
    await release();
    expect(await readFile(join(path, nextOwner), "utf8")).toBe(next);
    await releaseNext();
  });
});
