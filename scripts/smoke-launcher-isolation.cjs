#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Usage: node scripts/smoke-launcher-isolation.cjs <command> [launcher args...]');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ggh-launcher isolation-é-'));
try {
  const trusted = path.join(root, 'trusted config');
  const injected = path.join(root, 'injected config');
  const canary = path.join(root, 'preload-ran');
  if (process.platform === 'win32') fs.copyFileSync(process.execPath, path.join(root, 'bun.exe'));
  for (const [directory, enabled] of [[trusted, false], [injected, true]]) {
    fs.mkdirSync(path.join(directory, 'good-gh'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'good-gh', 'config.json'), JSON.stringify({ ai_enabled: enabled }));
  }
  fs.writeFileSync(path.join(root, '.env'), `XDG_CONFIG_HOME=${injected}\nGGH_AI_ENABLED=true\n`);
  fs.writeFileSync(path.join(root, 'preload.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(canary)}, 'ran');\n`);
  fs.writeFileSync(path.join(root, 'bunfig.toml'), 'preload = ["./preload.cjs"]\n');
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: trusted, GGH_NO_PLUGINS: '1', GGH_NO_RECORDS: '1', NO_COLOR: '1' };
  delete env.GGH_AI_ENABLED;
  const run = () => execFileSync(command, [...args, 'config', 'get', 'ai_enabled'], {
    cwd: root, env, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  assert.equal(run(), 'false', 'project dotenv changed trusted user policy');
  assert.equal(fs.existsSync(canary), false, 'project bunfig preload executed');
  env.GGH_AI_ENABLED = 'true';
  assert.equal(run(), 'true', 'explicit caller environment override was lost');
  assert.equal(fs.existsSync(canary), false, 'project bunfig preload executed');
  console.log('Verified launcher ignores project dotenv and bunfig preload, and preserves explicit environment overrides.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
