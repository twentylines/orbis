#!/usr/bin/env python3
"""Qualify real Host/Core storage and optional isolated data flows on Linux.

The fixture never configures recovery, systemd or production services. Optional
normal setup creates an account only in this run's disposable installation.
Optional Engine cases write only separately named synthetic test databases.
It refuses existing installations and destroys only positively identified actors
created by this run. Generated environment files and raw process output stay local.
"""
import argparse
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import stat
import subprocess
import sys
import time

IMAGE = 'ghcr.io/twentylines/orbis'
ENGINE_IMAGE = 'docker.io/library/postgres@sha256:09f23e02d76670d3b346a3c00aa33a27cf57aab8341eedfcdaed41459d14f5c4'
SERVICES = ('runtipi-db', 'runtipi-queue', 'runtipi-reverse-proxy', 'runtipi')
NETWORK = 'runtipi_tipi_main_network'
DEPENDENCIES = {
    'library/postgres': {'reference': 'docker.io/library/postgres@sha256:c0e9c0e9bac7e4c1834b698217a03ee5c708de30d313c84a506972de0e24b059'},
    'library/rabbitmq': {'reference': 'docker.io/library/rabbitmq@sha256:3dbd31cb9e4d45dac44de7b73cc45b848028494e98bcab71477386cbd4dc7f56'},
    'library/traefik': {'reference': 'docker.io/library/traefik@sha256:171c9c3565b29f6c133f1c1b43c5d4e5853415198e9e1078c001f8702ff66aec'},
}

# Optional diagnostic instrumentation records only public source locations and
# exception types. The original service, predicates and exceptions are unchanged.
HOST_TRACE_BOOTSTRAP = r'''
import json, os, pathlib, re, runpy, sys, threading
if sys.platform != 'linux' or os.geteuid() != 0 or os.environ.get('ORBIS_HOST_STORAGE_TEST') != '1' or os.environ.get('ORBIS_HOST_STORAGE_TRACE') != '1':
    raise SystemExit('The isolated Host observation diagnostic is not enabled.')
service = pathlib.Path(sys.argv[1])
if service.name != 'orbis-host-service.py' or not service.is_file():
    raise SystemExit('The source Host service is required.')
modules = {'orbis-host-app-storage.py', 'orbis-host-credential-peer.py', 'orbis-host-service.py', 'orbis-host.py'}
credential_modules = {'orbis-host-ownership-bootstrap.py', 'orbis-host-ownership-authority.py',
                      'orbis-host-credential-fence.py', 'orbis-host-credential-service.py', 'orbis-host-existing-ownership.py'}
modules |= credential_modules
files = {str(service.parent / name) for name in modules}
observation_file = str(service.parent / 'orbis-host-app-storage.py')
ownership_file = str(service.parent / 'orbis-host-ownership-bootstrap.py')
errors = {'ValueError', 'TypeError', 'KeyError', 'OSError', 'PermissionError', 'FileNotFoundError', 'RuntimeError'}
local = threading.local()
count = 0
def trace(frame, event, arg):
    global count
    # Only calls, returns and exceptions matter; tracing every source line can
    # distort a real credential request enough to hit its unchanged deadline.
    frame.f_trace_lines = False
    filename, function = frame.f_code.co_filename, frame.f_code.co_name
    selected = (filename == observation_file and function == 'observe'
                or filename == ownership_file and function == 'request'
                and frame.f_locals.get('operation') in ('change-admission', 'ownership-prepare', 'ownership-check', 'ownership-complete'))
    if selected and event == 'call': local.depth = getattr(local, 'depth', 0) + 1
    if not getattr(local, 'depth', 0) or filename not in files: return None
    if event == 'exception' and count < 200 and arg[0].__name__ in errors:
        if arg[0].__name__ == 'FileNotFoundError':
            return trace
        count += 1
        record = {'module': pathlib.Path(filename).name, 'function': function, 'line': frame.f_lineno, 'error': arg[0].__name__}
        if filename == observation_file and function == 'mounts':
            # Classify only the rejected syntax. Never emit paths, inode IDs,
            # namespaces, mount destinations or other observed values.
            root = frame.f_locals.get('root')
            destination = frame.f_locals.get('destination')
            extra = frame.f_locals.get('extra', [])
            record['mountInput'] = {
                'rootAbsolute': isinstance(root, str) and root.startswith('/'),
                'destinationAbsolute': isinstance(destination, str) and destination.startswith('/'),
                'destinationCanonical': isinstance(destination, str) and os.path.normpath(destination) == destination,
                'namespaceHandle': isinstance(root, str) and re.fullmatch(r'(?:net|mnt|uts|ipc|user|pid|pid_for_children|cgroup|time|time_for_children):\[[0-9]{1,20}\]', root) is not None,
                'filesystem': 'nsfs' if extra and extra[0] == 'nsfs' else 'other',
            }
        if filename == observation_file and function == 'verify':
            # Compare copies for diagnosis only. Never alter a witness or emit
            # observed values, configuration, paths or process identities.
            try:
                before = frame.f_locals['self'].before
                current = frame.f_locals['current']
                fields = ('pid', 'daemonSha256', 'socketIdentity', 'enrollmentSha256', 'publicationSha256')
                differences = [key for key in fields if before.get(key) != current.get(key)]
                differences += ['controller.' + key for key in ('id', 'imageId', 'startedAt', 'definitionSha256')
                                if before['controller'].get(key) != current['controller'].get(key)]
                previous_mounts, current_mounts = before['raw'].get('Mounts'), current['raw'].get('Mounts')
                encode = lambda rows: sorted(json.dumps(row, sort_keys=True) for row in rows)
                record['differences'] = differences
                record['mountOrderOnly'] = (type(previous_mounts) is list and type(current_mounts) is list
                    and previous_mounts != current_mounts and encode(previous_mounts) == encode(current_mounts))
                record['otherDefinitionFieldsEqual'] = all(before['raw'].get(key) == current['raw'].get(key)
                    for key in ('Config', 'HostConfig', 'Path', 'Args'))
            except Exception:
                pass
        try:
            os.write(2, ('ORBIS_HOST_STORAGE_TRACE ' + json.dumps(record, sort_keys=True) + '\n').encode())
        except OSError:
            pass
    if selected and event == 'return': local.depth -= 1
    return trace
sys.settrace(trace)
threading.settrace(trace)
sys.argv = sys.argv[1:]
runpy.run_path(str(service), run_name='__main__')
'''


