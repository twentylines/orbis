"""Exact release response replay for the disposable Linux upgrade fixture."""

from contextlib import contextmanager
from io import BytesIO
import json
import os
from pathlib import Path
import re
import site
import stat
import sys
import urllib.request
from urllib.error import HTTPError
from urllib.response import addinfourl


WORK = Path('/opt/orbis-official-upgrade-fixture')
REPO = 'twentylines/orbis'
MODULE = 'orbis_official_draft_fixture_transport'
TAG = re.compile(r'v[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+')
ASSETS = {'install-orbis.py': 1024 * 1024, 'orbis-installer-manifest.json': 65536,
          'orbis-installer.tar.gz': 64 * 1024 * 1024, 'release-manifest.json': 16384}
CORE_MANIFEST = 'release-manifest.json'
QUALIFIED_CORE_MANIFEST = 'qualified-release-manifest.json'


def require(condition):
    if not condition:
        raise ValueError('Draft fixture transport binding is invalid')


def private_directory(path):
    path = Path(path)
    require(path == path.resolve(strict=True))
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid() and not info.st_mode & 0o077)
    return path


def read(path, limit):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and not info.st_mode & 0o077
                and info.st_nlink == 1 and 0 < info.st_size <= limit)
        body = stream.read(limit + 1)
        require(len(body) == info.st_size)
        return body


def routes(directory, tags):
    directory = private_directory(directory)
    require(type(tags) is list and 1 <= len(tags) <= 2
            and all(type(tag) is str and TAG.fullmatch(tag) for tag in tags)
            and len(set(tags)) == len(tags))
    values = {}
    for tag in tags:
        release = private_directory(directory / tag)
        origin = f'https://github.com/{REPO}/releases/download/{tag}'
        limits = dict(ASSETS)
        if os.path.lexists(release / QUALIFIED_CORE_MANIFEST):
            require(not os.path.lexists(release / CORE_MANIFEST))
            limits[QUALIFIED_CORE_MANIFEST] = limits.pop(CORE_MANIFEST)
            values[f'{origin}/{CORE_MANIFEST}'] = None
        for file, limit in limits.items():
            values[f'{origin}/{file}'] = (release / file, limit)
        values[f'https://api.github.com/repos/{REPO}/releases/tags/{tag}'] = (release / 'metadata.json', 65536)
    return values


def replay(original, values):
    def open_url(url, *args, **kwargs):
        address = url.full_url if isinstance(url, urllib.request.Request) else url
        if address not in values:
            return original(url, *args, **kwargs)
        if isinstance(url, urllib.request.Request) and url.get_method() != 'GET':
            raise HTTPError(address, 405, 'Draft fixture supports readback only', {}, None)
        entry = values[address]
        if entry is None:
            raise HTTPError(address, 404, 'Draft fixture has no legacy manifest asset', {}, None)
        path, limit = entry
        return addinfourl(BytesIO(read(path, limit)), {'Content-Type': 'application/octet-stream'}, address, 200)
    return open_url


def install():
    # The runner startup file loads this in isolated Python processes too.
    # Non-root services and machines without the private fixture are unaffected.
    if sys.platform != 'linux' or os.getuid() != 0 or not WORK.is_dir():
        return
    directory = private_directory(WORK) / 'draft-release-responses'
    tags = json.loads(read(directory / 'tags.json', 4096))
    urllib.request.urlopen = replay(urllib.request.urlopen, routes(directory, tags))


@contextmanager
def activate():
    require(sys.platform == 'linux' and os.getuid() == os.geteuid() == 0
            and os.environ.get('GITHUB_ACTIONS') == 'true'
            and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
            and os.environ.get('GITHUB_REPOSITORY') == REPO
            and os.environ.get('GITHUB_REF') == 'refs/heads/main')
    private_directory(WORK)
    directory = WORK / 'draft-release-responses'
    values = routes(directory, json.loads(read(directory / 'tags.json', 4096)))
    require(all(read(*entry) for entry in values.values() if entry is not None))
    # Use a protected system site path on disposable Ubuntu. No product source
    # or installed unit is rewritten, including units that use Python -I.
    available = [Path(path) for path in site.getsitepackages() if path.startswith(('/usr/local/lib/', '/usr/lib/'))]
    writable = [path for path in available if path.is_dir() and path == path.resolve(strict=True)
                and all(parent.stat().st_uid == 0 and not parent.stat().st_mode & 0o022
                        for parent in (path, *path.parents))]
    require(writable)
    packages = writable[0]
    module = packages / f'{MODULE}.py'
    startup = packages / 'orbis-official-draft-fixture.pth'
    original = urllib.request.urlopen
    created = []
    try:
        for destination, body in ((module, Path(__file__).read_bytes()),
                                  (startup, f'import {MODULE}; {MODULE}.install()\n'.encode())):
            with destination.open('xb') as output:
                created.append(destination)
                output.write(body)
        urllib.request.urlopen = replay(original, values)
        yield
    finally:
        urllib.request.urlopen = original
        for path in reversed(created):
            path.unlink()
