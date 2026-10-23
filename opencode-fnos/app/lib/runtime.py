"""Own the service lifecycle and transactional, architecture-specific updates."""
import argparse
from contextlib import contextmanager, closing
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request
import uuid

VERSION = re.compile(r'\d+\.\d+\.\d+\Z')
TERMINAL = {'idle', 'complete', 'failed'}
API = 'https://api.github.com/repos/anomalyco/opencode'
HOSTS = {'api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'}


def atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with temp.open('x', encoding='utf-8') as stream:
            os.chmod(temp, 0o600)
            json.dump(value, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
        if os.name == 'posix':
            directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        temp.unlink(missing_ok=True)


def read(path, default=None):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        return default


@contextmanager
def lock(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a+b') as stream:
        if os.name == 'nt':
            import msvcrt
            stream.write(b'0')
            stream.flush()
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(stream, fcntl.LOCK_EX)
        try:
            yield
        finally:
            if os.name == 'nt':
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream, fcntl.LOCK_UN)


def valid_version(version):
    if not isinstance(version, str) or not VERSION.fullmatch(version):
        raise ValueError('版本号须为正式版本，例如 1.19.4。')
    return version


def sha256(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def safe_url(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname not in HOSTS or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError('更新地址不是受信任的官方 HTTPS 地址。')
    return url


class Redirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        safe_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download(url, target=None, maximum=2 * 1024 * 1024):
    request = urllib.request.Request(safe_url(url), headers={'User-Agent': 'FN-OPENCODE-updater', 'Accept': 'application/vnd.github+json' if url.startswith(API) else 'application/octet-stream'})
    opener = urllib.request.build_opener(Redirect())
    with opener.open(request, timeout=30) as response:
        chunks, total = [], 0
        stream = target.open('xb') if target else None
        try:
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > maximum:
                    raise ValueError('官方更新文件超出大小限制。')
                if stream:
                    stream.write(chunk)
                else:
                    chunks.append(chunk)
        finally:
            if stream:
                stream.close()
    return json.loads(b''.join(chunks)) if target is None else total


def architecture():
    value = platform.machine().lower()
    if value in ('x86_64', 'amd64'):
        return 'x86_64', 'opencode-linux-x64-baseline.tar.gz', 62
    if value in ('aarch64', 'arm64'):
        return 'arm64', 'opencode-linux-arm64.tar.gz', 183
    raise ValueError('当前设备架构不支持独立更新。')


def release(version):
    result = download(API + '/releases/tags/v' + valid_version(version))
    if result.get('tag_name') != 'v' + version or result.get('draft') or result.get('prerelease'):
        raise ValueError('目标不是官方正式发行版。')
    name = architecture()[1]
    asset = next((x for x in result.get('assets', []) if x.get('name') == name), None)
    if not asset or not re.fullmatch(r'sha256:[a-f0-9]{64}', asset.get('digest', '')):
        raise ValueError('官方发行缺少对应架构的安装包或 SHA256，已取消更新。')
    expected = f'https://github.com/anomalyco/opencode/releases/download/v{version}/{name}'
    if asset.get('browser_download_url') != expected:
        raise ValueError('官方安装包下载地址不匹配。')
    return asset


def unpack(archive, target, machine):
    with tarfile.open(archive, 'r:gz') as tar:
        files = [m for m in tar if not m.isdir()]
        if len(files) != 1 or files[0].name.removeprefix('./') != 'opencode' or not files[0].isfile() or not 20 <= files[0].size <= 500 * 1024 * 1024:
            raise ValueError('官方程序归档结构改变，已取消更新。')
        with target.open('xb') as out:
            shutil.copyfileobj(tar.extractfile(files[0]), out)
    with target.open('rb') as stream:
        header = stream.read(20)
    if header[:6] != b'\x7fELF\x02\x01' or int.from_bytes(header[18:20], 'little') != machine:
        raise ValueError('下载程序的 ELF 架构不匹配。')
    target.chmod(0o700)


def copy_tree(source, target, live=False):
    if not source.exists():
        target.mkdir(parents=True)
        return
    shutil.copytree(source, target, symlinks=True)
    if live:
        # SQLite's online backup API captures WAL-backed databases consistently.
        for source_file in source.rglob('*'):
            if source_file.is_symlink() or not source_file.is_file():
                continue
            with source_file.open('rb') as stream:
                if stream.read(16) != b'SQLite format 3\x00':
                    continue
            destination = target / source_file.relative_to(source)
            destination.unlink()
            with closing(sqlite3.connect(source_file.resolve().as_uri() + '?mode=ro', uri=True, timeout=10)) as src, closing(sqlite3.connect(destination)) as dst:
                with dst:
                    src.backup(dst)
            for suffix in ('-wal', '-shm'):
                destination.with_name(destination.name + suffix).unlink(missing_ok=True)


class Runtime:
    def __init__(self):
        self.app = Path(os.environ['TRIM_APPDEST']).resolve()
        self.var = Path(os.environ['TRIM_PKGVAR']).resolve()
        self.etc = Path(os.environ['TRIM_PKGETC']).resolve()
        self.home = Path(os.environ['TRIM_PKGHOME']).resolve()
        self.package = os.environ.get('TRIM_APPVER', 'unknown')
        self.root = self.var / 'runtime'
        self.root.mkdir(parents=True, exist_ok=True)
        self.roots = {'etc': self.etc, 'data': self.var / 'data', 'state': self.var / 'state', 'home': self.home}
        self.children = {}
        self.logs = {}
        self.probe = None
        self.settings()

    def settings(self, etc=None):
        etc = etc or self.etc
        self.port = int((etc / 'web.port').read_text().strip())
        self.credentials = {
            'OPENCODE_SERVER_USERNAME': (etc / 'web.username').read_text().rstrip('\n'),
            'OPENCODE_SERVER_PASSWORD': (etc / 'web.password').read_text().rstrip('\n'),
        }

    def active(self):
        state = read(self.root / 'active.json', {})
        return state if state.get('package') == self.package else {}

    def binary(self, state=None):
        state = self.active() if state is None else state
        if not state:
            return self.app / 'bin/opencode'
        version = valid_version(state['version'])
        candidate = self.root / 'versions' / version / 'opencode'
        if not candidate.resolve().is_relative_to((self.root / 'versions').resolve()) or sha256(candidate) != state['sha256']:
            raise ValueError('已安装更新文件损坏，请回退或重新安装 FPK。')
        return candidate

    def status(self):
        state = read(self.root / 'status.json', {'phase': 'idle', 'message': '尚未执行独立更新。'})
        compat = read(self.app / 'gateway/compatibility.json')
        return {**state, 'package': self.package, 'current': self.active().get('version', compat['server']), 'architecture': architecture()[0], 'canRollback': self.rollback_id() is not None}

    def rollback_id(self):
        state = read(self.root / 'rollback.json', {})
        return state.get('backup') if state.get('package') == self.package else None

    def progress(self, phase, message, job=None):
        atomic(self.root / 'status.json', {'phase': phase, 'message': message, 'job': job, 'time': int(time.time())})

    def enqueue(self, action, version=None):
        if action not in ('apply', 'rollback'):
            raise ValueError('未知更新操作。')
        if action == 'apply':
            valid_version(version)
        with lock(self.root / 'request.lock'):
            status = self.status()
            if (self.root / 'request.json').exists() or status['phase'] not in TERMINAL:
                raise ValueError('已有更新任务正在执行，请稍后再试。')
            if action == 'rollback' and not self.rollback_id():
                raise ValueError('当前没有可回退的独立更新。')
            job = uuid.uuid4().hex
            self.progress('queued', '已排队，更新时会中断当前生成与终端。', job)
            atomic(self.root / 'request.json', {'job': job, 'action': action, 'version': version})
        return {'job': job, 'phase': 'queued'}

    def spawn(self, name, args, env=None, cwd=None):
        log = (self.var / 'log' / (name + '.log')).open('ab', buffering=0)
        try:
            child = subprocess.Popen(args, cwd=cwd or self.home, env=env or os.environ.copy(), stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        except BaseException:
            log.close()
            raise
        self.children[name] = child
        self.logs[name] = log
        return child

    @staticmethod
    def kill(child):
        if child is None:
            return
        # Kill the owned process group even if the leader already exited.
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=3)
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    def stop(self):
        for child in list(self.children.values()):
            self.kill(child)
        self.children.clear()
        for log in self.logs.values():
            log.close()
        self.logs.clear()

    def start(self):
        self.settings()
        self.spawn('opencode', [str(self.binary()), 'web', '--hostname', '0.0.0.0', '--port', str(self.port)], {**os.environ, **self.credentials}, Path(os.environ['FNOS_WORKSPACE']))
        self.spawn('gateway', ['node', str(self.app / 'gateway/server.mjs')], {**os.environ, 'FNOS_SERVER_PID': str(os.getpid())})
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            if any(child.poll() is not None for child in self.children.values()):
                raise ValueError('OpenCode 或网关启动失败，请查看应用日志。')
            result = subprocess.run([sys.executable, str(self.app / 'lib/health.py'), str(self.app), str(self.etc)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8)
            if result.returncode == 0:
                return
            time.sleep(0.5)
        raise ValueError('新版启动健康检查超时。')

    def snapshot(self, job, live=False):
        folder = self.root / 'backups' / job
        folder.mkdir(parents=True)
        try:
            for name, source in self.roots.items():
                copy_tree(source, folder / name, live=live)
            atomic(folder / 'metadata.json', {'package': self.package, 'active': self.active()})
        except BaseException:
            shutil.rmtree(folder)
            raise
        return folder

    def backup(self, ident):
        if not isinstance(ident, str) or not re.fullmatch('[a-f0-9]{32}', ident):
            raise ValueError('回退备份标识无效。')
        folder = self.root / 'backups' / ident
        meta = read(folder / 'metadata.json')
        if not meta or meta['package'] != self.package:
            raise ValueError('回退备份与当前 FPK 不匹配。')
        return folder, meta

    def restore(self, ident):
        folder, meta = self.backup(ident)
        for name, destination in self.roots.items():
            temp = destination.with_name(destination.name + '.restore-' + ident)
            old = destination.with_name(destination.name + '.before-restore-' + ident)
            if temp.exists():
                shutil.rmtree(temp)
            copy_tree(folder / name, temp)
            if old.exists():
                shutil.rmtree(old)
            if destination.exists():
                os.replace(destination, old)
            os.replace(temp, destination)
            if old.exists():
                shutil.rmtree(old)
        atomic(self.root / 'active.json', meta['active'])

    def preflight(self, binary, version, source=None):
        with tempfile.TemporaryDirectory(prefix='probe-', dir=self.root) as temp:
            temp = Path(temp)
            for name, directory in self.roots.items():
                copy_tree((source / name) if source else directory, temp / name, live=source is None)
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            (temp / 'cache').mkdir()
            probe_credentials = {
                'OPENCODE_SERVER_USERNAME': (temp / 'etc/web.username').read_text().rstrip('\n'),
                'OPENCODE_SERVER_PASSWORD': (temp / 'etc/web.password').read_text().rstrip('\n'),
            }
            env = {**os.environ, **probe_credentials, 'HOME': str(temp / 'home'), 'XDG_CONFIG_HOME': str(temp / 'etc'), 'XDG_DATA_HOME': str(temp / 'data'), 'XDG_STATE_HOME': str(temp / 'state'), 'XDG_CACHE_HOME': str(temp / 'cache')}
            with (temp / 'probe.log').open('wb') as log:
                self.probe = subprocess.Popen([str(binary), 'web', '--hostname', '127.0.0.1', '--port', str(port)], env=env, cwd=temp, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                try:
                    subprocess.run(['node', str(self.app / 'gateway/validate-upstream.mjs'), str(port), str(temp / 'etc'), version], check=True, timeout=90, stdout=subprocess.DEVNULL, stderr=log, env={k: v for k, v in os.environ.items() if k not in self.credentials})
                except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
                    log.flush()
                    shutil.copyfile(temp / 'probe.log', self.root / 'last-preflight.log')
                    raise ValueError('新版与飞牛界面或接口不兼容，或未能正常启动。当前版本未替换；请等待新版 FPK。') from exc
                finally:
                    self.kill(self.probe)
                    self.probe = None

    def install(self, version, job):
        self.progress('downloading', '正在下载并校验官方程序。', job)
        asset = release(version)
        with tempfile.TemporaryDirectory(prefix='download-', dir=self.root) as temp:
            temp = Path(temp)
            archive = temp / 'release.tar.gz'
            download(asset['browser_download_url'], archive, 250 * 1024 * 1024)
            if sha256(archive) != asset['digest'][7:]:
                raise ValueError('官方程序 SHA256 校验失败。')
            binary = temp / 'opencode'
            unpack(archive, binary, architecture()[2])
            self.progress('checking', '正在临时实例中检查新版界面与接口。', job)
            self.preflight(binary, version)
            destination = self.root / 'versions' / version
            destination.mkdir(parents=True, exist_ok=True)
            # Never overwrite an executable currently used by the running service.
            if destination.joinpath('opencode').exists():
                if sha256(destination / 'opencode') != sha256(binary):
                    raise ValueError('同版本官方文件发生变化，请通过新版 FPK 更新。')
            else:
                os.replace(binary, destination / 'opencode')
            return {'package': self.package, 'version': version, 'sha256': sha256(destination / 'opencode')}

    def transact(self, request):
        job = request['job']
        stopped = False
        try:
            if request['action'] == 'apply':
                target = self.install(valid_version(request['version']), job)
                selected_backup = None
            elif request['action'] == 'rollback':
                selected_backup = self.rollback_id()
                folder, meta = self.backup(selected_backup)
                target = meta['active']
                self.progress('checking', '正在检查回退版本及其备份。', job)
                self.preflight(self.binary(target), target.get('version', read(self.app / 'gateway/compatibility.json')['server']), folder)
            else:
                raise ValueError('未知更新操作。')
            self.progress('backing-up', '正在停止服务并备份配置和会话数据。', job)
            self.stop()
            stopped = True
            self.snapshot(job)
            atomic(self.root / 'transaction.json', {'backup': job})
            if selected_backup:
                self.restore(selected_backup)
            atomic(self.root / 'active.json', target)
            self.progress('restarting', '正在切换版本并检查服务。', job)
            self.start()
            atomic(self.root / 'rollback.json', {'package': self.package, 'backup': job})
            (self.root / 'transaction.json').unlink()
            self.progress('complete', '已完成。请刷新或重新打开窗口。', job)
        except Exception as exc:
            if stopped:
                self.stop()
                if (self.root / 'transaction.json').exists():
                    self.restore(job)
                    (self.root / 'transaction.json').unlink()
                self.start()
            self.progress('failed', str(exc) if isinstance(exc, ValueError) else '更新失败：' + type(exc).__name__ + '。请检查网络、磁盘及应用日志。', job)

    def serve(self):
        import maintenance
        journal = read(self.root / 'transaction.json')
        if journal:
            self.restore(journal['backup'])
            (self.root / 'transaction.json').unlink()
            self.progress('failed', '上次更新中断，已恢复更新前的程序和数据。')
        elif self.status()['phase'] not in TERMINAL and not (self.root / 'request.json').exists():
            self.progress('failed', '上次更新任务已中断，保留当前版本。')
        self.start()
        attempts, first, rotated = 0, time.monotonic(), 0
        while True:
            with lock(self.root / 'request.lock'):
                request = read(self.root / 'request.json')
                if request:
                    (self.root / 'request.json').unlink()
            if request:
                self.transact(request)
            if self.children['opencode'].poll() is not None:
                raise RuntimeError('OpenCode backend exited')
            if self.children['gateway'].poll() is not None:
                now = time.monotonic()
                if now - first > 60:
                    attempts, first = 0, now
                attempts += 1
                if attempts >= 5:
                    raise RuntimeError('Gateway repeatedly failed')
                self.kill(self.children['gateway'])
                self.logs.pop('gateway').close()
                time.sleep(attempts)
                self.spawn('gateway', ['node', str(self.app / 'gateway/server.mjs')], {**os.environ, 'FNOS_SERVER_PID': str(os.getpid())})
            if time.monotonic() - rotated > 30:
                maintenance.rotate_logs(self.var / 'data/opencode/log')
                maintenance.rotate_logs(self.var / 'log')
                rotated = time.monotonic()
            time.sleep(0.5)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description='飞牛 OpenCode 官方程序更新：check / status / apply VERSION / rollback')
    parser.add_argument('command', choices=['serve', 'check', 'status', 'apply', 'rollback'])
    parser.add_argument('version', nargs='?')
    args = parser.parse_args()
    runtime = Runtime()
    if args.command == 'serve':
        def stop(signum, frame):
            raise SystemExit(0)
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        try:
            runtime.serve()
        finally:
            runtime.kill(runtime.probe)
            runtime.stop()
        return
    if args.command == 'check':
        releases = download(API + '/releases?per_page=20')
        result = []
        for item in releases:
            version = str(item.get('tag_name', '')).removeprefix('v')
            if VERSION.fullmatch(version) and not item.get('draft') and not item.get('prerelease'):
                if any(a.get('name') == architecture()[1] and re.fullmatch('sha256:[a-f0-9]{64}', a.get('digest', '')) for a in item.get('assets', [])):
                    result.append(version)
        print(json.dumps({'versions': result, **runtime.status()}, ensure_ascii=False))
    elif args.command == 'status':
        print(json.dumps(runtime.status(), ensure_ascii=False))
    else:
        print(json.dumps(runtime.enqueue(args.command, args.version), ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'error': str(exc) if isinstance(exc, ValueError) else type(exc).__name__}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
