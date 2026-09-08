import { describe, expect, it } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { version } from "../package.json";

describe.skipIf(process.platform === "win32" || !Bun.which("make"))("Makefile packaging", () => {
  it("installs, runs, and uninstalls the lean CLI under a prefix containing spaces", () => {
    const root = mkdtempSync(join(tmpdir(), "ggh-make-install-"));
    const repo = join(import.meta.dir, "..");
    const prefix = join(root, "install space");
    try {
      for (const dir of ["src", "bin", "dist", "man"]) mkdirSync(join(root, dir));
      for (const file of ["Makefile", "LICENSE", "man/ggh.1"]) copyFileSync(join(repo, file), join(root, file));
      const build = Bun.spawnSync([process.execPath, "build", join(repo, "bin/ggh.ts"), "--target=bun", `--outfile=${join(root, "dist/ggh.js")}`], {
        cwd: repo, stdout: "pipe", stderr: "pipe",
      });
      expect(build.exitCode).toBe(0);
      for (const target of ["install-lean", "uninstall"]) {
        const result = Bun.spawnSync(["make", "-o", "build-lean", "-o", "man", target, `PREFIX=${prefix}`], {
          cwd: root, stdout: "pipe", stderr: "pipe",
          env: { ...process.env, GGH_NO_PLUGINS: "1" },
        });
        expect(result.exitCode).toBe(0);
        const executable = join(prefix, "bin/ggh");
        if (target === "install-lean") {
          const launch = Bun.spawnSync([executable, "--version"], { stdout: "pipe", stderr: "pipe" });
          expect(launch.exitCode).toBe(0);
          expect(launch.stdout.toString().trim()).toBe(version);
        } else {
          expect(existsSync(executable)).toBe(false);
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rebuilds binaries and manuals when nested sources or version inputs change", () => {
    const root = mkdtempSync(join(tmpdir(), "ggh-make-"));
    try {
      copyFileSync(join(import.meta.dir, "..", "Makefile"), join(root, "Makefile"));
      utimesSync(join(root, "Makefile"), 1000000000, 1000000000);
      const inputs = ["bin/ggh.ts", "src/services/git/split.ts", "scripts/man.ts", "package.json", "bun.lock"];
      for (const file of [...inputs, "build/ggh", "man/ggh.1"]) {
        const path = join(root, file);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "");
        utimesSync(path, 1000000000, inputs.includes(file) ? 1000000000 : 1000000100);
      }
      const plan = (target: string, changed?: string) => {
        const result = Bun.spawnSync(["make", "-n", ...(changed ? ["-W", changed] : []), target], {
          cwd: root, stdout: "pipe", stderr: "pipe",
        });
        expect(result.exitCode).toBe(0);
        return result.stdout.toString();
      };
      expect(plan("build")).not.toContain("--compile");
      expect(plan("man")).not.toContain("bun run man");
      for (const input of ["src/services/git/split.ts", "package.json", "bun.lock"]) {
        expect(plan("build", input)).toContain("--compile");
        expect(plan("man", input)).toContain("bun run man");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
