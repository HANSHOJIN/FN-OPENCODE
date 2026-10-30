"""Capture pinned official Web resources for adapter tests on a clean checkout."""
import hashlib
import json
import os
from pathlib import Path
import platform
import secrets
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from build import ROOT, fetch, digest


def capture():
    compatibility = json.loads((ROOT / 'opencode-fnos/app/gateway/compatibility.json').read_text('utf-8'))
    version = compatibility['server']
    resources = [{'path': compatibility['entry'], **compatibility['ui']}, *compatibility['settings']]
    output = ROOT / '.build/upstream-ui'
    output.parent.mkdir(parents=True, exist_ok=True)
    if '--refresh' not in sys.argv and all((output / item['path'].lstrip('/')).is_file()
           and digest(output / item['path'].lstrip('/')) == item['sha256'] for item in resources):
        print('Pinned Web resource cache verified.')
        return
    metadata = ROOT / 'downloads' / f'release-v{version}.json'
    if not metadata.exists():
        fetch(f'https://api.github.com/repos/anomalyco/opencode/releases/tags/v{version}', metadata)
    release = json.loads(metadata.read_text('utf-8'))
    architecture = 'arm64' if platform.machine().lower() in ('arm64', 'aarch64') else 'x64-baseline'
    system = {'Windows': 'windows', 'Linux': 'linux', 'Darwin': 'darwin'}[platform.system()]
    if system == 'darwin' and architecture == 'x64-baseline':
        architecture = 'x64'
    suffix = '.zip' if system == 'windows' else '.tar.gz'
    name = f'opencode-{system}-{architecture}{suffix}'
    asset = next(item for item in release['assets'] if item['name'] == name)
    archive = ROOT / 'downloads' / f'v{version}-{name}'
    if not archive.exists():
        fetch(asset['browser_download_url'], archive)
    if 'sha256:' + digest(archive) != asset.get('digest'):
        raise ValueError('Official executable archive digest mismatch')
    with tempfile.TemporaryDirectory(prefix='capture-ui-', dir=ROOT / '.build') as folder:
        folder = Path(folder)
        binary = folder / ('opencode.exe' if system == 'windows' else 'opencode')
        if system == 'windows':
            with zipfile.ZipFile(archive) as source:
                members = [item for item in source.infolist() if Path(item.filename).name == 'opencode.exe']
                if len(members) != 1:
                    raise ValueError('Official Windows archive layout changed')
                binary.write_bytes(source.read(members[0]))
        else:
            with tarfile.open(archive) as source:
                members = [item for item in source if item.isfile() and item.name.removeprefix('./') == 'opencode']
                if len(members) != 1:
                    raise ValueError('Official archive layout changed')
                binary.write_bytes(source.extractfile(members[0]).read())
            binary.chmod(0o700)
        env = {key: value for key, value in os.environ.items() if not key.startswith(('OPENCODE_', 'XDG_'))}
        for key, subdirectory in {'HOME':'home', 'USERPROFILE':'home', 'OPENCODE_TEST_HOME':'home',
                                  'XDG_DATA_HOME':'data', 'XDG_CONFIG_HOME':'config', 'XDG_CACHE_HOME':'cache',
                                  'XDG_STATE_HOME':'state', 'TMPDIR':'tmp', 'TEMP':'tmp', 'TMP':'tmp'}.items():
            target = folder / subdirectory; target.mkdir(exist_ok=True); env[key] = str(target)
        env.update(OPENCODE_SERVER_PASSWORD=secrets.token_hex(24), OPENCODE_DISABLE_MODELS_FETCH='true', OPENCODE_DISABLE_AUTOUPDATE='true')
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0)); port = listener.getsockname()[1]
        with (folder / 'capture.log').open('wb') as log:
            windows_flags = subprocess.CREATE_NO_WINDOW if system == 'windows' else 0
            child = subprocess.Popen([str(binary), 'serve', '--hostname', '127.0.0.1', '--port', str(port)],
                                     cwd=folder, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                     creationflags=windows_flags)
            try:
                for _ in range(100):
                    if child.poll() is not None:
                        raise RuntimeError('Official capture process exited')
                    try:
                        with urllib.request.urlopen(f'http://127.0.0.1:{port}/', timeout=2) as response:
                            if response.status == 200:
                                break
                    except (OSError, urllib.error.URLError):
                        time.sleep(.2)
                else:
                    raise RuntimeError('Official capture process startup timed out')
                for item in resources:
                    with urllib.request.urlopen(f'http://127.0.0.1:{port}' + item['path'], timeout=20) as response:
                        data = response.read(8 * 1024 * 1024 + 1)
                    if hashlib.sha256(data).hexdigest() != item['sha256']:
                        raise ValueError('Official Web resource differs: ' + item['path'])
                    target = output / item['path'].lstrip('/'); target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(data)
            finally:
                if child.poll() is None:
                    if system == 'windows':
                        subprocess.run(['taskkill', '/PID', str(child.pid), '/T', '/F'],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                       creationflags=subprocess.CREATE_NO_WINDOW)
                    else:
                        child.terminate()
                    try: child.wait(timeout=15)
                    except subprocess.TimeoutExpired: child.kill(); child.wait()
    print('Captured and verified pinned official Web resources.')


if __name__ == '__main__': capture()
