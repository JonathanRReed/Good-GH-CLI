#!/usr/bin/env python3
"""Qualify a native CLI in real POSIX terminals using synthetic local commits."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--binary', required=True, type=Path)
parser.add_argument('--results', required=True, type=Path)
args = parser.parse_args()
binary = args.binary.resolve(strict=True)
git_binary = shutil.which('git')
assert git_binary, 'Git is required.'
results = {'platform': sys.platform, 'binarySha256': hashlib.sha256(binary.read_bytes()).hexdigest(), 'cases': []}


def run_case(name, mode):
    with tempfile.TemporaryDirectory(prefix='ggh terminal ') as temporary:
        root = Path(temporary)
        repo = root / 'repo'
        repo.mkdir()
        home = root / 'home'
        home.mkdir()
        deny = root / 'deny'
        deny.mkdir()
        deny_log = root / 'denied.log'
        shim = '#!' + sys.executable + '\nimport os,sys\nwith open(os.environ["GGH_TERMINAL_DENY"],"a") as f:f.write(sys.argv[0]+"\\n")\nsys.exit(97)\n'
        for command in ['gh', 'codex', 'grok', 'claude', 'ollama']:
            path = deny / command
            path.write_text(shim)
            path.chmod(0o700)
        env = {key: value for key, value in os.environ.items() if not key.startswith(('GIT_', 'GH_', 'GITHUB_', 'GGH_', 'XDG_', 'OLLAMA_', 'CODEX_', 'ANTHROPIC_', 'OPENAI_'))}
        env.update(HOME=str(home), XDG_CONFIG_HOME=str(home / 'config'), XDG_CACHE_HOME=str(home / 'cache'),
                   GH_CONFIG_DIR=str(home / 'gh'), GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=str(home / 'gitconfig'),
                   GGH_NO_PLUGINS='1', GGH_TERMINAL_DENY=str(deny_log), TERM='xterm-256color',
                   PATH=str(deny) + os.pathsep + os.environ['PATH'])

        def git(*words):
            return subprocess.check_output([git_binary, *words], cwd=repo, env=env, stderr=subprocess.PIPE).decode().strip()

        git('init', '-b', 'main')
        for key, value in [('user.name', 'Terminal qualification'), ('user.email', 'terminal@example.invalid'),
                           ('commit.gpgsign', 'false'), ('core.autocrlf', 'false'), ('core.hooksPath', str(root / 'no-hooks'))]:
            git('config', key, value)
        (repo / 'file.txt').write_text('base\n')
        git('add', '.')
        git('commit', '-m', 'base')
        before = git('rev-parse', 'HEAD')
        git('switch', '-c', 'terminal')
        (repo / 'file.txt').write_text('staged terminal change\n')
        git('add', '.')
        master, slave = pty.openpty()
        original = termios.tcgetattr(slave)
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
        child = subprocess.Popen([str(binary), 'commit', '--no-ai', '--yes', '--no-verify'], cwd=repo,
                                 env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        output = b''

        def until(marker):
            nonlocal output
            deadline = time.monotonic() + 15
            while marker not in output:
                if time.monotonic() > deadline or child.poll() is not None:
                    raise AssertionError(f'{name}: prompt {marker!r} unavailable, exit={child.poll()}, output={output[-3000:]!r}')
                if select.select([master], [], [], 0.1)[0]:
                    output += os.read(master, 65536)

        try:
            until(b'Select commit type:')
            os.write(master, b'\r')
            until(b'Enter scope')
            if mode == 'queued':
                fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 12, 28, 0, 0))
                child.send_signal(signal.SIGWINCH)
                os.write(master, 'tty\r\x1b[200~preserve café 🛠\x1b[201~\rqueued body\r'.encode())
            elif mode == 'word-delete':
                os.write(master, b'tty\r')
                until(b'Enter short description')
                os.write(master, b'keep remove\x1b\x7fword\r\r')
            elif mode == 'cancel':
                os.write(master, b'\x03')
            elif mode == 'terminate':
                child.send_signal(signal.SIGTERM)
            elif mode == 'eof':
                os.write(master, b'\x04')
            deadline = time.monotonic() + 15
            while child.poll() is None and time.monotonic() < deadline:
                if select.select([master], [], [], 0.1)[0]:
                    output += os.read(master, 65536)
            if child.poll() is None:
                raise AssertionError(f'{name}: command did not finish: {output[-3000:]!r}')
            code = child.wait()
            assert termios.tcgetattr(slave) == original, f'{name}: terminal settings were not restored'
            # The same terminal must accept another command after completion or cancellation.
            restored = subprocess.run(['/bin/sh', '-c', 'printf terminal-restored'], stdin=slave,
                                      stdout=slave, stderr=slave, env=env, timeout=5)
            assert restored.returncode == 0
            restored_output = b''
            deadline = time.monotonic() + 2
            while b'terminal-restored' not in restored_output and time.monotonic() < deadline:
                if select.select([master], [], [], 0.1)[0]:
                    restored_output += os.read(master, 65536)
            assert b'terminal-restored' in restored_output, f'{name}: terminal was unusable'
            if mode in ['queued', 'word-delete']:
                assert code == 0, output[-3000:].decode(errors='replace')
                expected = 'feat(tty): preserve café 🛠' if mode == 'queued' else 'feat(tty): keep word'
                assert git('log', '-1', '--format=%s') == expected
                if mode == 'queued':
                    assert git('log', '-1', '--format=%b') == 'queued body'
                assert git('rev-list', '--count', f'{before}..HEAD') == '1'
                assert git('status', '--porcelain') == ''
            else:
                assert code == {'cancel': 130, 'terminate': 143, 'eof': 130}[mode], f'{name}: exit {code}, output={output[-1500:]!r}'
                assert git('rev-parse', 'HEAD') == before
                assert git('diff', '--cached', '--', 'file.txt').endswith('+staged terminal change')
            assert not deny_log.exists(), f'{name}: invoked a network/provider client: {deny_log.read_text()}'
            return {'name': name, 'passed': True, 'exitCode': code, 'terminalRestored': True}
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)
            os.close(master)
            os.close(slave)


try:
    for name, mode in [('unicode-paste-typeahead-resize', 'queued'), ('word-delete', 'word-delete'),
                       ('ctrl-c-preserves-index', 'cancel'), ('sigterm-preserves-index', 'terminate'), ('eof-preserves-index', 'eof')]:
        results['cases'].append(run_case(name, mode))
    reader, writer = os.pipe()
    os.close(reader)
    with os.fdopen(writer, 'wb') as closed:
        child = subprocess.run([str(binary), '--help'], stdout=closed, stderr=subprocess.PIPE, timeout=10)
    assert child.returncode == 0, f'Closed stdout exited {child.returncode}'
    results['cases'].append({'name': 'closed-stdout', 'passed': True, 'exitCode': child.returncode})
except Exception as error:
    results['error'] = str(error)
    raise
finally:
    args.results.write_text(json.dumps(results, indent=2) + '\n')
print(json.dumps(results))
