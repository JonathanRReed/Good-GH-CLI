#!/usr/bin/env python3
"""Black-box regression checks for Good-GH-CLI, audited at 8840f97 / 0.4.0-beta.2.

Run on Linux/macOS with Python 3.10+, Git, and a trusted native ggh executable:
  python3 scripts/audit-regressions.py --binary /absolute/path/to/ggh --results results.json

Assertions describe SAFE/EXPECTED behavior. Failures on the audited version are
intentional defect reproductions, not a replacement for the project's own suite.
All repositories, HOME/config/cache paths, and deletion canaries are temporary.
The PATH is isolated; gh and Ollama are deterministic local mocks. No real GitHub
or model requests are made. The 101 MiB index test uses a temporary sparse file.
This harness is POSIX-only; it is not a Windows compatibility test.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

AUDITED_COMMIT = '8840f9774addb87a0400cd7cd5bf5af1fed65b85'
AUDITED_SHA256 = '4c069b191058745154bd81e3e9e611a7dd7fb296e98ed3f103d17ae4c3852eec'
BIN: Path
GIT: str
COMMANDS: list[dict] = []
MOCK_CALLS: list[dict] = []

GH_MOCK = r'''#!/usr/bin/env python3
import os, sys, json
from pathlib import Path
a=sys.argv[1:]
with open(os.environ['AUDIT_GH_LOG'],'a') as f:
 f.write(json.dumps({'argv':a,'cwd':os.getcwd(),'GH_HOST':os.getenv('GH_HOST'),'GH_REPO':os.getenv('GH_REPO')})+'\n')
if a[:2]==['auth','status']:
 host=os.getenv('GH_HOST','github.com')
 if '--hostname' in a: host=a[a.index('--hostname')+1]
 print(json.dumps({'hosts':{host:[{'active':True,'state':'success','login':os.getenv('AUDIT_ACCOUNT','audit-user'),'host':host,'gitProtocol':'https'}]}}))
elif a[:2] in [['pr','list'],['issue','list']]:
 print(json.dumps([{'number':1,'title':os.getenv('AUDIT_TITLE',Path.cwd().name),'author':{'login':'audit'},'headRefName':'feature','state':'OPEN','url':'https://example.invalid/pull/1'}]))
elif a[:2]==['pr','view']:
 print('no pull requests found',file=sys.stderr);sys.exit(1)
elif a[:2]==['repo','view']:
 print('audit/repository' if '-q' in a else json.dumps({'nameWithOwner':'audit/repository','defaultBranchRef':{'name':'main'}}))
elif a and a[0]=='api':
 print('[]')
else:
 print('AUDIT mock: unexpected gh command '+repr(a),file=sys.stderr);sys.exit(2)
'''
OLLAMA_MOCK = r'''#!/usr/bin/env python3
import sys, os, json
if sys.argv[1:]==['list']:
 print('NAME ID SIZE MODIFIED\nqwen2.5-coder dummy 1GB today')
elif sys.argv[1:2]==['show']:
 print(os.getenv('AUDIT_MODELFILE', 'FROM /local/models/blobs/sha256-'+'a'*64))
elif sys.argv[1:2]==['run']:
 prompt=sys.stdin.read()
 with open(os.environ['AUDIT_AI_LOG'],'a') as f:
  f.write(json.dumps({'argv':sys.argv[1:],'cwd':os.getcwd(),'OLLAMA_HOST':os.getenv('OLLAMA_HOST'),'prompt':prompt})+'\n')
 print(os.environ['AUDIT_PLAN'])
else:
 sys.exit(2)
'''

class Audit(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='ggh-regression-')
        self.root = Path(self.tmp.name)
        self.home = self.root/'home'; self.home.mkdir()
        self.shim = self.root/'bin'; self.shim.mkdir()
        for name,target in [('git',GIT),('python3',sys.executable),('ggh',str(BIN))]:
            (self.shim/name).symlink_to(target)
        for name,text in [('gh',GH_MOCK),('ollama',OLLAMA_MOCK)]:
            p=self.shim/name;p.write_text(text);p.chmod(0o755)
        config=self.home/'.config/good-gh';config.mkdir(parents=True)
        (config/'config.json').write_text(json.dumps({'ai_provider':'ollama','ai_fallback':False,'hosted_ai_consent':False,'first_run_completed':True}))
        self.env = {'HOME':str(self.home),'PATH':str(self.shim),'LANG':'C.UTF-8','TERM':'dumb','NO_COLOR':'1',
                    'GIT_CONFIG_NOSYSTEM':'1','GIT_TERMINAL_PROMPT':'0','GIT_EDITOR':'true',
                    'XDG_CACHE_HOME':str(self.root/'cache'),'XDG_CONFIG_HOME':str(self.home/'.config'),
                    'AUDIT_GH_LOG':str(self.root/'gh.jsonl'),'AUDIT_AI_LOG':str(self.root/'ai.jsonl')}
        self.repo=self.new_repo('repo')

    def tearDown(self):
        for client in ('gh', 'ai'):
            log = self.root / (client + '.jsonl')
            if log.exists():
                for line in log.read_text().splitlines():
                    entry = json.loads(line)
                    prompt = entry.pop('prompt', None)
                    if prompt is not None:
                        entry['prompt_chars'] = len(prompt)
                        entry['prompt_sha256'] = hashlib.sha256(prompt.encode()).hexdigest()
                    MOCK_CALLS.append({'test': self._testMethodName, 'client': client, **entry})
        self.tmp.cleanup()

    def run_cmd(self,args,cwd=None,env=None,input='',timeout=20):
        start=time.monotonic()
        p=subprocess.run([str(a) for a in args],cwd=cwd or self.repo,env={**self.env,**(env or {})},
                         input=input,text=True,capture_output=True,timeout=timeout)
        COMMANDS.append({'test':self._testMethodName,'argv':[str(a) for a in args],
                         'cwd':str(cwd or self.repo),'returncode':p.returncode,
                         'stdout':p.stdout[:6000],'stderr':p.stderr[:6000],
                         'seconds':round(time.monotonic()-start,4)})
        return p

    def git(self,*args,cwd=None,**kwargs):
        return self.run_cmd([GIT,*args],cwd=cwd,**kwargs)

    def ggh(self,*args,cwd=None,**kwargs):
        return self.run_cmd([BIN,*args],cwd=cwd,**kwargs)

    def ok(self,p):
        self.assertEqual(p.returncode,0,p.stderr[-3000:])
        return p

    def new_repo(self,name):
        p=self.root/name;p.mkdir()
        self.ok(self.git('init','-b','main',cwd=p))
        self.ok(self.git('config','user.email','audit@example.invalid',cwd=p))
        self.ok(self.git('config','user.name','Audit',cwd=p))
        (p/'file.txt').write_text('initial\n')
        self.ok(self.git('add','.',cwd=p));self.ok(self.git('commit','-m','initial',cwd=p))
        return p

    def stage_change(self,text='staged version\n'):
        (self.repo/'file.txt').write_text(text);self.ok(self.git('add','file.txt'))

    def feature(self,name='feature'):
        self.ok(self.git('switch','-c',name))

    def split_env(self,extra=False):
        second='untracked.txt' if extra else 'second.txt'
        return {'AUDIT_PLAN':json.dumps({'commits':[
            {'subject':'feat: first','body':'','files':['file.txt']},
            {'subject':'feat: second','body':'','files':[second]}]})}

    def test_31_cache_is_scoped_to_account(self):
        self.ok(self.ggh('pr','--json',env={'AUDIT_ACCOUNT':'one','AUDIT_TITLE':'PRIVATE_ONE'}))
        actual=json.loads(self.ok(self.ggh('pr','--json',env={'AUDIT_ACCOUNT':'two','AUDIT_TITLE':'PRIVATE_TWO'})).stdout)
        self.assertEqual(actual[0]['title'],'PRIVATE_TWO')

    def test_32_cache_is_scoped_to_host(self):
        self.ok(self.ggh('pr','--json',env={'GH_HOST':'github.com','AUDIT_TITLE':'PUBLIC_HOST'}))
        actual=json.loads(self.ok(self.ggh('pr','--json',env={'GH_HOST':'git.example.invalid','AUDIT_TITLE':'ENTERPRISE_HOST'})).stdout)
        self.assertEqual(actual[0]['title'],'ENTERPRISE_HOST')

    def test_33_cache_is_scoped_to_explicit_target(self):
        self.ok(self.ggh('pr','--json','-R','audit/one',env={'AUDIT_TITLE':'TARGET_ONE'}))
        actual=json.loads(self.ok(self.ggh('pr','--json','-R','audit/two',env={'AUDIT_TITLE':'TARGET_TWO'})).stdout)
        self.assertEqual(actual[0]['title'],'TARGET_TWO')

    def test_34_environment_tokens_do_not_share_cache(self):
        self.ok(self.ggh('pr','--json',env={'GH_TOKEN':'synthetic-scope-one','AUDIT_TITLE':'TOKEN_ONE'}))
        actual=json.loads(self.ok(self.ggh('pr','--json',env={'GH_TOKEN':'synthetic-scope-two','AUDIT_TITLE':'TOKEN_TWO'})).stdout)
        self.assertEqual(actual[0]['title'],'TOKEN_TWO')

    def test_35_api_preserves_argument_boundaries(self):
        args=['repos/audit/repo/issues','-X','POST','-f','title=contains spaces','-f','body=slash/value']
        self.ok(self.ggh('api',*args))
        calls=[json.loads(line)['argv'] for line in (self.root/'gh.jsonl').read_text().splitlines()]
        self.assertEqual(calls[-1],['api',*args])

    def test_36_api_dry_run_never_calls_graphql(self):
        self.ok(self.ggh('api','graphql','-f','query=mutation { dummy }','--dry-run'))
        log=self.root/'gh.jsonl'
        self.assertFalse(log.exists() and log.read_text().strip(), 'dry-run spawned GitHub client')

    def test_37_invalid_ai_group_cannot_be_silently_dropped(self):
        self.feature(); self.stage_change()
        plan={'commits':[{'subject':'feat: valid','body':'','files':['file.txt']},{}]}
        before=self.ok(self.git('rev-parse','HEAD')).stdout
        result=self.ggh('c','--split','-y','--provider','ollama',env={'AUDIT_PLAN':json.dumps(plan)})
        self.assertNotEqual(result.returncode,0)
        self.assertEqual(self.ok(self.git('rev-parse','HEAD')).stdout,before)

    def test_38_ollama_remote_host_receives_no_prompt(self):
        self.feature(); self.stage_change()
        result=self.ggh('c','--split','-y','--provider','ollama',env={**self.split_env(),'OLLAMA_HOST':'https://cloud.example.invalid'})
        self.assertNotEqual(result.returncode,0)
        self.assertFalse((self.root/'ai.jsonl').exists(), 'prompt sent to remote endpoint')

    def test_39_ollama_cloud_alias_receives_no_prompt(self):
        self.feature(); self.stage_change()
        result=self.ggh('c','--split','-y','--provider','ollama',env={**self.split_env(),'AUDIT_MODELFILE':'FROM hidden-cloud-model:cloud'})
        self.assertNotEqual(result.returncode,0)
        self.assertFalse((self.root/'ai.jsonl').exists(), 'prompt sent through cloud model alias')

    def test_40_stack_on_rejects_missing_parent(self):
        self.feature()
        result=self.ggh('stack','on','missing-parent')
        self.assertNotEqual(result.returncode,0)
        self.assertNotEqual(self.git('config','--get','branch.feature.gh-merge-base').returncode,0)

    def test_41_stack_on_rejects_cycles(self):
        self.ok(self.git('switch','-c','one'))
        self.ok(self.ggh('stack','on','main'))
        self.ok(self.git('switch','-c','two'))
        self.ok(self.ggh('stack','on','one'))
        self.ok(self.git('switch','one'))
        self.assertNotEqual(self.ggh('stack','on','two').returncode,0)
        self.assertEqual(self.ok(self.git('config','--get','branch.one.gh-merge-base')).stdout.strip(),'main')

    def test_42_claude_is_prompt_only_in_isolated_directory(self):
        self.feature(); self.stage_change()
        script = "#!/usr/bin/env python3\nimport os,sys,json\nfrom pathlib import Path\nPath(os.environ['AUDIT_AI_LOG']).write_text(json.dumps({'argv':sys.argv[1:],'cwd':os.getcwd()}))\nprint(os.environ['AUDIT_PLAN'])\n"
        client=self.shim/'claude'; client.write_text(script); client.chmod(0o755)
        plan={'commits':[{'subject':'feat: staged','body':'','files':['file.txt']}]}
        self.ok(self.ggh('c','--split','-y','--provider','claude',env={'GGH_HOSTED_AI_CONSENT':'true','AUDIT_PLAN':json.dumps(plan)}))
        record=json.loads((self.root/'ai.jsonl').read_text())
        self.assertIn('--safe-mode',record['argv'])
        self.assertEqual(record['argv'][record['argv'].index('--tools')+1],'')
        self.assertEqual(record['argv'][record['argv'].index('--disallowedTools')+1],'*')
        self.assertIn('--strict-mcp-config',record['argv'])
        self.assertNotEqual(Path(record['cwd']), self.repo)
        self.assertFalse(Path(record['cwd']).exists(), 'private provider directory was not cleaned up')

    def test_43_plugin_recovery_mode_does_not_load_plugins(self):
        folder=self.home/'.config/good-gh/plugins'; folder.mkdir(parents=True)
        (folder/'manifest.json').write_text(json.dumps([{'name':'canary','installedAt':'2026-09-04'}]))
        (folder/'canary.ts').write_text('import {writeFileSync} from "node:fs"; writeFileSync(process.env.AUDIT_PLUGIN_CANARY,"loaded"); export function register() {}')
        canary=self.root/'plugin-loaded'
        self.ok(self.ggh('plugin','list','--json',env={'GGH_NO_PLUGINS':'1','AUDIT_PLUGIN_CANARY':str(canary)}))
        self.assertFalse(canary.exists())
        self.ok(self.ggh('plugin','list','--json',env={'GGH_NO_PLUGINS':'0','AUDIT_PLUGIN_CANARY':str(canary)}))
        self.assertTrue(canary.exists())

    def test_01_help_smoke(self):
        self.assertIn('Usage:',self.ok(self.ggh('--help')).stdout)

    def test_02_git_passthrough(self):
        self.assertEqual(self.ok(self.ggh('git','rev-parse','HEAD')).stdout,
                         self.ok(self.git('rev-parse','HEAD')).stdout)

    def test_03_cache_clear_does_not_delete_unrelated_json(self):
        blocker=self.root/'not-a-directory';blocker.write_text('block')
        isolated=self.root/'isolated-tmp';isolated.mkdir()
        canary=isolated/'unrelated.json';canary.write_text('{"not_owned_by_ggh":true}')
        self.ggh('config','cache-clear',env={'XDG_CACHE_HOME':str(blocker),'TMPDIR':str(isolated),'TMP':str(isolated),'TEMP':str(isolated)})
        self.assertTrue(canary.exists(),'cache-clear deleted an unrelated JSON canary')

    def test_04_cache_is_scoped_to_repository(self):
        other=self.new_repo('other')
        first=json.loads(self.ok(self.ggh('pr','--json',env={'AUDIT_TITLE':'REPO_A_PRIVATE'})).stdout)
        second=json.loads(self.ok(self.ggh('pr','--json',cwd=other,env={'AUDIT_TITLE':'REPO_B'})).stdout)
        self.assertEqual(first[0]['title'],'REPO_A_PRIVATE')
        self.assertEqual(second[0]['title'],'REPO_B','repository B received repository A cached data')

    def test_05_default_pre_commit_hook_allows_normal_commit(self):
        self.feature();self.stage_change()
        self.ok(self.ggh('hook','install','pre-commit','-y'))
        self.ok(self.git('commit','-m','fix: normal native commit'))

    def test_06_hook_honors_core_hooks_path(self):
        (self.repo/'.custom-hooks').mkdir()
        self.ok(self.git('config','core.hooksPath','.custom-hooks'))
        self.ok(self.ggh('hook','install','pre-commit','-y'))
        self.assertTrue((self.repo/'.custom-hooks/pre-commit').is_file(),'hook was written to an ignored location')

    def test_07_hook_supports_linked_worktrees(self):
        wt=self.root/'wt';self.ok(self.git('worktree','add','-b','linked',wt))
        self.ok(self.ggh('hook','install','pre-commit','-y',cwd=wt))

    def test_08_ignore_local_supports_linked_worktrees(self):
        wt=self.root/'wt';self.ok(self.git('worktree','add','-b','linked',wt))
        self.ok(self.ggh('ignore','*.audit','--local',cwd=wt))

    def test_09_no_verify_reaches_git(self):
        self.feature();self.stage_change()
        hook=self.repo/'.git/hooks/pre-commit';hook.write_text('#!/bin/sh\necho HOOK_BLOCK >&2\nexit 1\n');hook.chmod(0o755)
        result=self.ggh('c','-m','fix: explicit bypass','-y','--no-verify')
        if result.returncode != 0:
            self.ok(self.git('commit','-m','control bypass','--no-verify'))
        self.ok(result)

    def test_10_local_commit_does_not_require_gh(self):
        (self.shim/'gh').unlink();self.stage_change()
        self.ok(self.ggh('c','-m','fix: local only','-y'))

    def test_11_split_preserves_unstaged_edits(self):
        self.feature();self.stage_change()
        (self.repo/'second.txt').write_text('second staged\n');self.ok(self.git('add','second.txt'))
        (self.repo/'file.txt').write_text('UNSTAGED PRIVATE CANARY\n')
        self.ok(self.ggh('c','--split','-y','--provider','ollama',env=self.split_env()))
        self.assertEqual(self.ok(self.git('show','HEAD:file.txt')).stdout,'staged version\n','split committed the working-tree version instead of the index snapshot')
        self.assertIn('file.txt',self.ok(self.git('status','--porcelain')).stdout)

    def test_12_split_rejects_files_outside_staged_set(self):
        self.feature();self.stage_change();(self.repo/'untracked.txt').write_text('NOT STAGED PRIVATE CANARY\n')
        before=self.ok(self.git('rev-parse','HEAD')).stdout
        self.ggh('c','--split','-y','--provider','ollama',env=self.split_env(extra=True))
        self.git('show','HEAD:untracked.txt')  # Capture committed-canary evidence, even on a broken version.
        self.assertEqual(self.ok(self.git('rev-parse','HEAD')).stdout,before,'invalid AI plan mutated history before being rejected')

    def test_13_no_ai_is_honored_with_split(self):
        self.feature();self.stage_change();(self.repo/'second.txt').write_text('second\n');self.ok(self.git('add','second.txt'))
        self.ggh('c','--split','--no-ai','-y','--provider','ollama',env=self.split_env())
        self.assertFalse((self.root/'ai.jsonl').exists(),'--no-ai still invoked the model client')

    def test_14_large_file_guard_reads_staged_blob(self):
        with (self.repo/'large.dat').open('wb') as f:f.truncate(101*1024*1024)
        self.ok(self.git('add','large.dat',timeout=30));(self.repo/'large.dat').write_text('small working copy\n')
        before=self.ok(self.git('rev-parse','HEAD')).stdout
        self.ggh('c','-m','test: oversized index','-y',timeout=30)
        self.git('cat-file','-s','HEAD:large.dat')  # Capture exact object size for the evidence log.
        self.assertEqual(self.ok(self.git('rev-parse','HEAD')).stdout,before,'a 101 MiB index blob was committed despite the advertised guard')

    def test_15_restack_abort_dry_run_changes_nothing(self):
        self.ok(self.ggh('stack','next','child'));self.stage_change('child conflict\n');self.ok(self.git('commit','-m','child'))
        self.ok(self.git('switch','main'));self.stage_change('main conflict\n');self.ok(self.git('commit','-m','main advance'))
        self.ok(self.git('switch','child'))
        self.assertNotEqual(self.git('rebase','main').returncode,0)
        state=self.repo/'.git/rebase-merge';self.assertTrue(state.exists())
        self.ggh('stack','restack','--abort','--dry-run')
        self.assertTrue(state.exists(),'--dry-run aborted and removed active rebase state')

    def test_16_stack_submit_excludes_root_not_immediate_parent(self):
        for name in ['one','two','three']:
            self.ok(self.ggh('stack','next',name));(self.repo/(name+'.txt')).write_text(name+'\n')
            self.ok(self.git('add','.'));self.ok(self.git('commit','-m',name))
        p=self.ok(self.ggh('stack','submit','--dry-run'));preview=p.stdout+p.stderr
        for edge in ['one → main','two → one','three → two']:
            self.assertIn(edge,preview,'wrong stack submission edges')
        self.assertNotIn('main →',preview,'default branch must never be submitted as a feature PR')

    def test_17_restack_replays_amended_parent_correctly(self):
        self.ok(self.ggh('stack','next','parent'));(self.repo/'parent.txt').write_text('v1\n')
        self.ok(self.git('add','.'));self.ok(self.git('commit','-m','parent'))
        self.ok(self.ggh('stack','next','child'));(self.repo/'child.txt').write_text('child\n')
        self.ok(self.git('add','.'));self.ok(self.git('commit','-m','child'))
        self.ok(self.git('switch','parent'));(self.repo/'parent.txt').write_text('v2\n')
        self.ok(self.git('add','.'));self.ok(self.git('commit','--amend','--no-edit'))
        self.ok(self.ggh('stack','restack','parent','-y'))
        self.assertEqual(self.ok(self.git('show','child:parent.txt')).stdout,'v2\n')
        self.assertEqual(self.ok(self.git('log','--format=%s','main..child')).stdout.splitlines(),['child','parent'])

    def test_18_notifications_includes_gh_api_subcommand(self):
        p=self.ggh('notifications','--json')
        calls=[json.loads(x) for x in (self.root/'gh.jsonl').read_text().splitlines()]
        endpoints=[x['argv'] for x in calls if any('/notifications' in a for a in x['argv'])]
        self.assertTrue(endpoints,'no notifications request observed')
        self.assertEqual(endpoints[0][0],'api','invoked gh ENDPOINT instead of gh api ENDPOINT')
        self.ok(p);self.assertEqual(json.loads(p.stdout),[])

    def test_19_repo_flag_works_outside_a_checkout(self):
        self.ok(self.ggh('pr','--json','-R','audit/remote',cwd=self.root))

    def test_20_config_get_json_is_valid_json(self):
        p=self.ok(self.ggh('config','get','ai_provider','--json'))
        try: value=json.loads(p.stdout)
        except json.JSONDecodeError:self.fail('stdout is not JSON: '+repr(p.stdout))
        self.assertTrue(value is not None)

    def test_21_mcp_rejects_invalid_envelope_without_crashing(self):
        init={'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2024-11-05','capabilities':{},'clientInfo':{'name':'audit','version':'1'}}}
        p=self.ggh('mcp',input='null\n'+json.dumps(init)+'\n')
        self.ok(p)
        self.assertTrue(any(json.loads(x).get('id')==1 for x in p.stdout.splitlines()),'valid request after invalid envelope was not processed')

    def test_22_mcp_advertised_legacy_protocol_supports_ping(self):
        init={'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2024-11-05','capabilities':{},'clientInfo':{'name':'audit','version':'1'}}}
        p=self.ok(self.ggh('mcp',input='\n'.join(map(json.dumps,[init,{'jsonrpc':'2.0','method':'notifications/initialized'},{'jsonrpc':'2.0','method':'ping','id':2}]))+'\n'))
        reply=next(x for x in map(json.loads,p.stdout.splitlines()) if x.get('id')==2)
        self.assertEqual(reply.get('result'),{},'legacy handshake ping returned an error')

    def test_23_config_rejects_numeric_garbage(self):
        self.assertNotEqual(self.ggh('config','set','ai_timeout_ms','5000garbage').returncode,0)

    def test_24_discard_all_preserves_untracked_by_default(self):
        self.stage_change();(self.repo/'private-untracked.txt').write_text('local\n')
        self.ok(self.ggh('discard','--all','-y'))
        self.assertTrue((self.repo/'private-untracked.txt').exists())

    def test_25_split_rejects_duplicate_paths_before_committing(self):
        self.feature();self.stage_change()
        before=self.ok(self.git('rev-parse','HEAD')).stdout
        plan={'commits':[{'subject':'one','body':'','files':['file.txt']},{'subject':'two','body':'','files':['file.txt']}]}
        self.assertNotEqual(self.ggh('c','--split','-y','--provider','ollama',env={'AUDIT_PLAN':json.dumps(plan)}).returncode,0)
        self.assertEqual(self.ok(self.git('rev-parse','HEAD')).stdout,before)

    def test_26_split_rejects_missing_staged_paths(self):
        self.feature();self.stage_change();(self.repo/'second.txt').write_text('second\n');self.ok(self.git('add','second.txt'))
        before=self.ok(self.git('rev-parse','HEAD')).stdout
        plan={'commits':[{'subject':'one','body':'','files':['file.txt']}]}
        self.assertNotEqual(self.ggh('c','--split','-y','--provider','ollama',env={'AUDIT_PLAN':json.dumps(plan)}).returncode,0)
        self.assertEqual(self.ok(self.git('rev-parse','HEAD')).stdout,before)

    def test_27_split_preserves_deletions_and_literal_paths(self):
        self.feature();self.ok(self.git('rm','file.txt'))
        literal=':(glob)*';(self.repo/literal).write_text('staged literal\n')
        self.ok(self.git('--literal-pathspecs','add','--',literal))
        (self.repo/literal).write_text('not staged\n')
        plan={'commits':[{'subject':'remove old','body':'','files':['file.txt']},{'subject':'literal filename','body':'','files':[literal]}]}
        self.ok(self.ggh('c','--split','-y','--provider','ollama',env={'AUDIT_PLAN':json.dumps(plan)}))
        self.assertNotEqual(self.git('cat-file','-e','HEAD:file.txt').returncode,0)
        self.assertEqual(self.ok(self.git('show','HEAD:'+literal)).stdout,'staged literal\n')
        self.assertEqual((self.repo/literal).read_text(),'not staged\n')

    def test_28_split_hook_failure_preserves_remaining_index(self):
        self.feature();self.stage_change();(self.repo/'second.txt').write_text('second\n');self.ok(self.git('add','second.txt'))
        (self.repo/'file.txt').write_text('UNSTAGED PRIVATE CANARY\n')
        hook=self.repo/'.git/hooks/pre-commit'
        hook.write_text('#!/usr/bin/env python3\nimport subprocess, sys\nfiles=subprocess.check_output(["git","diff","--cached","--name-only"]).decode()\nsys.exit(1 if "second.txt" in files else 0)\n');hook.chmod(0o755)
        p=self.ggh('c','--split','-y','--provider','ollama',env=self.split_env())
        self.assertNotEqual(p.returncode,0)
        self.assertEqual(self.ok(self.git('show','HEAD:file.txt')).stdout,'staged version\n')
        self.assertEqual(self.ok(self.git('show',':second.txt')).stdout,'second\n')
        self.assertEqual((self.repo/'file.txt').read_text(),'UNSTAGED PRIVATE CANARY\n')
        self.assertFalse((self.repo/'.git/index.lock').exists())

    def test_29_split_no_verify_bypasses_hooks(self):
        self.feature();self.stage_change();(self.repo/'second.txt').write_text('second\n');self.ok(self.git('add','second.txt'))
        hook=self.repo/'.git/hooks/pre-commit';hook.write_text('#!/bin/sh\nexit 1\n');hook.chmod(0o755)
        self.ok(self.ggh('c','--split','-y','--no-verify','--provider','ollama',env=self.split_env()))
        self.assertEqual(self.ok(self.git('log','--format=%s','main..HEAD')).stdout.splitlines(),['feat: second','feat: first'])

    def test_30_mcp_recovers_after_oversized_frame(self):
        p=self.ok(self.ggh('mcp',input='x'*(1024*1024+1)+'\n'+json.dumps({'jsonrpc':'2.0','id':3,'method':'ping'})+'\n'))
        replies=[json.loads(x) for x in p.stdout.splitlines()]
        self.assertTrue(any(x.get('error') for x in replies))
        self.assertTrue(any(x.get('id')==3 and x.get('result')=={} for x in replies))


class Results(unittest.TextTestResult):
    def __init__(self,*a,**kw):super().__init__(*a,**kw);self.records=[]
    def addSuccess(self,test):super().addSuccess(test);self.records.append({'test':str(test),'status':'pass'})
    def addFailure(self,test,err):super().addFailure(test,err);self.records.append({'test':str(test),'status':'fail','detail':self._exc_info_to_string(err,test)})
    def addError(self,test,err):super().addError(test,err);self.records.append({'test':str(test),'status':'error','detail':self._exc_info_to_string(err,test)})

def main():
    global BIN,GIT
    parser=argparse.ArgumentParser(description=__doc__,formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--binary',required=True,type=Path)
    parser.add_argument('--results',type=Path,default=Path('ggh-audit-results.json'))
    args=parser.parse_args()
    if os.name!='posix':parser.error('Use Linux or macOS; this harness does not cover Windows.')
    BIN=args.binary.expanduser().resolve()
    if not BIN.is_file() or not os.access(BIN,os.X_OK):parser.error('--binary must be an existing executable')
    GIT=shutil.which('git') or ''
    if not GIT:parser.error('Git must be installed')
    hasher = hashlib.sha256()
    with BIN.open('rb') as binary_file:
        for chunk in iter(lambda: binary_file.read(1024 * 1024), b''):
            hasher.update(chunk)
    digest = hasher.hexdigest()
    result=unittest.TextTestRunner(verbosity=2,resultclass=Results).run(unittest.defaultTestLoader.loadTestsFromTestCase(Audit))
    report={'audited_commit':AUDITED_COMMIT,'reference_binary_sha256':AUDITED_SHA256,'tested_binary':str(BIN),
            'tested_sha256':digest,'reference_match':digest==AUDITED_SHA256,'platform':sys.platform,
            'tests_run':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),
            'tests':result.records,'commands':COMMANDS,'mock_calls':MOCK_CALLS}
    args.results.parent.mkdir(parents=True,exist_ok=True)
    args.results.write_text(json.dumps(report,indent=2)+'\n')
    print(f'\nEvidence written to {args.results.resolve()}')
    return 0 if result.wasSuccessful() else 1

if __name__=='__main__':raise SystemExit(main())