class Refused(Exception):
    pass


def require(value, code):
    if not value:
        raise Refused(code)


def engine_probe_diagnostics(result):
    error = result.stderr
    return {'stdoutPresent': bool(result.stdout), 'stderrPresent': bool(error),
            'outputBounded': len(result.stdout) <= 16384 and len(error) <= 16384,
            'moduleResolutionError': any(value in error for value in (b'ERR_MODULE_NOT_FOUND', b'MODULE_NOT_FOUND', b'Cannot find module', b'Cannot find package')),
            'dynamicRequireError': b'Dynamic require of' in error and b'not supported' in error,
            'syntaxError': b'SyntaxError:' in error, 'referenceError': b'ReferenceError:' in error,
            'permissionError': b'ERR_ACCESS_DENIED' in error}


NORMAL_SETUP_PROBE = r'''
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';

let phase = 'fixture-preconditions';
const completed = [];
let lastStatus;

function require(value) {
  if (!value) throw new Error('fixture-refused');
}

function request(method, pathname, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: 3000, method, path: pathname, agent: false, signal: AbortSignal.timeout(120000),
      headers: {
        Host: 'fixture.invalid', Origin: 'http://fixture.invalid', Connection: 'close',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 65536) response.destroy(new Error('response-limit'));
        else chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('aborted', () => reject(new Error('response-aborted')));
      response.once('end', () => {
        lastStatus = response.statusCode;
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: response.statusCode, body: raw ? JSON.parse(raw) : undefined,
            cookies: response.headers['set-cookie'] ?? [] });
        } catch {
          reject(new Error('response-json'));
        }
      });
    });
    req.setTimeout(120000, () => req.destroy(new Error('request-deadline')));
    req.once('error', reject);
    req.end(payload);
  });
}

function session(response) {
  // The server retires a legacy domain cookie before issuing the host-only one.
  const cookies = response.cookies.filter((value) => value.startsWith('runtipi-sid=')
    && value.split(';', 1)[0] !== 'runtipi-sid=' && !/(?:^|;)\s*Domain=/i.test(value));
  require(cookies.length === 1);
  const cookie = cookies[0].split(';', 1)[0];
  require(cookie.length <= 4096 && !cookie.includes('\r') && !cookie.includes('\n'));
  return cookie;
}

try {
  const commit = process.argv[2];
  require(process.argv[3] === '--exercise-normal-setup');
  require(process.platform === 'linux' && process.geteuid?.() === 0);
  require(/^[a-f0-9]{40}$/.test(commit) && process.env.ORBIS_COMMIT === commit);
  require(process.env.NODE_ENV === 'production' && process.env.DEMO_MODE === 'false');
  require(process.env.ORBIS_HOST_SOCKET === '/run/orbis/host.sock');
  const marker = '/opt/orbis-test-probe/normal-setup-enabled';
  const info = await fs.lstat(marker);
  require(info.isFile() && !info.isSymbolicLink() && info.uid === 0 && (info.mode & 0o022) === 0);
  require(await fs.readFile(marker, 'utf8') === `ephemeral-normal-setup\n${commit}\n`);

  const username = `fixture-${randomUUID().slice(0, 12)}`;
  const originalPassword = randomBytes(32).toString('base64url');
  const replacementPassword = randomBytes(32).toString('base64url');
  phase = 'actual-first-registration';
  const registered = await request('POST', '/api/auth/register', { body: { username, password: originalPassword } });
  require(registered.status === 201 && registered.body?.success === true);
  const originalCookie = session(registered);
  const apps = await request('GET', '/api/apps/installed', { cookie: originalCookie });
  require(apps.status === 200 && Array.isArray(apps.body?.installed) && apps.body.installed.length === 0);
  completed.push('root-authorized-first-registration');

  phase = 'second-registration-refusal';
  const duplicate = await request('POST', '/api/auth/register', {
    body: { username: `fixture-other-${randomUUID().slice(0, 12)}`, password: randomBytes(32).toString('base64url') },
  });
  require(duplicate.status === 403);
  require((await request('GET', '/api/apps/installed', { cookie: originalCookie })).status === 200);
  completed.push('second-operator-registration-refused');

  phase = 'root-authorized-password-change';
  const changed = await request('PATCH', '/api/auth/password', {
    body: { currentPassword: originalPassword, newPassword: replacementPassword }, cookie: originalCookie,
  });
  require(changed.status === 204);
  require((await request('GET', '/api/apps/installed', { cookie: originalCookie })).status === 401);
  const oldLogin = await request('POST', '/api/auth/login', { body: { username, password: originalPassword } });
  require(oldLogin.status === 400 && oldLogin.cookies.length === 0);
  const newLogin = await request('POST', '/api/auth/login', { body: { username, password: replacementPassword } });
  require(newLogin.status === 201 && newLogin.body?.success === true && !newLogin.body?.totpSessionId);
  const replacementCookie = session(newLogin);
  require((await request('GET', '/api/apps/installed', { cookie: replacementCookie })).status === 200);
  completed.push('root-authorized-password-change-and-session-retirement');

  phase = 'actual-logout';
  const loggedOut = await request('POST', '/api/auth/logout', { cookie: replacementCookie });
  require(loggedOut.status === 204);
  require((await request('GET', '/api/apps/installed', { cookie: replacementCookie })).status === 401);
  completed.push('session-logout');
  process.stdout.write(`${JSON.stringify({ case: 'normal-setup-api', passed: true, completed, credentialsLogged: false })}\n`);
} catch {
  // Passwords, cookies, response bodies and error stacks are deliberately absent.
  process.stdout.write(`${JSON.stringify({ case: 'normal-setup-api', passed: false, completed, failurePhase: phase, lastStatus })}\n`);
  process.exitCode = 1;
}

'''

MAPPED = Path('/var/lib/orbis-normal-setup-fixture')
STATE_PARENT = Path('/var/lib/orbis')
STATE = STATE_PARENT / 'state'




def identity(path):
    value = path.lstat()
    require(stat.S_ISDIR(value.st_mode) and not path.is_symlink(), 'physical-directory-required')
    return value.st_dev, value.st_ino, value.st_uid, value.st_gid, stat.S_IMODE(value.st_mode)


