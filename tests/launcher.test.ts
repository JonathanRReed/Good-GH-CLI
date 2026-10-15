import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { runInNewContext } from "node:vm";

describe("npm launcher", () => {
  it("never invokes Bun through a shell on Windows", () => {
    const source = readFileSync(join(import.meta.dir, "..", "bin", "ggh.cjs"), "utf-8");
    const calls: Array<{ command: string; args: string[]; options: { shell?: boolean } }> = [];
    const exit = new Error("exit");

    expect(() =>
      runInNewContext(source, {
        __dirname: "C:\\package\\bin",
        Bun: undefined,
        console: { error() {} },
        process: {
          argv: ["node", "ggh", "status", "& calc.exe"],
          platform: "win32",
          env: { Path: "C:\\trusted-bun" },
          exit() {
            throw exit;
          },
          kill() {},
          pid: 123,
        },
        require(id: string) {
          if (id === "node:fs") return {
            constants: { X_OK: 1 }, existsSync: () => true,
            accessSync: (candidate: string) => { expect(candidate).toBe("C:\\trusted-bun\\bun.exe"); },
            statSync: () => ({ isFile: () => true }),
          };
          if (id === "node:path") return win32;
          if (id === "node:child_process") {
            return {
              spawnSync(command: string, args: string[], options: { shell?: boolean }) {
                calls.push({ command, args, options });
                return { error: undefined, signal: null, status: 0 };
              },
            };
          }
          throw new Error(`Unexpected require: ${id}`);
        },
      }),
    ).toThrow(exit);

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.command)).toEqual(["C:\\trusted-bun\\bun.exe", "C:\\trusted-bun\\bun.exe"]);
    expect(calls.every((call) => call.options.shell === false)).toBe(true);
    expect(calls[1]?.args.slice(0, 2)).toEqual(["--no-env-file", "--config=C:\\package\\bin\\bunfig.toml"]);
    expect(calls[1]?.args.slice(-2)).toEqual(["status", "& calc.exe"]);
  });
});
