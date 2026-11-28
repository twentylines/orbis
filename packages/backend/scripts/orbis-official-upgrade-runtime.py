#!/usr/bin/env python3
"""Qualify one official coordinated release update on a new hosted Linux runner."""

import ast
import errno
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import platform
import pwd
import re
import secrets
import shutil
import stat
import subprocess
import sys
import time
from urllib.parse import quote
import uuid


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
TARGET_TAG = 'v0.9.2-beta.5'
TARGET_COMMIT = '9a75b406906c0d642f1fd15b0ad4553a42b9dde6'
TARGET_RUN = 46094714979
SENTINEL = {'version': '0.1.0-dev.24', 'sha256': 'c9373a394c306524b2e37b76afa9eec42272507faf45657d7f46d1b9f8fb565f',
            'sourceCommit': '16b2aa6158ab38d961e0d3f6a2d489b702ab63e3'}
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
    require(commit == TARGET_COMMIT and DIGEST.fullmatch(digest), 'target-pin-required')
    return (TARGET_TAG, commit, digest, '4.12.0', TARGET_RUN)


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
    WORK.mkdir(mode=0o700)
    (WORK / 'tmp').mkdir(mode=0o700)


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
    require(published.get('tag_name') == tag and published.get('draft') is False and published.get('prerelease') is True
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
    return path, installer_signals(closure)


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


def fresh_journal_phase():
    launcher = load('orbis-host-upgrade-launcher')
    pointer = launcher.decoded(launcher.read_file(ROOT / '.orbis-installation.json', 16384))
    if (pointer.get('schema'), pointer.get('kind'), pointer.get('root'), pointer.get('dockerContext')) != (
            'orbis.installer-pointer.v1', 'new', str(ROOT), 'default'):
        return None
    path = Path(pointer['journal'])
    parts = path.relative_to(WORK / 'source' / 'custody').parts
    if (len(parts) != 4 or not re.fullmatch(re.escape(SOURCE[0]) + r'-[a-z0-9_]{8}', parts[0])
            or parts[1] != 'transactions'
            or not re.fullmatch(r'new-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}', parts[2])
            or parts[3] != 'transaction.json'):
        return None
    journal = launcher.decoded(launcher.read_file(path, 64 * 1024))
    if ((journal.get('schema'), journal.get('root'), journal.get('dockerContext'))
            != ('orbis.new-installation.v2', str(ROOT), 'default')
            or journal.get('manifest', {}).get('digest') != SOURCE[2]):
        return None
    phase = journal.get('stage')
    return phase if phase in ('prepared', 'starting', 'enrolled', 'complete') else None


def fresh_startup_evidence():
    evidence = {}
    try:
        phase = fresh_journal_phase()
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


def launch(release, operation, timeout):
    path, signals = release
    workdir = WORK / operation
    workdir.mkdir(mode=0o700)
    log_path = workdir / 'installer.log'
    with log_path.open('xb') as log:
        result = subprocess.run([sys.executable, '-I', '-B', str(path), '--work-dir', str(workdir / 'custody'),
                                 '--root', str(ROOT), '--docker-context', 'default', '--channel', 'nightly',
                                 '--accept-nightly', '--yes', '--no-animation', '--no-color',
                                 '--http-port', str(PORT), '--https-port', str(TLS_PORT)],
                                env=ENV, cwd=WORK, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                check=False, timeout=timeout)
    if result.returncode:
        code, evidence = installer_failure(log_path, signals)
        if operation == 'source' and evidence.get('installerStep') == 'start-core':
            evidence.update(fresh_startup_evidence())
        raise Refused(code, installerExitCode=result.returncode, **evidence)


def http(method, path, *, body=None, cookie=None, expect=(200,)):
    connection = http.client.HTTPConnection('127.0.0.1', PORT, timeout=8)
    headers = {'Accept': 'application/json', 'Origin': f'http://127.0.0.1:{PORT}'}
    if cookie:
        headers['Cookie'] = cookie
    if body is not None:
        body = json.dumps(body).encode()
        headers['Content-Type'] = 'application/json'
    try:
        connection.request(method, path, body, headers)
        response = connection.getresponse()
        data = response.read(2 * 1024 * 1024 + 1)
        require(response.status in expect and len(data) <= 2 * 1024 * 1024, 'loopback-api-refused')
        mime = (response.getheader('Content-Type') or '').split(';')[0]
        return (json.loads(data) if data and mime == 'application/json' else None,
                [value for name, value in response.getheaders() if name.lower() == 'set-cookie'])
    finally:
        connection.close()


def session(operation, credential):
    body, cookies = http('POST', '/api/auth/' + operation, body=credential, expect=(201,))
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


def seed(cookie):
    marker = secrets.token_hex(12)
    title, name = 'Official update fixture', 'orbis-ota-fixture-' + marker[:8]
    url = 'https://ota-fixture.invalid/' + marker
    http('POST', '/api/links', body={'title': title, 'url': url, 'description': title,
                                    'isVisibleOnGuestDashboard': False}, cookie=cookie, expect=(200, 201))
    entries, _ = http('GET', '/api/links', cookie=cookie)
    links = [item for item in entries['links'] if item['url'] == url]
    require(len(links) == 1 and type(links[0]['id']) is int and 0 < links[0]['id'] < 2**31, 'fixture-link-missing')
    program = ("const f=require('node:fs');f.mkdirSync('/ota-data',{recursive:true});"
               f"if(!f.existsSync('/ota-data/marker'))f.writeFileSync('/ota-data/marker','{marker}',{{flag:'wx'}});"
               "setInterval(()=>{},1000)")
    config = {'services': {'web': {'image': f'{IMAGE}@{SOURCE[2]}', 'entrypoint': ['node', '-e'], 'command': [program],
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
            require(len(selected) == 1 and selected[0]['appUrn'] == urn and selected[0]['action'] == 'install'
                    and selected[0]['status'] in ('queued', 'running', 'succeeded'), 'fixture-app-task-refused')
            if selected[0]['status'] == 'succeeded':
                return marker, name, links[0]['id']
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
    status = load('orbis-host-service-setup', HOST).read_socket_status()
    require(status['currentTag'] == pin[0] and status['currentDigest'] == pin[2] and status['imageMatches'] is True
            and status['enrolled'] is True and status['coreHealth'] == 'healthy' and status['serviceRole'] == 'administration'
            and 'runtipi-412-update.v1' in status['capabilities']
            and run(['/usr/bin/systemctl', 'is-active', 'orbis-host.service']) == 'active',
            'installed-host-refused')
    sentinel = load('orbis-sentinel-install', HOST)
    sentinel._installed_payload(sentinel.INSTALLED_STATE, sentinel.INSTALLED_ROOT)
    installed = json.loads((sentinel.INSTALLED_STATE / 'installed.json').read_bytes())
    status_sentinel = load('orbis-host-service', HOST).sentinel_component_status()
    require({key: installed[key] for key in SENTINEL} == SENTINEL and status_sentinel['available'] is True
            and status_sentinel['status']['components']['sentinel']['installedVersion'] == SENTINEL['version'],
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


def completed(status, target):
    operation = status['job']['id']
    require(str(uuid.UUID(operation)) == operation and status['job']['state'] == 'complete'
            and status['job']['backupPolicy'] == 'automatic', 'coordinated-job-refused')
    job = json.loads((STATE / 'job.json').read_bytes())
    operation_dir = STATE / 'component-upgrades' / operation
    require(list(operation_dir.parent.iterdir()) == [operation_dir], 'more-than-one-coordinated-operation')
    target_body = (operation_dir / 'target-set.json').read_bytes()
    target_set = json.loads(target_body)
    require(job['id'] == operation and job['state'] == 'complete' and job['backupPolicy'] == 'automatic'
            and job['current']['digest'] == SOURCE[2] and job['target']['digest'] == target[2]
            and target_set['core']['digest'] == target[2] and target_set['sentinel']['release'] == SENTINEL,
            'authoritative-job-refused')
    previous = None
    journal = {}
    for index, path in enumerate(sorted((operation_dir / 'component-journal').iterdir())):
        body = path.read_bytes()
        record = json.loads(body)
        phase = record['phase']
        require(index < 64 and phase not in journal and path.name == f'{index:02d}-{phase}.json'
                and record['operationId'] == operation and record['targetSetSha256'] == sha(target_body)
                and record['previousSha256'] == previous, 'component-journal-binding-refused')
        journal[phase] = record['value']
        previous = sha(body)
    phases = list(journal)
    expected = ['integration-ready', 'host-ready', 'core-ready', 'complete']
    require(phases[-1:] == ['complete'] and all(phase in journal for phase in expected)
            and [phases.index(phase) for phase in expected] == sorted(phases.index(phase) for phase in expected)
            and previous == job['componentReceiptSha256'], 'component-terminal-receipt-refused')
    terminal = journal['complete']
    require(terminal['core'] == {'commit': target[1], 'digest': target[2]}
            and terminal['sentinel']['release'] == SENTINEL, 'component-set-mismatch')
    setup = load('orbis-host-service-setup', HOST)
    current_host = setup.actual_copy(setup.INSTALL_DIR, setup.UNIT_FILE)
    target_host = {key: target_set['host'][key] for key in ('inventory', 'unitSha256')}
    require(current_host == target_host, 'component-host-inventory-mismatch')

    update = load('orbis-host-update', HOST)
    snapshot = Path('/var/lib/orbis/snapshots') / f'orbis-{target[0]}-{operation}'
    require(job['snapshot'] == str(snapshot), 'backed-operation-path-mismatch')
    producer = update.read_journal(snapshot, ROOT, 'default', job['current'], job['target'])
    tools, reader = update.controller_tools('default')
    record = tools.read_record(update.checkpoint_path(snapshot), ROOT, reader)
    manifest = tools.STORAGE.verified_manifest(snapshot)
    require(producer['stage'] == 'complete' and producer['backupScope'] == update.CONTROLLER.SCOPE
            and manifest['stage'] == 'complete' and record['backupFingerprint'] == tools.APPS.digest(manifest)
            and record['runtipiConfigurationStaging']['phase'] == 'staged'
            and record['runtipiConfigurationStaging']['completed'] == 3, 'backed-operation-custody-refused')
    for name, expected_hash in record['runtipiConfiguration']['stagedFileSha256'].items():
        require(name in ('.env', 'VERSION', 'orbis-compose.yml') and sha((ROOT / name).read_bytes()) == expected_hash,
                'installed-config-mismatch')
    require((ROOT / 'VERSION').read_text().strip() == target[3], 'installed-base-version-mismatch')
    require(run(DOCKER + ['inspect', '--format', '{{.State.Health.Status}}', 'runtipi-db']) == 'healthy',
            'installed-postgres-refused')
    run(DOCKER + ['exec', 'runtipi-queue', 'rabbitmq-diagnostics', '-q', 'check_running'], code='installed-queue-refused')
    observation = load('orbis-host-upgrade-supervision', HOST)
    units = [observation.unit_name(operation), observation.reconciliation_unit_name(operation)]
    until = time.monotonic() + 20
    while time.monotonic() < until:
        states = run(['/usr/bin/systemctl', 'show', '--property=ActiveState', '--value', *units]).split()
        if states == ['inactive', 'inactive']:
            return
        time.sleep(0.25)
    raise Refused('worker-quiescence-refused')


def fixture(environment, result):
    result['phase'] = 'scope'
    target = target_pin(environment)
    preflight(environment)
    result['phase'] = 'publisher'
    modules = [load(name) for name in ('orbis-release-check', 'install-orbis', 'orbis-host-upgrade-launcher')]
    source, candidate = [publisher(pin, *modules, environment.get('GITHUB_TOKEN')) for pin in (SOURCE, target)]
    result['phase'] = 'loopback-isolation'
    isolate_dashboard()
    result['phase'] = 'guided-source'
    launch(source, 'source', 600)
    baseline = check_host(SOURCE)
    require(baseline.get('job') is None, 'fresh-source-job-refused')
    result['phase'] = 'fixture-markers'
    credential = {'username': 'ota-fixture-' + secrets.token_hex(5), 'password': secrets.token_urlsafe(32)}
    cookie = session('register', credential)
    build(cookie, SOURCE)
    identity = seed(cookie)
    original = app_data(identity)
    proxy = run(DOCKER + ['inspect', '--format', '{{.Id}} {{.State.StartedAt}} {{.State.Running}}', 'runtipi-reverse-proxy'])
    require(proxy.endswith(' true'), 'source-ingress-refused')
    http('POST', '/api/auth/logout', cookie=cookie, expect=(204,))
    result['snapshotEstimateBytes'] = checkpoint_limit()
    result['phase'] = 'guided-target'
    with (WORK / 'apply-intent').open('xb') as fence:
        fence.write((target[2] + '\n').encode('ascii'))
        fence.flush()
        os.fsync(fence.fileno())
    launch(candidate, 'target', 1500)
    result['phase'] = 'terminal-readback'
    completed(check_host(target), target)
    cookie = session('login', credential)
    try:
        build(cookie, target)
        require(app_data(identity) == original, 'fixture-continuity-refused')
        require(run(DOCKER + ['inspect', '--format', '{{.Id}} {{.State.StartedAt}} {{.State.Running}}',
                             'runtipi-reverse-proxy']) == proxy, 'proxy-continuity-refused')
    finally:
        http('POST', '/api/auth/logout', cookie=cookie, expect=(204,))
    result.update(phase='complete', source=SOURCE[0], target=target[0], targetCommit=target[1], targetDigest=target[2],
                  runtipi=target[3], sentinel=SENTINEL['version'], markerChecks=2, appAndProxyUninterrupted=True,
                  componentTerminalVerified=True, automaticBackupVerified=True, loopbackVerified=True, passed=True)


def failure_readback(environment, result):
    if result.get('phase') not in ('guided-target', 'terminal-readback'):
        return
    try:
        target = target_pin(environment)
        if (WORK / 'apply-intent').read_bytes() != (target[2] + '\n').encode('ascii'):
            return
        service = load('orbis-host-service', HOST)
        job = service.read_private(STATE / 'job.json')
        if not job or job.get('target', {}).get('digest') != target[2] or job.get('current', {}).get('digest') != SOURCE[2]:
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
        if journal and journal.get('targetDigest') == target[2] and journal.get('previousDigest') == SOURCE[2]:
            stage = journal.get('stage')
            if stage in update.FAILURE_STAGES | update.TERMINAL_STAGES | {'rolling-back', 'rollback-failed', 'recovery-required'}:
                result['producerStage'] = stage
            result.update(update.safe_failure(journal))
    except Exception:
        # Secondary readback never changes an outcome or reveals raw state.
        return


def main():
    result = {'schema': 'orbis.official-upgrade-runtime.v1', 'passed': False}
    try:
        fixture(os.environ, result)
    except Refused as error:
        result['error'] = str(error)
        result.update(error.evidence)
    except Exception:
        # Installed command and API errors may contain the fixture's credentials.
        result['error'] = 'fixture-step-failed'
    if not result['passed']:
        failure_readback(os.environ, result)
    print(json.dumps(result, sort_keys=True))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
