"""Complete-package release selection and retirement of live kernel updates."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'opencode-fnos/app/lib'))
import package_updates as updates
import runtime

def release(version, arch='x86_64'):
    name=f'OpenCode-fnOS-{version}-{arch}.fpk'
    return {'tag_name':'v'+version,'draft':False,'prerelease':False,'body':'release notes',
            'assets':[{'name':name,'state':'uploaded','size':123456,'digest':'sha256:'+'a'*64,
                       'browser_download_url':updates.RELEASES+f'/download/v{version}/{name}'}]}

class PackageUpdateTests(unittest.TestCase):
    def test_own_fpk_revisions_are_sorted_numerically(self):
        data=[release('2.2.6-2'),release('2.2.5-12'),release('2.2.6-10'),release('2.2.6-1')]
        self.assertEqual([r['version'] for r in updates.select_releases(data,'x86_64')],
                         ['2.2.6-10','2.2.6-2','2.2.6-1','2.2.5-12'])
        self.assertIn('HANSHOJIN/FN-OPENCODE',updates.API)

    def test_wrong_repository_architecture_incomplete_and_preview_assets_are_rejected(self):
        candidates=[]
        for modify in [lambda r:r.update(draft=True),lambda r:r.update(prerelease=True),
                       lambda r:r.update(tag_name='v2.2.6-beta'),lambda r:r['assets'][0].update(state='new'),
                       lambda r:r['assets'][0].update(digest=None),lambda r:r['assets'][0].update(size=0),
                       lambda r:r['assets'][0].update(browser_download_url='https://github.com/anomalyco/opencode/releases/download/v2.2.6/opencode-linux-x64-baseline.tar.gz'),
                       lambda r:r['assets'][0].update(name='opencode-linux-x64-baseline.tar.gz')]:
            item=release('2.2.6-1');modify(item);candidates.append(item)
        candidates.extend([release('2.2.6-1','arm64'),None,{},release('2.2.7-1','x86_64')])
        selected=updates.select_releases(candidates,'x86_64')
        self.assertEqual([r['version'] for r in selected],['2.2.7-1'])

    def test_package_checker_does_not_offer_a_downgrade(self):
        status={'package':'2.2.6-1','architecture':'x86_64'}
        for available, expected in [('2.2.5-4',False),('2.2.6-1',False),('2.2.6-2',True)]:
            with patch.object(updates,'status',return_value=status),patch.object(updates,'fetch_releases',return_value=[release(available)]):
                self.assertEqual(updates.check()['hasUpdate'],expected)

    def test_arm64_selects_its_own_complete_package(self):
        with patch.object(updates.platform,'machine',return_value='aarch64'):
            arch=updates.architecture()
        found=updates.select_releases([release('2.2.6-1'),release('2.2.6-1','arm64')],arch)
        self.assertEqual(len(found),1);self.assertTrue(found[0]['filename'].endswith('-arm64.fpk'))

    def test_redirects_cannot_change_repository_or_send_requests_elsewhere(self):
        for url in ['http://api.github.com/repos/HANSHOJIN/FN-OPENCODE/releases',
                    'https://api.github.com/repos/anomalyco/opencode/releases',
                    'https://evil.example/repos/HANSHOJIN/FN-OPENCODE/releases']:
            with self.assertRaises(ValueError):updates.Redirect().redirect_request(None,None,302,'',{},url)

    def test_retired_apply_and_rollback_do_not_construct_runtime_or_queue_jobs(self):
        for args in [['apply','2.2.7'],['rollback']]:
            with patch.object(sys,'argv',['runtime.py',*args]),patch.object(runtime,'Runtime') as manager:
                with self.assertRaisesRegex(ValueError,'已取消'):runtime.main()
                manager.assert_not_called()

    def test_old_active_binary_and_pending_transactions_never_change_bundled_runtime(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.build') as temp:
            folder=Path(temp)
            env={k:str(folder/v) for k,v in {'TRIM_APPDEST':'app','TRIM_PKGVAR':'var','TRIM_PKGETC':'etc','TRIM_PKGHOME':'home'}.items()}
            for value in env.values():Path(value).mkdir()
            etc=Path(env['TRIM_PKGETC'])
            for key,value in {'port':'4096','username':'opencode','password':'test-only-password'}.items():(etc/('web.'+key)).write_text(value+'\n')
            legacy=Path(env['TRIM_PKGVAR'])/'runtime';legacy.mkdir()
            for name in ['active','request','transaction','status']:(legacy/(name+'.json')).write_text('{"action":"apply","version":"9.9.9","backup":"old"}')
            before={p.name:p.read_bytes() for p in legacy.iterdir()}
            with patch.dict(os.environ,env):manager=runtime.Runtime()
            self.assertEqual(manager.binary(),Path(env['TRIM_APPDEST'])/'bin/opencode')
            manager.children={'opencode':Mock(poll=lambda:1)}
            with patch.object(manager,'start'):
                with self.assertRaisesRegex(RuntimeError,'backend exited'):manager.serve()
            self.assertEqual({p.name:p.read_bytes() for p in legacy.iterdir()},before)

if __name__=='__main__':unittest.main(verbosity=2)
