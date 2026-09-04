import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

describe("npm launcher", () => {
  it("never invokes Bun through a shell on Windows", () => {
    const source = readFileSync(join(import.meta.dir, "..", "bin", "ggh.cjs"), "utf-8");
    const calls: Array<{ command: string; args: string[]; options: { shell?: boolean } }> = [];
    const exit = new Error("exit");

    expect(() =>
      runInNewContext(source, {
        __dirname: "/package/bin",
        Bun: undefined,
        console: { error() {} },
        process: {
          argv: ["node", "ggh", "status", "& calc.exe"],
          platform: "win32",
          exit() {
            throw exit;
          },
          kill() {},
          pid: 123,
        },
        require(id: string) {
          if (id === "node:fs") return { existsSync: () => true };
          if (id === "node:path") return { join: (...parts: string[]) => parts.join("/") };
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
    expect(calls.every((call) => call.options.shell === false)).toBe(true);
    expect(calls[1]?.args.slice(-2)).toEqual(["status", "& calc.exe"]);
  });
});
