import { expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

it.skipIf(process.platform === "win32")("bounds optional status probes, kills children, and leaves generation availability fresh", async () => {
  const root = mkdtempSync(join(tmpdir(), "ggh-status-providers-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  mkdirSync(bin);
  mkdirSync(home);
  try {
    for (const id of ["codex", "grok", "ollama"]) {
      writeFileSync(join(bin, id), `#!/bin/sh\necho $$ > "$HOME/${id}.pid"\nexec /bin/sleep 20\n`, { mode: 0o755 });
    }
    writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const script = `
      import { getStatusProviders, getAvailableProviders, refreshProviders } from ${JSON.stringify(resolve("src/services/ai/index.ts"))};
      import { writeFileSync } from "node:fs";
      const start = performance.now();
      const status = await getStatusProviders();
      const elapsedMs = performance.now() - start;
      writeFileSync(${JSON.stringify(join(bin, "codex"))}, '#!/bin/sh\\necho "Logged in using ChatGPT"\\n', { mode: 0o755 });
      writeFileSync(${JSON.stringify(join(bin, "grok"))}, '#!/bin/sh\\nexit 1\\n', { mode: 0o755 });
      writeFileSync(${JSON.stringify(join(bin, "ollama"))}, '#!/bin/sh\\nexit 1\\n', { mode: 0o755 });
      const normal = await getAvailableProviders();
      writeFileSync(${JSON.stringify(join(bin, "codex"))}, '#!/bin/sh\\necho "Not logged in"\\n', { mode: 0o755 });
      const loggedOut = await refreshProviders();
      console.log(JSON.stringify({ elapsedMs, status: status.map(p => p.id), normal: normal.map(p => p.id), loggedOut: loggedOut.map(p => p.id) }));
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, HOME: home, CODEX_HOME: join(home, ".codex"), PATH: `${bin}${delimiter}/usr/bin${delimiter}/bin` },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.elapsedMs).toBeLessThan(5_000);
    expect(result.status).toEqual([]);
    expect(result.normal).toEqual(["codex"]);
    expect(result.loggedOut).toEqual([]);
    for (const id of ["codex", "grok", "ollama"]) {
      const pid = Number(readFileSync(join(home, `${id}.pid`), "utf8").trim());
      expect(() => process.kill(pid, 0)).toThrow();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