def mount_rows():
    rows = []
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        fields = line.split()
        require(len(fields) >= 10 and '-' in fields, 'invalid-mount-table')
        # Fixed mount points and generated scopes contain no escaped whitespace.
        rows.append({'id': fields[0], 'point': fields[4], 'options': fields[5],
                     'optional': fields[6:fields.index('-')]})
    return rows


def mount_command(*arguments):
    result = subprocess.run(arguments, capture_output=True, timeout=20)
    require(result.returncode == 0, 'protected-fixture-mount-operation-failed')


class ProtectedScope:
    def __init__(self, source, physical):
        self.source, self.physical = Path(source), Path(physical)
        self.physical_identity = None
        self.created = []
        self.mounts = []
        self.entered = False

    def preflight(self):
        require(sys.platform == 'linux' and os.geteuid() == 0, 'linux-root-required')
        require(os.environ.get('ORBIS_NORMAL_SETUP_TEST') == '1', 'explicit-normal-setup-gate-required')
        require(self.source == self.source.resolve(strict=True)
                and self.physical == self.physical.resolve(strict=True)
                and self.physical.parent == self.source
                and re.fullmatch(r'\.orbis-host-[A-Za-z0-9]{6,16}', self.physical.name), 'named-checkout-scope-required')
        self.physical_identity = identity(self.physical)
        require(self.physical_identity[2:] == (0, 0, 0o700)
                and not list(self.physical.iterdir()), 'fresh-root-owned-scope-required')
        require(not any(os.path.lexists(path) for path in (MAPPED, STATE_PARENT)), 'preexisting-orbis-state-refused')
        require(not any(row['point'] in (str(MAPPED), str(STATE_PARENT), str(STATE)) for row in mount_rows()), 'preexisting-orbis-mount-refused')

    def directory(self, path):
        path.mkdir(mode=0o700)
        before = identity(path)
        require(before[2:] == (0, 0, 0o700), 'unprotected-mountpoint')
        self.created.append((path, before))

    def bind(self, source, target):
        before = identity(source)
        placeholder = identity(target)
        prior = {row['id'] for row in mount_rows()}
        mount_command('mount', '--bind', str(source), str(target))
        # Retain the exact new mount before further operations, so a failed
        # propagation update still has a positively bound cleanup target.
        rows = [row for row in mount_rows() if row['point'] == str(target)]
        require(len(rows) == 1 and rows[0]['id'] not in prior and identity(target) == before, 'new-bind-mount-not-proven')
        self.mounts.append({'target': target, 'source': source, 'identity': before,
                            'placeholder': placeholder, 'mountId': rows[0]['id']})
        mount_command('mount', '--make-private', str(target))
        rows = [row for row in mount_rows() if row['point'] == str(target)]
        require(len(rows) == 1 and rows[0]['id'] == self.mounts[-1]['mountId']
                and not any(value.startswith(('shared:', 'master:', 'propagate_from:')) for value in rows[0]['optional']),
                'private-bind-propagation-required')

    def verify(self):
        require(self.physical_identity is not None and identity(self.physical) == self.physical_identity, 'physical-scope-replaced')
        rows = mount_rows()
        for record in self.mounts:
            matches = [row for row in rows if row['point'] == str(record['target'])]
            require(len(matches) == 1 and matches[0]['id'] == record['mountId']
                    and identity(record['source']) == record['identity']
                    and identity(record['target']) == record['identity'], 'protected-fixture-mount-changed')

    def enter(self):
        self.preflight()
        private_state = self.physical / 'private-host-state'
        private_state.mkdir(mode=0o700)
        try:
            self.directory(MAPPED)
            self.directory(STATE_PARENT)
            self.directory(STATE)
            self.bind(self.physical, MAPPED)
            self.bind(private_state, STATE)
            self.verify()
            self.entered = True
            return MAPPED, STATE
        except BaseException:
            self.release()
            raise

    def release(self):
        # No lazy/forced unmount, group signal, name-based process stop or broad
        # deletion. An active actor/changed identity leaves evidence for review.
        if self.mounts:
            self.verify()
        while self.mounts:
            record = self.mounts[-1]
            mount_command('umount', str(record['target']))
            require(identity(record['target']) == record['placeholder'], 'mountpoint-placeholder-changed')
            self.mounts.pop()
        for path, before in reversed(self.created):
            require(identity(path) == before and not list(path.iterdir()), 'mountpoint-not-empty-or-changed')
            path.rmdir()
        self.created.clear()
        self.entered = False



def canonical_reference(value):
    """Keep the exact digest while expanding Docker's familiar repository names."""
    if not isinstance(value, str) or len(value) > 1024:
        return None
    match = re.fullmatch(r'([^@]+)@(sha256:[a-f0-9]{64})', value)
    if match is None:
        return None
    parts, digest = match[1].split('/'), match[2]
    registry = 'docker.io'
    if len(parts) > 1 and (parts[0] == 'localhost' or '.' in parts[0] or ':' in parts[0]):
        registry = parts.pop(0)
        if not re.fullmatch(r'(?:localhost|[a-z0-9]+(?:[.-][a-z0-9]+)*)(?::[0-9]{1,5})?', registry):
            return None
        port = registry.split(':')[1:]
        if port and not 1 <= int(port[0]) <= 65535:
            return None
    if registry == 'index.docker.io':
        registry = 'docker.io'
    if not parts or any(not re.fullmatch(r'[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*', part) for part in parts):
        return None
    if registry == 'docker.io' and len(parts) == 1:
        parts.insert(0, 'library')
    return registry + '/' + '/'.join(parts) + '@' + digest


