"""Verify the built FPK and adversarial wizard inputs; no fnOS claims."""
import io
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import struct
import sys
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BASH = os.environ.get('BASH_EXE', r'C:\Program Files\Git\bin\bash.exe' if os.name == 'nt' else 'bash')

def shellpath(path):
    text = str(path).replace('\\', '/')
    return '/' + text[0].lower() + text[2:] if len(text) > 1 and text[1] == ':' else text

class PackageTests(unittest.TestCase):
    def test_package_permissions_and_contract(self):
        artifact = ROOT / 'dist/OpenCode-fnOS-1.19.0-10-x86_64.fpk'
        from build import validate_fpk
        validate_fpk(artifact)
        evidence = json.loads(artifact.with_suffix('.build.json').read_text())
        with artifact.open('rb') as f:
            self.assertEqual(evidence['fpk_sha256'], hashlib.file_digest(f, 'sha256').hexdigest())
        with tarfile.open(artifact) as outer:
            for member in outer:
                self.assertFalse(member.mode & 0o022, member.name)
                if member.name.startswith('cmd/') and member.isfile():
                    self.assertEqual(member.mode, 0o755, member.name)
                    self.assertNotIn(b'\r', outer.extractfile(member).read(), member.name)
            privilege = json.load(outer.extractfile('config/privilege'))
            self.assertEqual(privilege['defaults']['run-as'], 'package')
            resource = json.load(outer.extractfile('config/resource'))
            self.assertEqual(resource['data-share']['shares'], [{'name': 'OpenCode/projects'}])
            for name in ('install', 'config', 'upgrade', 'uninstall'):
                self.assertIsInstance(json.load(outer.extractfile('wizard/' + name)), list)
            with tarfile.open(fileobj=io.BytesIO(outer.extractfile('app.tgz').read())) as app:
                self.assertEqual(app.getmember('bin/opencode').mode, 0o755)
                for name in ('bin/pnpm', 'bin/mvn', 'libexec/apache-maven-3.9.11/bin/mvn'):
                    self.assertEqual(app.getmember(name).mode, 0o755, name)
                self.assertTrue(app.getmember('libexec/pnpm/package/bin/pnpm.cjs').isfile())
                config = json.load(app.extractfile('ui/config'))['.url']['opencode-fnos.Application']
                self.assertEqual(config['type'], 'iframe')
                self.assertEqual(config['gatewayPrefix'], '/app/opencode-fnos')
                self.assertEqual(config['gatewaySocket'], 'app.sock')
                self.assertFalse(config['allUsers'])
                binary = app.extractfile('bin/opencode').read()
                self.assertEqual(binary[:6], b'\x7fELF\x02\x01')
                self.assertEqual(int.from_bytes(binary[18:20], 'little'), 62)
                # Parse ELF dynamic dependencies without executing Linux code on Windows.
                offset = struct.unpack_from('<Q', binary, 40)[0]
                size, count = struct.unpack_from('<HH', binary, 58)
                sections = [struct.unpack_from('<IIQQQQIIQQ', binary, offset + n * size) for n in range(count)]
                needed = []
                for section in sections:
                    if section[1] != 6:
                        continue
                    strings = sections[section[6]]
                    table = binary[strings[4]:strings[4] + strings[5]]
                    for n in range(section[4], section[4] + section[5], 16):
                        tag, val = struct.unpack_from('<QQ', binary, n)
                        if tag == 1:
                            needed.append(table[val:].split(b'\0', 1)[0].decode())
                versions = sorted(set(re.findall(rb'GLIBC_(\d+\.\d+(?:\.\d+)?)', binary)), key=lambda s: tuple(map(int, s.split(b'.'))))
                report = {'elf': 'Linux x86_64 64-bit little-endian', 'dynamic_dependencies': needed, 'max_referenced_glibc_symbol': versions[-1].decode() if versions else None, 'execution_tested': False}
                (ROOT / 'dist/binary-inspection.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')

    def test_fpk_invalid_container_and_checksum_are_rejected(self):
        from build import validate_fpk
        with tempfile.TemporaryDirectory(dir=ROOT / '.build') as temp:
            for mode in ('w', 'w:gz'):
                bad = Path(temp) / ('bad-' + mode.replace(':', '-') + '.fpk')
                with tarfile.open(bad, mode) as archive:
                    for name, data in [('manifest', b'checksum = 00000000000000000000000000000000\n'), ('app.tgz', b'changed payload')]:
                        member = tarfile.TarInfo(name)
                        member.size = len(data)
                        archive.addfile(member, io.BytesIO(data))
                with self.assertRaises(ValueError):
                    validate_fpk(bad)

    def test_shell_syntax(self):
        files = list((ROOT / 'opencode-fnos/cmd').iterdir()) + list((ROOT / 'opencode-fnos/app/lib').glob('*.sh')) + [ROOT / 'scripts/build.sh', ROOT / 'opencode-fnos/app/bin/pnpm', ROOT / 'opencode-fnos/app/bin/mvn']
        for file in files:
            subprocess.run([BASH, '-n', shellpath(file)], check=True, capture_output=True)

    def test_log_rotation(self):
        with tempfile.TemporaryDirectory(dir=ROOT / '.build') as temp:
            log = Path(temp) / 'service.log'
            subprocess.run([BASH, shellpath(ROOT / 'opencode-fnos/app/lib/logpipe.sh'), shellpath(log)], input=(b'x' * 9000 + b'\n') * 800, check=True, capture_output=True)
            self.assertTrue(log.with_suffix('.log.1').exists())
            self.assertLess(log.stat().st_size, 5242880)

    def test_wizard_injection_and_preservation(self):
        with tempfile.TemporaryDirectory(dir=ROOT / '.build') as temp:
            env = os.environ.copy()
            base = Path(temp)
            if os.name == 'nt':
                shim = base / 'bin'
                shim.mkdir()
                (shim / 'python3').write_text('#!/bin/bash\nexec "' + shellpath(sys.executable) + '" "$@"\n')
                env['PATH'] = str(shim) + os.pathsep + env['PATH']
            env.update(TRIM_APPDEST=shellpath(ROOT / 'opencode-fnos/app'), TRIM_PKGETC=shellpath(base / 'etc'), TRIM_PKGVAR=shellpath(base / 'var'), TRIM_PKGHOME=shellpath(base / 'home'), TRIM_TEMP_LOGFILE=shellpath(base / 'error.log'))
            script = shellpath(ROOT / 'opencode-fnos/app/lib/configure.sh')
            password = 'quote" backslash\\ $(touch NEVER) `touch NEVER`'
            env.update(wizard_port='4096', wizard_username='opencode', wizard_password=password)
            subprocess.run([BASH, script], env=env, check=True, capture_output=True)
            self.assertEqual((base / 'etc/web.password').read_text().rstrip('\n'), password)
            self.assertFalse((ROOT / 'NEVER').exists())
            for invalid in ('0', '1023', '65536', '4096;touch NEVER', '04096'):
                env['wizard_port'] = invalid
                if invalid == '04096':
                    # Decimal leading zeros are accepted explicitly via 10#.
                    subprocess.run([BASH, script], env=env, check=True, capture_output=True)
                    continue
                result = subprocess.run([BASH, script], env=env, capture_output=True)
                self.assertNotEqual(result.returncode, 0, invalid)
                self.assertEqual((base / 'etc/web.password').read_text().rstrip('\n'), password)
            env.update(wizard_port='4096', wizard_password='bad\npassword123')
            self.assertNotEqual(subprocess.run([BASH, script], env=env, capture_output=True).returncode, 0)
            env['wizard_password'] = ''
            subprocess.run([BASH, script], env=env, check=True, capture_output=True)
            self.assertEqual((base / 'etc/web.password').read_text().rstrip('\n'), password)


    def test_encrypted_restore_and_traversal_rejection(self):
        openssl = shutil.which('openssl')
        if not openssl and os.name == 'nt':
            openssl = r'C:\Program Files\Git\usr\bin\openssl.exe'
        self.assertTrue(openssl and Path(openssl).exists(), 'openssl required for backup verification')
        spec = importlib.util.spec_from_file_location('restore', ROOT / 'opencode-fnos/app/lib/restore.py')
        restore = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(restore)
        with tempfile.TemporaryDirectory(dir=ROOT / '.build') as temp:
            base = Path(temp)
            source = base / 'source'
            (source / 'etc').mkdir(parents=True)
            (source / 'var/data').mkdir(parents=True)
            (source / 'var/state').mkdir()
            (source / 'home').mkdir()
            (source / 'etc/web.password').write_text('original credential\n')
            (source / 'var/data/session').write_text('persisted session')
            (source / 'home/test').write_text('user home')
            for name, folder, entries in [('etc', 'etc', ['.']), ('data', 'var', ['data', 'state']), ('home', 'home', ['.'])]:
                with tarfile.open(base / (name + '.tar.gz'), 'w:gz') as archive:
                    for entry in entries:
                        archive.add(source / folder / entry, arcname=entry)
            with tarfile.open(base / 'export.tar', 'w') as archive:
                for name in ('etc.tar.gz', 'data.tar.gz', 'home.tar.gz'):
                    archive.add(base / name, arcname=name)
            env = os.environ.copy()
            env['TEST_BACKUP_PASSWORD'] = 'test restore password'
            encrypted = base / 'backup.enc'
            subprocess.run([openssl, 'enc', '-aes-256-cbc', '-salt', '-pbkdf2', '-iter', '200000', '-pass', 'env:TEST_BACKUP_PASSWORD', '-in', str(base / 'export.tar'), '-out', str(encrypted)], env=env, check=True, capture_output=True)
            overrides = {'TRIM_PKGETC': str(base / 'restored/etc'), 'TRIM_PKGVAR': str(base / 'restored/var'), 'TRIM_PKGHOME': str(base / 'restored/home'), 'PATH': str(Path(openssl).parent) + os.pathsep + os.environ['PATH']}
            for key in ('TRIM_PKGETC', 'TRIM_PKGVAR', 'TRIM_PKGHOME'):
                Path(overrides[key]).mkdir(parents=True)
            from unittest.mock import patch
            with patch.dict(os.environ, overrides), patch.object(restore.getpass, 'getpass', return_value=env['TEST_BACKUP_PASSWORD']), patch.object(restore.sys, 'argv', ['restore.py', str(encrypted)]):
                restore.restore()
            self.assertEqual((base / 'restored/var/data/session').read_text(), 'persisted session')
            self.assertEqual((base / 'restored/etc/web.password').read_text(), 'original credential\n')
            with tarfile.open(base / 'etc.tar.gz', 'w:gz') as archive:
                member = tarfile.TarInfo('../../outside')
                member.size = 4
                archive.addfile(member, io.BytesIO(b'evil'))
            with tarfile.open(base / 'export.tar', 'w') as archive:
                for name in ('etc.tar.gz', 'data.tar.gz', 'home.tar.gz'):
                    archive.add(base / name, arcname=name)
            subprocess.run([openssl, 'enc', '-aes-256-cbc', '-salt', '-pbkdf2', '-iter', '200000', '-pass', 'env:TEST_BACKUP_PASSWORD', '-in', str(base / 'export.tar'), '-out', str(encrypted)], env=env, check=True, capture_output=True)
            with patch.dict(os.environ, overrides), patch.object(restore.getpass, 'getpass', return_value=env['TEST_BACKUP_PASSWORD']), patch.object(restore.sys, 'argv', ['restore.py', str(encrypted)]):
                with self.assertRaises(tarfile.OutsideDestinationError):
                    restore.restore()
            self.assertFalse((base / 'outside').exists())

if __name__ == '__main__':
    unittest.main(verbosity=2)
