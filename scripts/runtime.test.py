"""Transactional tests with fake processes; Linux execution is verified separately."""
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import sys
import tarfile
import tempfile
import unittest
from contextlib import closing
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'opencode-fnos/app/lib'))
spec = importlib.util.spec_from_file_location('runtime', ROOT / 'opencode-fnos/app/lib/runtime.py')
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT / '.build')
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        env = {k: str(base / v) for k, v in {'TRIM_APPDEST':'app','TRIM_PKGVAR':'var','TRIM_PKGETC':'etc','TRIM_PKGHOME':'home','FNOS_WORKSPACE':'projects'}.items()}
        env['TRIM_APPVER'] = 'test-package'
        for value in env.values():
            if value != 'test-package':
                Path(value).mkdir(parents=True)
        etc = Path(env['TRIM_PKGETC'])
        for key, value in {'username':'test','password':'a-test-password','port':'4096'}.items():
            (etc / ('web.' + key)).write_text(value + '\n', encoding='utf-8')
        app = Path(env['TRIM_APPDEST'])
        (app / 'gateway').mkdir()
        (app / 'gateway/compatibility.json').write_text(json.dumps({'server':'1.19.4'}))
        self.env = patch.dict(os.environ, env)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.r = runtime.Runtime()
        for name, path in self.r.roots.items():
            path.mkdir(exist_ok=True)
            (path / 'value').write_text('before-' + name)

    def test_request_validation_and_exclusion(self):
        for version in ('../../etc', 'v1.19.4', '1.2.3; echo secret', '1.2.3\n', '1.2.3-beta'):
            with self.assertRaises(ValueError):
                self.r.enqueue('apply', version)
        result = self.r.enqueue('apply', '1.19.5')
        self.assertEqual(len(result['job']), 32)
        with self.assertRaises(ValueError):
            self.r.enqueue('apply', '1.19.6')
        self.assertEqual(runtime.read(self.r.root / 'request.json')['version'], '1.19.5')

    def test_download_origin_and_architecture_rejection(self):
        for value in ('http://github.com/a', 'https://github.com.evil/a', 'https://user:pass@github.com/a', 'https://github.com:123/a'):
            with self.assertRaises(ValueError):
                runtime.safe_url(value)
        self.assertEqual(runtime.safe_url('https://release-assets.githubusercontent.com/a'), 'https://release-assets.githubusercontent.com/a')
        with patch.object(runtime.platform, 'machine', return_value='aarch64'):
            self.assertEqual(runtime.architecture()[2], 183)

    def test_archive_symlinks_traversal_and_wrong_elf_are_rejected(self):
        for index, name in enumerate(('../opencode', 'opencode', './opencode')):
            archive = self.r.root / f'test-{index}.tgz'
            with tarfile.open(archive, 'w:gz') as tar:
                item = tarfile.TarInfo(name)
                item.size = 20
                tar.addfile(item, io.BytesIO(b'X' * 20))
            with self.assertRaises(ValueError):
                runtime.unpack(archive, self.r.root / f'out-{index}', 62)

    def test_incompatible_candidate_never_stops_or_mutates_current_instance(self):
        with patch.object(self.r, 'install', side_effect=ValueError('incompatible')), patch.object(self.r, 'stop') as stop, patch.object(self.r, 'start') as start:
            self.r.transact({'job':'a'*32, 'action':'apply', 'version':'1.19.5'})
            stop.assert_not_called()
            start.assert_not_called()
        self.assertEqual((self.r.etc / 'value').read_text(), 'before-etc')
        self.assertEqual(self.r.status()['phase'], 'failed')
        self.assertFalse((self.r.root / 'transaction.json').exists())

    def test_failure_after_switch_restores_program_and_all_data(self):
        target = {'package':'test-package','version':'1.19.5','sha256':'unused'}
        starts = []
        def start():
            starts.append(self.r.active())
            if len(starts) == 1:
                for name, path in self.r.roots.items():
                    (path / 'value').write_text('migrated')
                raise ValueError('health failed after data migration')
        with patch.object(self.r, 'install', return_value=target), patch.object(self.r, 'stop'), patch.object(self.r, 'start', side_effect=start):
            self.r.transact({'job':'b'*32,'action':'apply','version':'1.19.5'})
        self.assertEqual(starts, [target, {}])
        for name, path in self.r.roots.items():
            self.assertEqual((path / 'value').read_text(), 'before-' + name)
        self.assertEqual(self.r.status()['phase'], 'failed')
        self.assertFalse((self.r.root / 'transaction.json').exists())

    def test_manual_rollback_restores_snapshot_and_keeps_recovery_copy(self):
        first = 'c'*32
        self.r.snapshot(first)
        target = {'package':'test-package','version':'1.19.5','sha256':'unused'}
        runtime.atomic(self.r.root / 'active.json', target)
        runtime.atomic(self.r.root / 'rollback.json', {'package':'test-package','backup':first})
        for path in self.r.roots.values():
            (path / 'value').write_text('after-update')
        with patch.object(self.r, 'preflight'), patch.object(self.r, 'stop'), patch.object(self.r, 'start'):
            self.r.transact({'job':'d'*32,'action':'rollback','version':None})
        self.assertEqual(self.r.active(), {})
        self.assertEqual((self.r.etc / 'value').read_text(), 'before-etc')
        self.assertEqual((self.r.root / 'backups' / ('d'*32) / 'etc/value').read_text(), 'after-update')
        self.assertEqual(self.r.status()['phase'], 'complete')

    def test_restart_recovers_interrupted_switch_before_launching(self):
        job = 'e'*32
        self.r.snapshot(job)
        runtime.atomic(self.r.root / 'transaction.json', {'backup':job})
        (self.r.etc / 'value').write_text('partially-migrated')
        with patch.object(self.r, 'start', side_effect=RuntimeError('stop test before service loop')):
            with self.assertRaises(RuntimeError):
                self.r.serve()
        self.assertEqual((self.r.etc / 'value').read_text(), 'before-etc')
        self.assertFalse((self.r.root / 'transaction.json').exists())

    def test_new_fpk_ignores_previous_runtime_selection(self):
        runtime.atomic(self.r.root / 'active.json', {'package':'older-fpk','version':'1.19.3','sha256':'unused'})
        self.assertEqual(self.r.binary(), self.r.app / 'bin/opencode')

    def test_online_sqlite_snapshot_includes_uncheckpointed_wal(self):
        dbfile = self.r.var / 'data/test.db'
        with closing(sqlite3.connect(dbfile)) as db:
            db.execute('pragma journal_mode=wal')
            db.execute('create table test(value text)')
            db.execute('insert into test values (?)', ('latest',))
            db.commit()
            snapshot = self.r.snapshot('f'*32, live=True)
        with closing(sqlite3.connect(snapshot / 'data/test.db')) as db:
            self.assertEqual(db.execute('select value from test').fetchone()[0], 'latest')


if __name__ == '__main__':
    unittest.main(verbosity=2)
