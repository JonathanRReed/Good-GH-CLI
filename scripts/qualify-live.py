#!/usr/bin/env python3
"""Exercise synthetic GitHub workflows. Remote writes require --execute."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import stat
import shutil
import struct
import subprocess
import time
import urllib.error
import urllib.request
import uuid
import zlib

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('phase', choices=['prepare', 'private', 'public', 'protection', 'inspect', 'cleanup'])
parser.add_argument('--root', type=Path, required=True)
parser.add_argument('--binary', type=Path)
parser.add_argument('--owner')
parser.add_argument('--execute', action='store_true')
args = parser.parse_args()
root = args.root.resolve()
state_path = root / 'state.json'
if args.phase not in ['prepare', 'inspect'] and not args.execute:
    parser.error('Use --execute to authorize this synthetic GitHub phase.')
if not hasattr(os, 'getuid'):
    parser.error('Run this live qualification runner on macOS or Linux.')
root.mkdir(mode=0o700, parents=True, exist_ok=True)
root_info = root.lstat()
if not stat.S_ISDIR(root_info.st_mode) or root_info.st_uid != os.getuid() or root_info.st_mode & 0o077:
    parser.error('The qualification root must be an owned private directory.')
state = json.loads(state_path.read_text()) if state_path.exists() else {}
if state.get('run'):
    if not re.fullmatch(r'[0-9]{8}-[a-f0-9]{8}', state['run']):
        parser.error('Invalid qualification run identity.')
    for kind in ['private', 'public']:
        if state['repositories'][kind]['target'] != f'{state["owner"]}/ggh-qa-{kind}-{state["run"]}':
            parser.error('Repository scope does not match this qualification run.')
user_gh = Path(os.environ.get('GH_CONFIG_DIR') or Path(os.environ.get('XDG_CONFIG_HOME') or Path.home() / '.config') / 'gh').resolve()
env = {key: value for key, value in os.environ.items() if not key.startswith(('GIT_', 'GGH_')) and key != 'GH_REPO'}
# HOME stays intact because macOS gh credentials can depend on the login Keychain.
env.update(GH_CONFIG_DIR=str(user_gh), GH_HOST='github.com', XDG_CONFIG_HOME=str(root / 'config'),
           XDG_CACHE_HOME=str(root / 'cache'), GGH_NO_PLUGINS='1', GIT_CONFIG_NOSYSTEM='1',
           GIT_CONFIG_GLOBAL=str(root / 'gitconfig'), GIT_TERMINAL_PROMPT='0', NO_COLOR='1')

def save():
    temporary = state_path.with_suffix('.tmp')
    temporary.write_text(json.dumps(state, indent=2) + '\n')
    temporary.chmod(0o600)
    temporary.replace(state_path)


def command(argv, cwd=None, allow_failure=False, binary=False):
    process = subprocess.Popen([str(value) for value in argv], cwd=cwd or root, env=env,
                               stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        output, error = process.communicate(timeout=150)
    except subprocess.TimeoutExpired:
        process.terminate()
        try:
            output, error = process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            output, error = process.communicate()
        raise RuntimeError('Qualification command timed out; inspect recorded operation state before retrying.')
    if process.returncode and not allow_failure:
        raise RuntimeError(f'{argv[0]} {argv[1]} failed: {error.decode("utf8", "replace")[:2000]}')
    return process.returncode, output if binary else output.decode('utf8'), error.decode('utf8', 'replace')


def api(endpoint, *flags):
    _, output, _ = command(['gh', 'api', endpoint, *flags])
    return json.loads(output)


def git(repo, *words):
    return command(['git', *words], repo)[1].strip()


def ggh(repo, *words, allow_failure=False):
    code, output, error = command([state['binary'], *words, '--agent'], repo, allow_failure=True)
    report = json.loads(output)
    if report.get('contract') != 'ggh.agent' or report.get('version') != 1:
        raise RuntimeError('The command did not return the supported agent contract.')
    state.setdefault('commands', []).append({'command': list(words), 'exitCode': code,
        'status': report['status'], 'operationId': report.get('operationId'), 'effects': report['effects'], 'error': report.get('error')})
    save()
    if code and not allow_failure:
        raise RuntimeError(f'ggh failed: {report.get("error", {})}; {error[:1000]}')
    return report


def repository(kind):
    target = state['repositories'][kind]['target']
    repo = api('repos/' + target)
    if repo['full_name'].lower() != target.lower():
        raise RuntimeError('Repository name changed. Cleanup will not follow a redirect.')
    previous = state['repositories'][kind].get('id')
    if previous is not None and previous != repo['id']:
        raise RuntimeError('Repository identity changed. Nothing will be cleaned or overwritten.')
    state['repositories'][kind].update(id=repo['id'], url=repo['html_url'], private=repo['private'])
    save()
    return repo


def initialize_repo(kind, feature=False):
    repo = root / kind
    if (repo / '.git').exists():
        return repo
    repo.mkdir()
    git(repo, 'init', '-b', 'main')
    for key, value in [('user.name', 'GGH qualification'), ('user.email', 'fixture@example.invalid'),
                       ('commit.gpgsign', 'false'), ('core.autocrlf', 'false')]:
        git(repo, 'config', key, value)
    (repo / 'README.md').write_text('Synthetic ggh qualification data. No real project content.\n')
    git(repo, 'add', 'README.md')
    git(repo, 'commit', '-m', 'test: synthetic base')
    if feature:
        git(repo, 'switch', '-c', 'qa-feature')
        (repo / 'feature.txt').write_text(state['run'] + '\n')
        git(repo, 'add', 'feature.txt')
        git(repo, 'commit', '-m', 'test: synthetic feature')
    return repo


def inspect_private():
    target = state['repositories']['private']['target']
    media = str(root / 'evidence' / 'private.png')
    pulls = api(f'repos/{target}/pulls?state=all&head={state["owner"]}:qa-feature')
    assert len(pulls) == 1 and pulls[0]['draft'] is True
    assert repository('private')['private'] is True
    urls = re.findall(r'https://github.com/user-attachments/assets/[A-Za-z0-9-]+(?:\?[^)\s"<>]*)?', pulls[0]['body'])
    assert len(urls) == 1, pulls[0]['body']
    try:
        with urllib.request.urlopen(urls[0], timeout=30) as response:
            unauthenticated = response.status
            login_redirect = response.url.startswith('https://github.com/login') and response.headers.get('Content-Type', '').startswith('text/html')
    except urllib.error.HTTPError as error:
        unauthenticated, login_redirect = error.code, False
    assert unauthenticated in [401, 403, 404] or login_redirect, f'Private media was anonymously accessible: {unauthenticated}'
    code, uploaded, _ = command(['gh', 'api', urls[0], '-H', 'Accept: application/octet-stream'], allow_failure=True, binary=True)
    state['privateMedia'] = {'url': urls[0], 'anonymousStatus': unauthenticated,
        'authenticatedBytesMatch': code == 0 and hashlib.sha256(uploaded).digest() == hashlib.sha256(Path(media).read_bytes()).digest()}
    assert state['privateMedia']['authenticatedBytesMatch'], 'Authenticated private media did not match the uploaded image.'
    state['privatePullRequest'] = {'number': pulls[0]['number'], 'url': pulls[0]['html_url']}
    state['privateComplete'] = True


try:
    if args.phase == 'prepare':
        if state:
            raise RuntimeError('This qualification root already has state. Use its recorded next phase.')
        if not args.binary or not args.owner or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]*', args.owner):
            parser.error('prepare requires --binary and a GitHub --owner login.')
        login = api('user')['login']
        if login.lower() != args.owner.lower():
            raise RuntimeError('The active GitHub account does not match the requested owner.')
        run = time.strftime('%Y%m%d') + '-' + uuid.uuid4().hex[:8]
        executable = args.binary.resolve()
        state.update(run=run, owner=login, binary=str(executable), binarySha256=hashlib.sha256(executable.read_bytes()).hexdigest(),
                     repositories={kind: {'target': f'{login}/ggh-qa-{kind}-{run}', 'branches': ['main', 'qa-feature'] if kind == 'private' else ['main']} for kind in ['private', 'public']}, commands=[])
        save()
        helper = '!' + shlex.join([shutil.which('gh'), 'auth', 'git-credential'])
        command(['git', 'config', '--file', root / 'gitconfig', 'credential.https://github.com.helper', ''])
        command(['git', 'config', '--file', root / 'gitconfig', '--add', 'credential.https://github.com.helper', helper])
        evidence = root / 'evidence'
        evidence.mkdir()
        def png_chunk(kind, data):
            return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
        png = b'\x89PNG\r\n\x1a\n' + png_chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)) + png_chunk(b'IDAT', zlib.compress(b'\x00\x44\x88\xcc')) + png_chunk(b'IEND', b'')
        (evidence / 'private.png').write_bytes(png)
        state['prepared'] = True
    else:
        if not state.get('prepared') or api('user')['login'].lower() != state['owner'].lower():
            raise RuntimeError('Prepared state and its active owner are required.')
        if args.phase in ['private', 'public'] and hashlib.sha256(Path(state['binary']).read_bytes()).hexdigest() != state['binarySha256']:
            raise RuntimeError('The qualified executable changed. Start a new qualification root.')
        if args.phase == 'private':
            if state.get('privateComplete'):
                raise RuntimeError('This phase completed already. Do not repeat confirmed uploads.')
            if state.get('privatePublicationStarted'):
                raise RuntimeError('Publication was attempted already. Inspect its operation before retrying; confirmed uploads will not be replayed.')
            repo = initialize_repo('private', feature=True)
            target = state['repositories']['private']['target']
            title = 'Synthetic private recovery ' + state['run']
            body = 'Synthetic body canary ' + state['run'] + '\n\n![Private evidence](../evidence/private.png)'
            media = str(root / 'evidence' / 'private.png')
            words = ['pr', 'create', '--repo-name', target, '--base', 'main', '--title', title,
                     '--body', body, '--no-ai', '--draft', '--attach', media]
            hook = repo / '.git' / 'hooks' / 'pre-push'
            hook.write_text('#!/bin/sh\nwhile read local_ref local_sha remote_ref remote_sha; do\n if [ "$remote_ref" = refs/heads/qa-feature ]; then echo synthetic-head-rejection >&2; exit 1; fi\ndone\n')
            hook.chmod(0o700)
            before = git(repo, 'rev-parse', 'HEAD')
            preview = ggh(repo, *words, '--dry-run')['result']
            state['privatePublicationStarted'] = True
            save()
            first = ggh(repo, *words, '--approve-plan', preview['snapshotId'], allow_failure=True)
            state['privateInterruptedOperation'] = first.get('operationId')
            assert repository('private')['private'] is True
            assert first['status'] == 'partially_completed', first
            assert 'push_base' in first['effects']['completed'] and 'push_head' not in first['effects']['completed']
            assert git(repo, 'rev-parse', 'HEAD') == before
            record = json.loads((repo / '.git' / 'ggh-operations' / (first['operationId'] + '.json')).read_text())
            serialized = json.dumps(record)
            assert body.splitlines()[0] not in serialized and title not in serialized and media not in serialized
            hook.unlink()
            guide = ggh(repo, 'operation', 'recover', first['operationId'])['result']
            assert guide['resumable'] and guide['requiredContent']['pullRequest']
            resumed = ['operation', 'resume', first['operationId'], '--title', title, '--body', body, '--attach', media]
            plan = ggh(repo, *resumed, '--dry-run')['result']
            completed = ggh(repo, *resumed, '--approve-plan', plan['snapshotId'])
            assert completed['status'] == 'succeeded' and git(repo, 'rev-parse', 'HEAD') == before
            retry = ggh(repo, 'operation', 'resume', first['operationId'])
            assert retry['status'] == 'no_op'
            inspect_private()
        elif args.phase == 'public':
            if state.get('publicComplete'):
                raise RuntimeError('This phase completed already.')
            repo = initialize_repo('public')
            words = ['repo', 'create', state['repositories']['public']['target'], '--public', '--push']
            plan = ggh(repo, *words, '--dry-run')['result']
            result = ggh(repo, *words, '--approve-plan', plan['snapshotId'])
            assert result['status'] == 'succeeded' and repository('public')['private'] is False
            state['publicComplete'] = True
        elif args.phase == 'protection':
            target = state['repositories']['public']['target']
            current = repository('public')
            assert current['private'] is False and not current['archived']
            repo = root / 'public'
            before = api(f'repos/{target}/git/ref/heads/main')['object']['sha']
            (repo / 'protected.txt').write_text('Synthetic protected push ' + state['run'] + '\n')
            git(repo, 'add', 'protected.txt')
            git(repo, 'commit', '-m', 'test: synthetic protected push')
            head = git(repo, 'rev-parse', 'HEAD')
            policy = root / 'branch-protection.json'
            policy.write_text(json.dumps({'required_status_checks': None, 'enforce_admins': True,
                'required_pull_request_reviews': {'required_approving_review_count': 1}, 'restrictions': None}))
            api(f'repos/{target}/branches/main/protection', '-X', 'PUT', '--input', str(policy))
            state['protectionEnabled'] = True
            save()
            try:
                words = ['repo', 'create', target, '--public', '--push']
                preview = ggh(repo, *words, '--dry-run')['result']
                rejected = ggh(repo, *words, '--approve-plan', preview['snapshotId'], allow_failure=True)
                assert rejected['status'] == 'failed' and state['commands'][-1]['exitCode'] != 0, rejected
                assert api(f'repos/{target}/git/ref/heads/main')['object']['sha'] == before
                assert git(repo, 'rev-parse', 'HEAD') == head
                state['protectedPush'] = {'rejected': True, 'remoteUnchanged': True, 'localCommitPreserved': True,
                    'operationId': rejected.get('operationId'), 'error': rejected.get('error')}
            finally:
                command(['gh', 'api', f'repos/{target}/branches/main/protection', '-X', 'DELETE'])
                state['protectionEnabled'] = False
                save()
        elif args.phase == 'inspect':
            if state['repositories']['private'].get('id'):
                inspect_private()
            if state['repositories']['public'].get('id'):
                assert repository('public')['private'] is False
        elif args.phase == 'cleanup':
            for kind, info in state['repositories'].items():
                if not info.get('id'):
                    continue
                current = repository(kind)
                if current['archived']:
                    info['archived'] = True
                    continue
                target = info['target']
                branches = api(f'repos/{target}/branches?per_page=100')
                pulls = api(f'repos/{target}/pulls?state=open')
                if any(branch['name'] not in info['branches'] for branch in branches):
                    raise RuntimeError('Unexpected branch; automatic cleanup stopped before writes.')
                if any(state['run'] not in ((pull.get('title') or '') + (pull.get('body') or '')) for pull in pulls):
                    raise RuntimeError('Unexpected pull request; automatic cleanup stopped before writes.')
                for pull in pulls:
                    api(f'repos/{target}/pulls/{pull["number"]}', '-X', 'PATCH', '-f', 'state=closed')
                for branch in branches:
                    name = branch['name']
                    if name != 'main':
                        command(['gh', 'api', f'repos/{target}/git/refs/heads/{name}', '-X', 'DELETE'])
                api(f'repos/{target}', '-X', 'PATCH', '-F', 'archived=true')
                info['archived'] = True
                save()
            state['cleanupComplete'] = True
    state['lastPhase'] = args.phase
    state.pop('error', None)
    save()
    print(json.dumps({'phase': args.phase, 'run': state['run'], 'repositories': state['repositories'], 'state': str(state_path)}))
except Exception as error:
    state['error'] = str(error)
    state['failedPhase'] = args.phase
    save()
    raise
