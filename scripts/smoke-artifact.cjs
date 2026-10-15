#!/usr/bin/env node
// Qualifies exact native artifacts through a private, isolated installation.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const [file, version, previousFile, resultsFile] = process.argv.slice(2);
if (!file || !version) {
  throw new Error('Usage: node scripts/smoke-artifact.cjs <binary> <version> [previous-binary] [results-json]');
}

const executable = path.resolve(file);
const previousExecutable = previousFile ? path.resolve(previousFile) : null;
const hashFile = filePath => createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
const verifyArtifact = filePath => {
  const expected = fs.readFileSync(filePath + '.sha256', 'utf8').trim().split(/\s+/)[0];
  assert.match(expected, /^[a-f0-9]{64}$/, `invalid checksum file for ${filePath}`);
  const actual = hashFile(filePath);
  assert.equal(actual, expected, `artifact checksum mismatch: ${filePath}`);
  return actual;
};

// Validate every supplied artifact before executing either one.
const currentHash = verifyArtifact(executable);
const previousHash = previousExecutable ? verifyArtifact(previousExecutable) : null;
if (previousExecutable) assert.notEqual(previousHash, currentHash, 'current and previous artifacts must differ');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ggh-artifact space-é-'));
const verifiedArtifacts = path.join(root, 'verified artifacts-é');
const prefix = path.join(root, 'private prefix-é');
const bin = path.join(prefix, 'bin');
const installed = path.join(bin, process.platform === 'win32' ? 'ggh.exe' : 'ggh');
const sentinel = path.join(prefix, 'keep this file.txt');
const profile = path.join(root, 'simulated profile-é');
const results = {
  probe: 'native-artifact-clean-install',
  timestamp: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  profilePath: 'simulated Unicode profile path, not an actual OS account',
  versions: { current: version },
  artifactSha256: { current: currentHash },
  stages: {},
};
if (previousExecutable) {
  results.versions.previous = 'unverified';
  results.artifactSha256.previous = previousHash;
}

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
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(verifiedArtifacts, { recursive: true });
  fs.mkdirSync(profile, { recursive: true });
  const currentCopy = path.join(verifiedArtifacts, path.basename(installed));
  fs.copyFileSync(executable, currentCopy);
  if (process.platform !== 'win32') fs.chmodSync(currentCopy, 0o755);
  assert.equal(hashFile(currentCopy), currentHash, 'current verified copy checksum mismatch');
  let previousCopy;
  if (previousExecutable) {
    previousCopy = path.join(verifiedArtifacts, `previous-${path.basename(installed)}`);
    fs.copyFileSync(previousExecutable, previousCopy);
    if (process.platform !== 'win32') fs.chmodSync(previousCopy, 0o755);
    assert.equal(hashFile(previousCopy), previousHash, 'previous verified copy checksum mismatch');
  }
  fs.writeFileSync(sentinel, 'preserve unrelated fixture data\n');
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
    PATH: bin + path.delimiter + (process.env.PATH || ''),
    GGH_NO_PLUGINS: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(profile, 'empty.gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
    NO_COLOR: '1',
  };
  const run = (command, args) => execFileSync(command, args, {
    cwd: root, env, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  const hashInstalled = () => hashFile(installed);
  const assertInstalled = expectedVersion => {
    assert.equal(hashInstalled(), expectedVersion === version ? currentHash : previousHash,
      `installed checksum does not match ${expectedVersion}`);
    assert.equal(run('ggh', ['--version']), expectedVersion, 'PATH-resolved installed version mismatch');
    return { version: expectedVersion, sha256: hashInstalled(), resolvedBy: 'native OS PATH lookup' };
  };
  const installCopy = source => {
    fs.copyFileSync(source, installed);
    if (process.platform !== 'win32') fs.chmodSync(installed, 0o755);
  };

  stage('current-source-version', () => {
    const actual = run(currentCopy, ['--version']);
    assert.equal(actual, version);
    results.versions.current = actual;
  });
  if (previousExecutable) {
    stage('previous-source-version', () => {
      const actual = run(previousCopy, ['--version']);
      assert.notEqual(actual, version, 'previous artifact must have a different version');
      results.versions.previous = actual;
    });
    stage('install-previous', () => {
      installCopy(previousCopy);
      return assertInstalled(results.versions.previous);
    });
    stage('upgrade-current', () => {
      installCopy(currentCopy);
      return assertInstalled(version);
    });
    stage('rollback-previous', () => {
      installCopy(previousCopy);
      return assertInstalled(results.versions.previous);
    });
    stage('restore-current', () => {
      installCopy(currentCopy);
      return assertInstalled(version);
    });
  } else {
    stage('install-current', () => {
      installCopy(currentCopy);
      return assertInstalled(version);
    });
  }

  stage('installed-help-and-agent-contract', () => {
    assert.match(run('ggh', ['--help']), /Usage:/);
    const schema = JSON.parse(run('ggh', ['agent', 'schema']));
    assert.equal(schema.envelope.properties.contract.const, 'ggh.agent');
    return { help: 'passed', agentSchema: 'ggh.agent v1' };
  });
  stage('native-local-commit-and-installed-hook', () => {
    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.name', 'Artifact test']);
    run('git', ['config', 'user.email', 'artifact@example.invalid']);
    fs.writeFileSync(path.join(root, 'test.txt'), 'safe staged text\n');
    run('git', ['add', 'test.txt']);
    run('ggh', ['c', '-m', 'test: native artifact commit', '-y']);
    assert.equal(run('git', ['log', '-1', '--format=%s']), 'test: native artifact commit');
    run('ggh', ['hook', 'install', 'pre-commit', '-y']);
    fs.appendFileSync(path.join(root, 'test.txt'), 'another safe change\n');
    run('git', ['add', 'test.txt']);
    run('git', ['commit', '-m', 'test: installed hook']);
    assert.equal(run('git', ['rev-list', '--count', 'HEAD']), '2');
    return { commits: 2, hook: 'pre-commit' };
  });
  stage('uninstall-fixture-binary', () => {
    fs.rmSync(installed, { force: true });
    assert.equal(fs.existsSync(installed), false);
    assert.throws(() => execFileSync(installed, ['--version'], {
      cwd: root, env, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
    }), 'uninstalled direct path must not launch');
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve unrelated fixture data\n');
    return { directPathLaunch: 'rejected', unrelatedSentinel: 'preserved' };
  });
  console.log(`Verified ${path.basename(executable)} ${version}: clean install, PATH, local commit, hook, uninstall${previousExecutable ? ', upgrade and rollback' : ''}.`);
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
