"""Build with official fnpack and normalize Unix permissions on every host."""
import argparse
import base64
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]

def fetch(url, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "FN-OPENCODE-build"}), timeout=120) as response, path.with_suffix(path.suffix + '.part').open('wb') as out:
        shutil.copyfileobj(response, out)
    path.with_suffix(path.suffix + '.part').replace(path)

def digest(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()

def normalize(source, target, nested=False):
    if not nested:
        # fnpack 1.2.3 produces a gzip-compressed tar, whose manifest checksum
        # is the MD5 of the compressed app.tgz bytes (not extracted contents).
        with tempfile.TemporaryDirectory() as temp, tarfile.open(source, 'r:*') as src:
            raw = Path(temp) / 'app.tgz'
            with raw.open('wb') as out:
                shutil.copyfileobj(src.extractfile('app.tgz'), out)
            fixed = Path(temp) / 'fixed.tgz'
            normalize(raw, fixed, True)
            with fixed.open('rb') as f:
                checksum = hashlib.file_digest(f, 'md5').hexdigest()
            manifest = src.extractfile('manifest').read().decode('utf-8')
            manifest = manifest.replace('\r\r\n', '\n').replace('\r\n', '\n')
            if len(re.findall(r'(?m)^checksum\s*=', manifest)) != 1:
                raise RuntimeError('Unexpected fnpack manifest checksum layout')
            manifest = re.sub(r'(?m)^checksum\s*=.*$', f'checksum = {checksum}', manifest).encode('utf-8')
            with open(target, 'wb') as out, gzip.GzipFile(filename='', mode='wb', fileobj=out, mtime=0) as gz, tarfile.open(fileobj=gz, mode='w', format=tarfile.USTAR_FORMAT) as dst:
                for member in src.getmembers():
                    member.uid = member.gid = 0
                    member.uname = member.gname = 'root'
                    member.mode = 0o755 if member.isdir() or member.name.startswith('cmd/') else 0o644
                    member.mtime = 0
                    member.pax_headers = {}
                    if member.name == 'app.tgz':
                        member.size = fixed.stat().st_size
                        with fixed.open('rb') as f:
                            dst.addfile(member, f)
                    elif member.name == 'manifest':
                        member.size = len(manifest)
                        dst.addfile(member, io.BytesIO(manifest))
                    else:
                        dst.addfile(member, src.extractfile(member) if member.isfile() else None)
        validate_fpk(target)
        return
    with tarfile.open(source, 'r:*') as src, tarfile.open(target, 'w:gz', format=tarfile.PAX_FORMAT) as dst:
        for member in src:
            if member.name.endswith('.DS_Store'):
                continue
            member.uid = member.gid = 0
            member.uname = member.gname = 'root'
            executable = member.name.startswith('cmd/') or member.name.startswith('bin/') or '/bin/' in member.name or member.name.endswith('.sh')
            member.mode = 0o755 if member.isdir() or executable else 0o644
            member.mtime = 0
            dst.addfile(member, src.extractfile(member) if member.isfile() else None)

def validate_fpk(path):
    with open(path, 'rb') as f:
        if f.read(2) != b'\x1f\x8b':
            raise ValueError('FPK must use the fnpack gzip container format')
    with tarfile.open(path, 'r:gz') as archive:
        manifest = archive.extractfile('manifest').read().decode('utf-8')
        checksums = re.findall(r'(?m)^checksum\s*=\s*([0-9a-f]{32})\s*$', manifest)
        with archive.extractfile('app.tgz') as f:
            actual = hashlib.file_digest(f, 'md5').hexdigest()
        if checksums != [actual]:
            raise ValueError('FPK manifest checksum does not match app.tgz')
        return actual

def build():
    ap = argparse.ArgumentParser()
    ap.add_argument('version', nargs='?', default='1.19.0')
    ap.add_argument('arch', nargs='?', choices=['x86_64', 'arm64'], default='x86_64')
    ap.add_argument('--revision', type=int, default=10)
    args = ap.parse_args()
    if not re.fullmatch(r'\d+\.\d+\.\d+', args.version) or args.revision < 1:
        ap.error('Use a stable numeric version and a positive revision')
    if args.arch != 'x86_64':
        ap.error('ARM64 is gated on x86_64 fnOS acceptance; no untested ARM package is produced')
    metadata = ROOT / 'downloads' / f'release-v{args.version}.json'
    if not metadata.exists():
        fetch(f'https://api.github.com/repos/anomalyco/opencode/releases/tags/v{args.version}', metadata)
    release = json.loads(metadata.read_text('utf-8'))
    if release['tag_name'] != f'v{args.version}' or release.get('draft') or release.get('prerelease'):
        raise RuntimeError('Release tag is not the requested stable release')
    asset = next(a for a in release['assets'] if a['name'] == 'opencode-linux-x64-baseline.tar.gz')
    expected = asset.get('digest', '')
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', expected):
        raise RuntimeError('Official release metadata lacks a SHA256 digest; refusing unverified binary')
    archive = ROOT / 'downloads' / f"v{args.version}-{asset['name']}"
    if not archive.exists():
        fetch(asset['browser_download_url'], archive)
    actual = digest(archive)
    if actual != expected[7:]:
        raise RuntimeError('OpenCode archive SHA256 mismatch')
    stage = ROOT / '.build' / f'opencode-{args.version}-{args.arch}'
    stage.mkdir(parents=True, exist_ok=True)
    shutil.copytree(ROOT / 'opencode-fnos', stage, dirs_exist_ok=True, ignore=shutil.ignore_patterns('.DS_Store', 'opencode', '__pycache__', '*.pyc'))
    with tarfile.open(archive) as src:
        entries = [m for m in src if m.isfile()]
        binary = next(m for m in entries if m.name.removeprefix('./') == 'opencode')
        if len(entries) != 1:
            raise RuntimeError('Release layout changed: review helper files before packaging')
        destination = stage / 'app' / 'bin' / 'opencode'
        destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.open('wb') as out:
            shutil.copyfileobj(src.extractfile(binary), out)
        destination.chmod(0o755)
        header = destination.open('rb').read(20)
        if header[:4] != b'\x7fELF' or header[4:6] != b'\x02\x01' or int.from_bytes(header[18:20], 'little') != 62:
            raise RuntimeError('Expected an x86_64 Linux ELF binary')
    manifest = stage / 'manifest'
    content = re.sub(r'(?m)^version=.*$', f'version={args.version}-{args.revision}', manifest.read_text('utf-8'))
    manifest.write_text(content, encoding='utf-8', newline='\n')
    # Bundle pnpm and Maven without touching the host's global installations.
    pnpm_version = '10.18.3'
    pnpm_meta = ROOT / 'downloads' / f'pnpm-{pnpm_version}.json'
    if not pnpm_meta.exists():
        fetch(f'https://registry.npmjs.org/pnpm/{pnpm_version}', pnpm_meta)
    info = json.loads(pnpm_meta.read_text('utf-8'))
    pnpm_archive = ROOT / 'downloads' / f'pnpm-{pnpm_version}.tgz'
    if not pnpm_archive.exists():
        fetch(info['dist']['tarball'], pnpm_archive)
    integrity = info['dist']['integrity']
    if not integrity.startswith('sha512-') or base64.b64encode(hashlib.sha512(pnpm_archive.read_bytes()).digest()).decode() != integrity[7:]:
        raise RuntimeError('pnpm archive integrity mismatch')
    with tarfile.open(pnpm_archive) as src:
        src.extractall(stage / 'app/libexec/pnpm', filter='data')
    maven_version = '3.9.11'
    maven_archive = ROOT / 'downloads' / f'apache-maven-{maven_version}-bin.tar.gz'
    maven_checksum = maven_archive.with_suffix('.gz.sha512')
    maven_url = f'https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/{maven_version}/{maven_archive.name}'
    if not maven_archive.exists():
        fetch(maven_url, maven_archive)
    if not maven_checksum.exists():
        fetch(maven_url + '.sha512', maven_checksum)
    if hashlib.sha512(maven_archive.read_bytes()).hexdigest() != maven_checksum.read_text().split()[0].lower():
        raise RuntimeError('Apache Maven SHA512 mismatch')
    with tarfile.open(maven_archive) as src:
        src.extractall(stage / 'app/libexec', filter='data')
    for item in list((stage / 'cmd').iterdir()) + list((stage / 'app' / 'lib').glob('*.sh')):
        item.chmod(0o755)
    system = {'Windows': 'windows', 'Linux': 'linux', 'Darwin': 'darwin'}[platform.system()]
    machine = 'arm64' if platform.machine().lower() in ('arm64', 'aarch64') else 'amd64'
    fnpack = ROOT / 'tools' / ('fnpack.exe' if system == 'windows' else 'fnpack')
    if not fnpack.exists():
        fetch(f'https://static2.fnnas.com/fnpack/fnpack-1.2.3-{system}-{machine}', fnpack)
        fnpack.chmod(0o755)
    subprocess.run([str(fnpack), 'build', '--directory', str(stage)], cwd=stage, check=True)
    validate_fpk(stage / 'opencode-fnos.fpk')
    dist = ROOT / 'dist'
    dist.mkdir(exist_ok=True)
    result = dist / f'OpenCode-fnOS-{args.version}-{args.revision}-{args.arch}.fpk'
    normalize(stage / 'opencode-fnos.fpk', result)
    package_checksum = validate_fpk(result)
    result.with_suffix('.fpk.sha256').write_text(f'{digest(result)}  {result.name}\n', encoding='utf-8')
    evidence = {'upstream_tag': release['tag_name'], 'upstream_asset': asset['name'], 'upstream_sha256': actual, 'binary_sha256': digest(destination), 'fpk_sha256': digest(result), 'fnpack_version': '1.2.3', 'fnpack_sha256': digest(fnpack), 'pnpm_version': pnpm_version, 'pnpm_integrity': integrity, 'maven_version': maven_version, 'maven_sha512': maven_checksum.read_text().split()[0].lower(), 'unix_permissions_normalized': True, 'fnOS_device_tested': False}
    evidence.update(fpk_container='gzip+tar', app_tgz_md5=package_checksum, fpk_internal_checksum_verified=True)
    result.with_suffix('.build.json').write_text(json.dumps(evidence, indent=2) + '\n', encoding='utf-8')
    print(result)

if __name__ == '__main__':
    build()
