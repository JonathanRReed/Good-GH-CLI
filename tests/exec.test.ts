import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killAllChildren, run } from "../src/utils/exec.ts";
import { resetFlags, setFlags } from "../src/services/runtime.ts";

interface ChildPids {
  parent: number;
  child: number;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readChildPids(path: string): Promise<ChildPids | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as ChildPids;
  } catch {
    return undefined;
  }
}

async function waitForChildPids(path: string): Promise<ChildPids> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const pids = await readChildPids(path);
    if (pids && pids.parent > 0 && pids.child > 0) return pids;
    await delay(20);
  }
  throw new Error("subprocess fixture did not report its child pids");
}

async function cleanupTree(pids: ChildPids | undefined, controllerPid?: number): Promise<void> {
  if (controllerPid && process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (systemRoot) {
      try {
        const killer = Bun.spawn([join(systemRoot, "System32", "taskkill.exe"), "/PID", String(controllerPid), "/T", "/F"], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        });
        await Promise.race([killer.exited, delay(2_000)]);
        killer.kill("SIGKILL");
      } catch {
        // Fall through to direct cleanup.
      }
    }
  } else if (controllerPid) {
    try { process.kill(-controllerPid, "SIGKILL"); } catch { /* Already gone. */ }
  }
  if (!pids) {
    if (controllerPid) {
      try { process.kill(controllerPid, "SIGKILL"); } catch { /* Already gone. */ }
    }
    return;
  }
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (systemRoot) {
      try {
        const killer = Bun.spawn([join(systemRoot, "System32", "taskkill.exe"), "/PID", String(pids.parent), "/T", "/F"], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        });
        await Promise.race([killer.exited, delay(2_000)]);
        killer.kill("SIGKILL");
      } catch {
        // Fall through to direct cleanup if taskkill is unavailable.
      }
    }
  } else {
    try { process.kill(-pids.parent, "SIGKILL"); } catch { /* Already gone. */ }
  }
  for (const pid of [pids.parent, pids.child]) {
    try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
  }
}

