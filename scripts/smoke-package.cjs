#!/usr/bin/env node
// Verifies the launchers from an installed npm tarball in isolated profile paths.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const [file, version, resultsFile] = process.argv.slice(2);
if (!file || !version) {
  throw new Error('Usage: node scripts/smoke-package.cjs <installed-launcher> <version> [results-json]');
}

const launcher = fs.realpathSync(path.resolve(file));
const launcherSha256 = createHash('sha256').update(fs.readFileSync(launcher)).digest('hex');
const findPackage = start => {
  let directory = path.dirname(start);
  while (directory !== path.dirname(directory)) {
    const manifest = path.join(directory, 'package.json');
    if (fs.existsSync(manifest)) {
      const data = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (data.name === 'good-gh-cli') return { data, root: directory };
    }
    directory = path.dirname(directory);
  }
  throw new Error(`Could not locate the installed good-gh-cli package for ${launcher}`);
};
const installedPackage = findPackage(launcher);
assert.equal(installedPackage.data.version, version, 'installed tarball package version mismatch');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ggh-package smoke-é-'));
const profile = path.join(root, 'simulated profile-é');
const results = {
  probe: 'installed-package-clean-install',
  timestamp: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  profilePath: 'simulated Unicode profile path, not an actual OS account',
  version,
  artifactSha256: { installedLauncher: launcherSha256 },
  packageRoot: installedPackage.root,
  stages: {},
};
const stage = (name, action) => {
  try {
    const detail = action();
    results.stages[name] = { status: 'passed', ...(detail === undefined ? {} : { detail }) };
    return detail;
  } catch (error) {
    results.stages[name] = { status: 'failed', error: error.message };
    throw error;
  }
};

try {
  fs.mkdirSync(profile, { recursive: true });
  const env = {
    ...process.env,
    HOME: profile,
    USERPROFILE: profile,
    APPDATA: path.join(profile, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(profile, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(profile, 'config'),
    XDG_CACHE_HOME: path.join(profile, 'cache'),
    XDG_DATA_HOME: path.join(profile, 'data'),
    XDG_STATE_HOME: path.join(profile, 'state'),
    GGH_NO_PLUGINS: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(profile, 'empty.gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
    NO_COLOR: '1',
  };
  const run = (command, args) => execFileSync(command, args, {
    cwd: root, env, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  stage('installed-package-provenance', () => {
    assert.equal(createHash('sha256').update(fs.readFileSync(launcher)).digest('hex'), launcherSha256);
    assert.equal(JSON.parse(fs.readFileSync(path.join(installedPackage.root, 'package.json'), 'utf8')).version, version);
    return { version, launcherSha256 };
  });
  run('git', ['init', '-b', 'main']);
  run('git', ['config', 'user.name', 'Package fixture']);
  run('git', ['config', 'user.email', 'fixture@example.invalid']);
  for (const runtime of ['node', 'bun']) {
    stage(`${runtime}-launcher-and-local-commit`, () => {
      assert.equal(run(runtime, [launcher, '--version']), version);
      assert.match(run(runtime, [launcher, '--help']), /Usage:/);
      const schema = JSON.parse(run(runtime, [launcher, 'agent', 'schema']));
      assert.equal(schema.envelope.properties.contract.const, 'ggh.agent');
      fs.writeFileSync(path.join(root, 'file.txt'), runtime + '\n');
      const subject = `test: ${runtime} installed package`;
      const report = JSON.parse(run(runtime, [launcher, 'commit', '-a', '-m', subject, '--agent']));
      assert.equal(report.contract, 'ggh.agent');
      assert.equal(report.status, 'succeeded');
      assert.equal(report.result.revision, run('git', ['rev-parse', 'HEAD']));
      assert.equal(run('git', ['log', '-1', '--format=%s']), subject);
      assert.equal(run('git', ['status', '--porcelain']), '');
      return { version, agentContract: 'ggh.agent v1', commit: subject };
    });
  }
  stage('node-launcher-project-autoload-isolation', () => run(process.execPath, [path.join(__dirname, 'smoke-launcher-isolation.cjs'), process.execPath, launcher]));
  console.log(`Verified installed package ${version}: Node and Bun launchers, agent JSON, and local commits.`);
} catch (error) {
  results.status = 'failed';
  results.error = error.message;
  throw error;
} finally {
  results.status ||= 'passed';
  results.timestamp = new Date().toISOString();
  if (resultsFile) fs.writeFileSync(path.resolve(resultsFile), JSON.stringify(results, null, 2) + '\n');
  fs.rmSync(root, { recursive: true, force: true });
}
