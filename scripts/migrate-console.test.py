import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('migrate_console', ROOT / 'opencode-fnos/app/lib/migrate_console.py')
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT / '.build')
        self.addCleanup(self.temp.cleanup)
        self.etc, self.data = Path(self.temp.name) / 'etc', Path(self.temp.name) / 'data'
        self.etc.mkdir(); (self.data / 'opencode').mkdir(parents=True)
        self.old = {'type': 'oauth', 'access': 'old-access', 'refresh': 'old-refresh', 'expires': 123,
                    'metadata': {'orgID': 'test-org', 'server': 'https://opencode.ai/console'}}
        self.entries, self.posts = [], []
        owner = self
        class Connection:
            def __init__(self, *args, **kwargs): pass
            def request(self, method, url, body, headers):
                owner.assertEqual(url, '/api/credential')
                owner.assertTrue(headers['Authorization'].startswith('Basic '))
                if method == 'POST':
                    payload = json.loads(body); owner.posts.append(payload)
                    entry = {**payload, 'active': payload['activate']}; owner.entries.append(entry)
                    self.data = {'data': entry}
                else: self.data = {'data': owner.entries}
            def getresponse(self): self.status = 200; return self
            def read(self, limit): return json.dumps(self.data).encode()
            def close(self): pass
        mock = patch.object(migration.http.client, 'HTTPConnection', Connection)
        mock.start(); self.addCleanup(mock.stop)

    def run_migration(self, key='opencode-go'):
        (self.data / 'opencode/auth.json').write_text(json.dumps({key: self.old}))
        migration.migrate(4096, 'test-password', self.etc, self.data)

    def test_go_alias_preserves_org_metadata_and_uses_native_device_method(self):
        self.run_migration()
        self.assertEqual(self.posts[0]['integrationID'], 'opencode')
        self.assertEqual(self.posts[0]['value']['methodID'], 'device')
        self.assertEqual(self.posts[0]['value']['metadata'], self.old['metadata'])
        self.assertTrue(self.posts[0]['activate'])
        marker = (self.etc / 'fnos-console-v2-migration.json').read_text()
        self.assertNotIn('old-access', marker); self.assertNotIn('old-refresh', marker)

    def test_existing_fresh_login_is_not_replaced(self):
        self.entries.append({'id': 'new-login', 'integrationID': 'opencode', 'active': True,
                             'value': {'type': 'oauth', 'refresh': 'fresh-refresh', 'access': 'fresh-access'}})
        self.run_migration()
        self.assertFalse(self.posts[0]['activate'])

    def test_imported_legacy_console_recovers_org_metadata(self):
        self.entries.append({'id': 'native-import', 'integrationID': 'opencode', 'active': True, 'value': self.old.copy()})
        self.run_migration('opencode')
        self.assertTrue(self.posts[0]['activate'])

    def test_restart_and_partial_completion_do_not_duplicate_credentials(self):
        self.run_migration(); self.run_migration()
        self.assertEqual(len(self.posts), 1)
        (self.etc / 'fnos-console-v2-migration.json').unlink()
        self.run_migration()
        self.assertEqual(len(self.posts), 1)


if __name__ == '__main__': unittest.main(verbosity=2)