async function exerciseTreeTermination(mode: "timeout" | "killAllChildren"): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ggh-exec-tree-"));
  const heartbeatPath = join(directory, "heartbeat.log");
  const pidsPath = join(directory, "pids.json");
  const childScript = "const fs=require('node:fs');const path=process.argv[1];setInterval(()=>{fs.appendFileSync(path,'x');process.stdout.write('beat\\n')},20)";
  const parentScript = [
    "const fs=require('node:fs');const {spawn}=require('node:child_process');",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(childScript)},${JSON.stringify(heartbeatPath)}],{stdio:'inherit'});`,
    `fs.writeFileSync(${JSON.stringify(pidsPath)},JSON.stringify({parent:process.pid,child:child.pid}));`,
    "setInterval(()=>{},1000);",
  ].join("");
  let pids: ChildPids | undefined;
  try {
    const execution = run(process.execPath, ["-e", parentScript], { timeoutMs: mode === "timeout" ? 500 : 0 })
      .then((result) => ({ result }), (error: unknown) => ({ error }));
    pids = await waitForChildPids(pidsPath);
    const heartbeatDeadline = Date.now() + 3_000;
    let heartbeatStarted = false;
    while (Date.now() < heartbeatDeadline) {
      try {
        if ((await readFile(heartbeatPath, "utf8")).length > 0) {
          heartbeatStarted = true;
          break;
        }
      } catch {
        // The child has not written its first heartbeat yet.
      }
      await delay(20);
    }
    expect(heartbeatStarted).toBe(true);
    if (mode === "killAllChildren") await killAllChildren();

    const completion = await Promise.race([
      execution,
      delay(8_000).then(() => undefined),
    ]);
    expect(completion).toBeDefined();
    if (!completion || !("error" in completion)) throw new Error("subprocess termination unexpectedly completed without an error");
    expect(completion.error).toBeInstanceOf(Error);
    if (mode === "timeout") expect((completion.error as Error).message).toContain("timed out");

    const stoppedAt = await readFile(heartbeatPath, "utf8").catch(() => "");
    await delay(150);
    expect(await readFile(heartbeatPath, "utf8").catch(() => "")).toBe(stoppedAt);
  } finally {
    await cleanupTree(pids);
    await rm(directory, { recursive: true, force: true });
  }
}

async function exerciseControllerExitAfterCancellation(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ggh-exec-controller-"));
  const heartbeatPath = join(directory, "heartbeat.log");
  const pidsPath = join(directory, "pids.json");
  const execModule = new URL("../src/utils/exec.ts", import.meta.url).href;
  const childScript = "const fs=require('node:fs');const path=process.argv[1];setInterval(()=>{fs.appendFileSync(path,'x');process.stdout.write('beat\\n')},20)";
  const parentScript = [
    "const fs=require('node:fs');const {spawn}=require('node:child_process');",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(childScript)},${JSON.stringify(heartbeatPath)}],{stdio:'inherit'});`,
    `fs.writeFileSync(${JSON.stringify(pidsPath)},JSON.stringify({parent:process.pid,child:child.pid}));`,
    "setInterval(()=>{},1000);",
  ].join("");
  const controllerScript = [
    `const {run,killAllChildren}=await import(${JSON.stringify(execModule)});`,
    `const execution=run(process.execPath,['-e',${JSON.stringify(parentScript)}],{timeoutMs:0});execution.catch(()=>{});`,
    "const fs=require('node:fs');const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));",
    `while(!fs.existsSync(${JSON.stringify(pidsPath)}))await wait(10);`,
    `while(!fs.existsSync(${JSON.stringify(heartbeatPath)})||!fs.readFileSync(${JSON.stringify(heartbeatPath)}).length)await wait(10);`,
    "await killAllChildren();process.exit(0);",
  ].join("");
  let pids: ChildPids | undefined;
  let controllerPid: number | undefined;
  try {
    const controller = Bun.spawn([process.execPath, "-e", controllerScript], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: process.platform !== "win32",
    });
    controllerPid = controller.pid;
    pids = await waitForChildPids(pidsPath);
    const heartbeatDeadline = Date.now() + 5_000;
    let heartbeatStarted = false;
    while (Date.now() < heartbeatDeadline) {
      try {
        if ((await readFile(heartbeatPath, "utf8")).length > 0) {
          heartbeatStarted = true;
          break;
        }
      } catch {
        // The child has not written its first heartbeat yet.
      }
      await delay(20);
    }
    expect(heartbeatStarted).toBe(true);
    const exitCode = await Promise.race([controller.exited, delay(8_000).then(() => undefined)]);
    expect(exitCode).toBe(0);

    const stoppedAt = await readFile(heartbeatPath, "utf8").catch(() => "");
    await delay(150);
    expect(await readFile(heartbeatPath, "utf8").catch(() => "")).toBe(stoppedAt);
  } finally {
    await cleanupTree(pids, controllerPid);
    await rm(directory, { recursive: true, force: true });
  }
}

describe("subprocess contracts", () => {
  it("captures inherited subprocess output in app JSON mode", async () => {
    resetFlags();
    setFlags({ json: true });
    try {
      const result = await run(process.execPath, ["-e", "console.log('progress');console.error('diagnostic')"], { stdio: "inherit" });
      expect(result.stdout).toBe("progress\n");
      expect(result.stderr).toBe("diagnostic\n");
    } finally { resetFlags(); }
  });
  it("inherits PATH when callers override individual environment keys", async () => {
    const result = await run(process.execPath, ["-e", "console.log(JSON.stringify([process.env.PATH, process.env.GGH_EXEC_TEST]))"], { env: { GGH_EXEC_TEST: "override" } });
    expect(JSON.parse(result.stdout)).toEqual([process.env.PATH, "override"]);
  });
  it("bounds captured output and terminates the child", async () => {
    await expect(run(process.execPath, ["-e", "process.stdout.write('x'.repeat(100000)); setInterval(()=>{},1000)"], { maxOutputBytes: 1024, timeoutMs: 3000 })).rejects.toThrow("output limit");
  });
  it("terminates timed-out processes instead of reporting success", async () => {
    await expect(run(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 30 })).rejects.toThrow("timed out");
  });
  it("stops a grandchild and closes inherited pipes after timeout", async () => {
    await exerciseTreeTermination("timeout");
  });
  it("stops a grandchild and closes inherited pipes when all children are killed", async () => {
    await exerciseTreeTermination("killAllChildren");
  });
  it("awaits tree cancellation before its controller exits", async () => {
    await exerciseControllerExitAfterCancellation();
  });
});
