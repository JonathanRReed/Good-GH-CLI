import { describe, expect, it } from "bun:test";
import { run } from "../src/utils/exec.ts";

describe("subprocess contracts", () => {
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
});
