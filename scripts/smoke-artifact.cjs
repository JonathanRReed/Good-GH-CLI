#!/usr/bin/env node
// Verifies an actual distributed executable, not a separately rebuilt copy.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const [file, version] = process.argv.slice(2);
if (!file || !version) throw new Error('Usage: node scripts/smoke-artifact.cjs <binary> <version>');
const executable = path.resolve(file);
const expected = fs.readFileSync(executable + '.sha256', 'utf8').trim().split(/\s+/)[0];
assert.match(expected, /^[a-f0-9]{64}$/);
assert.equal(createHash('sha256').update(fs.readFileSync(executable)).digest('hex'), expected, 'artifact checksum mismatch');
if (process.platform !== 'win32') fs.chmodSync(executable, 0o755);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ggh-artifact-'));
try {
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const alias = path.join(bin, process.platform === 'win32' ? 'ggh.exe' : 'ggh');
  if (process.platform === 'win32') fs.copyFileSync(executable, alias);
  else fs.symlinkSync(executable, alias);
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'),
    GGH_NO_PLUGINS: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'empty.gitconfig'),
    GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' };
  const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, env, encoding: 'utf8', timeout: 30000,
    stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  assert.equal(run(executable, ['--version']), version);
  assert.match(run(executable, ['--help']), /Usage:/);
  run('git', ['init', '-b', 'main']);
  run('git', ['config', 'user.name', 'Artifact test']);
  run('git', ['config', 'user.email', 'artifact@example.invalid']);
  fs.writeFileSync(path.join(root, 'test.txt'), 'safe staged text\n');
  run('git', ['add', 'test.txt']);
  run(executable, ['c', '-m', 'test: native artifact commit', '-y']);
  assert.equal(run('git', ['log', '-1', '--format=%s']), 'test: native artifact commit');
  run(executable, ['hook', 'install', 'pre-commit', '-y']);
  fs.appendFileSync(path.join(root, 'test.txt'), 'another safe change\n');
  run('git', ['add', 'test.txt']);
  run('git', ['commit', '-m', 'test: installed hook']);
  assert.equal(run('git', ['rev-list', '--count', 'HEAD']), '2');
  console.log(`Verified ${path.basename(executable)} ${version}: checksum, startup, native commit, installed hook.`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
