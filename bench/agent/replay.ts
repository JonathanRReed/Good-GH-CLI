import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import manifest from "./fixtures/manifest.json";

export interface ReplayResponse {
  command: "git" | "gh";
  prefix: string[];
  stdout?: string;
  fixture?: string;
  stderr?: string;
  exitCode?: number;
}
export interface ReplaySpec { args: string[]; responses: ReplayResponse[] }

export const fixtureDirectory = join(import.meta.dir, "fixtures");
export function recorded(label: string): string {
  const fixture = manifest.fixtures.find(item => item.label === label);
  if (!fixture) throw new Error(`Unknown fixture: ${label}`);
  const bytes = readFileSync(join(fixtureDirectory, fixture.file));
  const raw = fixture.file.endsWith(".gz") ? gunzipSync(bytes) : bytes;
  if (createHash("sha256").update(raw).digest("hex") !== fixture.sha256) throw new Error(`Fixture checksum mismatch: ${label}`);
  return raw.toString("utf8");
}

export async function replayCli(args: string[], responses: ReplayResponse[]) {
  const root = mkdtempSync(join(tmpdir(), "ggh-agent-replay-"));
  try {
    const spec = join(root, "spec.json");
    writeFileSync(spec, JSON.stringify({ args, responses } satisfies ReplaySpec));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GH_|GITHUB_|GGH_|GIT_|XDG_)/.test(key)));
    const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "replay-child.ts"), spec], {
      cwd: fixtureDirectory,
      env: { ...env, HOME: root, XDG_CONFIG_HOME: root, GGH_NO_PLUGINS: "1", GGH_NO_RECORDS: "1", NO_COLOR: "1" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 15_000);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      const trace: { calls: string[][]; unexpected: string[][] } = JSON.parse(readFileSync(`${spec}.trace`, "utf8"));
      return { stdout, stderr, exitCode, ...trace };
    } finally { clearTimeout(timer); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}
