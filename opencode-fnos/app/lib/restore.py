"""Restore only our encrypted export into stopped fnOS application directories."""
import getpass
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

def restore():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: python3 restore.py /path/OpenCode-private-*.tar.enc')
    roots = {name: Path(os.environ[name]).resolve(strict=True) for name in ('TRIM_PKGETC', 'TRIM_PKGVAR', 'TRIM_PKGHOME')}
    if any(str(p) == '/' or len(p.parts) < 3 for p in roots.values()) or len(set(roots.values())) != 3:
        raise SystemExit('Invalid fnOS application paths')
    pidfile = roots['TRIM_PKGVAR'] / 'run/server.pid'
    if pidfile.exists():
        raise SystemExit('Stop the application in fnOS before restoring')
    password = getpass.getpass('Backup Web password: ')
    env = os.environ.copy()
    env['OPENCODE_RESTORE_PASSWORD'] = password
    with tempfile.TemporaryDirectory(dir=roots['TRIM_PKGVAR']) as temp:
        folder = Path(temp)
        decrypted = folder / 'export.tar'
        subprocess.run(['openssl', 'enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '200000', '-pass', 'env:OPENCODE_RESTORE_PASSWORD', '-in', str(Path(sys.argv[1]).resolve(strict=True)), '-out', str(decrypted)], env=env, check=True)
        expected = {'etc.tar.gz': roots['TRIM_PKGETC'], 'data.tar.gz': roots['TRIM_PKGVAR'], 'home.tar.gz': roots['TRIM_PKGHOME']}
        with tarfile.open(decrypted) as archive:
            if set(archive.getnames()) != set(expected) or any(not m.isfile() for m in archive):
                raise SystemExit('Unexpected export archive layout')
            archive.extractall(folder, filter='data')
        # Validate every nested archive before modifying any destination.
        for name in expected:
            with tarfile.open(folder / name) as archive:
                for member in archive:
                    tarfile.data_filter(member, str(expected[name]))
                    if name == 'data.tar.gz' and Path(member.name).parts[0] not in ('data', 'state'):
                        raise SystemExit('Unexpected data archive path')
        for name, destination in expected.items():
            with tarfile.open(folder / name) as archive:
                archive.extractall(destination, filter='data')
    print('Restored. Match the fnOS wizard port to web.port before starting the application.')

if __name__ == '__main__':
    restore()
