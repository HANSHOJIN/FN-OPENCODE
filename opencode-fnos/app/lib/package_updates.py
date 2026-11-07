"""Discover complete FN-OPENCODE releases without modifying the live service."""
import json
import os
from pathlib import Path
import platform
import re
import urllib.parse
import urllib.request

REPOSITORY = 'HANSHOJIN/FN-OPENCODE'
RELEASES = 'https://github.com/' + REPOSITORY + '/releases'
API = 'https://api.github.com/repos/' + REPOSITORY + '/releases?per_page=30'
VERSION = re.compile(r'(\d+)\.(\d+)\.(\d+)(?:-([1-9]\d*))?\Z')

def version_key(value):
    match = VERSION.fullmatch(value) if isinstance(value, str) and len(value) <= 64 else None
    if not match:
        raise ValueError('FN-OPENCODE 版本号无效。')
    return tuple(int(part or 0) for part in match.groups())

def architecture():
    machine = platform.machine().lower()
    if machine in ('x86_64', 'amd64'): return 'x86_64'
    if machine in ('arm64', 'aarch64'): return 'arm64'
    raise ValueError('当前设备架构不受支持。')

def status():
    compatibility = json.loads((Path(os.environ['TRIM_APPDEST']) / 'gateway/compatibility.json').read_text(encoding='utf8'))
    return {'source': REPOSITORY, 'package': os.environ.get('TRIM_APPVER') or compatibility['package'],
            'current': compatibility['server'], 'architecture': architecture(), 'mode': 'fpk',
            'releasesURL': RELEASES, 'message': '请下载 FN-OPENCODE 安装包，在飞牛应用中心手动安装。'}

class Redirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parsed = urllib.parse.urlsplit(newurl)
        if parsed.scheme != 'https' or parsed.netloc != 'api.github.com' or not parsed.path.startswith('/repos/' + REPOSITORY + '/'):
            raise ValueError('更新服务重定向地址不受信任。')
        return super().redirect_request(req, fp, code, msg, headers, newurl)

def fetch_releases():
    request = urllib.request.Request(API, headers={'User-Agent': 'FN-OPENCODE-update-check', 'Accept': 'application/vnd.github+json'})
    with urllib.request.build_opener(Redirect()).open(request, timeout=15) as response:
        data = response.read(2 * 1024 * 1024 + 1)
    if len(data) > 2 * 1024 * 1024: raise ValueError('更新列表超出大小限制。')
    try: result = json.loads(data)
    except ValueError as error: raise ValueError('更新服务返回了无效数据。') from error
    if not isinstance(result, list): raise ValueError('暂时无法获取 FN-OPENCODE 更新，请稍后重试。')
    return result

def select_releases(items, arch):
    releases, seen = [], set()
    for item in items:
        if not isinstance(item, dict) or item.get('draft') or item.get('prerelease'): continue
        tag = item.get('tag_name', '')
        if not isinstance(tag, str) or not tag.startswith('v'): continue
        version = tag[1:]
        try: version_key(version)
        except ValueError: continue
        if version in seen: continue
        filename = f'OpenCode-fnOS-{version}-{arch}.fpk'
        expected = RELEASES + f'/download/{tag}/{filename}'
        assets = item.get('assets')
        if not isinstance(assets, list): continue
        asset = next((a for a in assets if isinstance(a, dict) and a.get('name') == filename), None)
        if not asset or asset.get('state') != 'uploaded' or asset.get('browser_download_url') != expected: continue
        digest, size = asset.get('digest'), asset.get('size')
        if not isinstance(digest, str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', digest): continue
        if type(size) is not int or not 0 < size <= 512 * 1024 * 1024: continue
        releases.append({'version': version, 'filename': filename, 'url': expected, 'releaseURL': RELEASES + '/tag/' + tag,
                         'sha256': digest[7:], 'size': size, 'notes': str(item.get('body') or '')[:12000]})
        seen.add(version)
    return sorted(releases, key=lambda item: version_key(item['version']), reverse=True)

def check():
    current = status()
    releases = select_releases(fetch_releases(), current['architecture'])
    latest = releases[0] if releases else None
    return {**current, 'releases': releases, 'latest': latest,
            'hasUpdate': bool(latest and version_key(latest['version']) > version_key(current['package']))}
