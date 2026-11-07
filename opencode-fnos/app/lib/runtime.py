"""Own bundled OpenCode and gateway processes; updates use complete fnOS FPKs."""
import argparse
import http.client
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import package_updates


class Runtime:
    def binary(self):
        # Old runtime/active.json and queued kernel updates are intentionally ignored.
        return self.app / 'bin/opencode'

    def __init__(self):
        self.app = Path(os.environ['TRIM_APPDEST']).resolve()
        self.var = Path(os.environ['TRIM_PKGVAR']).resolve()
        self.etc = Path(os.environ['TRIM_PKGETC']).resolve()
        self.home = Path(os.environ['TRIM_PKGHOME']).resolve()
        self.package = os.environ.get('TRIM_APPVER', 'unknown')
        self.root = self.var / 'runtime'
        self.root.mkdir(parents=True, exist_ok=True)
        self.children = {}
        self.logs = {}
        self.settings()


    def settings(self, etc=None):
        etc = etc or self.etc
        self.port = int((etc / 'web.port').read_text().strip())
        self.credentials = {
            'OPENCODE_SERVER_USERNAME': (etc / 'web.username').read_text().rstrip('\n'),
            'OPENCODE_SERVER_PASSWORD': (etc / 'web.password').read_text().rstrip('\n'),
        }


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
        self.spawn('opencode', [str(self.binary()), 'serve', '--hostname', '0.0.0.0', '--port', str(self.port)], {**os.environ, **self.credentials}, Path(os.environ['FNOS_WORKSPACE']))
        self.spawn('gateway', ['node', str(self.app / 'gateway/server.mjs')], {**os.environ, 'FNOS_SERVER_PID': str(os.getpid())})
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            if any(child.poll() is not None for child in self.children.values()):
                raise ValueError('OpenCode 或网关启动失败，请查看应用日志。')
            result = subprocess.run([sys.executable, str(self.app / 'lib/health.py'), str(self.app), str(self.etc)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8)
            if result.returncode == 0:
                try:
                    from migrate_console import migrate
                    migrate(self.port, self.credentials['OPENCODE_SERVER_PASSWORD'], self.etc, self.var / 'data')
                except (OSError, ValueError, KeyError, http.client.HTTPException):
                    print('旧版 Console 授权尚未完成迁移，可重启重试或在提供商中重新连接。', file=sys.stderr)
                return
            time.sleep(0.5)
        raise ValueError('新版启动健康检查超时。')


    def serve(self):
        import maintenance
        self.start()
        attempts, first, rotated = 0, time.monotonic(), 0
        while True:
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
    parser = argparse.ArgumentParser(description='FN-OPENCODE 更新查询：check / status；安装包由飞牛应用中心安装。')
    parser.add_argument('command', choices=['serve', 'check', 'status', 'apply', 'rollback'])
    parser.add_argument('version', nargs='?')
    args = parser.parse_args()
    if args.command in ('apply', 'rollback'):
        raise ValueError('已取消官方内核独立更新和回退。请运行 fnos-opencode-update check，下载 FN-OPENCODE FPK 并在飞牛应用中心安装。')
    if args.version is not None:
        parser.error('检查更新不接受版本参数。')
    if args.command != 'serve':
        result = package_updates.check() if args.command == 'check' else package_updates.status()
        print(json.dumps(result, ensure_ascii=False))
        return
    runtime = Runtime()
    def stop(signum, frame):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        runtime.serve()
    finally:
        runtime.stop()


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'error': str(exc) if isinstance(exc, ValueError) else 'FN-OPENCODE 更新查询或服务启动失败，请检查网络及应用日志。'}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
