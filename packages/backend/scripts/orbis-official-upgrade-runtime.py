#!/usr/bin/env python3
"""Qualify one official coordinated release update on a new hosted Linux runner."""

import ast
from contextlib import contextmanager
import errno
import hashlib
from http.client import HTTPConnection, HTTPException
import importlib.util
from io import BytesIO
import json
import os
from pathlib import Path
from types import SimpleNamespace
import platform
import pwd
import re
import secrets
import shutil
import signal
import stat
import subprocess
import sys
from threading import Event, Thread
import time
import traceback
from urllib.parse import quote
import uuid
from zoneinfo import ZoneInfo


WORK = Path('/opt/orbis-official-upgrade-fixture')
ROOT = WORK / 'server'
STATE = Path('/var/lib/orbis/state')
HOST = Path('/opt/orbis/host-service')
PORT = 18080
TLS_PORT = 18443
SCRIPTS = Path(__file__).resolve().parents[3] / 'scripts'
REPO = 'twentylines/orbis'
IMAGE = 'ghcr.io/' + REPO
SOURCE = ('v0.9.2-beta.3', '43813e77609f955c4a4cec3b647a95e780780ca6',
          'sha256:24d8ffed6dde1660b1954c445b2c67b96342b423b1042441d72c251a20d92801', '4.10.1', 46080825494)
BRIDGE = ('v0.9.2-beta.8', 'a5e56e900ea2022f663684e272ad6134df0cc7a0',
          'sha256:28fe9e83c597a3b955916c53f2445b19cc3224000961ddb45b6e11018af52eb4', '4.10.1', 46117877777)
STABLE = ('v0.9.1', '6b627e1939e11e91fbd5c6ed419e1e90a71cf281',
          'sha256:fcd6ddadf52d19aedc428cae04aea98f0baf4e36c12edab9a1239fa75c8248d2', '4.10.1', 44938065911)
# Keep historical rehearsals reproducible. The digest is separately checked against
# the exact successful publisher, source-bound release manifest and registry index.
TARGET_RELEASES = {
    'c9a0f76329e1319f6a1451fd1b8875cceb788dd8': ('v0.9.2-beta.6', 46100282294),
    'f7172eaad3cc4b645bce84662948cf2fa42a18ab': ('v0.9.2-beta.7', 46106118153),
    BRIDGE[1]: ('v0.9.2-beta.9', 46117878047),
}
SENTINEL = {'version': '0.1.0-dev.24', 'sha256': 'c9373a394c306524b2e37b76afa9eec42272507faf45657d7f46d1b9f8fb565f',
            'sourceCommit': '16b2aa6158ab38d961e0d3f6a2d489b702ab63e3'}
STABLE_SENTINEL = {'version': '0.1.0-dev.19', 'sha256': '4a3c29039b768dbae15a562abc64086374f66af9e12b8b490d3aa4466d152f6c',
                   'sourceCommit': '32e384d9d492d8b5cb1aea562bd86447e2cc04a0'}
PAIRED_SENTINEL = {'version': '0.1.0-dev.25', 'sha256': 'f6a90314f76a9e9367741e16ce55fc2bf8dd88105ac6964aea3d2c6ffb6c1f16',
                   'sourceCommit': '79df3acbdadb35630f471a35d17cd4d6a711eccb'}
ASSETS = {'install-orbis.py': 1024 * 1024, 'orbis-installer-manifest.json': 65536,
          'orbis-installer.tar.gz': 64 * 1024 * 1024, 'release-manifest.json': 16384}
DOCKER = ['/usr/bin/docker', '--context', 'default']
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C.UTF-8', 'TMPDIR': str(WORK / 'tmp')}
DIGEST = re.compile(r'sha256:[a-f0-9]{64}')


class Refused(ValueError):
    def __init__(self, code, **evidence):
        super().__init__(code)
        self.evidence = evidence


def require(condition, code):
    if not condition:
        raise Refused(code)


