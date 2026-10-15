import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "..", "src", "index.ts");

export interface FixtureResponse {
  prefix: string[];
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function stopFixtureProcessTree(child: Bun.Subprocess): Promise<void> {
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (systemRoot) {
      try {
        const killer = Bun.spawn([join(systemRoot, "System32", "taskkill.exe"), "/PID", String(child.pid), "/T", "/F"], {
          stdin: "ignore", stdout: "ignore", stderr: "ignore",
        });
        const stopped = await Promise.race([killer.exited, delay(2_000).then(() => undefined)]);
        if (stopped === 0) {
          await child.exited;
          return;
        }
        killer.kill("SIGKILL");
      } catch {
        // Fall through to the direct child if taskkill is unavailable.
      }
    }
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
      await child.exited;
      return;
    } catch {
      // Bun may not start this child in its own process group.
    }
  }

  try { child.kill("SIGKILL"); } catch { /* The fixture already exited. */ }
  await child.exited;
}

export async function runFixture(
  args: string[],
  options: { root: string; cwd?: string; responses?: FixtureResponse[]; invoke?: string; config?: Record<string, unknown> },
): Promise<{ stdout: string; stderr: string; exitCode: number; calls: string[][]; providerCalls: string[][]; inputs: Array<{ args: string[]; text: string }> }> {
  const runRoot = mkdtempSync(join(options.root, "run-"));
  const trace = join(runRoot, "gh-calls.jsonl");
  const providerTrace = join(runRoot, "provider-calls.jsonl");
  const inputTrace = join(runRoot, "gh-inputs.jsonl");
  if (options.config) {
    mkdirSync(join(runRoot, "good-gh"), { recursive: true });
    writeFileSync(join(runRoot, "good-gh", "config.json"), JSON.stringify(options.config));
  }
  const responses = options.responses ?? [];
  const script = `
    const { appendFileSync } = await import('node:fs');
    const spawn = Bun.spawn.bind(Bun);
    const responses = ${JSON.stringify(responses)};
    Bun.spawn = (argv, options) => {
      if (['codex','claude','grok','ollama'].includes(argv[0])) {
        appendFileSync(${JSON.stringify(providerTrace)}, JSON.stringify(argv) + '\\n');
        return {pid:0,stdout:new Blob([]).stream(),stderr:new Blob(['Provider access denied by fixture']).stream(),exited:Promise.resolve(99),kill(){},stdin:null};
      }
      if (argv[0] !== 'gh') return spawn(argv, options);
      appendFileSync(${JSON.stringify(trace)}, JSON.stringify(argv.slice(1)) + '\\n');
      const response = responses.find(r => r.prefix.every((value, index) => argv[index + 1] === value));
      const auth = argv[1] === 'auth' && argv[2] === 'status';
      const stdout = response?.stdout ?? (auth ? JSON.stringify({hosts:{'github.com':[{active:true,state:'success',login:'fixture',host:'github.com'}]}}) : '');
      const stderr = response?.stderr ?? (auth || response ? '' : 'Unexpected fixture gh call: ' + argv.slice(1).join(' '));
      const exitCode = response?.exitCode ?? (auth || response ? 0 : 99);
      if (options?.stdout === 'inherit' && stdout) process.stdout.write(stdout);
      if (options?.stderr === 'inherit' && stderr) process.stderr.write(stderr);
      let text = '';
      return {pid:0, stdout:new Blob([stdout]).stream(), stderr:new Blob([stderr]).stream(), exited:Promise.resolve(exitCode), kill(){}, stdin: options?.stdin !== 'pipe' ? null : {write(chunk){text += String(chunk)},async flush(){},async end(){appendFileSync(${JSON.stringify(inputTrace)},JSON.stringify({args:argv.slice(1),text})+'\\n')}}};
    };
    ${options.invoke ? "" : `const { runCli } = await import(${JSON.stringify(entry)});`}
    try { ${options.invoke ?? `await runCli(['bun', 'ggh', ...${JSON.stringify(args)}]);`} }
    catch (error) {
      const { fail } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "utils", "ui.ts"))});
      const { finalizeJsonOutput } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "utils", "output.ts"))});
      fail(error.message);
      finalizeJsonOutput();
    }
  `;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GH_|GITHUB_|GGH_|GIT_)/.test(key)));
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: options.cwd ?? options.root,
    detached: process.platform !== "win32",
    env: { ...env, HOME: runRoot, XDG_CONFIG_HOME: runRoot, GGH_NO_PLUGINS: "1", GIT_CONFIG_NOSYSTEM: "1", NO_COLOR: "1" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const completed = Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    const outcome = await Promise.race([
      completed.then((result) => ({ kind: "completed" as const, result })),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), 10_000);
      }),
    ]);
    if (outcome.kind === "timeout") {
      await stopFixtureProcessTree(child);
      const captured = await Promise.race([completed, delay(1_000).then(() => undefined)]);
      const detail = captured
        ? ` stdout=${JSON.stringify(captured[0])} stderr=${JSON.stringify(captured[1])} exit=${captured[2]}`
        : " stdout/stderr did not close after the child tree exited";
      throw new Error(`CLI fixture timed out after 10000ms (pid ${child.pid}).${detail}`);
    }
    const [stdout, stderr, exitCode] = outcome.result;
    let calls: string[][] = [];
    if (existsSync(trace)) calls = readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    const providerCalls: string[][] = existsSync(providerTrace) ? readFileSync(providerTrace, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    const inputs: Array<{ args: string[]; text: string }> = existsSync(inputTrace) ? readFileSync(inputTrace, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    return { stdout, stderr, exitCode, calls, providerCalls, inputs };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function fixtureRoot(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}
