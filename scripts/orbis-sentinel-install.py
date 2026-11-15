"""Prepare trusted Sentinel tooling and activate its independently signed package."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import stat
import subprocess
import sys
import uuid
import weakref


OWNER = 0
PYTHON = Path('/usr/bin/python3')
TOOLKIT_COMMIT = '936e05fc13d45e68b6c99bb600ff5c5e5f9640d6'
TOOLKIT = {
    'activate_release.py': (28644, '0b4645072cb1de6251b27b5e063bdd38163078ea9c6b1ede7161ef89d71c924f'),
    'verify_release.py': (14462, '9461fb041d055bbae13cc3ce48f3daf09ff8835ceedb8a77c4bf15c237137629'),
    'stage_release.py': (21359, '0920770996fc7cd7c627edbb62bb6a0a8ab51dbae74348988959cabfeaefa142'),
    'bootstrap_verifier.py': (13977, '965002f855e940446951d27a2bd44a37043efa692d3e4ba56473bd5525de6e6c'),
    'LICENSE': (35149, '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986'),
}
RELEASE = {'version': '0.1.0-dev.11',
           'sha256': '11c45eec2da2a4a28790ce5b231f72a2256b440bda3abdf42511f5ac7db7ff1a',
           'sourceCommit': 'c9b44e69cb70fc0f8c7f48f4dd183b2c3f099f3a'}
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
_PREPARATIONS = weakref.WeakKeyDictionary()


class SentinelInstallError(ValueError):
    pass


def _seal(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


class Directory:
    def __init__(self, path, *, private=False):
        self.path = Path(path)
        self.private = private
        if (not self.path.is_absolute() or Path(os.path.abspath(self.path)) != self.path
                or any(ord(character) < 32 or ord(character) == 127 for character in str(self.path))):
            raise SentinelInstallError('Sentinel preparation requires a canonical protected directory')
        self.handles = [os.open('/', DIRECTORY_FLAGS)]
        try:
            for name in self.path.parts[1:]:
                self.handles.append(os.open(name, DIRECTORY_FLAGS, dir_fd=self.handles[-1]))
            self.check()
            if private and stat.S_IMODE(os.fstat(self.fd).st_mode) != 0o700:
                raise SentinelInstallError('Sentinel preparation requires a private directory')
        except BaseException:
            self.close()
            raise

    @property
    def fd(self):
        return self.handles[-1]

    def identity(self):
        return tuple((info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode)
                     for info in map(os.fstat, self.handles))

    def check(self):
        for descriptor in self.handles:
            info = os.fstat(descriptor)
            if info.st_uid not in {0, OWNER} or info.st_mode & 0o022:
                raise SentinelInstallError('Sentinel preparation has an untrusted ancestor')
        if self.private and stat.S_IMODE(os.fstat(self.fd).st_mode) != 0o700:
            raise SentinelInstallError('Sentinel preparation directory is no longer private')
        for parent, child, name in zip(self.handles, self.handles[1:], self.path.parts[1:]):
            current = os.stat(name, dir_fd=parent, follow_symlinks=False)
            info = os.fstat(child)
            if not stat.S_ISDIR(current.st_mode) or (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
                raise SentinelInstallError('Sentinel preparation directory changed')

    def mkdir(self, name, *, existing=False):
        if not re.fullmatch(r'[a-z][a-z0-9-]*', name):
            raise SentinelInstallError('Sentinel preparation directory name is invalid')
        self.check()
        created = False
        try:
            os.mkdir(name, 0o700, dir_fd=self.fd)
            created = True
        except FileExistsError:
            if not existing:
                raise
        if created:
            descriptor = os.open(name, DIRECTORY_FLAGS, dir_fd=self.fd)
            try:
                os.fchmod(descriptor, 0o700)
            finally:
                os.close(descriptor)
        self.check()
        with Directory(self.path / name, private=True) as child:
            if os.fstat(child.fd).st_uid != OWNER:
                raise SentinelInstallError('Sentinel preparation directory has a foreign owner')
        return self.path / name

    def close(self):
        for descriptor in reversed(self.handles):
            os.close(descriptor)
        self.handles.clear()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def require_host():
    if (sys.platform != 'linux' or os.getuid() != 0 or os.geteuid() != 0
            or platform.machine().lower() not in {'x86_64', 'amd64', 'aarch64', 'arm64'}):
        raise SentinelInstallError('Sentinel installation requires a Linux AMD64 or ARM64 root operator')
    with Directory(Path('/run/systemd/system')):
        pass


def _file(path, size, digest, *, mode=0o600, expected=None, maximum=None):
    with Directory(path.parent) as parent:
        descriptor = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=parent.fd)
        try:
            before = os.fstat(descriptor)
            if (not stat.S_ISREG(before.st_mode) or before.st_uid != OWNER or before.st_nlink != 1
                    or stat.S_IMODE(before.st_mode) != mode or not 0 < before.st_size <= (maximum or size)
                    or (size and before.st_size != size)):
                raise SentinelInstallError('Sentinel preparation file has an untrusted identity')
            actual = hashlib.sha256()
            count = 0
            while chunk := os.read(descriptor, 65536):
                count += len(chunk)
                if count > before.st_size:
                    raise SentinelInstallError('Sentinel preparation file exceeds its size')
                actual.update(chunk)
            identity = _seal(before)
            parent.check()
            if ((digest and actual.hexdigest() != digest) or count != before.st_size or _seal(os.fstat(descriptor)) != identity
                    or _seal(os.stat(path.name, dir_fd=parent.fd, follow_symlinks=False)) != identity
                    or (expected is not None and identity != expected)):
                raise SentinelInstallError('Sentinel preparation file changed')
            return {'path': path, 'bytes': count, 'sha256': actual.hexdigest(), 'mode': mode, 'identity': identity}
        finally:
            os.close(descriptor)


def _python():
    path = PYTHON.resolve(strict=True)
    with Directory(path.parent):
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != OWNER or info.st_mode & 0o7022 or not info.st_mode & 0o111:
            raise SentinelInstallError('The system Python interpreter is not trusted')
        return path, _seal(info)


def _environment(work):
    return {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'TMPDIR': str(work / 'tmp'),
            'XDG_CACHE_HOME': str(work / 'cache'), 'XDG_CONFIG_HOME': str(work / 'config'),
            'XDG_STATE_HOME': str(work / 'state'), 'XDG_DATA_HOME': str(work / 'data'),
            'PYTHONDONTWRITEBYTECODE': '1'}


def _run(work, name, code, arguments, *, timeout=60, descriptors=()):
    interpreter, identity = _python()
    with Directory(work, private=True) as directory:
        result = subprocess.run([str(interpreter), '-I', '-B', '-c', code, *map(str, arguments)],
            cwd=work, env=_environment(work), stdin=subprocess.DEVNULL, capture_output=True,
            timeout=timeout, pass_fds=descriptors)
        directory.check()
        if _seal(interpreter.lstat()) != identity:
            raise SentinelInstallError('The system Python interpreter changed')
        if len(result.stdout) > 65536 or len(result.stderr) > 16384:
            raise SentinelInstallError('Sentinel preparation command exceeded its output limit')
        for extension, body in (('stdout', result.stdout), ('stderr', result.stderr)):
            descriptor = os.open(name + '.' + extension, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                 0o600, dir_fd=directory.fd)
            with os.fdopen(descriptor, 'wb') as output:
                os.fchmod(output.fileno(), 0o600)
                output.write(body)
                output.flush()
                os.fsync(output.fileno())
        if result.returncode:
            raise SentinelInstallError('Sentinel preparation or activation did not complete; private files were retained')
        return result.stdout


DOWNLOAD = r'''
import hashlib, os, sys
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
url, descriptor, maximum, size, expected = sys.argv[1:]
descriptor, maximum, size = int(descriptor), int(maximum), int(size)
assert urlsplit(url).scheme == 'https'
digest, count = hashlib.sha256(), 0
with urlopen(Request(url, headers={'User-Agent': 'Orbis-Sentinel-installer/1'}), timeout=15) as response:
    assert response.status == 200
    final = urlsplit(response.geturl())
    assert final.scheme == 'https' and final.hostname in {
        'raw.githubusercontent.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'}
    with os.fdopen(descriptor, 'wb', closefd=False) as output:
        while chunk := response.read(65536):
            count += len(chunk)
            assert count <= maximum
            digest.update(chunk)
            output.write(chunk)
        assert count > 0 and (size == 0 or count == size) and (not expected or digest.hexdigest() == expected)
        output.flush()
        os.fsync(output.fileno())
'''


def _download(work, path, url, maximum, *, size=0, digest=''):
    with Directory(path.parent, private=True) as parent:
        descriptor = os.open(path.name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                             0o600, dir_fd=parent.fd)
        before = os.fstat(descriptor)
        try:
            os.fchmod(descriptor, 0o600)
            _run(work, 'download-' + path.stem.replace('_', '-'), DOWNLOAD,
                 [url, descriptor, maximum, size, digest], descriptors=(descriptor,))
            parent.check()
            after = os.stat(path.name, dir_fd=parent.fd, follow_symlinks=False)
            if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
                raise SentinelInstallError('Sentinel download destination changed')
        finally:
            os.close(descriptor)
    return _file(path, size, digest, maximum=maximum)


def _check_files(files):
    for record in files:
        _file(record['path'], record['bytes'], record['sha256'], mode=record['mode'], expected=record['identity'])


def _json(body):
    def pairs(items):
        result = dict(items)
        if len(result) != len(items):
            raise SentinelInstallError('Sentinel preparation returned ambiguous metadata')
        return result
    return json.loads(body, object_pairs_hook=pairs)


class Prepared:
    def __init__(self, work, identity, files, release, verifier):
        self.work, self.identity, self.files = work, identity, files
        self.release, self.verifier, self.used = release, verifier, False


def prepare(state_dir):
    return _prepare(state_dir, _release_identity(RELEASE), pinned=True)


def prepare_release(state_dir, release):
    return _prepare(state_dir, _release_identity(release), pinned=False)


def _release_identity(value):
    if (type(value) is not dict or set(value) != {'version', 'sha256', 'sourceCommit'}
            or any(type(item) is not str for item in value.values())):
        raise SentinelInstallError('Choose one complete Sentinel release identity')
    version = value['version']
    if (not 0 < len(version) <= 128 or not re.fullmatch(
            r'(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?', version)
            or not re.fullmatch(r'[0-9a-f]{64}', value['sha256'])
            or not re.fullmatch(r'[0-9a-f]{40}', value['sourceCommit'])):
        raise SentinelInstallError('Sentinel release version, checksum or source revision is invalid')
    prerelease = version.split('+', 1)[0].partition('-')[2]
    build = version.partition('+')[2]
    for identifiers, numeric in ((prerelease, True), (build, False)):
        if identifiers and any(not part or (numeric and part.isdigit() and len(part) > 1 and part.startswith('0'))
                               for part in identifiers.split('.')):
            raise SentinelInstallError('Sentinel release version is not canonical')
    return dict(value)


def _preparation_identity(prepared):
    return (prepared.work, prepared.identity, prepared.verifier,
            tuple(sorted(prepared.release.items())),
            tuple((record['path'], record['bytes'], record['sha256'], record['mode'], record['identity'])
                  for record in prepared.files))


def _prepare(state_dir, release, *, pinned):
    require_host()
    with Directory(state_dir, private=True) as state:
        work = state.mkdir('sentinel-install-' + uuid.uuid4().hex)
        verifiers = state.mkdir('sentinel-verifiers', existing=True)
    with Directory(work, private=True) as directory:
        for name in ('toolkit', 'inputs', 'tmp', 'cache', 'config', 'state', 'data', 'validated-releases'):
            directory.mkdir(name)
        files = []
        for name, (size, digest) in TOOLKIT.items():
            source = name if name == 'LICENSE' else 'packaging/' + name
            url = 'https://raw.githubusercontent.com/twentylines/orbis-sentinel/' + TOOLKIT_COMMIT + '/' + source
            files.append(_download(work, work / 'toolkit' / name, url, size, size=size, digest=digest))
        _check_files(files)
        spec = _json(_run(work, 'verifier-spec',
            "import json,sys;sys.path.insert(0,sys.argv[1]);import bootstrap_verifier as b;print(json.dumps(b.verifier_spec()))",
            [work / 'toolkit']))
        if (not isinstance(spec, dict) or spec.get('version') != '2.103.3' or spec.get('architecture') not in {'amd64', 'arm64'}
                or type(spec.get('archiveBytes')) is not int or not 0 < spec['archiveBytes'] < 32 * 1024 * 1024
                or not re.fullmatch(r'[0-9a-f]{64}', str(spec.get('archiveSha256', '')))
                or type(spec.get('binaryBytes')) is not int or not 0 < spec['binaryBytes'] < 64 * 1024 * 1024
                or not re.fullmatch(r'[0-9a-f]{64}', str(spec.get('binarySha256', '')))
                or spec.get('url') != 'https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_linux_' + spec['architecture'] + '.tar.gz'):
            raise SentinelInstallError('Pinned verifier metadata is unavailable')
        files.append(_download(work, work / 'inputs' / 'github-cli.tar.gz', spec['url'], spec['archiveBytes'],
                               size=spec['archiveBytes'], digest=spec['archiveSha256']))
        _check_files(files)
        result = _json(_run(work, 'bootstrap-verifier',
            "import json,pathlib,sys;sys.path.insert(0,sys.argv[1]);import bootstrap_verifier as b;print(json.dumps({'verifier':str(b.bootstrap_verifier(pathlib.Path(sys.argv[2]),pathlib.Path(sys.argv[3])))}))",
            [work / 'toolkit', work / 'inputs' / 'github-cli.tar.gz', verifiers]))
        verifier = Path(result['verifier'])
        if not verifier.is_absolute() or not verifier.is_relative_to(verifiers):
            raise SentinelInstallError('Prepared verifier is outside its protected cache')
        files.append(_file(verifier, spec['binaryBytes'], spec['binarySha256'], mode=0o555))
        filename = 'orbis-sentinel-' + release['version'] + '.tar.gz'
        url = 'https://github.com/twentylines/orbis-sentinel/releases/download/v' + release['version'] + '/' + filename
        files.append(_download(work, work / 'inputs' / filename, url, 72 * 1024 * 1024, digest=release['sha256']))
        files.append(_download(work, work / 'inputs' / (filename + '.sigstore.json'), url + '.sigstore.json', 4 * 1024 * 1024))
        _check_files(files)
        validated = _json(_run(work, 'verify-package',
            "import runpy,sys;sys.path.insert(0,sys.argv[1]);sys.argv=sys.argv[2:];runpy.run_path(sys.argv[0],run_name='__main__')",
            [work / 'toolkit', work / 'toolkit' / 'verify_release.py', '--artifact', work / 'inputs' / filename,
             '--bundle', work / 'inputs' / (filename + '.sigstore.json'), '--workspace', work / 'publisher-verification',
             '--releases', work / 'validated-releases', '--verifier', verifier, '--sha256', release['sha256'],
             '--version', release['version'], '--source-commit', release['sourceCommit']], timeout=90))
        _confirmed(validated, release, activated=False)
        _check_files(files)
        directory.check()
        prepared = Prepared(work, directory.identity(), files, release, verifier)
        _PREPARATIONS[prepared] = (_preparation_identity(prepared), pinned)
        return prepared


def _confirmed(result, release, *, activated):
    if (not isinstance(result, dict) or result.get('activated') is not activated or result.get('publisherVerified') is not True
            or any(result.get(key) != release[key] for key in ('version', 'sha256', 'sourceCommit'))
            or (activated and (type(result.get('retainedVersionsRemoved')) is not int or result['retainedVersionsRemoved'] != 0))):
        raise SentinelInstallError('Sentinel did not confirm the verified component identity')


def activate(prepared):
    require_host()
    if not isinstance(prepared, Prepared) or prepared.used:
        raise SentinelInstallError('Sentinel preparation has already been consumed')
    prepared.used = True
    sealed = _PREPARATIONS.pop(prepared, None)
    try:
        current = _preparation_identity(prepared)
    except (TypeError, KeyError, AttributeError):
        raise SentinelInstallError('Prepared Sentinel identity changed') from None
    if sealed is None or current != sealed[0] or (sealed[1] and prepared.release != RELEASE):
        raise SentinelInstallError('Prepared Sentinel identity changed')
    with Directory(prepared.work, private=True) as directory:
        if directory.identity() != prepared.identity:
            raise SentinelInstallError('Prepared Sentinel namespace changed')
        _check_files(prepared.files)
        filename = 'orbis-sentinel-' + prepared.release['version'] + '.tar.gz'
        result = _json(_run(prepared.work, 'activate-sentinel',
            "import runpy,sys;sys.argv=sys.argv[1:];runpy.run_path(sys.argv[0],run_name='__main__')",
            [prepared.work / 'toolkit' / 'activate_release.py', '--artifact', prepared.work / 'inputs' / filename,
             '--bundle', prepared.work / 'inputs' / (filename + '.sigstore.json'), '--workspace', prepared.work / 'verification',
             '--verifier', prepared.verifier, '--sha256', prepared.release['sha256'], '--version', prepared.release['version'],
             '--source-commit', prepared.release['sourceCommit']], timeout=None))
        directory.check()
        _confirmed(result, prepared.release, activated=True)
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-dir', type=Path, required=True)
    parser.add_argument('--prepare-only', action='store_true')
    parser.add_argument('--release-version')
    parser.add_argument('--release-sha256')
    parser.add_argument('--release-source-commit')
    args = parser.parse_args()
    try:
        selected = (args.release_version, args.release_sha256, args.release_source_commit)
        if any(value is not None for value in selected):
            if any(value is None for value in selected):
                raise SentinelInstallError('Choose a release version, checksum and source revision together')
            prepared = prepare_release(args.state_dir, {
                'version': args.release_version, 'sha256': args.release_sha256, 'sourceCommit': args.release_source_commit})
        else:
            prepared = prepare(args.state_dir)
        result = {'prepared': True, 'activated': False, 'version': prepared.release['version']} if args.prepare_only else activate(prepared)
    except (OSError, ValueError, subprocess.SubprocessError):
        parser.exit(1, 'Sentinel setup did not complete; retained preparation and activation records require inspection.\n')
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