def load(name, directory=SCRIPTS):
    spec = importlib.util.spec_from_file_location('official_upgrade_fixture_' + name, directory / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha(body):
    return hashlib.sha256(body).hexdigest()


def target_pin(environment):
    commit, digest = environment.get('TARGET_COMMIT'), environment.get('TARGET_DIGEST', '')
    require(commit in TARGET_RELEASES and DIGEST.fullmatch(digest), 'target-pin-required')
    tag, workflow_run = TARGET_RELEASES[commit]
    return (tag, commit, digest, '4.12.0', workflow_run)


def source_pin(target):
    if target[1] == BRIDGE[1]:
        require(DIGEST.fullmatch(BRIDGE[2]), 'verified-recovery-bridge-pin-required')
        return BRIDGE
    return SOURCE


def sentinel_pin(pin):
    if pin == STABLE:
        return STABLE_SENTINEL
    return PAIRED_SENTINEL if pin[1] == BRIDGE[1] else SENTINEL


def run(args, *, timeout=20, allowed=(0,), code='native-command-refused'):
    result = subprocess.run(args, env=ENV, cwd=WORK if WORK.is_dir() else '/', stdin=subprocess.DEVNULL,
                            capture_output=True, check=False, text=True, timeout=timeout)
    require(result.returncode in allowed and len(result.stdout) <= 2 * 1024 * 1024, code)
    return result.stdout.strip()


def protect_installer_parent(environment):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    root_fd = os.open('/', flags)
    try:
        root = os.fstat(root_fd)
        require(root.st_uid == 0 and not root.st_mode & 0o022, 'installer-root-ancestor-refused')
        opt_fd = os.open('opt', flags, dir_fd=root_fd)
        try:
            before = os.fstat(opt_fd)
            mode = stat.S_IMODE(before.st_mode)
            if before.st_uid != 0 or mode & 0o022:
                # Orbis fixes Host and Sentinel paths under /opt. Restore only
                # the runner image's top-level directory to their normal policy.
                uid = environment.get('SUDO_UID', '')
                require(re.fullmatch(r'[1-9][0-9]{0,9}', uid) and pwd.getpwuid(int(uid)).pw_name == 'runner'
                        and before.st_uid in (0, int(uid)), 'installer-opt-ancestor-refused')
                if before.st_uid != 0:
                    os.fchown(opt_fd, 0, 0)
                if mode & 0o022:
                    os.fchmod(opt_fd, mode & ~0o022)
            after = os.stat('opt', dir_fd=root_fd, follow_symlinks=False)
            require((after.st_dev, after.st_ino) == (before.st_dev, before.st_ino)
                    and after.st_uid == 0 and after.st_mode & 0o022 == 0,
                    'installer-opt-ancestor-unverified')
        finally:
            os.close(opt_fd)
    finally:
        os.close(root_fd)



def prepare_fixture_workspace():
    # The runner image owns /opt. Its default ACL can survive chmod and be
    # inherited by a new directory. Clear it only on our empty fixture so the
    # stock installers and containers receive ordinary creation permissions.
    os.umask(0o022)
    WORK.mkdir(mode=0o700)
    descriptor = os.open(WORK, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(descriptor)
        require(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700,
                'fixture-workspace-permissions-refused')
        name = 'system.posix_acl_default'
        inherited = name in os.listxattr(descriptor)
        if inherited:
            os.removexattr(descriptor, name)
        require(name not in os.listxattr(descriptor), 'fixture-default-acl-unverified')
    finally:
        os.close(descriptor)
    (WORK / 'tmp').mkdir(mode=0o700)
    return inherited


def protect_fixture_timezone():
    # Hosted Ubuntu can expose zoneinfo through a world-writable /usr/share.
    # Keep the same timezone bytes in a protected regular /etc/localtime file
    # so the real Orbis bootstrap proof can verify its ordinary bind mount.
    directory = os.open('/etc', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    temporary = '.orbis-runtime-localtime'
    staged = False
    try:
        root, etc = Path('/').stat(), os.fstat(directory)
        require(all(info.st_uid == 0 and not info.st_mode & 0o022 for info in (root, etc)),
                'fixture-timezone-parent-refused')
        info = os.stat('localtime', dir_fd=directory, follow_symlinks=False)
        require(info.st_uid == 0, 'fixture-timezone-owner-refused')
        if not stat.S_ISLNK(info.st_mode):
            require(stat.S_ISREG(info.st_mode) and not info.st_mode & 0o022,
                    'fixture-timezone-file-refused')
            return False
        pointer = os.readlink('localtime', dir_fd=directory)
        resolved = Path('/etc/localtime').resolve(strict=True)
        require(resolved.is_relative_to('/usr/share/zoneinfo'), 'fixture-timezone-location-refused')
        with os.fdopen(os.open(resolved, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as source:
            observed = os.fstat(source.fileno())
            require(observed.st_uid == 0 and stat.S_ISREG(observed.st_mode) and 0 < observed.st_size <= 1024 * 1024,
                    'fixture-zoneinfo-source-refused')
            data = source.read(observed.st_size + 1)
            require(len(data) == observed.st_size, 'fixture-zoneinfo-size-changed')
        ZoneInfo.from_file(BytesIO(data))
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=directory)
        staged = True
        with os.fdopen(descriptor, 'wb') as output:
            os.fchmod(output.fileno(), 0o644)
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        current = os.stat('localtime', dir_fd=directory, follow_symlinks=False)
        require((current.st_dev, current.st_ino, current.st_mode) == (info.st_dev, info.st_ino, info.st_mode)
                and os.readlink('localtime', dir_fd=directory) == pointer, 'fixture-timezone-link-changed')
        os.replace(temporary, 'localtime', src_dir_fd=directory, dst_dir_fd=directory)
        staged = False
        os.fsync(directory)
        return True
    finally:
        if staged:
            os.unlink(temporary, dir_fd=directory)
        os.close(directory)


def preflight(environment):
    require(os.getuid() == os.geteuid() == 0 and sys.platform == 'linux' and platform.machine() == 'x86_64'
            and environment.get('GITHUB_ACTIONS') == 'true' and environment.get('RUNNER_ENVIRONMENT') == 'github-hosted'
            and environment.get('GITHUB_REPOSITORY') == REPO and environment.get('GITHUB_REF') == 'refs/heads/main'
            and Path('/run/systemd/system').is_dir(), 'hosted-root-scope-required')
    os_release = platform.freedesktop_os_release()
    require((os_release.get('ID'), os_release.get('VERSION_ID'), os_release.get('VERSION_CODENAME'))
            == ('ubuntu', '24.04', 'noble'), 'hosted-ubuntu-24-04-required')
    require(all(not os.path.lexists(path) for path in (WORK, HOST, Path('/var/lib/orbis'), Path('/opt/orbis-sentinel'),
                Path('/var/lib/orbis-sentinel'), Path('/run/orbis'), Path('/etc/systemd/system/orbis-host.service'))),
            'existing-installation-refused')
    prerequisites = load('orbis-install-prerequisites')
    try:
        ready = prerequisites.inspect('default')['kind'] == 'ready'
        missing = prerequisites.required_tools()
    except prerequisites.PrerequisiteError:
        raise Refused('docker-prerequisite-check-refused') from None
    require(ready, 'docker-prerequisites-not-ready')
    require(not missing, 'backup-prerequisites-not-ready')
    require(not run(DOCKER + ['ps', '-aq', '--filter', 'label=com.docker.compose.project=runtipi']),
            'runtipi-containers-exist')
    require(not run(DOCKER + ['network', 'ls', '-q', '--filter', 'label=com.docker.compose.project=runtipi']),
            'runtipi-networks-exist')
    docker_root = Path(run(DOCKER + ['info', '--format', '{{.DockerRootDir}}']))
    require(docker_root.is_absolute() and all(shutil.disk_usage(path).free >= 4 * 1024**3
            for path in (WORK.parent, docker_root, Path('/var/lib'))), 'disposable-space-required')
    protect_installer_parent(environment)
    default_acl_removed = prepare_fixture_workspace()
    return default_acl_removed, protect_fixture_timezone()


def isolate_dashboard():
    # Drop ingress before Docker's destination NAT. Host loopback requests
    # follow the local output path, so the real proxy remains available.
    rule = ['!', '-i', 'lo', '-p', 'tcp', '-m', 'multiport', '--dports',
            f'{PORT},{TLS_PORT}', '-j', 'DROP']
    for binary in ('/usr/sbin/iptables', '/usr/sbin/ip6tables'):
        command = [binary, '--wait', '5', '-t', 'raw']
        run(command + ['-I', 'PREROUTING', '1', *rule], code='dashboard-isolation-refused')
        run(command + ['-C', 'PREROUTING', *rule], code='dashboard-isolation-unverified')


def installer_signals(files):
    """Index public fatal messages from the verified publisher source closure."""
    signals = []
    for name, body in files.items():
        if not re.fullmatch(r'scripts/(?:install-orbis|orbis-[a-z0-9-]+)\.py', name):
            continue
        for node in ast.walk(ast.parse(body)):
            if isinstance(node, ast.Raise):
                error = node.exc
            elif (isinstance(node, ast.Return) and isinstance(node.value, ast.Call)
                  and isinstance(node.value.func, ast.Name) and node.value.func.id.endswith('Error')):
                error = node.value
            else:
                continue
            if not isinstance(error, ast.Call) or not error.args:
                continue
            text = error.args[0]
            while isinstance(text, ast.BinOp) and isinstance(text.op, ast.Add):
                text = text.left
            exact = text is error.args[0] and isinstance(text, ast.Constant)
            if isinstance(text, ast.JoinedStr) and text.values:
                text = text.values[0]
            if isinstance(text, ast.Constant) and isinstance(text.value, str) and 16 <= len(text.value) <= 4096:
                signals.append((text.value.encode(), exact, f'{name.removeprefix("scripts/")}:{node.lineno}'))
    return signals


def publisher(pin, reader, boot, launcher, token):
    tag, commit, digest, base, run_id = pin
    api = reader.GITHUB_API
    headers = {'Accept': 'application/vnd.github+json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token

    def fetch(url, limit):
        return reader.read_url(url, limit, headers if url.startswith(api + '/') else None)[0]

    publication = json.loads(fetch(f'{api}/actions/runs/{run_id}', 512 * 1024))
    require((publication.get('conclusion'), publication.get('head_sha'), publication.get('path', '').partition('@')[0])
            == ('success', commit, '.github/workflows/release.yml'), 'official-publisher-mismatch')
    checked = reader.check(tag)
    require((checked['tag'], checked['commit'], checked['image'], checked['runtipiCompatibility'],
             checked['installationProtocol']) == (tag, commit, f'{IMAGE}@{digest}', base, 'orbis.installation-state.v1')
            and 'linux/amd64' in checked['platforms'], 'official-image-mismatch')

    published = json.loads(fetch(f'{api}/releases/tags/{tag}', 512 * 1024))
    assets = published['assets']
    require(published.get('tag_name') == tag and published.get('draft') is False
            and published.get('prerelease') is (pin != STABLE)
            and len(assets) == len(ASSETS) and {asset['name'] for asset in assets} == set(ASSETS), 'official-assets-mismatch')
    files = {}
    for asset in assets:
        name = asset['name']
        url = f'https://github.com/{REPO}/releases/download/{tag}/{name}'
        require(asset['browser_download_url'] == url, 'official-asset-url-mismatch')
        body = fetch(url, ASSETS[name])
        require(len(body) == asset['size'] and 'sha256:' + sha(body) == asset.get('digest'), 'official-asset-hash-mismatch')
        files[name] = body
    identity = launcher.literal(files['install-orbis.py'], 'EXPECTED_RELEASE')
    require(identity.get('tag') == tag and identity.get('commit') == commit, 'official-launcher-mismatch')
    manifest, closure = boot.verify_source_package(files[boot.MANIFEST], identity, files[boot.ARCHIVE])
    core = json.loads(files['release-manifest.json'])
    template = closure['scripts/install-orbis.py']
    require(sha(files['release-manifest.json']) == manifest['releaseManifestSha256']
            and (core['tag'], core['commit'], core['image'], core['digest'], core['runtipiCompatibility'],
                 core['installationProtocol']) == (tag, commit, IMAGE, digest, base, 'orbis.installation-state.v1')
            and boot._render_installer('release', identity, template) == files['install-orbis.py'],
            'official-source-closure-mismatch')
    launcher.authenticate_tree(fetch, commit, closure)
    path = WORK / (tag + '.py')
    with path.open('xb') as output:
        output.write(files['install-orbis.py'])
    return path, installer_signals(closure), {name: (len(body), sha(body)) for name, body in closure.items()}


def installer_failure(path, signals=()):
    """Classify bounded launcher evidence. Raw logs stay on the runner."""
    with path.open('rb') as log:
        log.seek(max(0, path.stat().st_size - 128 * 1024))
        tail = log.read(128 * 1024).splitlines()
    known = {
        b'Automatic Docker setup supports ': 'guided-docker-platform-refused',
        b'Automatic Docker setup requires ': 'guided-docker-endpoint-refused',
        b'Installer working directory ': 'guided-installer-storage-refused',
        b'The installation parent must be root-owned ': 'guided-installation-parent-refused',
        b'HTTP Error ': 'guided-publisher-request-refused',
        b'Host administration requires ': 'guided-systemd-prerequisite-refused',
        b'The supported local package boundary ': 'guided-docker-platform-refused',
    }
    steps = {
        b'Detecting existing installations': 'detect',
        b'Checking managed-container ownership': 'ownership',
        b'Verifying the Orbis release': 'verify-release',
        b'Downloading the verified Orbis image': 'pull-core',
        b'Preparing Sentinel': 'prepare-sentinel',
        b'Enabling Sentinel': 'enable-sentinel',
        b'Downloading postgres': 'pull-postgres',
        b'Downloading rabbitmq': 'pull-rabbitmq',
        b'Downloading traefik': 'pull-proxy',
        b'Starting Orbis and checking its health': 'start-core',
        b'Enabling system administration': 'enable-host',
        b'Checking the release and update readiness': 'review-upgrade',
        b'Updating Orbis and verifying server health': 'apply-upgrade',
    }
    evidence = {}
    for line in tail:
        step = re.fullmatch(rb'(?:\[[0-9]{1,3}/[0-9]{1,3}\] )?(.{1,90})\.\.\.', line)
        if step and step[1] in steps:
            evidence['installerStep'] = steps[step[1]]
        elif line.startswith(b'Verified installer. Recovery files: '):
            evidence['installerStep'] = 'verified-launcher'
    for line in reversed(tail):
        for prefix in (b'Orbis installer could not start: ', b'Orbis installation stopped: '):
            if line.startswith(prefix):
                message = line[len(prefix):]
                number = re.match(rb'\[Errno ([0-9]{1,3})\] ', message)
                if number:
                    category = errno.errorcode.get(int(number[1]))
                    if category in ('EACCES', 'EPERM', 'ENOENT', 'EIO', 'ENOSPC', 'EROFS', 'ELOOP', 'EBUSY'):
                        evidence['installerErrno'] = category
                matches = [(exact, len(text), site) for text, exact, site in signals
                           if (message == text if exact else message.startswith(text))]
                if matches:
                    specificity = max((exact, length) for exact, length, _ in matches)
                    evidence['installerFailureSites'] = sorted({site for exact, length, site in matches
                                                               if (exact, length) == specificity})[:4]
                fallback = 'guided-launcher-refused' if prefix.startswith(b'Orbis installer ') else 'guided-installer-refused'
                return next((code for signal, code in known.items() if message.startswith(signal)), fallback), evidence
    return 'guided-installer-refused', evidence


def fresh_journal_evidence(pin):
    launcher = load('orbis-host-upgrade-launcher')
    pointer = launcher.decoded(launcher.read_file(ROOT / '.orbis-installation.json', 16384))
    if (pointer.get('schema'), pointer.get('kind'), pointer.get('root'), pointer.get('dockerContext')) != (
            'orbis.installer-pointer.v1', 'new', str(ROOT), 'default'):
        return None
    path = Path(pointer['journal'])
    parts = path.relative_to(WORK / 'source' / 'custody').parts
    if (len(parts) != 4 or not re.fullmatch(re.escape(pin[0]) + r'-[a-z0-9_]{8}', parts[0])
            or parts[1] != 'transactions'
            or not re.fullmatch(r'new-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}', parts[2])
            or parts[3] != 'transaction.json'):
        return None
    journal = launcher.decoded(launcher.read_file(path, 64 * 1024))
    identity = journal.get('manifest', {})
    if ((journal.get('schema'), journal.get('root'), journal.get('dockerContext'))
            != ('orbis.new-installation.v2', str(ROOT), 'default')
            or tuple(identity.get(field) for field in ('tag', 'commit', 'digest')) != pin[:3]
            or 'installerStorage' in journal):
        return None
    phase = journal.get('stage')
    custody = path.parents[2]
    executor = custody / 'scripts/orbis-install-new.py'
    if (phase not in ('prepared', 'starting', 'enrolled', 'complete')
            or pointer.get('executor') != str(executor)
            or not re.fullmatch(r'[a-f0-9]{64}', pointer.get('executorSha256', ''))):
        return None
    return phase, custody, pointer['executorSha256']


def fresh_journal_phase(pin=SOURCE):
    evidence = fresh_journal_evidence(pin)
    return evidence[0] if evidence is not None else None


def fresh_startup_evidence(pin=SOURCE):
    evidence = {}
    try:
        phase = fresh_journal_phase(pin)
        if phase:
            evidence['freshJournalPhase'] = phase
        if phase in ('starting', 'enrolled', 'complete'):
            host = load('orbis-host')
            probe = subprocess.run(DOCKER + host.compose_args(ROOT) + ['config', '--quiet'], env=ENV, cwd=ROOT,
                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   check=False, timeout=8)
            evidence['composeConfigValid'] = probe.returncode == 0
    except (OSError, ValueError, KeyError, TypeError, RuntimeError, subprocess.SubprocessError):
        pass

    names = ('runtipi', 'runtipi-db', 'runtipi-queue', 'runtipi-reverse-proxy')
    try:
        inventory = run(DOCKER + ['container', 'ls', '--all', '--no-trunc',
                        '--filter', 'label=com.docker.compose.project=runtipi',
                        '--filter', 'label=com.docker.compose.project.working_dir=' + str(ROOT),
                        '--format', '{{.ID}} {{.Names}}'], timeout=8)
        owned = {name: identifier for line in inventory.splitlines() if ' ' in line
                 for identifier, name in [line.split(' ', 1)]
                 if name in names and re.fullmatch(r'[a-f0-9]{64}', identifier)}
    except (OSError, ValueError, subprocess.SubprocessError):
        return evidence
    template = ('{"service":{{json (index .Config.Labels "com.docker.compose.service")}},'
                '"project":{{json (index .Config.Labels "com.docker.compose.project")}},'
                '"root":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},'
                '"status":{{json .State.Status}},"exitCode":{{json .State.ExitCode}},'
                '"oom":{{json .State.OOMKilled}},"hasEngineError":{{if .State.Error}}true{{else}}false{{end}},'
                '"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}"none"{{end}}}')
    rows = {}
    for name in names:
        identifier = owned.get(name)
        rows[name] = {'status': 'not-observed' if not identifier else 'unavailable'}
        if not identifier:
            continue
        try:
            state = json.loads(run(DOCKER + ['container', 'inspect', '--format', template, identifier], timeout=8))
            if (state['service'], state['project'], state['root']) != (name, 'runtipi', str(ROOT)):
                continue
            rows[name] = {
                'status': state['status'] if state['status'] in ('created', 'running', 'paused', 'restarting', 'exited', 'dead') else 'unknown',
                'health': state['health'] if state['health'] in ('starting', 'healthy', 'unhealthy') else 'none',
                'exitCode': state['exitCode'] if type(state['exitCode']) is int and 0 <= state['exitCode'] <= 255 else None,
                'oom': state['oom'] is True,
                'hasEngineError': state['hasEngineError'] is True,
            }
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
            pass
    evidence['startupServices'] = rows
    return evidence



def proxy_startup_probe(pin, closure):
    # Only the validated v1 pointer and journal establish the legacy layout.
    # Unsupported or unverifiable storage does not authorize another observer.
    try:
        evidence = fresh_journal_evidence(pin)
    except (OSError, ValueError, RuntimeError, KeyError, TypeError):
        evidence = None
    if evidence is None or evidence[0] != 'starting':
        return {'proxyObservation': 'layout-unverified'}
    _, custody, executor_sha = evidence
    # Report fixed role names and classes only.
    roles = {
        'fixture-parent': (ROOT.parent, False, False),
        'installation-root': (ROOT, False, False),
        'proxy-identity': (ROOT.parent / ('.' + ROOT.name + '.orbis-proxy-identity'), False, True),
        'proxy-receipt': (ROOT.parent / ('.' + ROOT.name + '.orbis-proxy-identity.json'), True, True),
        'proxy-config-directory': (ROOT / 'traefik', False, False),
        'proxy-config': (ROOT / 'traefik' / 'traefik.yml', True, False),
    }
    roles_out = {}
    for role, (path, regular, private) in roles.items():
        try:
            info = path.lstat()
        except FileNotFoundError:
            roles_out[role] = 'absent'
            continue
        except OSError:
            roles_out[role] = 'unavailable'
            continue
        expected_type = stat.S_ISREG if regular else stat.S_ISDIR
        if not expected_type(info.st_mode):
            roles_out[role] = 'type'
        elif info.st_uid != 0:
            roles_out[role] = 'owner'
        elif stat.S_IMODE(info.st_mode) & (0o077 if private else 0o022):
            roles_out[role] = 'permissions'
        elif regular and info.st_nlink != 1:
            roles_out[role] = 'link-count'
        else:
            roles_out[role] = 'as-expected'
    result = {'proxyStartupLayout': 'legacy', 'proxyStartupRoles': roles_out}
    try:
        launcher = load('orbis-host-upgrade-launcher')
        require(closure['scripts/orbis-install-new.py'][1] == executor_sha
                and 'scripts/orbis-proxy-identity.py' in closure, 'proxy-executor-unverified')
        for name, (size, digest) in closure.items():
            body = launcher.read_file(custody / name, max(1, size))
            require((len(body), sha(body)) == (size, digest), 'proxy-extraction-unverified')
    except (OSError, ValueError, RuntimeError, KeyError, TypeError):
        result['proxyObservation'] = 'source-unverified'
        return result
    directory = custody / 'scripts'
    cache = WORK / 'proxy-observer-unused-cache'
    if os.path.lexists(cache) or not sys.dont_write_bytecode:
        result['proxyObservation'] = 'source-unverified'
        return result
    previous_cache = sys.pycache_prefix
    try:
        # Bytecode caches in the extraction are outside the publisher inventory.
        sys.pycache_prefix = str(cache)
        proxy = load('orbis-proxy-identity', directory)
        proxy.observe_current(ROOT, 'default')
    except (OSError, ValueError, RuntimeError, KeyError, TypeError, subprocess.SubprocessError) as error:
        relevant = {'orbis-proxy-identity.py', 'orbis-host-retained-authority.py', 'orbis-host-layout.py'}
        result['proxyObservation'] = 'refused'
        result['proxyObservationSites'] = [
            f'{Path(frame.filename).name}:{frame.lineno}'
            for frame in traceback.extract_tb(error.__traceback__)
            if Path(frame.filename).parent == directory and Path(frame.filename).name in relevant
        ][-6:]
    else:
        result['proxyObservation'] = 'verified-after-failure'
    finally:
        sys.pycache_prefix = previous_cache
    return result


def launch(release, operation, timeout, *, channel='nightly', installed_pin=SOURCE):
    path, signals, closure = release
    workdir = WORK / operation
    workdir.mkdir(mode=0o700)
    log_path = workdir / 'installer.log'
    with log_path.open('xb') as log:
        nightly = ['--accept-nightly'] if channel == 'nightly' else []
        result = subprocess.run([sys.executable, '-I', '-B', str(path), '--work-dir', str(workdir / 'custody'),
                                 '--root', str(ROOT), '--docker-context', 'default', '--channel', channel,
                                 *nightly, '--yes', '--no-animation', '--no-color',
                                 '--http-port', str(PORT), '--https-port', str(TLS_PORT)],
                                env=ENV, cwd=WORK, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                check=False, timeout=timeout)
    if result.returncode:
        code, evidence = installer_failure(log_path, signals)
        if operation == 'source' and evidence.get('installerStep') == 'start-core':
            try:
                pin = STABLE if channel == 'stable' else installed_pin
                evidence.update(fresh_startup_evidence(pin))
                if any(site.startswith('orbis-host-retained-authority.py:')
                       for site in evidence.get('installerFailureSites', [])):
                    evidence.update(proxy_startup_probe(pin, closure))
            except Exception:
                # This optional follow-up must not supersede the actual installer refusal.
                evidence['startupDiagnostic'] = 'unavailable'
        raise Refused(code, installerExitCode=result.returncode, **evidence)


def executed_launcher(release, operation, pin):
    launcher = load('orbis-host-upgrade-launcher')
    path, _, _ = release
    custody = WORK / operation / 'custody'
    selected = list(custody.iterdir())
    require(len(selected) == 1 and re.fullmatch(re.escape(pin[0]) + r'-[a-z0-9_]{8}', selected[0].name),
            'launcher-extraction-not-unique')
    directory = selected[0]
    selected_body = launcher.read_file(directory / 'installer-source-selection.json', 16384)
    selection = launcher.decoded(selected_body)
    executed = launcher.decoded(launcher.read_file(directory / 'installer-source-execution.json', 16384))
    core = launcher.read_file(directory / 'release-manifest.json', 16384)
    expected = launcher.decoded(core)
    source = launcher.read_file(directory / 'installer-source-launcher.py', ASSETS['install-orbis.py'])
    require(source == launcher.read_file(path, ASSETS['install-orbis.py'], private=False)
            and selection.get('schema') == 'orbis.installer-source-selection.v1'
            and selection.get('mode') == 'release' and selection.get('channel') == 'nightly'
            and selection.get('installer') == launcher.literal(source, 'EXPECTED_RELEASE')
            and selection.get('proofs', {}).get('installer-source-launcher.py') == {'bytes': len(source), 'sha256': sha(source)}
            and selection.get('proofs', {}).get('release-manifest.json') == {'bytes': len(core), 'sha256': sha(core)}
            and (expected.get('tag'), expected.get('commit'), expected.get('digest')) == pin[:3]
            and executed == {'schema': 'orbis.installer-source-execution.v1', 'selectionSha256': sha(selected_body),
                             'launcherSha256': sha(source), 'channel': 'nightly'}, 'launcher-execution-receipt-refused')
    return sha(selected_body)


def fence(name, pin):
    with (WORK / name).open('xb') as output:
        output.write((pin[2] + '\n').encode('ascii'))
        output.flush()
        os.fsync(output.fileno())
    descriptor = os.open(WORK, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def http(method, path, *, body=None, cookie=None, expect=(200,), timeout=8, maximum=2 * 1024 * 1024):
    routes = {'/api/health': 'health', '/api/user-context': 'setup-context', '/api/auth/register': 'register',
              '/api/auth/login': 'login', '/api/auth/logout': 'logout', '/api/system/build': 'build',
              '/login': 'login-page', '/api/links': 'links', '/api/custom-apps': 'custom-app', '/api/tasks': 'tasks',
              '/api/system/core-update-progress': 'core-update-progress'}
    kind = routes.get(path, 'app-install' if path.startswith('/api/app-lifecycle/') else 'other')
    connection = HTTPConnection('127.0.0.1', PORT, timeout=timeout)
    headers = {'Accept': 'application/json', 'Origin': f'http://127.0.0.1:{PORT}'}
    if cookie:
        headers['Cookie'] = cookie
    if body is not None:
        body = json.dumps(body).encode()
        headers['Content-Type'] = 'application/json'
    try:
        connection.request(method, path, body, headers)
        response = connection.getresponse()
        data = response.read(maximum + 1)
        if response.status not in expect or len(data) > maximum:
            raise Refused('loopback-api-refused', loopbackRoute=kind, loopbackStatus=response.status)
        mime = (response.getheader('Content-Type') or '').split(';')[0]
        return (json.loads(data) if data and mime == 'application/json' else None,
                [value for name, value in response.getheaders() if name.lower() == 'set-cookie'])
    except (OSError, HTTPException) as error:
        if isinstance(error, TimeoutError):
            outcome = 'timeout'
        elif isinstance(error, ConnectionResetError):
            outcome = 'connection-reset'
        elif isinstance(error, ConnectionRefusedError):
            outcome = 'connection-refused'
        elif isinstance(error, HTTPException):
            outcome = 'invalid-http'
        else:
            outcome = 'transport-unavailable'
        raise Refused('loopback-transport-refused', loopbackRoute=kind, loopbackTransport=outcome) from None
    finally:
        connection.close()


def sample_progress(target):
    # The browser polls this same loopback route. Do not pass an operator cookie
    # or keep the raw response, including file or download metadata.
    try:
        host = ['/usr/bin/systemctl', 'show', '--property=MainPID', '--value', 'orbis-host.service']
        host_pid = run(host, timeout=1)
        body, _ = http('GET', '/api/system/core-update-progress', timeout=2, maximum=16 * 1024)
        require(type(body) is dict and set(body) == {'version', 'job'}
                and type(body['version']) is int and body['version'] == 1, 'progress-fixture-shape-refused')
        job = body.get('job')
        if job is None or job.get('targetTag') != target:
            return host_pid, None
        require(re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}', job['id'])
                and job.get('state') in
                ('queued', 'running', 'recovering', 'complete', 'failed', 'interrupted')
                and job.get('phase') in (None, 'downloading', 'installing', 'restarting', 'verifying', 'recovering'),
                'progress-fixture-job-refused')
        # Only count a Host observation when both reads bracket this HTTP response.
        after = run(host, timeout=1)
        stable_pid = host_pid if host_pid == after and re.fullmatch(r'[0-9]{1,10}', host_pid) else None
        return stable_pid, (job['id'], job.get('phase'))
    except (OSError, ValueError, TypeError, AttributeError, KeyError, subprocess.SubprocessError):
        return None, None


@contextmanager
def observe_progress(target, result):
    stop = Event()
    samples = []
    def collect():
        while not stop.is_set() and len(samples) < 6000:
            host_pid, work = sample_progress(target)
            samples.append((time.monotonic(), host_pid, work))
            stop.wait(0.25)
    observer = Thread(target=collect, name='native-progress-readback')
    observer.start()
    try:
        yield
    finally:
        stop.set()
        observer.join()
        valid = [(observed, pid, job) for observed, pid, job in samples if job is not None]
        operations = {job[0] for _, _, job in valid}
        gaps = [b[0] - a[0] for a, b in zip(valid, valid[1:]) if a[2][0] == b[2][0]]
        after_start = sum(job is None for observed, _, job in samples
                          if valid and valid[0][0] <= observed <= valid[-1][0])
        result['targetProgress'] = {
            'samples': len(samples),
            'boundSamples': len(valid),
            'operations': sorted(operations),
            'phases': sorted({job[1] for _, _, job in valid if job[1] is not None}),
            'hostPidsDuringBoundSamples': len({pid for _, pid, _ in valid if pid not in (None, '0')}),
            'boundSampleWithHostStopped': any(pid == '0' for _, pid, _ in valid),
            'missingSamplesBetweenBoundReads': after_start,
            'longestBetweenBoundReadsMs': round(1000 * max(gaps)) if gaps else None,
        }


def session(operation, credential):
    # First registration can wait for a protected Host ownership request.
    # Allow that request to settle without sending registration a second time.
    timeout = 195 if operation == 'register' else 8
    body, cookies = http('POST', '/api/auth/' + operation, body=credential, expect=(200, 201), timeout=timeout)
    selected = [cookie.split(';', 1)[0] for cookie in cookies if re.match(r'^runtipi-sid=[^;\r\n]+;', cookie)
                and not re.search(r'(?:^|;)\s*Domain=', cookie, re.I)]
    require(body.get('success') is True and len(selected) == 1, 'fixture-authentication-refused')
    return selected[0]


def build(cookie, pin):
    tag, commit, digest, base, _ = pin
    http('GET', '/login')
    http('GET', '/api/health')
    value, _ = http('GET', '/api/system/build', cookie=cookie)
    require((value['version'], value['commit'], value['imageDigest'], value['runtipiCompatibility'])
            == (tag, commit, digest, base), 'loopback-build-mismatch')


def fixture_app_failure(status):
    evidence = {}
    if status in ('failed', 'interrupted', 'unconfirmed', 'cancelled'):
        evidence['fixtureAppTaskStatus'] = status
    if status == 'failed':
        signals = {
            'permission': ('permission denied', 'operation not permitted', 'eacces'),
            'mount': ('mount source path', 'invalid mount config', 'mounts denied'),
            'network': ('network_mode', 'failed to create network', 'failed to program'),
            'image': ('manifest unknown', 'pull access denied', 'no such image', 'failed to resolve reference'),
            'compose': ('compose json validation errors', 'invalid compose project', 'services.web'),
            'storage': ('no space left on device', 'read-only file system'),
        }
        try:
            logs = subprocess.run(DOCKER + ['logs', '--tail', '220', 'runtipi'], env=ENV,
                                  stdin=subprocess.DEVNULL, capture_output=True, timeout=10)
            if logs.returncode == 0:
                body = (logs.stdout + logs.stderr).decode(errors='replace').lower()
                evidence['fixtureAppFailureClasses'] = [
                    kind for kind, phrases in signals.items() if any(phrase in body for phrase in phrases)
                ]
        except (OSError, subprocess.SubprocessError):
            pass
    return Refused('fixture-app-task-refused', **evidence)


def seed(cookie, pin=SOURCE):
    marker = secrets.token_hex(12)
    title, name = 'OTA DB ' + marker[:8], 'orbis-ota-fixture-' + marker[:8]
    url = 'https://ota-fixture.invalid/' + marker
    http('POST', '/api/links', body={'title': title, 'url': url, 'description': title,
                                    'isVisibleOnGuestDashboard': False}, cookie=cookie, expect=(200, 201))
    entries, _ = http('GET', '/api/links', cookie=cookie)
    links = [item for item in entries['links'] if item['url'] == url]
    require(len(links) == 1 and type(links[0]['id']) is int and 0 < links[0]['id'] < 2**31, 'fixture-link-missing')
    program = ("const f=require('node:fs');f.mkdirSync('/ota-data',{recursive:true});"
               f"if(!f.existsSync('/ota-data/marker'))f.writeFileSync('/ota-data/marker','{marker}',{{flag:'wx'}});"
               "setInterval(()=>{},1000)")
    config = {'services': {'web': {'image': f'{IMAGE}@{pin[2]}', 'entrypoint': ['node', '-e'], 'command': [program],
                                   'network_mode': 'none', 'restart': 'no', 'healthcheck': {'disable': True},
                                   'volumes': ['${APP_DATA_DIR}/data:/ota-data'], 'labels': {'io.orbis.ota-fixture': marker},
                                   'x-runtipi': {'is_main': True, 'internal_port': 3000}}},
              'x-runtipi': {'schema_version': 2}}
    urn = name + ':_user'
    created, _ = http('POST', '/api/custom-apps', body={'name': name, 'config': config}, cookie=cookie, expect=(201,))
    require(created['appUrn'] == urn, 'fixture-app-origin-refused')
    installed, _ = http('POST', '/api/app-lifecycle/' + quote(urn, safe='') + '/install',
                        body={'skipPull': True, 'openPort': False, 'exposed': False, 'exposedLocal': False, 'maxBackups': 2},
                        cookie=cookie, expect=(200, 201, 202))
    request_id = installed['requestId']
    require(str(uuid.UUID(request_id)) == request_id, 'fixture-install-request-refused')
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        tasks, _ = http('GET', '/api/tasks', cookie=cookie)
        selected = [task for task in tasks['tasks'] if task['id'] == request_id]
        if selected:
            # Creating a custom app reserves its record. The install endpoint
            # can dispatch Start for that record on the published source.
            require(len(selected) == 1 and selected[0]['appUrn'] == urn and selected[0]['action'] in ('install', 'start'),
                    'fixture-app-task-identity-refused')
            status = selected[0]['status']
            if status == 'succeeded':
                return marker, name, links[0]['id']
            if status not in ('queued', 'running'):
                raise fixture_app_failure(status)
        time.sleep(0.5)
    raise Refused('fixture-app-task-timeout')


def app_data(identity):
    marker, name, link_id = identity
    path = ROOT / 'app-data' / '_user' / name / 'data' / 'marker'
    until = time.monotonic() + 12
    while not path.exists() and time.monotonic() < until:
        time.sleep(0.25)
    info = path.lstat()
    require(path.resolve() == path and stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size == len(marker),
            'fixture-file-identity-refused')
    body = path.read_bytes()
    require(body == marker.encode(), 'fixture-file-content-refused')
    sql = ('BEGIN READ ONLY; '
           "SELECT json_build_object('id',id,'userId',user_id,'url',url,'title',title,'description',description,"
           f"'guest',is_visible_on_guest_dashboard) FROM link WHERE id={link_id}; ROLLBACK;")
    result = json.loads(run(DOCKER + ['exec', 'runtipi-db', 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1',
                                    '-U', 'tipi', '-d', 'tipi', '-c', sql], code='fixture-sql-refused'))
    require(result['id'] == link_id and result['url'] == 'https://ota-fixture.invalid/' + marker
            and result['guest'] is False, 'fixture-row-refused')
    identifier = run(DOCKER + ['ps', '-q', '--no-trunc', '--filter', 'label=io.orbis.ota-fixture=' + marker])
    require(re.fullmatch(r'[a-f0-9]{64}', identifier), 'running-fixture-app-refused')
    started = run(DOCKER + ['inspect', '--format', '{{.State.StartedAt}}', identifier])
    return (sha(body), sha(json.dumps(result, sort_keys=True).encode()), identifier, started)


def check_host(pin):
    # Older installed helpers omit the setup module from their runtime closure.
    # The release-neutral socket reader verifies the actual systemd listener.
    pid = run(['/usr/bin/systemctl', 'show', '--property=MainPID', '--value', 'orbis-host.service'])
    require(re.fullmatch(r'[1-9][0-9]{0,9}', pid), 'installed-host-listener-refused')
    status = load('orbis-host-service-setup').read_socket_status(expected_pid=int(pid))
    stable = pin == STABLE
    expected_sentinel = sentinel_pin(pin)
    require(status['currentTag'] == pin[0] and status['currentDigest'] == pin[2] and status['imageMatches'] is True
            and status['enrolled'] is True and status['coreHealth'] == 'healthy'
            and ('release-channels.v1' in status['capabilities'] if stable else
                 status['serviceRole'] == 'administration' and 'runtipi-412-update.v1' in status['capabilities'])
            and run(['/usr/bin/systemctl', 'is-active', 'orbis-host.service']) == 'active',
            'installed-host-refused')
    if not stable:
        sentinel = load('orbis-sentinel-install', HOST)
        sentinel._installed_payload(sentinel.INSTALLED_STATE, sentinel.INSTALLED_ROOT)
        installed = json.loads((sentinel.INSTALLED_STATE / 'installed.json').read_bytes())
        require({key: installed[key] for key in expected_sentinel} == expected_sentinel, 'installed-sentinel-release-refused')
    status_sentinel = load('orbis-host-service', HOST).sentinel_component_status()
    require(status_sentinel['available'] is True, 'installed-sentinel-refused')
    component = status_sentinel['status']['components']['sentinel']
    require(component['installedVersion'] == expected_sentinel['version']
            and component['state'] == 'healthy',
            'installed-sentinel-refused')
    return status


def checkpoint_limit():
    update = load('orbis-host-update', HOST)
    tools, reader = update.controller_tools('default')
    bundle = Path('/var/lib/orbis/snapshots/.official-runtime-readiness')
    reviewed = tools.review(ROOT, reader, bundle, update.checkpoint_path(bundle),
                            scope=update.CONTROLLER.SCOPE, backup=True)
    estimate = reviewed['storage']['estimatedBytes']
    require(type(estimate) is int and 0 < estimate <= 256 * 1024**2
            and not reviewed['storage']['conflictingWriters'], 'unexpected-backup-readiness')
    return estimate


def component_journal(operation_dir, operation, target_body):
    launcher = load('orbis-host-upgrade-launcher')
    runner = load('orbis-host-upgrade-runner')
    directory = operation_dir / 'component-journal'
    with launcher.directory(directory) as descriptor:
        names = sorted(os.listdir(descriptor))
    require(1 <= len(names) <= 64, 'component-journal-inventory-refused')
    previous = None
    journal = {}
    for index, name in enumerate(names):
        require(bool(re.fullmatch(r'[0-9]{2}-[a-z-]+\.json', name)), 'component-journal-name-refused')
        body = launcher.read_file(directory / name)
        record = json.loads(body)
        phase = record['phase']
        require(phase in runner.PHASES and phase not in journal and name == f'{index:02d}-{phase}.json'
                and record['operationId'] == operation and record['targetSetSha256'] == sha(target_body)
                and record['previousSha256'] == previous, 'component-journal-binding-refused')
        journal[phase] = record['value']
        previous = sha(body)
    return journal, previous


def verified_operation(status, source, target, policy, prior_operations):
    expected_sentinel = sentinel_pin(target)
    operation = status['job']['id']
    require(str(uuid.UUID(operation)) == operation and status['job']['state'] == 'complete'
            and status['job']['backupPolicy'] == policy and operation not in prior_operations,
            'coordinated-job-refused')
    job = json.loads((STATE / 'job.json').read_bytes())
    operation_dir = STATE / 'component-upgrades' / operation
    require({path.name for path in operation_dir.parent.iterdir()} == {*prior_operations, operation},
            'coordinated-operation-inventory-refused')
    target_body = (operation_dir / 'target-set.json').read_bytes()
    target_set = json.loads(target_body)
    require(job['id'] == operation and job['state'] == 'complete' and job['backupPolicy'] == policy
            and job['current']['digest'] == source[2] and job['target']['digest'] == target[2]
            and target_set['core']['digest'] == target[2] and target_set['sentinel']['release'] == expected_sentinel,
            'authoritative-job-refused')
    journal, previous = component_journal(operation_dir, operation, target_body)
    phases = list(journal)
    expected = ['integration-ready', 'host-ready', 'core-ready', 'complete']
    require(phases[-1:] == ['complete'] and all(phase in journal for phase in expected)
            and [phases.index(phase) for phase in expected] == sorted(phases.index(phase) for phase in expected)
            and previous == job['componentReceiptSha256'], 'component-terminal-receipt-refused')
    terminal = journal['complete']
    require(terminal['core'] == {'commit': target[1], 'digest': target[2]}
            and terminal['sentinel']['release'] == expected_sentinel, 'component-set-mismatch')
    setup = load('orbis-host-service-setup', HOST)
    current_host = setup.actual_copy(setup.INSTALL_DIR, setup.UNIT_FILE)
    target_host = {key: target_set['host'][key] for key in ('inventory', 'unitSha256')}
    require(current_host == target_host, 'component-host-inventory-mismatch')

    update = load('orbis-host-update', HOST)
    snapshot = Path('/var/lib/orbis/snapshots') / f'orbis-{target[0]}-{operation}'
    require(job['snapshot'] == str(snapshot), 'backed-operation-path-mismatch')
    producer = update.read_journal(snapshot, ROOT, 'default', job['current'], job['target'])
    require(producer['stage'] == 'complete' and producer['backupScope'] == update.CONTROLLER.SCOPE,
            'coordinated-producer-refused')
    return operation, update, snapshot


def quiescent(operation):
    observation = load('orbis-host-upgrade-supervision', HOST)
    units = [observation.unit_name(operation), observation.reconciliation_unit_name(operation)]
    until = time.monotonic() + 20
    while time.monotonic() < until:
        states = run(['/usr/bin/systemctl', 'show', '--property=ActiveState', '--value', *units]).split()
        if states == ['inactive', 'inactive']:
            return
        time.sleep(0.25)
    raise Refused('worker-quiescence-refused')


def completed(status, source, target, prior_operations=()):
    operation, update, snapshot = verified_operation(status, source, target, 'automatic', prior_operations)
    tools, reader = update.controller_tools('default')
    record = tools.read_record(update.checkpoint_path(snapshot), ROOT, reader)
    manifest = tools.STORAGE.verified_manifest(snapshot)
    require(manifest['stage'] == 'complete' and record['backupFingerprint'] == tools.APPS.digest(manifest)
            and record['runtipiConfigurationStaging']['phase'] == 'staged'
            and record['runtipiConfigurationStaging']['completed'] == 3, 'backed-operation-custody-refused')
    for name, expected_hash in record['runtipiConfiguration']['stagedFileSha256'].items():
        require(name in ('.env', 'VERSION', 'orbis-compose.yml') and sha((ROOT / name).read_bytes()) == expected_hash,
                'installed-config-mismatch')
    require((ROOT / 'VERSION').read_text().strip() == target[3], 'installed-base-version-mismatch')
    require(run(DOCKER + ['inspect', '--format', '{{.State.Health.Status}}', 'runtipi-db']) == 'healthy',
            'installed-postgres-refused')
    run(DOCKER + ['exec', 'runtipi-queue', 'rabbitmq-diagnostics', '-q', 'check_running'], code='installed-queue-refused')
    quiescent(operation)


def verify_internal_network():
    # Inspect the actual target, including service isolation. The configuration
    # and the protected checkpoint alone cannot prove this runtime topology.
    network = load('orbis-host-controller-update', HOST).CORE_NETWORK
    fields = '{{json .Name}} {{json .Driver}} {{json .Scope}} {{json .Internal}}'
    selected = run(DOCKER + ['network', 'inspect', '--format', fields, network])
    require(selected == f'"{network}" "bridge" "local" true', 'installed-private-network-refused')
    for container in ('runtipi-db', 'runtipi-queue', 'runtipi', 'runtipi-reverse-proxy'):
        template = '{{json .NetworkSettings.Networks}}'
        connected = json.loads(run(DOCKER + ['container', 'inspect', '--format', template, container]))
        require(type(connected) is dict and connected, 'installed-service-network-refused')
        if container in ('runtipi-db', 'runtipi-queue'):
            require(set(connected) == {network}, 'installed-service-isolation-refused')
        elif container == 'runtipi':
            require(network in connected and len(connected) > 1, 'installed-controller-network-refused')
        else:
            require(network not in connected, 'installed-proxy-isolation-refused')


def verify_installed_app_backup(cookie, identity, original):
    app = identity[1] + ':_user'
    route = '/api/backups/' + quote(app, safe='')
    before, _ = http('GET', route, cookie=cookie)
    # This runs only after the OTA itself has preserved the original app
    # instance. Backups can pause that instance to acquire a safe archive.
    body = run(DOCKER + ['exec', 'runtipi', 'orbis-cli', 'app', 'backup', app],
               timeout=180, code='installed-cli-app-backup-refused')
    jobs = re.findall(r'^App backup accepted for ' + re.escape(app) + r' \(([a-f0-9-]{36})\)\.$', body, re.M)
    require(len(jobs) == 1 and str(uuid.UUID(jobs[0])) == jobs[0]
            and body.splitlines()[-1] == f'App backup completed for {app}.', 'installed-cli-app-backup-output-refused')
    tasks, _ = http('GET', '/api/tasks', cookie=cookie)
    selected = [task for task in tasks['tasks'] if task['id'] == jobs[0]]
    require(len(selected) == 1 and selected[0]['appUrn'] == app and selected[0]['action'] == 'backup'
            and selected[0]['status'] == 'succeeded', 'installed-cli-app-backup-job-refused')
    after, _ = http('GET', route, cookie=cookie)
    before_names = {item['id'] for item in before['data']}
    added = [item for item in after['data'] if item['id'] not in before_names]
    require(after['total'] == before['total'] + 1 and len(added) == 1 and added[0]['size'] > 0
            and app_data(identity)[:2] == original[:2], 'installed-cli-app-backup-archive-refused')


def committed_boundary(job, snapshot, update, target):
    # A healthy target alone does not establish that the data commit is durable.
    runtime = update.CONTROLLER.ControllerUpdate(update.HOST, ROOT, 'default', snapshot,
                                                   job['current'], job['target'], STATE)
    if runtime.read().get('phase') != 'committed':
        return None
    launcher = load('orbis-host-upgrade-launcher')
    directory = STATE / 'component-upgrades' / job['id']
    target_body = launcher.read_file(directory / 'target-set.json')
    selected = json.loads(target_body)
    require(selected['core']['digest'] == target[2] and selected['core']['commit'] == target[1]
            and selected['sentinel']['release'] == sentinel_pin(target), 'commit-window-target-refused')
    journal, receipt = component_journal(directory, job['id'], target_body)
    phases = list(journal)
    required = ('integration-ready', 'host-ready', 'core-intent', 'core-ready')
    if phases[-1:] != ['core-ready'] or any(phase not in journal for phase in required):
        return None
    require([phases.index(phase) for phase in required] == sorted(phases.index(phase) for phase in required)
            and journal['core-ready']['result'] == 'healthy', 'commit-window-component-order-refused')
    return receipt


def reviewed_checkpoint(source, target, committed=False):
    launcher = load('orbis-host-upgrade-launcher')
    service = load('orbis-host-service')
    job = service.read_private(STATE / 'job.json')
    if not job or job.get('state') != 'running' or job.get('backupPolicy') != 'automatic':
        return None
    require(tuple(job['current'][field] for field in ('tag', 'commit', 'digest')) == source[:3]
            and tuple(job['target'][field] for field in ('tag', 'commit', 'digest')) == target[:3],
            'interruption-job-release-refused')
    operation = job['id']
    require(str(uuid.UUID(operation)) == operation, 'interruption-job-refused')
    snapshot = Path('/var/lib/orbis/snapshots') / f'orbis-{target[0]}-{operation}'
    require(str(snapshot) == job['snapshot'], 'interruption-checkpoint-path-refused')
    update = service.UPDATE
    observation = service.read_private(update.journal_path(snapshot))
    stages = ('complete',) if committed else ('stopped', 'snapshotting', 'snapshot-ready')
    if not observation or observation['stage'] not in stages:
        return None
    producer = update.read_journal(snapshot, ROOT, 'default', job['current'], job['target'])
    if producer['stage'] != observation['stage'] or producer['backupScope'] != update.CONTROLLER.SCOPE:
        return None
    receipt = committed_boundary(job, snapshot, update, target) if committed else None
    if committed and receipt is None:
        return None
    witness = launcher.Bootstrap(STATE, operation, job['worker'])
    frame = witness.verify_bootstrap(current=False)
    claim = launcher.decoded(launcher.read_file(witness.directory / 'claim.json', 16384))
    require(claim == {'schema': 'orbis.host-upgrade-claim.v1',
                      'requestSha256': witness.reference['requestSha256'], **frame},
            'interruption-generation-refused')
    return job, producer['stage'], frame, receipt


@contextmanager
def interrupt_at_checkpoint(source, target, result, committed=False):
    stop = Event()
    failure = {}
    evidence_key = 'coreCommitInterruption' if committed else 'checkpointInterruption'
    intent = 'core-commit-interruption-intent' if committed else 'checkpoint-interruption-intent'
    def act():
        try:
            while not stop.wait(0.05 if committed else 0.15):
                try:
                    reviewed = reviewed_checkpoint(source, target, committed)
                except (Refused, FileNotFoundError, ProcessLookupError):
                    continue
                if not reviewed:
                    continue
                job, stage, frame, receipt = reviewed
                try:
                    pid = os.pidfd_open(frame['pid'])
                except ProcessLookupError:
                    continue
                try:
                    exact = reviewed_checkpoint(source, target, committed)
                    if exact != reviewed or stop.is_set():
                        continue
                    # Only the pinned process descriptor can receive this one
                    # deliberate test fault. The product checks quiescence.
                    fence(intent, target)
                    result[evidence_key] = {'operation': job['id'], 'stage': stage, 'sent': False}
                    if committed:
                        result[evidence_key]['coreReadyReceiptSha256'] = receipt
                    signal.pidfd_send_signal(pid, signal.SIGKILL)
                    result[evidence_key]['sent'] = True
                    return
                finally:
                    os.close(pid)
        except (OSError, ValueError, KeyError, TypeError, RuntimeError, subprocess.SubprocessError):
            failure['checkpointObservationRefused'] = True
    observer = Thread(target=act, name='disposable-checkpoint-interruption')
    observer.start()
    try:
        yield
    finally:
        stop.set()
        observer.join()
        result.update(failure)


def reconcile_interruption(source, target, fault, expected_state):
    operation = fault['operation']
    launcher = load('orbis-host-upgrade-launcher')
    service = load('orbis-host-service')
    job = service.read_private(STATE / 'job.json')
    require(job['id'] == operation and job['state'] in ('running', 'interrupted')
            and job['current']['digest'] == source[2] and job['target']['digest'] == target[2],
            'interruption-accepted-job-changed')
    witness = launcher.ReconciliationBootstrap(STATE, operation, job['worker'])
    witness.verify_original_claim()
    deadline = time.monotonic() + 15
    while True:
        try:
            witness.supervision.observe_quiescence(launcher.Files(), STATE, operation, witness.original_frame)
            break
        except witness.supervision.UpgradeSupervisionError:
            require(time.monotonic() < deadline, 'interruption-original-unit-not-quiescent')
            time.sleep(0.25)
    if expected_state == 'complete':
        require(committed_boundary(job, Path(job['snapshot']), service.UPDATE, target)
                == fault['coreReadyReceiptSha256'], 'commit-window-closed-before-interruption')
    # This fixed entry point rechecks the installed bootstrap and is the only
    # dispatcher used here. It does not replay the original Apply.
    worker = witness.directory / 'bootstrap/scripts/orbis-host-upgrade-launcher.py'
    run([sys.executable, '-I', '-B', str(worker), 'dispatch-reconciliation', operation,
         '--state-dir', str(STATE)], timeout=45, code='interruption-recovery-dispatch-refused')
    deadline = time.monotonic() + 420
    while time.monotonic() < deadline:
        current = service.read_private(STATE / 'job.json')
        require(current['id'] == operation and current['current'] == job['current'] and current['target'] == job['target'],
                'interruption-recovery-job-changed')
        if current['state'] == expected_state:
            break
        time.sleep(0.5)
    else:
        raise Refused('interruption-recovery-terminal-not-observed')
    witness.supervision.observe_quiescence(launcher.Files(), STATE, operation, witness.original_frame)
    runtime = witness.supervision.Runtime()
    unit = witness.supervision.reconciliation_unit_name(operation)
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        observed = runtime.unit(unit)
        if (observed['ActiveState'] == 'inactive' and observed['MainPID'] == observed['ControlPID'] == '0'
                and not observed['Job'] and runtime.cgroup_empty(unit)):
            break
        time.sleep(0.25)
    else:
        raise Refused('interruption-recovery-unit-not-quiescent')
    return job, current, witness.directory


def verify_checkpoint_return(credential, identity, original, proxy, source, target, result):
    fault = result['checkpointInterruption']
    operation = fault['operation']
    job, current, directory = reconcile_interruption(source, target, fault, 'rolled-back')
    launcher = load('orbis-host-upgrade-launcher')
    service = load('orbis-host-service')
    recovered = check_host(source)
    require(recovered['job']['id'] == operation and recovered['job']['state'] == 'rolled-back',
            'interruption-host-terminal-refused')
    target_body = launcher.read_file(directory / 'target-set.json')
    selected = json.loads(target_body)
    require(selected['core']['commit'] == target[1] and selected['core']['digest'] == target[2],
            'interruption-component-target-refused')
    journal, terminal = component_journal(directory, operation, target_body)
    require(list(journal)[-1] == 'rolled-back' and terminal == current['componentReceiptSha256'],
            'interruption-component-return-unverified')
    setup = load('orbis-host-service-setup', HOST)
    restored_host = setup.actual_copy(setup.INSTALL_DIR, setup.UNIT_FILE)
    original_host = journal['staged']['original']['host']
    require(restored_host['unitSha256'] == original_host['unitSha256']
            and sha(launcher.canonical(restored_host['inventory'])) == original_host['inventorySha256'],
            'interruption-original-host-copy-refused')
    snapshot = Path(job['snapshot'])
    producer = service.UPDATE.read_journal(snapshot, ROOT, 'default', job['current'], job['target'])
    require(producer['stage'] == 'rolled-back', 'interruption-core-return-unverified')
    cookie = session('login', credential)
    try:
        build(cookie, source)
        require(app_data(identity) == original, 'interruption-data-return-refused')
        require(run(DOCKER + ['inspect', '--format', '{{.Id}} {{.State.StartedAt}} {{.State.Running}}',
                             'runtipi-reverse-proxy']) == proxy, 'interruption-proxy-changed')
    finally:
        http('POST', '/api/auth/logout', cookie=cookie, expect=(204,))
    result.update(phase='checkpoint-recovery-complete', markerChecks=2, componentTerminalVerified=True,
                  originalReleaseVerified=True, passed=True)


def verify_committed_return(source, target, result):
    fault = result['coreCommitInterruption']
    operation = fault['operation']
    _, current, directory = reconcile_interruption(source, target, fault, 'complete')
    launcher = load('orbis-host-upgrade-launcher')
    target_body = launcher.read_file(directory / 'target-set.json')
    journal, terminal = component_journal(directory, operation, target_body)
    phases = list(journal)
    require(phases[-2:] == ['core-ready', 'complete'] and terminal == current['componentReceiptSha256'],
            'committed-reconciliation-terminal-unverified')
    before = directory / 'component-journal' / f'{phases.index("core-ready"):02d}-core-ready.json'
    require(sha(launcher.read_file(before)) == fault['coreReadyReceiptSha256'], 'commit-receipt-rewritten')
    result['committedReconciliationVerified'] = True


def fixture(environment, result):
    result['phase'] = 'scope'
    target = target_pin(environment)
    predecessor = source_pin(target)
    mode = environment.get('STABLE_BRIDGE', 'false')
    require(mode in ('true', 'false'), 'stable-bridge-mode-refused')
    bridge = mode == 'true'
    fault = environment.get('CHECKPOINT_RECOVERY', 'false')
    require(fault in ('true', 'false') and not (bridge and fault == 'true'), 'checkpoint-recovery-mode-refused')
    committed_input = environment.get('CORE_COMMIT_RECOVERY', 'false')
    require(committed_input in ('true', 'false') and not (committed_input == 'true' and (bridge or fault == 'true')),
            'commit-recovery-mode-refused')
    committed_fault = committed_input == 'true'
    installed_cli = environment.get('INSTALLED_CLI_UPDATE', 'false')
    require(installed_cli in ('true', 'false')
            and not (installed_cli == 'true' and (bridge or fault == 'true' or committed_fault)),
            'installed-cli-test-mode-refused')
    require(not committed_fault or (predecessor[0], target[0]) == ('v0.9.2-beta.8', 'v0.9.2-beta.9'),
            'commit-interruption-release-pair-refused')
    initial = STABLE if bridge else predecessor
    result['fixtureDefaultAclRemoved'], result['fixtureTimezoneProtected'] = preflight(environment)
    result['phase'] = 'publisher'
    modules = [load(name) for name in ('orbis-release-check', 'install-orbis', 'orbis-host-upgrade-launcher')]
    source, candidate = [publisher(pin, *modules, environment.get('GITHUB_TOKEN')) for pin in (predecessor, target)]
    bootstrap = publisher(STABLE, *modules, environment.get('GITHUB_TOKEN')) if bridge else source
    result['phase'] = 'loopback-isolation'
    isolate_dashboard()
    result['phase'] = 'guided-source'
    if bridge:
        fence('stable-install-intent', STABLE)
        launch(bootstrap, 'source', 600, channel='stable')
        result['phase'] = 'stable-install-readback'
        require(fresh_journal_phase(STABLE) == 'complete', 'stable-install-receipt-refused')
    else:
        launch(bootstrap, 'source', 600, installed_pin=initial)
    result['phase'] = 'source-host-readback'
    baseline = check_host(initial)
    require(baseline.get('job') is None, 'fresh-source-job-refused')
    result['phase'] = 'source-ingress-readback'
    until = time.monotonic() + 20
    while True:
        try:
            http('GET', '/api/health')
            break
        except (OSError, HTTPException, Refused):
            if time.monotonic() >= until:
                raise
            time.sleep(0.5)
    context, _ = http('GET', '/api/user-context')
    require(isinstance(context, dict) and context.get('isConfigured') is False, 'fresh-fixture-account-refused')
    result['phase'] = 'fixture-registration'
    credential = {'username': 'ota-fixture-' + secrets.token_hex(5), 'password': secrets.token_urlsafe(32)}
    started = time.monotonic()
    try:
        cookie = session('register', credential)
    except Refused:
        try:
            context, _ = http('GET', '/api/user-context', timeout=5)
            if type(context) is dict and type(context.get('isConfigured')) is bool:
                result['registrationObservedAccount'] = context['isConfigured']
        except (OSError, ValueError, HTTPException):
            pass
        raise
    finally:
        result['registrationElapsedMs'] = round(1000 * (time.monotonic() - started))
    build(cookie, initial)
    result['phase'] = 'fixture-markers'
    identity = seed(cookie, initial)
    original = app_data(identity)
    http('POST', '/api/auth/logout', cookie=cookie, expect=(204,))
    prior_operations = ()
    if bridge:
        result['phase'] = 'guided-bridge'
        fence('bridge-intent', predecessor)
        launch(source, 'bridge', 900)
        result['phase'] = 'bridge-readback'
        bridge_receipt = executed_launcher(source, 'bridge', predecessor)
        operation, _, _ = verified_operation(check_host(predecessor), STABLE, predecessor, 'none', ())
        quiescent(operation)
        prior_operations = (operation,)
        cookie = session('login', credential)
        try:
            build(cookie, predecessor)
            require(app_data(identity) == original, 'bridge-fixture-continuity-refused')
        finally:
            http('POST', '/api/auth/logout', cookie=cookie, expect=(204,))
        result['stableBridgeVerified'] = True
    proxy = run(DOCKER + ['inspect', '--format', '{{.Id}} {{.State.StartedAt}} {{.State.Running}}', 'runtipi-reverse-proxy'])
    require(proxy.endswith(' true'), 'source-ingress-refused')
    result['snapshotEstimateBytes'] = checkpoint_limit()
    result['phase'] = 'guided-target'
    fence('apply-intent', target)
    if fault == 'true':
        with observe_progress(target[0], result):
            try:
                with interrupt_at_checkpoint(predecessor, target, result):
                    launch(candidate, 'target', 1500)
            except Refused:
                require(result.get('checkpointInterruption', {}).get('sent') is True, 'checkpoint-interruption-not-observed')
            else:
                raise Refused('interruption-expected-target-refusal-not-observed')
            result['phase'] = 'checkpoint-recovery'
            verify_checkpoint_return(credential, identity, original, proxy, predecessor, target, result)
        result['targetProgress']['boundToTerminalOperation'] = (
            result['targetProgress']['operations'] == [result['checkpointInterruption']['operation']])
        return
    with observe_progress(target[0], result):
        if committed_fault:
            try:
                with interrupt_at_checkpoint(predecessor, target, result, committed=True):
                    launch(candidate, 'target', 1500)
            except Refused:
                require(result.get('coreCommitInterruption', {}).get('sent') is True, 'commit-interruption-not-observed')
                result['phase'] = 'committed-recovery'
                verify_committed_return(predecessor, target, result)
            else:
                raise Refused('commit-interruption-expected-target-refusal-not-observed')
        else:
            launch(candidate, 'target', 1500)
    result['phase'] = 'terminal-readback'
    if bridge:
        require(executed_launcher(candidate, 'target', target) != bridge_receipt, 'launcher-receipt-replayed')
    target_host = check_host(target)
    completed(target_host, predecessor, target, prior_operations)
    if committed_fault:
        require(target_host['job']['id'] == result['coreCommitInterruption']['operation'], 'commit-operation-changed')
    result['targetProgress']['boundToTerminalOperation'] = result['targetProgress']['operations'] == [target_host['job']['id']]
    if committed_fault:
        require(result['targetProgress']['boundToTerminalOperation'], 'commit-progress-operation-refused')
    cookie = session('login', credential)
    try:
        build(cookie, target)
        require(app_data(identity) == original, 'fixture-continuity-refused')
        require(run(DOCKER + ['inspect', '--format', '{{.Id}} {{.State.StartedAt}} {{.State.Running}}',
                             'runtipi-reverse-proxy']) == proxy, 'proxy-continuity-refused')
        result.update(coordinatedUpgradePassed=True, markerChecks=2, appAndProxyUninterrupted=True)
        result['phase'] = 'installed-private-network'
        verify_internal_network()
        result['privateNetworkVerified'] = True
        # The historical first beta.6 target predates the CLI app commands.
        if target[0] != 'v0.9.2-beta.6':
            result['phase'] = 'installed-app-cli'
            verify_installed_app_backup(cookie, identity, original)
            result['installedAppBackupVerified'] = True
        if installed_cli == 'true':
            result['phase'] = 'installed-store-cli-update'
            module = load('orbis-official-store-cli', Path(__file__).parent)
            module.installed_cli_update(sys.modules[__name__], cookie, predecessor, target)
            require(app_data(identity) == original, 'installed-cli-update-changed-ota-markers')
            result['installedAppUpdateVerified'] = True
    finally:
        http('POST', '/api/auth/logout', cookie=cookie, expect=(204,))
    result.update(phase='complete', source=predecessor[0], target=target[0], targetCommit=target[1], targetDigest=target[2],
                  runtipi=target[3], sentinel=sentinel_pin(target)['version'],
                  markerChecks=2, appAndProxyUninterrupted=True,
                  componentTerminalVerified=True, automaticBackupVerified=True, loopbackVerified=True, passed=True)


def timezone_permission_evidence(source):
    # Report fixed mount and ancestor categories only. Do not expose host paths.
    roles = {Path('/'): 'root', Path('/etc'): 'etc', Path('/usr'): 'usr',
             Path('/usr/share'): 'share', Path('/usr/share/zoneinfo'): 'zoneinfo'}
    failures = []
    for mount in source['Mounts']:
        target = mount.get('Destination')
        if target not in ('/etc/localtime', '/etc/timezone'):
            continue
        location = mount.get('Source')
        if not isinstance(location, str):
            continue
        try:
            resolved = Path(location).resolve(strict=True)
            for path in (*reversed(resolved.parents), resolved):
                meta = path.stat()
                if meta.st_uid != 0 or meta.st_mode & 0o022:
                    failures.append({'mount': target.rsplit('/', 1)[1],
                                     'role': roles.get(path, 'file' if path == resolved else 'ancestor'),
                                     'rootOwner': meta.st_uid == 0, 'mode': stat.S_IMODE(meta.st_mode)})
        except OSError:
            continue
    return failures


def bootstrap_refusal_evidence(update, job, snapshot):
    # The exact protected operation is settled before this diagnostic is used.
    # Observe the failed proof from the existing read-only Engine interface.
    host, controller = update.HOST, update.CONTROLLER
    authority, publication = host.AUTHORITY, host.IDENTITY.PUBLICATION
    record_path = STATE / 'controller-updates' / sha(str(snapshot).encode())
    with authority.protected_directory(record_path) as directory:
        with authority.protected_file(directory, 'runtime.json', 16 * 1024 * 1024) as body:
            record = publication.metadata(body, byte_limit=16 * 1024 * 1024, string_limit=2 * 1024 * 1024)
    require(record['snapshot'] == str(snapshot) and record['root'] == str(ROOT) and record['context'] == 'default'
            and record['current'] == job['current'] and record['target'] == job['target'], 'bootstrap-record-identity')
    manager = SimpleNamespace(host=host, authority=authority, root=ROOT, context='default')
    runtime = controller.D.DockerRestoreRuntime(manager)
    source = runtime.inspect('runtipi')
    require(source['Id'] == record['source']['Id'] and source['Image'] == record['source']['Image']
            and source['State']['Running'] is True, 'bootstrap-source-changed')
    result = {
        'bootstrapEnablementRecorded': isinstance(record.get('sourceBootstrapEnablement'), dict),
        'bootstrapProofRecorded': isinstance(record.get('sourceBootstrapProfile'), dict),
        'bootstrapProbePhase': 'unavailable',
    }
    entry = record.get('bootstrapProbes', {}).get('review', {})
    phase = entry.get('phase')
    if phase in ('allocating', 'created', 'starting', 'observed', 'retired'):
        result['bootstrapProbePhase'] = phase
    if phase is None:
        probe = controller.BOOTSTRAP
        try:
            probe.require_image_startup(SimpleNamespace(runtime=runtime, P=publication), {'source': source})
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
            origin = Path(probe.__file__)
            result['bootstrapStartupSites'] = [frame.lineno for frame in traceback.extract_tb(error.__traceback__)
                                                if Path(frame.filename) == origin][-4:]
            result['bootstrapStartupChecked'] = False
            result['bootstrapTimezonePermissions'] = timezone_permission_evidence(source)
        else:
            result['bootstrapStartupChecked'] = True
    identifier = entry.get('id')
    if phase in ('created', 'starting') and isinstance(identifier, str) and re.fullmatch(r'[a-f0-9]{64}', identifier):
        inspected = runtime.inspect(identifier)
        status = inspected['State'].get('Status')
        exit_code = inspected['State'].get('ExitCode')
        result['bootstrapProbeExited'] = status in ('exited', 'dead')
        result['bootstrapProbeExitCode'] = exit_code if type(exit_code) is int and 0 <= exit_code <= 255 else None
    return result


def failure_readback(environment, result):
    phase = result.get('phase')
    if phase not in ('guided-bridge', 'bridge-readback', 'guided-target', 'terminal-readback',
                     'checkpoint-recovery', 'installed-private-network', 'installed-app-cli'):
        return
    try:
        upgrade = target_pin(environment)
        predecessor = source_pin(upgrade)
        bridge = phase in ('guided-bridge', 'bridge-readback')
        source, target, intent = (STABLE, predecessor, 'bridge-intent') if bridge else (predecessor, upgrade, 'apply-intent')
        if (WORK / intent).read_bytes() != (target[2] + '\n').encode('ascii'):
            return
        service = load('orbis-host-service', HOST)
        job = service.read_private(STATE / 'job.json')
        if not job or job.get('target', {}).get('digest') != target[2] or job.get('current', {}).get('digest') != source[2]:
            return
        state = job.get('state')
        if state in ('complete', 'running', 'interrupted', 'rolled-back', 'failed', 'recovering'):
            result['acceptedJobState'] = state
        operation = job['id']
        if str(uuid.UUID(operation)) != operation:
            return
        update = service.UPDATE
        snapshot = Path('/var/lib/orbis/snapshots') / f'orbis-{target[0]}-{operation}'
        journal = service.read_private(update.journal_path(snapshot))
        if journal and journal.get('targetDigest') == target[2] and journal.get('previousDigest') == source[2]:
            stage = journal.get('stage')
            if stage in update.FAILURE_STAGES | update.TERMINAL_STAGES | {'rolling-back', 'rollback-failed', 'recovery-required'}:
                result['producerStage'] = stage
            failure = update.safe_failure(journal)
            result.update(failure)
            if stage == 'aborted' and failure.get('failureCode') == 'source-bootstrap-preservation-unsupported':
                result.update(bootstrap_refusal_evidence(update, job, snapshot))
    except Exception:
        # Secondary readback never changes an outcome or reveals raw state.
        return
    try:
        launcher = load('orbis-host-upgrade-launcher')
        directory = STATE / 'component-upgrades' / operation
        with launcher.directory(directory) as descriptor:
            names = set(os.listdir(descriptor))
        known = {'intake.json': 'intake', 'claim.json': 'claimed', 'source-preparation.json': 'source-prepared',
                 'source-checked.json': 'source-authenticated', 'target-set.json': 'target-bound',
                 'execution-intent.json': 'execution-intent', 'component-journal': 'component-journal'}
        result['acceptedCustody'] = [label for name, label in known.items() if name in names]
        if 'target-set.json' in names and 'component-journal' in names:
            target_body = launcher.read_file(directory / 'target-set.json')
            selected = json.loads(target_body)
            require(selected['core']['commit'] == target[1] and selected['core']['digest'] == target[2],
                    'diagnostic-target-mismatch')
            phases, _ = component_journal(directory, operation, target_body)
            result['componentJournalPhases'] = list(phases)
        if phase == 'checkpoint-recovery':
            result['reconciliationClaims'] = sum(bool(re.fullmatch(r'reconciliation-[a-f0-9]{32}\.json', name)) for name in names)
            supervision = load('orbis-host-upgrade-supervision')
            unit = supervision.Runtime().unit(supervision.reconciliation_unit_name(operation))
            if unit['ActiveState'] in ('inactive', 'failed', 'active', 'activating', 'deactivating'):
                result['reconciliationUnitState'] = unit['ActiveState']
    except Exception:
        # An incomplete stage or absent custody supplies no authority.
        return


def main():
    result = {'schema': 'orbis.official-upgrade-runtime.v1', 'passed': False}
    try:
        fixture(os.environ, result)
    except Refused as error:
        result['error'] = str(error)
        result.update(error.evidence)
    except Exception as error:
        # Emit the exact fixture source coordinate and a fixed exception class
        # only. Installed process and API messages may contain credentials.
        result['error'] = 'fixture-step-failed'
        classes = (OSError, ValueError, RuntimeError, KeyError, TypeError, AttributeError,
                   subprocess.SubprocessError)
        result['failureKind'] = next((kind.__name__ for kind in classes if isinstance(error, kind)), 'other')
        result['fixtureFailureLine'] = next((frame.lineno for frame in reversed(traceback.extract_tb(error.__traceback__))
                                             if Path(frame.filename) == Path(__file__)), None)
    if not result['passed']:
        failure_readback(os.environ, result)
    print(json.dumps(result, sort_keys=True))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