def startup_signals(body, packages, private_values=()):
    """Return bounded diagnostics without configuration, paths or credentials."""
    # Node can print a very long minified source line before its actual error.
    # Keep both bounded ends so that line cannot hide the final failure marker.
    text = (body[:128 * 1024] + b'\n' + body[-128 * 1024:]).decode('utf-8', errors='replace')
    text = '\n'.join(line for line in text.splitlines() if len(line) <= 4096)
    text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)
    markers = {
        'missing-module': ('ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'Cannot find package', 'Cannot find module'),
        'native-module': ('ERR_DLOPEN_FAILED', 'invalid ELF header'),
        'syntax-error': ('SyntaxError:',),
        'reference-error': ('ReferenceError:',),
        'type-error': ('TypeError:',),
        'permission-denied': ('EACCES', 'EPERM'),
        'missing-file': ('ENOENT',),
        'busy-file': ('EBUSY',),
        'connection-refused': ('ECONNREFUSED',),
        'database-authentication': ('password authentication failed',),
        'cli-secret-storage': ('CLI authentication storage is invalid or not private',),
        'server-configuration': ('Invalid server configuration',),
        'settings-configuration': ('Invalid settings.json file',),
        'dependency-injection': ("Nest can't resolve dependencies",),
        'schema-parse': ('ParseError:',),
        'bundled-commonjs-wrapper': ('Expected CommonJS module to have a function wrapper',),
        'database-query': ('DrizzleQueryError:', 'QueryFailedError:'),
        'dependency-package': ('package is missing.', 'No driver (HTTP) has been selected'),
    }
    missing = set()
    candidates = re.findall(r"Cannot find (?:package|module) ['\"]([^'\"\r\n]{1,200})['\"]", text)
    candidates += re.findall(r'The "([^"\r\n]{1,200})" package is missing\.', text)
    for value in candidates:
        root = '/'.join(value.split('/')[:2]) if value.startswith('@') else value.split('/')[0]
        if root in packages:
            missing.add(root)
    messages = []
    for line in text.splitlines():
        context = re.search(r'\b(?:ERROR|FATAL)\s+\[[A-Za-z][A-Za-z0-9_.:-]{0,63}\]\s*', line)
        if context:
            line = line[context.end():].strip()
        elif not re.match(r'^[A-Za-z]{0,48}(?:Error|Exception)(?: \[[A-Z_]+\])?:', line):
            continue
        if re.search(r'password|token|secret|cookie|session|PRIVATE KEY', line, re.I):
            continue
        for value in private_values:
            if isinstance(value, str) and len(value) >= 4:
                line = line.replace(value, '<private>')
        line = re.sub(r"(['\"`]).*?\1", '<quoted>', line)
        line = re.sub(r'https?://\S+|/[\w./:@%+~=-]+|[\w.+-]+@[\w.-]+|[A-Za-z0-9_+/=-]{32,}', '<private>', line)
        line = ''.join(char for char in line if 32 <= ord(char) <= 126)[:320]
        if line and line not in messages:
            messages.append(line)
        if len(messages) == 3:
            break
    return {'markers': sorted(key for key, values in markers.items() if any(value in text for value in values)),
            'missingPackages': sorted(missing), 'messages': messages, 'logBytes': len(body)}


def load(file, name):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(arguments, root, *, timeout=60, accepted=(0,)):
    try:
        result = subprocess.run(arguments, cwd=root, capture_output=True, timeout=timeout,
                                env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'})
    except subprocess.TimeoutExpired:
        raise Refused('command-deadline') from None
    require(result.returncode in accepted, 'command-failed')
    # Raw output can contain generated credentials or environment configuration.
    # Callers must select strict public fields; never forward it into job logs.
    return result


class Runtime:
    def __init__(self, source, folder, manifest_path, probe, *, normal_setup=False, host_engine=False):
        self.source, self.folder = source, folder
        self.manifest_path, self.probe = manifest_path, probe
        self.normal_setup = normal_setup
        self.host_engine = host_engine
        self.normal_scope = None
        self.layout_folder = folder
        self.host_state = folder / 'host-state'
        self.root = folder / 'install'
        self.socket = folder / 'socket/host.sock'
        self.host = None
        self.host_start = None
        self.host_log = None
        self.owned = {}
        self.network = None
        self.original_containers = None
        self.original_networks = None
        self.container_creation_started = False
        self.results = []
        self.failure_role = None

    def docker(self, *arguments, timeout=60, accepted=(0,)):
        return run(['docker', '--context', 'default', *arguments], self.source, timeout=timeout, accepted=accepted)

    def identifiers(self, kind):
        arguments = ['ls', '--quiet', '--no-trunc']
        if kind == 'container':
            arguments.append('--all')
        output = self.docker(kind, *arguments).stdout.decode('ascii')
        result = set(output.split())
        require(all(re.fullmatch(r'[a-f0-9]{64}', item) for item in result), 'invalid-inventory')
        return result

    def inspect(self, identifier, *, kind='container'):
        body = self.docker(kind, 'inspect', '--format', '{{json .}}', identifier).stdout
        require(len(body) <= 512 * 1024, 'oversized-inspection')
        result = json.loads(body)
        require(type(result) is dict, 'invalid-inspection')
        return result

    def prepare(self):
        require(sys.platform == 'linux' and os.geteuid() == 0, 'linux-root-required')
        require(os.environ.get('ORBIS_HOST_STORAGE_TEST') == '1', 'explicit-fixture-gate-required')
        require(not self.host_engine or os.environ.get('ORBIS_HOST_ENGINE_TEST') == '1', 'explicit-host-engine-gate-required')
        require(self.source.is_dir() and self.source == self.source.resolve(strict=True), 'physical-source-required')
        require(self.folder == self.folder.resolve(strict=True) and self.folder.parent == self.source
                and re.fullmatch(r'\.orbis-host-[A-Za-z0-9]{6,16}', self.folder.name), 'scoped-fixture-required')
        info = self.folder.lstat()
        require(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700 and not list(self.folder.iterdir()), 'fresh-protected-fixture-required')
        require(not os.path.lexists('/var/lib/orbis/state'), 'existing-host-state-refused')
        require(len(os.fsencode(self.socket)) <= 107, 'unix-socket-path-too-long')
        endpoint = json.loads(self.docker('context', 'inspect', 'default', '--format', '{{json .Endpoints.docker.Host}}').stdout)
        require(endpoint in ('unix:///var/run/docker.sock', 'unix:///run/docker.sock'), 'local-engine-required')
        self.original_containers = self.identifiers('container')
        self.original_networks = self.identifiers('network')
        for identifier in self.original_containers:
            item = self.inspect(identifier)
            labels = item['Config'].get('Labels') or {}
            require(item.get('Name', '').lstrip('/') not in SERVICES
                    and labels.get('com.docker.compose.project') != 'runtipi', 'existing-controller-refused')
        for identifier in self.original_networks:
            item = self.inspect(identifier, kind='network')
            require(item.get('Name') != NETWORK and (item.get('Labels') or {}).get('com.docker.compose.project') != 'runtipi', 'existing-network-refused')
        fixture = load(Path(__file__).with_name('orbis-host-storage-fixture.py'), 'storage_runtime_fixture')
        fixture.SOURCE = self.source
        prepared = self.prepare_installation(fixture)
        self.manifest = prepared['manifest']
        require(self.manifest['image'] == IMAGE and re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+', self.manifest['tag']), 'candidate-required')
        # The workflow verifies the registry index/platform/config against the
        # publication receipt before this runner touches Docker.
        self.references = {name: value['image'] for name, value in prepared['config']['services'].items()}
        require(self.probe.is_file() and not self.probe.is_symlink() and self.probe.stat().st_size < 2 * 1024 * 1024, 'source-probe-required')
        target = self.folder / 'public-probe/probe.mjs'
        with target.open('xb') as output:
            output.write(self.probe.read_bytes())
        target.chmod(0o644)
        if self.normal_setup:
            api = self.folder / 'public-probe/normal-setup.mjs'
            with api.open('xb') as output:
                output.write(NORMAL_SETUP_PROBE.encode())
            api.chmod(0o644)
            marker = self.folder / 'public-probe/normal-setup-enabled'
            with marker.open('x') as output:
                output.write('ephemeral-normal-setup\n' + self.manifest['commit'] + '\n')
            marker.chmod(0o644)
        if self.host_engine:
            marker = self.folder / 'public-probe/host-engine-enabled'
            with marker.open('x') as output:
                output.write('ephemeral-host-engine\n' + self.manifest['commit'] + '\n' + secrets.token_hex(32) + '\n')
            marker.chmod(0o644)
            self.docker('pull', '--quiet', ENGINE_IMAGE, timeout=180)
            engine = self.inspect(ENGINE_IMAGE, kind='image')
            require(engine.get('Os') == 'linux' and engine.get('Architecture') == 'amd64'
                    and canonical_reference(ENGINE_IMAGE) in {canonical_reference(value) for value in (engine.get('RepoDigests') or [])},
                    'migration-engine-image-identity-mismatch')
        for reference in set(self.references.values()):
            self.docker('pull', '--quiet', reference, timeout=180)
        for name, reference in self.references.items():
            item = self.inspect(reference, kind='image')
            self.failure_role = name
            expected = canonical_reference(reference)
            require(expected is not None and expected in
                    {canonical_reference(value) for value in (item.get('RepoDigests') or [])}, 'pulled-digest-mismatch')
        self.failure_role = None
        core = self.inspect(self.references['runtipi'], kind='image')
        labels = core['Config'].get('Labels') or {}
        require(labels.get('org.opencontainers.image.source') == 'https://github.com/twentylines/orbis'
                and labels.get('org.opencontainers.image.revision') == self.manifest['commit']
                and labels.get('org.opencontainers.image.version') == self.manifest['tag'], 'pulled-candidate-identity-mismatch')

    def prepare_installation(self, fixture):
        if self.normal_setup:
            require(os.environ.get('ORBIS_NORMAL_SETUP_TEST') == '1', 'explicit-normal-setup-gate-required')
            self.normal_scope = ProtectedScope(self.source, self.folder)
            self.layout_folder, self.host_state = self.normal_scope.enter()
            self.root = self.layout_folder / 'install'
            self.socket = self.layout_folder / 'socket/host.sock'
        return fixture.prepare(self.manifest_path, self.layout_folder, DEPENDENCIES,
                               before_populate=self.issue_normal_birth if self.normal_setup else None,
                               credential_socket=self.normal_setup, host_engine=self.host_engine)

    def issue_normal_birth(self, root):
        require(self.normal_setup and self.normal_scope is not None and root == self.root
                and root == Path('/var/lib/orbis-normal-setup-fixture/install')
                and not list(root.iterdir()), 'exact-empty-normal-setup-root-required')
        self.normal_scope.verify()
        host = load(self.source / 'scripts/orbis-host.py', 'actual_normal_setup_host')
        detect = load(self.source / 'scripts/orbis-install-detect.py', 'actual_normal_setup_discovery')
        birth = host.load_script('orbis-host-ownership-bootstrap.py', 'actual_normal_setup_birth')
        manifest = host.PLAN.require_installation_protocol(json.loads(self.manifest_path.read_bytes()))
        reader = detect.DockerReader('default')
        require(reader.socket() in ('/var/run/docker.sock', '/run/docker.sock'), 'local-normal-setup-engine-required')
        with host.host_lock(root):
            self.normal_scope.verify()
            receipt = birth.prepare_new(host, root, reader, manifest)
            birth.verify_reference(host, root, reader.context, hashlib.sha256(reader.daemon().encode()).hexdigest(), receipt)
            self.normal_scope.verify()

    def probe_normal_setup(self):
        before = self.inspect(self.core_id())
        require(before['State']['Status'] == 'running' and before['State'].get('Health', {}).get('Status') == 'healthy', 'candidate-health-lost')
        result = self.docker('exec', self.core_id(), 'node', '/opt/orbis-test-probe/normal-setup.mjs',
                             self.manifest['commit'], '--exercise-normal-setup', timeout=180, accepted=(0, 1))
        require(len(result.stdout) <= 16384 and not result.stderr, 'invalid-normal-setup-probe-output')
        record = json.loads(result.stdout)
        require(type(record) is dict and record.get('case') == 'normal-setup-api', 'invalid-normal-setup-probe-output')
        allowed = ('root-authorized-first-registration', 'second-operator-registration-refused',
                   'root-authorized-password-change-and-session-retirement', 'session-logout')
        completed = record.get('completed', [])
        require(type(completed) is list and len(completed) <= len(allowed)
                and completed == list(allowed[:len(completed)]), 'invalid-normal-setup-case-sequence')
        passed = result.returncode == 0 and record.get('passed') is True and completed == list(allowed)
        self.results.append({'case': 'normal-setup-api', 'passed': passed, 'completed': completed,
            'failurePhase': record.get('failurePhase') if record.get('failurePhase') in (
                'fixture-preconditions', 'actual-first-registration', 'second-registration-refusal',
                'root-authorized-password-change', 'actual-logout') else None,
            'lastStatus': record.get('lastStatus') if type(record.get('lastStatus')) is int
                          and 100 <= record['lastStatus'] <= 599 else None})
        require(passed, 'normal-setup-api-failed')
        after = self.inspect(self.core_id())
        require(after['State']['StartedAt'] == before['State']['StartedAt'] and after['Image'] == before['Image'], 'normal-setup-controller-changed')
        credential = load(self.source / 'scripts/orbis-host-credential-service.py', 'normal_setup_config_boundary')
        require(not os.path.lexists(self.host_state / credential.CONFIG_NAME), 'unexpected-recovery-configuration')

    def probe_host_engine(self, mode):
        require(self.host_engine and os.environ.get('ORBIS_HOST_ENGINE_TEST') == '1'
                and mode in ('upgrade', 'rollback'), 'explicit-host-engine-gate-required')
        before = self.inspect(self.core_id())
        require(before['State']['Status'] == 'running' and before['State'].get('Health', {}).get('Status') == 'healthy', 'candidate-health-lost')
        result = self.docker('exec', self.core_id(), 'node', '/opt/orbis-test-probe/probe.mjs',
                             'host-engine-' + mode, self.manifest['commit'], '--exercise-host-engine', timeout=180, accepted=(0, 1))
        if len(result.stdout) > 16384 or result.stderr:
            self.results.append({'case': 'host-engine-' + mode, 'passed': False,
                                 'failurePhase': 'probe-startup', 'diagnostic': engine_probe_diagnostics(result),
                                 'modeledHost': False, 'mainWorkerTested': False})
            require(False, 'invalid-host-engine-probe-output')
        record = json.loads(result.stdout)
        require(type(record) is dict and record.get('case') == 'host-engine-' + mode, 'invalid-host-engine-probe-output')
        passed = (result.returncode == 0 and record.get('passed') is True and record.get('cleanup') is True
                  and record.get('modeledHost') is False and record.get('mainWorkerTested') is False
                  and record.get('productionTouched') is False and record.get('failurePhase') is None)
        phases = ('fixture-preconditions', 'fixture-environment', 'fixture-marker', 'fixture-directory', 'actual-host-witness', 'actual-postgres-fixture',
                  'actual-host-backed-checkpoint', 'actual-isolated-migration', 'actual-checkpoint-rollback', 'owned-actor-cleanup')
        if passed:
            after = self.inspect(self.core_id())
            require(after['State']['StartedAt'] == before['State']['StartedAt'] and after['Image'] == before['Image'], 'host-engine-controller-changed')
        self.results.append({'case': 'host-engine-' + mode, 'passed': passed, 'cleanup': record.get('cleanup') is True,
                             'failurePhase': record.get('failurePhase') if record.get('failurePhase') in phases else None,
                             'modeledHost': False, 'mainWorkerTested': False})
        require(passed, 'host-engine-probe-failed')

    def start_host(self):
        self.host_log = (self.folder / 'host.private.log').open('xb')
        command = [sys.executable, '-B', str(self.source / 'scripts/orbis-host-service.py'),
            '--root', str(self.root), '--docker-context', 'default', '--socket', str(self.socket),
            '--snapshots', str(self.layout_folder / 'snapshots'), '--state-dir', str(self.host_state)]
        if os.environ.get('ORBIS_HOST_STORAGE_TRACE') == '1':
            command = [sys.executable, '-B', '-c', HOST_TRACE_BOOTSTRAP, *command[2:]]
        self.host = subprocess.Popen(command,
            cwd=self.source, stdout=self.host_log, stderr=self.host_log,
            env={**os.environ, 'TMPDIR': str(self.folder), 'PYTHONDONTWRITEBYTECODE': '1'})
        # A Popen handle plus process start time prevents name-based cleanup.
        self.host_start = self.process_start(self.host.pid)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            require(self.host.poll() is None, 'host-start-failed')
            if self.socket.exists():
                info = self.socket.lstat()
                require(stat.S_ISSOCK(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600, 'invalid-host-socket')
                return
            time.sleep(0.1)
        raise Refused('host-socket-deadline')

    @staticmethod
    def process_start(pid):
        body = Path(f'/proc/{pid}/stat').read_text()
        return body[body.rfind(')') + 2:].split()[19]

    def compose(self, *arguments):
        return run(['docker', '--context', 'default', 'compose', '--project-name', 'runtipi',
                    '--project-directory', str(self.root), '-f', str(self.root / 'docker-compose.yml'),
                    '-f', str(self.root / 'user-config/tipi-compose.yml'), '-f', str(self.root / 'orbis-compose.yml'),
                    *arguments], self.root, timeout=300)

    def collect_owned(self):
        # Read-only inventory may discover actors from a partially failed up.
        # Validate every new ID before retaining it as cleanup authority.
        for identifier in self.identifiers('container') - self.original_containers:
            item = self.inspect(identifier)
            name = item.get('Name', '').lstrip('/')
            labels = item.get('Config', {}).get('Labels') or {}
            if labels.get('com.docker.compose.project') != 'runtipi':
                continue
            require(name in SERVICES and labels.get('com.docker.compose.service') == name
                    and labels.get('com.docker.compose.project.working_dir') == str(self.root)
                    and canonical_reference(item['Config'].get('Image')) == canonical_reference(self.references[name])
                    and re.fullmatch(r'sha256:[a-f0-9]{64}', item.get('Image', '')), 'unowned-fixture-container')
            identity = (name, item['Image'], item['Config']['Image'])
            require(identifier not in self.owned or self.owned[identifier] == identity, 'owned-container-changed')
            self.owned[identifier] = identity
        for identifier in self.identifiers('network') - self.original_networks:
            item = self.inspect(identifier, kind='network')
            labels = item.get('Labels') or {}
            if item.get('Name') != NETWORK:
                continue
            require(labels.get('com.docker.compose.project') == 'runtipi'
                    and labels.get('com.docker.compose.network') == 'tipi_main_network', 'unowned-fixture-network')
            require(self.network in (None, identifier), 'fixture-network-replaced')
            self.network = identifier

    def start_core(self):
        self.container_creation_started = True
        try:
            self.compose('up', '--detach', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '240')
        finally:
            self.collect_owned()
        require({value[0] for value in self.owned.values()} == set(SERVICES), 'missing-fixture-service')
        require(self.network is not None, 'missing-fixture-network')
        core = self.inspect(self.core_id())
        require(core['State']['Status'] == 'running' and core['State'].get('Health', {}).get('Status') == 'healthy', 'candidate-not-healthy')
        result = run([sys.executable, '-B', str(self.source / 'scripts/orbis-host.py'), 'enroll',
            str(self.root), str(self.manifest_path), '--docker-context', 'default', '--confirm-root', str(self.root)], self.source)
        require(json.loads(result.stdout).get('result') == 'enrolled', 'ordinary-enrollment-failed')

    def core_id(self):
        identifiers = [identifier for identifier, identity in self.owned.items() if identity[0] == 'runtipi']
        require(len(identifiers) == 1, 'ambiguous-core')
        return identifiers[0]

    def probe_core(self, mode):
        before = self.inspect(self.core_id())
        require(before['State']['Status'] == 'running' and before['State'].get('Health', {}).get('Status') == 'healthy', 'candidate-health-lost')
        result = self.docker('exec', self.core_id(), 'node', '/opt/orbis-test-probe/probe.mjs', mode, timeout=90, accepted=(0, 1))
        require(len(result.stdout) <= 16384 and not result.stderr, 'invalid-probe-output')
        record = json.loads(result.stdout)
        if result.returncode != 0:
            phases = ('preconditions', 'host-transport', 'witness-open', 'witness-use', 'witness-close')
            diagnostic = record.get('diagnostic', {})
            safe = {key: value for key, value in diagnostic.items()
                    if (key == 'hostStatus' and type(value) is int and 100 <= value <= 599)
                    or (key in ('metadataVerified', 'directoryMatches', 'engineSocketMatches') and type(value) is bool)}
            self.results.append({'case': mode, 'passed': False,
                                 'phase': record.get('failedPhase') if record.get('failedPhase') in phases else 'unknown',
                                 'diagnostic': safe})
            raise Refused('core-storage-probe-failed')
        require(record.get('case') == mode and record.get('passed') is True, 'core-storage-probe-failed')
        if mode != 'directory-drift':
            require(record.get('observation', {}).get('controllerId') == self.core_id(), 'probe-controller-mismatch')
        after = self.inspect(self.core_id())
        require(after['State']['StartedAt'] == before['State']['StartedAt'] and after['Image'] == before['Image'], 'controller-changed-during-probe')
        self.results.append({'case': mode, 'passed': True})

    def probe_outside(self):
        before = self.enrollment_hash()
        payload = json.dumps({'appUrn': 'probe:fixture', 'nonce': secrets.token_hex(32)}).encode()
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.settimeout(30)
        try:
            client.connect(str(self.socket))
            client.sendall(b'POST /v1/app-storage/observe HTTP/1.1\r\nHost: orbis\r\nContent-Type: application/json\r\nContent-Length: '
                           + str(len(payload)).encode() + b'\r\nConnection: close\r\n\r\n' + payload)
            response = http.client.HTTPResponse(client)
            response.begin()
            body = response.read(16385)
            require(response.status == 409 and len(body) <= 16384
                    and json.loads(body) == {'error': 'The app storage binding could not be verified.'}, 'outside-peer-not-refused')
        finally:
            client.close()
        require(self.enrollment_hash() == before, 'outside-peer-mutated-enrollment')
        self.results.append({'case': 'outside-main-peer-refused', 'passed': True})

    def enrollment_hash(self):
        return hashlib.sha256((self.root / '.orbis-host-state.json').read_bytes()).hexdigest()

    def cleanup(self):
        if self.original_containers is None or self.original_networks is None:
            return False
        if self.container_creation_started:
            self.collect_owned()
        # Close only this Popen-owned service, never another pid/service by name.
        if self.host is not None and self.host.poll() is None:
            require(self.process_start(self.host.pid) == self.host_start, 'host-process-changed')
            self.host.send_signal(signal.SIGINT)
            try:
                self.host.wait(timeout=8)
            except subprocess.TimeoutExpired:
                require(self.process_start(self.host.pid) == self.host_start, 'host-process-changed')
                self.host.terminate()
                self.host.wait(timeout=5)
        if self.host_log is not None:
            self.host_log.close()
        # Preserve nonfixture actors and refuse ownership drift before mutations.
        for identifier, identity in self.owned.items():
            item = self.inspect(identifier)
            name, image_id, reference = identity
            labels = item['Config'].get('Labels') or {}
            require(item.get('Name') == '/' + name and item.get('Image') == image_id and item['Config'].get('Image') == reference
                    and labels.get('com.docker.compose.project') == 'runtipi'
                    and labels.get('com.docker.compose.service') == name
                    and labels.get('com.docker.compose.project.working_dir') == str(self.root), 'cleanup-identity-changed')
        for identifier in reversed(list(self.owned)):
            self.docker('stop', '--time', '10', identifier, timeout=25)
            self.docker('rm', identifier)
        if self.network is not None:
            item = self.inspect(self.network, kind='network')
            labels = item.get('Labels') or {}
            require(item.get('Name') == NETWORK and labels.get('com.docker.compose.project') == 'runtipi'
                    and labels.get('com.docker.compose.network') == 'tipi_main_network'
                    and not item.get('Containers'), 'cleanup-network-identity-changed')
            self.docker('network', 'rm', self.network)
        require(self.identifiers('container') == self.original_containers
                and self.identifiers('network') == self.original_networks, 'original-inventory-changed')
        if self.normal_scope is not None:
            self.normal_scope.release()
        (self.folder / 'cleanup-complete').write_text('Only positively identified fixture actors removed.\n')
        return True

    def diagnostics(self):
        # Record only bounded runtime state, never environment, raw inspect,
        # application output, Host logs or health-check command output.
        records = []
        for identifier, identity in self.owned.items():
            try:
                item = self.inspect(identifier)
                state = item.get('State') or {}
                status = state.get('Status')
                health = (state.get('Health') or {}).get('Status')
                records.append({'service': identity[0],
                    'status': status if status in ('created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead') else 'unknown',
                    'health': health if health in ('starting', 'healthy', 'unhealthy') else 'none',
                    'exitCode': state.get('ExitCode') if type(state.get('ExitCode')) is int else None})
                if identity[0] == 'runtipi' and status != 'running':
                    package = json.loads((self.source / 'packages/backend/package.json').read_bytes())
                    packages = set(package.get('dependencies', {}))
                    logs = self.docker('logs', '--tail', '100', identifier)
                    configuration = (self.root / '.env').read_text().splitlines()
                    private_values = [line.split('=', 1)[1] for line in configuration if '=' in line]
                    private_values.extend((str(self.root), str(self.folder), str(self.source)))
                    records[-1]['startup'] = startup_signals(logs.stdout + logs.stderr, packages, private_values)
            except (Refused, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
                records.append({'service': identity[0], 'status': 'unavailable'})
        return records

    def host_trace_records(self):
        if os.environ.get('ORBIS_HOST_STORAGE_TRACE') != '1':
            return []
        path = self.folder / 'host.private.log'
        if not path.is_file() or path.is_symlink():
            return []
        with path.open('rb') as log:
            log.seek(max(0, path.stat().st_size - 128 * 1024))
            lines = log.read(128 * 1024).splitlines()
        records = []
        for line in lines:
            if not line.startswith(b'ORBIS_HOST_STORAGE_TRACE ') or len(line) > 512:
                continue
            try:
                value = json.loads(line.split(b' ', 1)[1])
                base = {'module', 'function', 'line', 'error'}
                extended = base | {'differences', 'mountOrderOnly', 'otherDefinitionFieldsEqual'}
                mount_input = base | {'mountInput'}
                fields = ('pid', 'daemonSha256', 'socketIdentity', 'enrollmentSha256', 'publicationSha256',
                          'controller.id', 'controller.imageId', 'controller.startedAt', 'controller.definitionSha256')
                if (type(value) is dict and set(value) in (base, extended, mount_input)
                        and value['module'] in ('orbis-host-app-storage.py', 'orbis-host-credential-peer.py', 'orbis-host-service.py', 'orbis-host.py',
                            'orbis-host-ownership-bootstrap.py', 'orbis-host-ownership-authority.py', 'orbis-host-credential-fence.py',
                            'orbis-host-credential-service.py', 'orbis-host-existing-ownership.py')
                        and type(value['function']) is str and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,127}|<(?:genexpr|listcomp|dictcomp|lambda)>', value['function'])
                        and type(value['line']) is int and 1 <= value['line'] <= 100000
                        and value['error'] in ('ValueError', 'TypeError', 'KeyError', 'OSError', 'PermissionError', 'FileNotFoundError', 'RuntimeError')):
                    if set(value) == mount_input:
                        selected = value['mountInput']
                        if (value['module'] == 'orbis-host-app-storage.py' and value['function'] == 'mounts'
                                and type(selected) is dict and set(selected) == {'rootAbsolute', 'destinationAbsolute', 'destinationCanonical', 'namespaceHandle', 'filesystem'}
                                and all(type(selected[key]) is bool for key in ('rootAbsolute', 'destinationAbsolute', 'destinationCanonical', 'namespaceHandle'))
                                and selected['filesystem'] in ('nsfs', 'other')):
                            records.append(value)
                    elif set(value) == base or (type(value['differences']) is list and len(value['differences']) <= len(fields)
                            and all(type(key) is str and key in fields for key in value['differences'])
                            and type(value['mountOrderOnly']) is bool and type(value['otherDefinitionFieldsEqual']) is bool):
                        records.append(value)
            except (ValueError, TypeError):
                continue
        return records[-20:]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--fixture', required=True, type=Path)
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--probe', required=True, type=Path)
    args = parser.parse_args()
    runtime = Runtime(args.source, args.fixture, args.manifest, args.probe,
                      normal_setup=os.environ.get('ORBIS_NORMAL_SETUP_TEST') == '1',
                      host_engine=os.environ.get('ORBIS_HOST_ENGINE_TEST') == '1')
    failure, cleaned, phase, diagnostics, trace_records = None, False, 'prepare', [], []
    try:
        runtime.prepare()
        phase = 'start-host'
        runtime.start_host()
        phase = 'start-core-and-enroll'
        runtime.start_core()
        original = runtime.enrollment_hash()
        phase = 'positive-storage-observation'
        runtime.probe_core('positive')
        phase = 'custom-app-storage-observation'
        runtime.probe_core('custom-app-positive')
        phase = 'outside-main-refusal'
        runtime.probe_outside()
        phase = 'directory-drift-refusal'
        runtime.probe_core('directory-drift')
        if runtime.normal_setup:
            phase = 'normal-setup-api'
            runtime.probe_normal_setup()
        if runtime.host_engine:
            for mode in ('upgrade', 'rollback'):
                phase = 'host-engine-' + mode
                runtime.probe_host_engine(mode)
        require(runtime.enrollment_hash() == original, 'enrollment-changed')
        for store in ('fixture', '_user'):
            require((runtime.root / 'app-data' / store / 'probe/marker').read_text() == 'scoped fixture\n', 'fixture-data-changed')
    except Refused as error:
        failure = str(error)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        failure = 'fixture-execution-failed'
    finally:
        if failure is not None:
            diagnostics = runtime.diagnostics()
            try:
                trace_records = runtime.host_trace_records()
            except (OSError, ValueError, TypeError):
                trace_records = []
        try:
            cleaned = runtime.cleanup()
        except (Refused, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
            failure = 'positive-owned-cleanup-failed'
    result = {'schema': 'orbis.host-storage-runtime-test.v1', 'passed': failure is None and cleaned,
              'cases': runtime.results, 'cleanup': cleaned, 'error': failure,
              'failurePhase': phase if failure is not None else None, 'runtimeStates': diagnostics,
              'failureRole': runtime.failure_role if runtime.failure_role in SERVICES else None,
              'hostRefusals': trace_records, 'hostObservationTrace': os.environ.get('ORBIS_HOST_STORAGE_TRACE') == '1',
              'normalSetup': runtime.normal_setup, 'hostEngine': runtime.host_engine, 'recoveryConfigured': False, 'productionTouched': False}
    # This receipt deliberately excludes raw Docker/Host/Core output and secrets.
    print(json.dumps(result, sort_keys=True))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
