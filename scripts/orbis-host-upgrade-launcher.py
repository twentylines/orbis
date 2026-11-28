"""Authenticate the accepted release source before genuine installer execution.

Lifecycle dispatch belongs to the admitting independent unit. This module's
resource stage never executes downloaded Python, adopts an extraction, or
writes an installer execution receipt. Execution uses the existing held-launcher
continuation, which alone produces that receipt.
"""
import ast
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
import weakref
import zlib

PROTOCOL = 'orbis.component-upgrade-source-check.v1'
GITHUB = 'https://api.github.com/repos/twentylines/orbis/'
RELEASES = 'https://github.com/twentylines/orbis/releases/download/'
GIT_PROOF_FIELD = 'gitSourceProof'
GIT_PROOF_LIMIT = 256 * 1024
_STAGED = weakref.WeakKeyDictionary()


class UpgradeSourceError(ValueError):
    def __init__(self):
        super().__init__('The accepted upgrade source could not be authenticated; its evidence was preserved.')


def require(value):
    if not value:
        raise UpgradeSourceError()


def operator():
    require(sys.platform == 'linux' and os.getuid() == os.geteuid() == 0)


def sha(body):
    return hashlib.sha256(body).hexdigest()


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode('ascii')


def pairs(items):
    result = {}
    for key, value in items:
        require(key not in result)
        result[key] = value
    return result


def decoded(body):
    return json.loads(body, object_pairs_hook=pairs)


def literal(body, name):
    declarations = []
    for node in ast.parse(body).body:
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == name for target in node.targets):
            require(len(node.targets) == 1)
            declarations.append(node.value)
        elif isinstance(node, (ast.AugAssign, ast.AnnAssign)) and isinstance(node.target, ast.Name) and node.target.id == name:
            raise UpgradeSourceError()
    require(len(declarations) == 1)
    for node in ast.walk(declarations[0]):
        if isinstance(node, ast.Dict):
            keys = [ast.literal_eval(key) for key in node.keys]
            require(len(keys) == len(set(keys)))
    return ast.literal_eval(declarations[0])


def git_object(kind, body):
    # Git object addressing uses this fixed format, including on FIPS hosts.
    return hashlib.sha1(kind + b' ' + str(len(body)).encode('ascii') + b'\0' + body, usedforsecurity=False).hexdigest()


def git_blob(body):
    return git_object(b'blob', body)


def git_tree_entries(body):
    entries = {}
    offset = 0
    while offset < len(body):
        end = body.find(b'\0', offset)
        require(end > offset and end + 21 <= len(body))
        mode, separator, name = body[offset:end].partition(b' ')
        require(separator and name and name not in (b'.', b'..') and b'/' not in name and name not in entries)
        entries[name] = mode, body[end + 1:end + 21].hex()
        offset = end + 21
    return entries


def read_git_source_proof(proof):
    require(type(proof) is str and 0 < len(proof) <= 65536)
    try:
        compressed = base64.b64decode(proof, validate=True)
        stream = zlib.decompressobj()
        body = stream.decompress(compressed, GIT_PROOF_LIMIT + 1)
        require(len(body) <= GIT_PROOF_LIMIT and stream.eof and not stream.unused_data and not stream.unconsumed_tail)
        decoded_proof = decoded(body)
        require(type(decoded_proof) is dict and set(decoded_proof) == {'commit', 'trees'}
                and type(decoded_proof['commit']) is str and type(decoded_proof['trees']) is dict
                and 0 < len(decoded_proof['trees']) <= 64)
        require(all(re.fullmatch(r'[a-f0-9]{40}', key) and type(value) is str for key, value in decoded_proof['trees'].items()))
        return base64.b64decode(decoded_proof['commit'], validate=True), {
            key: base64.b64decode(value, validate=True) for key, value in decoded_proof['trees'].items()}
    except (ValueError, zlib.error) as error:
        raise UpgradeSourceError() from error


def authenticate_embedded_tree(proof, commit, files):
    """Verify the real Git commit and the path to each installer member."""
    commit_body, trees = read_git_source_proof(proof)
    require(git_object(b'commit', commit_body) == commit)
    header = re.fullmatch(rb'tree ([a-f0-9]{40})', commit_body.partition(b'\n')[0])
    require(header is not None)
    root = header[1].decode('ascii')
    entries = {}
    for name, body in files.items():
        current = root
        components = name.encode('utf-8').split(b'/')
        for index, component in enumerate(components):
            if current not in entries:
                tree = trees.get(current)
                require(tree is not None and git_object(b'tree', tree) == current)
                entries[current] = git_tree_entries(tree)
            mode, identifier = entries[current].get(component, (None, None))
            if index == len(components) - 1:
                require(mode in (b'100644', b'100755') and git_blob(body) == identifier)
            else:
                require(mode == b'40000')
                current = identifier
    require(entries.keys() == trees.keys())
    return root


def authenticate_tree(fetch, commit, files):
    """Bind every archive member to the exact accepted immutable Git source."""
    require(type(commit) is str and re.fullmatch(r'[a-f0-9]{40}', commit))
    selected = decoded(fetch(GITHUB + 'git/commits/' + commit, 65536))
    require(type(selected) is dict and selected.get('sha') == commit and type(selected.get('tree')) is dict)
    tree_sha = selected['tree'].get('sha')
    require(type(tree_sha) is str and re.fullmatch(r'[a-f0-9]{40}', tree_sha))
    tree = decoded(fetch(GITHUB + 'git/trees/' + tree_sha + '?recursive=1', 4 * 1024 * 1024))
    require(type(tree) is dict and tree.get('sha') == tree_sha and tree.get('truncated') is False
            and type(tree.get('tree')) is list and len(tree['tree']) <= 20000)
    entries = {}
    for entry in tree['tree']:
        require(type(entry) is dict and type(entry.get('path')) is str and entry['path'] not in entries)
        entries[entry['path']] = entry
    for name, body in files.items():
        entry = entries.get(name)
        require(type(body) is bytes and type(entry) is dict and entry.get('type') == 'blob'
                and entry.get('mode') in ('100644', '100755') and entry.get('sha') == git_blob(body)
                and type(entry.get('size')) is int and entry['size'] == len(body))
    return tree_sha


def file_seal(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


class StagedSource:
    def __init__(self, boot, scope, directory, descriptor, files, members):
        self.boot, self.scope, self.directory = boot, scope, directory
        self.descriptor = canonical(descriptor)
        self.files = dict(files)
        self.members = frozenset(members)
        self.used = False
        self.identities = {name: file_seal((directory / name).lstat()) for name in self.files}
        self.directory_identity = file_seal(directory.lstat())
        self.copies_identity = file_seal((directory / boot.SOURCE_COPIES).lstat())

    def identity(self):
        return (self.boot, self.scope, self.directory, self.descriptor, self.directory_identity, self.copies_identity,
                tuple(sorted(self.members)), tuple(sorted((name, len(body), sha(body), self.identities[name])
                                                          for name, body in self.files.items())))

    def verify(self):
        self.scope.verify_bootstrap()
        require(self.directory == self.boot.private_directory(self.directory)
                and file_seal(self.directory.lstat()) == self.directory_identity)
        for name, body in self.files.items():
            current = self.directory / name
            require(not current.is_symlink() and file_seal(current.lstat()) == self.identities[name]
                    and current.read_bytes() == body)
        require(file_seal((self.directory / self.boot.SOURCE_COPIES).lstat()) == self.copies_identity
                and not list((self.directory / self.boot.SOURCE_COPIES).iterdir()))
        self.scope.verify_bootstrap()


def source_protocol(body, *, legacy=False):
    declarations = [node for node in ast.parse(body).body if
                    isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign)) and
                    any(isinstance(item, ast.Name) and item.id == 'UPGRADE_SOURCE_CHECK_PROTOCOL'
                        for item in (node.targets if isinstance(node, ast.Assign) else [node.target]))]
    if not declarations:
        require(legacy is True)
        return None
    value = literal(body, 'UPGRADE_SOURCE_CHECK_PROTOCOL')
    require(value == PROTOCOL)
    return value


def stage_source(boot, plan, supervision, scope, state_directory, operation, request_sha, target, channel, *, legacy=False):
    operator()
    scope.verify_bootstrap()
    target = decoded(canonical(plan.validate_manifest(target)))
    require(type(target['tag']) is str and re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z.-]+)?', target['tag'])
            and type(request_sha) is str and re.fullmatch(r'[a-f0-9]{64}', request_sha)
            and channel in ('stable', 'nightly'))
    require(scope.operation == operation and scope.request_sha == request_sha and scope.target == target
            and scope.channel == channel and scope.state_directory == Path(state_directory))
    directory = supervision.operation_directory(state_directory, operation) / 'selection'
    require(not directory.exists() and not directory.is_symlink())

    def fetch(url, limit):
        scope.verify_bootstrap()
        value = boot.fetch(url, limit)
        require(type(value) is bytes and 0 < len(value) <= limit)
        scope.verify_bootstrap()
        return value

    base = RELEASES + target['tag'] + '/'
    launcher = fetch(base + 'install-orbis.py', 1024 * 1024)
    identity = literal(launcher, 'EXPECTED_RELEASE')
    require(type(identity) is dict and set(identity) == {'tag', 'commit', 'manifestSha256'}
            and identity['tag'] == target['tag'] and identity['commit'] == target['commit']
            and type(identity['manifestSha256']) is str and re.fullmatch(r'[a-f0-9]{64}', identity['manifestSha256']))
    manifest_body = fetch(base + boot.MANIFEST, 65536)
    manifest = boot.verify_manifest(manifest_body, identity, required=boot.SOURCE_CUSTODY_REQUIRED)
    core_body = boot.fetch_release_manifest(base, fetch)
    require(sha(core_body) == manifest['releaseManifestSha256']
            and plan.update_identity(decoded(core_body)) == plan.update_identity(target))
    archive = fetch(base + boot.ARCHIVE, manifest['archiveBytes'])
    manifest, files = boot.verify_source_package(manifest_body, identity, archive)
    if GIT_PROOF_FIELD in manifest:
        tree_sha = authenticate_embedded_tree(manifest[GIT_PROOF_FIELD], target['commit'], files)
    else:
        tree_sha = authenticate_tree(fetch, target['commit'], files)
    protocol = source_protocol(files['scripts/orbis-install.py'], legacy=legacy)
    require(boot._custody_template(files['scripts/install-orbis.py'])
            and boot._render_installer('release', identity, files['scripts/install-orbis.py']) == launcher)
    scope.verify_bootstrap()
    boot.private_directory(directory.parent)
    os.mkdir(directory, 0o700)
    scope.verify_bootstrap()
    selection = boot.stage_verified_installer(directory, mode='release', identity=identity, channel=channel,
        release=core_body, manifest=manifest_body, archive=archive, files=files)
    descriptor = {'schema': 'orbis.component-upgrade-source.v1', 'operationId': operation,
                  'requestSha256': request_sha, 'core': target, 'channel': channel,
                  'selectionSha256': selection, 'gitTreeSha': tree_sha, 'sourceProtocol': protocol}
    # Pin every extracted member plus each original proof. The existing
    # continuation revalidates its held launcher and creates execution custody.
    staged_files = {**files, boot.SOURCE_LAUNCHER: launcher, boot.MANIFEST: manifest_body,
                    boot.ARCHIVE: archive, 'release-manifest.json': core_body,
                    boot.SOURCE_SELECTION: (directory / boot.SOURCE_SELECTION).read_bytes()}
    require(not (directory / boot.SOURCE_EXECUTION).exists())
    result = StagedSource(boot, scope, directory, descriptor, staged_files, files)
    result.verify()
    _STAGED[result] = result.identity()
    return result


# The bootstrap snapshot is local Root custody, distinct from the publisher's
# installer selection/execution receipts produced by the held continuation.
import argparse
from contextlib import ExitStack, contextmanager
import fcntl
import importlib.util
import stat
import subprocess
from types import ModuleType
import uuid

OWNER = 0
LIMIT = 1024 * 1024
WORKER_SCHEMA = 'orbis.host-upgrade-worker.v1'
INTAKE_SCHEMA = 'orbis.host-upgrade-intake.v1'


def load_sibling(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@contextmanager
def directory(path, *, private=True):
    path = Path(path)
    require(path.is_absolute() and str(path) == os.path.normpath(str(path)))
    handles = [os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)]
    bindings = []
    try:
        for name in path.parts[1:]:
            parent = handles[-1]
            handle = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
            handles.append(handle)
            details = os.fstat(handle)
            require(details.st_uid in (0, OWNER) and not details.st_mode & 0o022)
            bindings.append((parent, name, handle, (details.st_dev, details.st_ino, details.st_mode, details.st_uid, details.st_gid)))
        details = os.fstat(handles[-1])
        require(details.st_uid == OWNER and not details.st_mode & (0o077 if private else 0o022))
        yield handles[-1]
        for parent, name, handle, expected in bindings:
            for observed in (os.fstat(handle), os.stat(name, dir_fd=parent, follow_symlinks=False)):
                require((observed.st_dev, observed.st_ino, observed.st_mode, observed.st_uid, observed.st_gid) == expected)
    finally:
        for handle in reversed(handles):
            os.close(handle)


@contextmanager
def protected_file(folder, name, maximum=LIMIT, *, private=True, digest_only=False):
    require('/' not in name and name not in ('.', '..'))
    descriptor = os.open(name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=folder)
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == OWNER and info.st_nlink == 1
                and not info.st_mode & (0o077 if private else 0o022) and 0 <= info.st_size <= maximum)
        body = bytearray()
        while len(body) <= maximum:
            part = os.read(descriptor, min(65536, maximum + 1 - len(body)))
            if not part:
                break
            body.extend(part)
        require(len(body) == info.st_size and file_seal(os.fstat(descriptor)) == file_seal(info))
        yield 'sha256:' + sha(body) if digest_only else bytes(body)
        require(file_seal(os.fstat(descriptor)) == file_seal(info)
                and file_seal(os.stat(name, dir_fd=folder, follow_symlinks=False)) == file_seal(info))
    finally:
        os.close(descriptor)


class Files:
    protected_directory = staticmethod(directory)
    protected_file = staticmethod(protected_file)


def read_file(path, maximum=LIMIT, *, private=True):
    with directory(path.parent, private=private) as folder:
        with protected_file(folder, path.name, maximum, private=private) as body:
            return body


def write_exclusive(path, body, *, mode=0o600, private=True):
    require(type(body) is bytes and len(body) <= 8 * LIMIT)
    with directory(path.parent, private=private) as folder:
        descriptor = os.open(path.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                             mode, dir_fd=folder)
        try:
            os.fchmod(descriptor, mode)
            remaining = memoryview(body)
            while remaining:
                count = os.write(descriptor, remaining)
                require(count > 0)
                remaining = remaining[count:]
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.fsync(folder)


def make_directory(parent, name, *, existing=False):
    require('/' not in name and name not in ('.', '..'))
    with directory(parent) as folder:
        try:
            os.mkdir(name, 0o700, dir_fd=folder)
        except FileExistsError:
            require(existing)
        os.fsync(folder)
    with directory(parent / name):
        pass
    return parent / name


def validate_job(service, job):
    require(type(job) is dict and job.get('schema') == 'orbis.host-service-job.v1'
            and job.get('state') == 'running' and not service.credentials_only)
    supervision = load_sibling('orbis-host-upgrade-supervision.py', 'orbis_worker_supervision')
    operation = job.get('id')
    supervision.unit_name(operation)
    current, target = (service.HOST.PLAN.validate_manifest(job[key]) for key in ('current', 'target'))
    require(job.get('targetTag') == target['tag'] and job.get('overlayId') == operation
            and job.get('snapshot') == str(service.snapshots / ('orbis-' + target['tag'] + '-' + operation))
            and job.get('backupPolicy') in ('none', 'automatic'))
    saved = decoded(read_file(service.job_file))
    require(saved == job)
    overlays = service.core_overlays()
    record = overlays.read(operation)
    require(overlays.accepted_job(record) is True and record['current'] == current and record['target'] == target)
    return supervision


def stage_worker(service, job):
    """Snapshot the accepting Host's real installed closure after acceptance."""
    operator()
    supervision = validate_job(service, job)
    require('worker' not in job)
    setup = load_sibling('orbis-host-service-setup.py', 'orbis_worker_setup')
    source = Path(__file__).resolve(strict=True).parent
    require(source == setup.INSTALL_DIR and setup._systemd_main_pid(service.root, service.context) == os.getpid())
    names = list(setup.SCRIPTS)
    require(1 <= len(names) <= 128 and len(set(names)) == len(names)
            and {'orbis-host-upgrade-launcher.py', 'orbis-host-upgrade-supervision.py',
                 'orbis-host-upgrade-runner.py', 'orbis-host-service.py', 'orbis-host-service-setup.py'} <= set(names))
    with directory(source) as source_folder:
        require(set(os.listdir(source_folder)) == set(names))
        files = {}
        total = 0
        for name in names:
            require(re.fullmatch(r'(?:[a-z-]+\.py|orbis-[a-z-]+\.mjs)', name))
            with protected_file(source_folder, name) as body:
                files[name] = body
            total += len(body)
            require(total <= 8 * LIMIT)
        # Hold all original descriptors/seals through publication, rather than
        # accepting equal-byte inode replacements during the copy.
        with setup._SetupSources([source / name for name in names], setup.UNIT_FILE) as inputs:
            require(all(inputs.body(source / name) == body for name, body in files.items()))
            host_unit = read_file(setup.UNIT_FILE, 32768, private=False)
            require(inputs.body(setup.UNIT_FILE) == host_unit)
            base = make_directory(service.state_dir, 'component-upgrades', existing=True)
            operation = make_directory(base, job['id'])
            bootstrap = make_directory(operation, 'bootstrap')
            scripts = make_directory(bootstrap, 'scripts')
            for name, body in files.items():
                write_exclusive(scripts / name, body)
            value = {'schema': INTAKE_SCHEMA, 'id': job['id'], 'stateDirectory': str(service.state_dir),
                     'root': str(service.root), 'dockerContext': service.context, 'snapshots': str(service.snapshots),
                     'job': job, 'files': {name: sha(body) for name, body in files.items()},
                     'acceptingHostUnitSha256': sha(host_unit)}
            body = canonical(value)
            write_exclusive(operation / 'intake.json', body)
            write_exclusive(operation / 'worker.lock', b'')
            inputs.verify()
        require(set(os.listdir(source_folder)) == set(names))
    validate_job(service, job)
    reference = {'schema': WORKER_SCHEMA, 'unit': supervision.unit_name(job['id']), 'requestSha256': sha(body)}
    return reference


def load_snapshot_supervision(bootstrap):
    # Import the held accepting version only after checking every snapshot
    # member; a newer Host must not substitute its own changed unit template.
    name = 'orbis-host-upgrade-supervision.py'
    scripts = bootstrap.directory / 'bootstrap/scripts'
    with directory(scripts) as folder:
        with protected_file(folder, name) as body:
            require(sha(body) == bootstrap.intake['files'][name])
            module = ModuleType('orbis_held_worker_supervision')
            module.__file__ = str(scripts / name)
            exec(compile(body, module.__file__, 'exec'), module.__dict__)
            return module


class Bootstrap:
    def __init__(self, state, operation, reference, *, supervision=None):
        require(type(operation) is str and str(uuid.UUID(operation)) == operation and uuid.UUID(operation).version == 4)
        self.state_directory = Path(state)
        require(self.state_directory.is_absolute() and str(self.state_directory) == os.path.normpath(str(self.state_directory))
                and not any(ord(char) < 32 or ord(char) == 127 for char in str(self.state_directory)))
        self.operation = operation
        self.directory = self.state_directory / 'component-upgrades' / operation
        self.reference = decoded(canonical(reference))
        require(set(self.reference) == {'schema', 'unit', 'requestSha256'}
                and self.reference['schema'] == WORKER_SCHEMA
                and self.reference['unit'] == 'orbis-upgrade-' + operation + '.service'
                and type(self.reference['requestSha256']) is str and re.fullmatch('[a-f0-9]{64}', self.reference['requestSha256']))
        self.body = read_file(self.directory / 'intake.json', 2 * LIMIT)
        self.intake_seal = file_seal((self.directory / 'intake.json').lstat())
        require(sha(self.body) == self.reference['requestSha256'])
        self.intake = decoded(self.body)
        require(set(self.intake) == {'schema', 'id', 'stateDirectory', 'root', 'dockerContext', 'snapshots', 'job',
                                    'files', 'acceptingHostUnitSha256'}
                and self.intake['schema'] == INTAKE_SCHEMA and self.intake['id'] == operation
                and self.intake['stateDirectory'] == str(self.state_directory))
        self.target = decoded(canonical(self.intake['job']['target']))
        self.channel = self.intake['job']['channelState']['channel']
        self.request_sha = self.reference['requestSha256']
        require(self.channel in ('stable', 'nightly'))
        self.frame = None
        self.source_seals = None
        self.verify_files()
        if supervision is None:
            supervision = load_snapshot_supervision(self)
        self.supervision = supervision
        self.verify_files()

    def accepted_job(self):
        return decoded(canonical(self.intake['job']))

    def check_job(self, job):
        require(job.get('worker') == self.reference
                and {key: value for key, value in job.items() if key != 'worker'} == self.accepted_job()
                and job['state'] == 'running')

    def verify_files(self):
        require(read_file(self.directory / 'intake.json', 2 * LIMIT) == self.body)
        require(file_seal((self.directory / 'intake.json').lstat()) == self.intake_seal)
        inventory = self.intake['files']
        require(type(inventory) is dict and 1 <= len(inventory) <= 128
                and {'orbis-host-upgrade-launcher.py', 'orbis-host-upgrade-supervision.py',
                     'orbis-host-upgrade-runner.py', 'orbis-host-service.py', 'orbis-host-service-setup.py'} <= set(inventory))
        scripts = self.directory / 'bootstrap/scripts'
        seals = {}
        with directory(scripts) as folder:
            require(set(os.listdir(folder)) == set(inventory))
            total = 0
            for name, expected in inventory.items():
                require(re.fullmatch(r'(?:[a-z-]+\.py|orbis-[a-z-]+\.mjs)', name)
                        and type(expected) is str and re.fullmatch('[a-f0-9]{64}', expected))
                with protected_file(folder, name) as body:
                    require(sha(body) == expected)
                    seals[name] = file_seal(os.stat(name, dir_fd=folder, follow_symlinks=False))
                    total += len(body)
                    require(total <= 8 * LIMIT)
        require(self.source_seals is None or self.source_seals == seals)
        self.source_seals = seals
        job = decoded(read_file(self.state_directory / 'job.json'))
        self.check_job(job)
        return job

    def verify_bootstrap(self, *, current=True):
        self.verify_files()
        frame = self.supervision.observe_invocation(Files(), self.state_directory, self.operation,
            self.supervision.launcher_argv(self.state_directory, self.operation), current=current)
        require(self.frame is None or self.frame == frame)
        self.verify_files()
        self.frame = frame
        return dict(frame)


class ReconciliationBootstrap(Bootstrap):
    """A distinct live unit, original source, old-generation quiescence and claim.

    Original execution custody is never overwritten or replayed. Only the
    Host's bounded interruption annotation may differ from the accepted job.
    """
    def __init__(self, state, operation, reference, *, supervision=None, claimed=True, allow_unclaimed=False):
        require(type(claimed) is bool)
        self.recovery_body = read_file(Path(state) / 'job.json')
        self.recovery_job = decoded(self.recovery_body)
        self.claimed = claimed
        self.original_frame = None
        super().__init__(state, operation, reference, supervision=supervision)
        try:
            original = decoded(read_file(self.directory / 'claim.json', 16384))
        except FileNotFoundError:
            require(allow_unclaimed)
            self.original_claim = None
            return
        require(type(original) is dict and set(original) == {'schema', 'requestSha256',
            'bootId', 'pid', 'startTime', 'invocationId', 'unit', 'unitSha256'}
            and original['schema'] == 'orbis.host-upgrade-claim.v1'
            and original['requestSha256'] == self.request_sha)
        self.original_frame = {key: value for key, value in original.items() if key not in ('schema', 'requestSha256')}
        self.original_claim = canonical(original)

    def accepted_job(self):
        return {key: value for key, value in self.recovery_job.items() if key != 'worker'}

    def check_job(self, job):
        require(read_file(self.state_directory / 'job.json') == self.recovery_body and job == self.recovery_job
                and job.get('worker') == self.reference and job.get('state') in ('running', 'interrupted')
                and {key: value for key, value in job.items() if key not in ('worker', 'state', 'message')} == {
                    key: value for key, value in self.intake['job'].items() if key not in ('state', 'message')}
                and self.intake['job']['state'] == 'running'
                and job.get('message') in (self.intake['job'].get('message'),
                    'Update worker dispatch needs reconciliation; its execution records were preserved.'))

    def claim_value(self, frame):
        return {'schema': 'orbis.host-upgrade-reconciliation.v1', 'requestSha256': self.request_sha,
                'originalClaimSha256': sha(self.original_claim), 'acceptedJobSha256': sha(self.recovery_body),
                'sourceCheckedSha256': sha(read_file(self.directory / 'source-checked.json')),
                'targetSetSha256': sha(read_file(self.directory / 'target-set.json')), **frame}

    def claim_path(self, frame):
        return self.directory / ('reconciliation-' + frame['invocationId'] + '.json')

    def verify_original_claim(self):
        try:
            body = read_file(self.directory / 'claim.json', 16384)
        except FileNotFoundError:
            require(self.original_claim is None)
        else:
            require(body == self.original_claim)

    def verify_bootstrap(self, *, current=True):
        self.verify_files()
        require(self.original_frame is not None)
        self.verify_original_claim()
        frame = self.supervision.observe_invocation(Files(), self.state_directory, self.operation,
            self.supervision.launcher_argv(self.state_directory, self.operation, reconciling=True),
            current=current, reconciling=True)
        require(frame['unit'] != self.original_frame['unit'] and (self.frame is None or self.frame == frame))
        self.supervision.observe_quiescence(Files(), self.state_directory, self.operation, self.original_frame)
        if self.claimed:
            require(read_file(self.claim_path(frame), 16384) == canonical(self.claim_value(frame)))
        self.verify_files()
        self.frame = frame
        return dict(frame)


def claim_reconciliation(bootstrap):
    operator()
    require(type(bootstrap) is ReconciliationBootstrap and not bootstrap.claimed)
    frame = bootstrap.verify_bootstrap()
    write_exclusive(bootstrap.claim_path(frame), canonical(bootstrap.claim_value(frame)))
    bootstrap.claimed = True
    bootstrap.verify_bootstrap()


@contextmanager
def worker_lock(bootstrap):
    with directory(bootstrap.directory) as folder:
        descriptor = os.open('worker.lock', os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=folder)
        try:
            info = os.fstat(descriptor)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == OWNER and info.st_nlink == 1
                    and stat.S_IMODE(info.st_mode) == 0o600)
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            require(file_seal(os.stat('worker.lock', dir_fd=folder, follow_symlinks=False)) == file_seal(info))
            yield
            require(file_seal(os.fstat(descriptor)) == file_seal(info)
                    and file_seal(os.stat('worker.lock', dir_fd=folder, follow_symlinks=False)) == file_seal(info))
        finally:
            os.close(descriptor)


def systemctl(action, unit=None):
    require(action in ('daemon-reload', 'start') and ((action == 'start') == (unit is not None)))
    if unit is not None:
        require(re.fullmatch(r'orbis-upgrade-(?:reconcile-)?[a-f0-9-]{36}\.service', unit))
    try:
        result = subprocess.run(['/usr/bin/systemctl', action, *([unit] if unit else [])],
            env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'}, capture_output=True, timeout=30)
    except subprocess.TimeoutExpired as error:
        raise RuntimeError('The coordinated upgrade unit response was not confirmed') from error
    require(result.returncode == 0)


def launch_worker(service, job):
    """Called only by the accepting Host; never retries an existing namespace."""
    reference = stage_worker(service, job)
    supervision = load_sibling('orbis-host-upgrade-supervision.py', 'orbis_launch_worker_supervision')
    with service.lock:
        require(decoded(read_file(service.job_file)) == job)
        job['worker'] = reference
        # No speculative worker task is created during plan review. The
        # original durable accepted job retains its UUID and all fences.
        service_module = load_sibling('orbis-host-service.py', 'orbis_worker_job_writer')
        service_module.write_private(service.job_file, job)
    bootstrap = Bootstrap(service.state_dir, job['id'], reference, supervision=supervision)
    runtime = supervision.Runtime()
    runtime.supported()
    unit = runtime.unit(reference['unit'])
    require(unit['LoadState'] == 'not-found' and not unit['Job'] and unit['MainPID'] == unit['ControlPID'] == '0'
            and unit['ActiveState'] == 'inactive' and not unit['ControlGroup'] and not unit['InvocationID'])
    body = supervision.unit_body(service.state_dir, job['id'])
    write_exclusive(supervision.UNITS / reference['unit'], body, mode=0o644, private=False)
    write_exclusive(bootstrap.directory / 'launch-intent.json', canonical({
        'schema': 'orbis.host-upgrade-launch.v1', 'requestSha256': reference['requestSha256'], 'unitSha256': sha(body)}))
    systemctl('daemon-reload')
    loaded = runtime.unit(reference['unit'])
    require(loaded['LoadState'] == 'loaded' and loaded['FragmentPath'] == str(supervision.UNITS / reference['unit'])
            and loaded['DropInPaths'] == '' and loaded['NeedDaemonReload'] == 'no' and loaded['MainPID'] == loaded['ControlPID'] == '0')
    bootstrap.verify_files()
    systemctl('start', reference['unit'])
    write_exclusive(bootstrap.directory / 'started.json', canonical({
        'schema': 'orbis.host-upgrade-started.v1', 'requestSha256': reference['requestSha256'], 'unitSha256': sha(body)}))


def live_worker(service, job):
    """Positive live recognition only; stale receipts never prove ownership."""
    operator()
    require(type(job) is dict and type(job.get('worker')) is dict)
    bootstrap = Bootstrap(service.state_dir, job['id'], job['worker'])
    frame = bootstrap.verify_bootstrap(current=False)
    claim = decoded(read_file(bootstrap.directory / 'claim.json', 16384))
    require(claim == {'schema': 'orbis.host-upgrade-claim.v1', 'requestSha256': job['worker']['requestSha256'], **frame})
    return True


def live_reconciliation(service, job):
    """Prove recovering telemetry belongs to a current claimed generation."""
    operator()
    bootstrap = ReconciliationBootstrap(service.state_dir, job['id'], job['worker'])
    require(bootstrap.recovery_job == job)
    bootstrap.verify_bootstrap(current=False)
    return True


def interrupt_unowned_worker(service, job):
    """Set reconciliation only when no independent writer owns the job lock."""
    operator()
    service_module = load_sibling('orbis-host-service.py', 'orbis_worker_interruption_writer')
    if not service.lock.acquire(blocking=False):
        return
    try:
        saved = service_module.read_private(service.job_file)
        if saved != job or saved.get('state') not in ('running', 'recovering'):
            return
        if job.get('worker') is None:
            saved = {**saved, 'state': 'interrupted', 'message': 'Update worker dispatch needs reconciliation; no retry was started.'}
            service_module.write_private(service.job_file, saved)
            return
        try:
            bootstrap = ReconciliationBootstrap(service.state_dir, job['id'], job['worker'], allow_unclaimed=True)
            with worker_lock(bootstrap):
                require(bootstrap.verify_files() == job)
                bootstrap.verify_original_claim()
                bootstrap.supervision.observe_quiescence(Files(), service.state_dir, job['id'], bootstrap.original_frame)
                require(bootstrap.verify_files() == job)
                bootstrap.verify_original_claim()
                saved = {**saved, 'state': 'interrupted',
                         'message': 'Update worker dispatch needs reconciliation; its execution records were preserved.'}
                service_module.write_private(service.job_file, saved)
        except (OSError, ValueError, RuntimeError):
            # A held worker lock or uncertain runtime observation preserves
            # the accepted job until a later observer has positive evidence.
            return
    finally:
        service.lock.release()


def observe_worker_exit(service, job):
    """Report a stopped dispatched worker as unknown, never as a retry permit."""
    operator()
    require(type(job) is dict and job.get('state') == 'running')
    supervision = load_sibling('orbis-host-upgrade-supervision.py', 'orbis_worker_exit_observer')
    operation = job['id']
    reference = job['worker']
    require(type(reference) is dict and reference.get('schema') == WORKER_SCHEMA
            and reference.get('unit') == supervision.unit_name(operation))
    root = supervision.operation_directory(service.state_dir, operation)
    if service.busy:
        return
    try:
        receipt = decoded(read_file(root / 'started.json', 16384))
        schema = 'orbis.host-upgrade-started.v1'
    except FileNotFoundError:
        try:
            receipt = decoded(read_file(root / 'launch-intent.json', 16384))
        except FileNotFoundError:
            # The accepting Host records intent before invoking systemd. A
            # status poll cannot infer dispatch from the worker reference alone.
            return
        schema = 'orbis.host-upgrade-launch.v1'
    require(receipt == {'schema': schema, 'requestSha256': reference['requestSha256'],
                        'unitSha256': sha(supervision.unit_body(service.state_dir, operation))})
    interrupt_unowned_worker(service, job)



def source_child_argv(supervision, state, operation):
    return [str(supervision.PYTHON), '-I', '-B',
            str(supervision.operation_directory(state, operation) / 'bootstrap/scripts/orbis-host-upgrade-launcher.py'),
            'source-check', operation, '--state-dir', str(state)]


def check_source_child(state, operation):
    """Use the genuine held continuation without replacing the supervisor."""
    operator()
    state = Path(state)
    job = decoded(read_file(state / 'job.json'))
    require(job.get('id') == operation)
    bootstrap = Bootstrap(state, operation, job.get('worker'))
    expected_script = bootstrap.directory / 'bootstrap/scripts/orbis-host-upgrade-launcher.py'
    require(Path(__file__).resolve(strict=True) == expected_script)
    frame = bootstrap.verify_bootstrap(current=False)
    claim = decoded(read_file(bootstrap.directory / 'claim.json', 16384))
    require(claim == {'schema': 'orbis.host-upgrade-claim.v1',
                     'requestSha256': bootstrap.request_sha, **frame} and os.getppid() == frame['pid'])
    runtime = bootstrap.supervision.Runtime()
    process = runtime.process(os.getpid())
    expected = source_child_argv(bootstrap.supervision, state, operation)
    require(process['parent'] == frame['pid'] and process['pid'] == os.getpid()
            and process['argv'] == [os.fsencode(item) for item in expected]
            and process['cgroup'] == '/system.slice/' + frame['unit']
            and process['invocationId'] == frame['invocationId']
            and process['executable'] == str(bootstrap.supervision.PYTHON.resolve(strict=True)))
    value = decoded(read_file(bootstrap.directory / 'source-preparation.json', 65536))
    require(type(value) is dict and set(value) == {'schema', 'operationId', 'requestSha256', 'core', 'channel',
                                                  'selectionSha256', 'gitTreeSha', 'sourceProtocol'})
    require(value['schema'] == 'orbis.component-upgrade-source.v1' and value['operationId'] == operation
            and value['requestSha256'] == bootstrap.request_sha and value['core'] == bootstrap.target
            and value['channel'] == bootstrap.channel and value['sourceProtocol'] in (None, PROTOCOL))
    selected = bootstrap.directory / 'selection'
    boot = load_sibling('install-orbis.py', 'orbis_source_child_boot')
    record_body = read_file(selected / boot.SOURCE_SELECTION, 16384)
    require(sha(record_body) == value['selectionSha256'])
    record = decoded(record_body)
    require(record['mode'] == 'release' and record['channel'] == bootstrap.channel
            and record['installer']['tag'] == bootstrap.target['tag']
            and record['installer']['commit'] == bootstrap.target['commit'])
    manifest_body = read_file(selected / boot.MANIFEST, 65536)
    manifest = boot.verify_manifest(manifest_body, record['installer'], required=boot.SOURCE_CUSTODY_REQUIRED)
    core_body = read_file(selected / 'release-manifest.json', 16384)
    plan = load_sibling('orbis-release-plan.py', 'orbis_source_child_plan')
    require(sha(core_body) == manifest['releaseManifestSha256']
            and plan.update_identity(decoded(core_body)) == plan.update_identity(bootstrap.target))
    archive = read_file(selected / boot.ARCHIVE, 8 * LIMIT)
    manifest, files = boot.verify_source_package(manifest_body, record['installer'], archive)
    require(source_protocol(files['scripts/orbis-install.py'], legacy=True) == value['sourceProtocol'])
    require(boot._custody_template(files['scripts/install-orbis.py']))
    launcher = read_file(selected / boot.SOURCE_LAUNCHER)
    require(launcher == boot._render_installer('release', record['installer'], files['scripts/install-orbis.py']))
    for name, body in files.items():
        require(read_file(selected / name) == body)
    bootstrap.verify_bootstrap(current=False)
    remaining = ['--verify-upgrade-source'] if value['sourceProtocol'] == PROTOCOL else ['--help']
    # This is the existing producer, which alone writes SOURCE_EXECUTION with
    # O_EXCL after authenticating the held launcher. Never synthesize a receipt.
    boot._exec_verified_installer(selected, bootstrap.channel, remaining, value['selectionSha256'], files)
    raise UpgradeSourceError()  # Successful exec does not return here.


def execute_source(staged):
    """Wait for one verified source-only child while retaining the parent lease."""
    operator()
    require(isinstance(staged, StagedSource) and not staged.used and _STAGED.pop(staged, None) == staged.identity())
    staged.used = True
    staged.verify()
    value = decoded(staged.descriptor)
    scope = staged.scope
    operation_directory = staged.directory.parent
    require(staged.directory == scope.state_directory / 'component-upgrades' / scope.operation / 'selection')
    write_exclusive(operation_directory / 'source-preparation.json', staged.descriptor)
    work = make_directory(operation_directory, 'source-check')
    for name in ('tmp', 'cache', 'config', 'state', 'data'):
        make_directory(work, name)
    supervision = scope.supervision
    command = source_child_argv(supervision, scope.state_directory, scope.operation)
    frame = scope.verify_bootstrap()
    require(type(frame) is dict and type(frame.get('invocationId')) is str
            and supervision.INVOCATION.fullmatch(frame['invocationId']))
    handles = []
    try:
        for name in ('stdout', 'stderr'):
            handles.append(os.open(work / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600))
        try:
            result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=handles[0], stderr=handles[1],
                close_fds=True, cwd=work, timeout=120,
                env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'PYTHONDONTWRITEBYTECODE': '1',
                     'INVOCATION_ID': frame['invocationId'],
                     'TMPDIR': str(work / 'tmp'), 'XDG_CACHE_HOME': str(work / 'cache'),
                     'XDG_CONFIG_HOME': str(work / 'config'), 'XDG_STATE_HOME': str(work / 'state'),
                     'XDG_DATA_HOME': str(work / 'data')})
        except subprocess.TimeoutExpired as error:
            # subprocess.run kills and waits for this fixed source-only child.
            # A timeout grants neither a receipt nor permission to replay it.
            raise UpgradeSourceError() from error
        for descriptor in handles:
            os.fsync(descriptor)
    finally:
        for descriptor in handles:
            os.close(descriptor)
    require(result.returncode == 0)
    output = read_file(work / 'stdout', 65536)
    read_file(work / 'stderr', 16384)
    scope.verify_bootstrap()
    # The continuation adds exactly one execution proof. Original inputs and
    # source member inode/byte identities must still be the staged identities.
    require(file_seal(staged.directory.lstat())[:5] == staged.directory_identity[:5])
    expected_names = {Path(name).parts[0] for name in staged.files} | {staged.boot.SOURCE_EXECUTION, staged.boot.SOURCE_COPIES}
    with directory(staged.directory) as folder:
        require(set(os.listdir(folder)) == expected_names)
    require(file_seal((staged.directory / staged.boot.SOURCE_COPIES).lstat()) == staged.copies_identity
            and not list((staged.directory / staged.boot.SOURCE_COPIES).iterdir()))
    for name, original in staged.files.items():
        location = staged.directory / name
        require(file_seal(location.lstat()) == staged.identities[name] and location.read_bytes() == original)
    setup = load_sibling('orbis-host-service-setup.py', 'orbis_checked_source_reader')
    with setup.hold_source_selection(staged.directory / 'scripts', value['selectionSha256']) as selection:
        require(selection is not None and selection['mode'] == 'release'
                and selection['installer']['tag'] == value['core']['tag']
                and selection['installer']['commit'] == value['core']['commit'])
        if value['sourceProtocol'] is not None:
            lines = output.splitlines()
            require(lines)
            checked = decoded(lines[-1])
            require(checked == {'schema': PROTOCOL, 'selectionSha256': value['selectionSha256'],
                'executionSha256': selection['executionSha256'], 'coreSha256': selection['coreSha256'],
                'core': decoded(staged.files['release-manifest.json'])})
        scope.verify_bootstrap()
        receipt = {**value, 'executionSha256': selection['executionSha256']}
        write_exclusive(operation_directory / 'source-checked.json', canonical(receipt))
        return receipt

def prepare_worker_source(bootstrap, service):
    boot = load_sibling('install-orbis.py', 'orbis_accepted_source_boot')
    staged = stage_source(boot, service.HOST.PLAN, bootstrap.supervision, bootstrap,
        bootstrap.state_directory, bootstrap.operation, bootstrap.request_sha,
        bootstrap.target, bootstrap.channel, legacy=True)
    return execute_source(staged)


class WorkerTargetAdmission:
    """Keep the real process scope and all selected component bytes held."""
    def __init__(self, bootstrap, target, body, checked):
        self.bootstrap, self.target, self.body = bootstrap, target, body
        self.record_seal = file_seal((bootstrap.directory / 'target-set.json').lstat())
        self.checked_body = canonical(checked)
        require(read_file(bootstrap.directory / 'source-checked.json') == self.checked_body)
        self.checked_seal = file_seal((bootstrap.directory / 'source-checked.json').lstat())

    def verify_bootstrap(self):
        frame = self.bootstrap.verify_bootstrap()
        self.target.verify()
        require(read_file(self.bootstrap.directory / 'target-set.json') == self.body
                and file_seal((self.bootstrap.directory / 'target-set.json').lstat()) == self.record_seal
                and read_file(self.bootstrap.directory / 'source-checked.json') == self.checked_body
                and file_seal((self.bootstrap.directory / 'source-checked.json').lstat()) == self.checked_seal
                and canonical(self.target.manifest()) == self.body)
        self.bootstrap.verify_bootstrap()
        return frame


@contextmanager
def hold_worker_target(bootstrap, checked, *, existing=False):
    bootstrap.verify_bootstrap()
    source = bootstrap.directory / 'selection' / 'scripts'
    require(type(checked) is dict and checked.get('core') == bootstrap.target
            and checked.get('operationId') == bootstrap.operation
            and checked.get('requestSha256') == bootstrap.request_sha
            and checked.get('channel') == bootstrap.channel)
    require(read_file(bootstrap.directory / 'source-checked.json') == canonical(checked))
    setup = load_sibling('orbis-host-service-setup.py', 'orbis_worker_target_setup')
    resolver = load_sibling('orbis-host-upgrade-target.py', 'orbis_worker_target_resolver')
    with resolver.hold_target_set(setup, source, checked['selectionSha256'], bootstrap.target) as target:
        selected = target.manifest()
        require(selected['sourceExecutionSha256'] == checked['executionSha256'])
        body = canonical(selected)
        require(type(existing) is bool)
        if existing:
            require(read_file(bootstrap.directory / 'target-set.json') == body)
        else:
            write_exclusive(bootstrap.directory / 'target-set.json', body)
        admission = WorkerTargetAdmission(bootstrap, target, body, checked)
        admission.verify_bootstrap()
        yield admission


def helper_intent(admission):
    frame = admission.verify_bootstrap()
    bootstrap = admission.bootstrap
    if isinstance(bootstrap, ReconciliationBootstrap):
        frame = bootstrap.original_frame
    return {'schema': 'orbis.component-upgrade-host-intent.v1',
            'requestSha256': bootstrap.request_sha, 'targetSetSha256': sha(admission.body),
            'direction': 'forward', **frame}


def admit_helper_replacement(admission):
    """Commit one live worker's Host effect intent before helper maintenance."""
    operator()
    value = helper_intent(admission)
    write_exclusive(admission.bootstrap.directory / 'host-forward-intent.json', canonical(value))
    admission.verify_bootstrap()
    return value


@contextmanager
def hold_owned_helper_job(state, job, root, context, *, preparing=False, returning=None):
    """Admit only the actual current worker, never another running Host job."""
    operator()
    require(type(preparing) is bool)
    require(not preparing or returning is None)
    require(type(job) is dict and job.get('worker') is not None
            and (job.get('state') == 'running' or returning is not None and job.get('state') == 'interrupted'))
    supervision = load_sibling('orbis-host-upgrade-supervision.py', 'orbis_helper_return_supervision')
    resumed = returning is not None and supervision.Runtime().unit(
        supervision.reconciliation_unit_name(job['id']))['MainPID'] == str(os.getpid())
    bootstrap = (ReconciliationBootstrap if resumed else Bootstrap)(Path(state), job['id'], job['worker'])
    require(bootstrap.intake['root'] == str(root) and bootstrap.intake['dockerContext'] == context
            and {key: value for key, value in job.items() if key != 'worker'} == bootstrap.accepted_job())
    frame = bootstrap.verify_bootstrap()
    if resumed:
        frame = bootstrap.original_frame
    require(decoded(read_file(bootstrap.directory / 'claim.json', 16384)) == {
        'schema': 'orbis.host-upgrade-claim.v1', 'requestSha256': bootstrap.request_sha, **frame})
    require(decoded(read_file(bootstrap.directory / 'execution-intent.json', 16384)) == {
        'schema': 'orbis.host-upgrade-execution.v1', 'requestSha256': bootstrap.request_sha, **frame})
    checked = decoded(read_file(bootstrap.directory / 'source-checked.json'))
    with hold_worker_target(bootstrap, checked, existing=True) as admission:
        if not preparing:
            require(decoded(read_file(bootstrap.directory / 'host-forward-intent.json', 16384)) == helper_intent(admission))
        # Forward helper replacement precedes the Core transaction. A Core
        # journal, including a failed/unknown one, needs the separate return path.
        update = load_sibling('orbis-host-update.py', 'orbis_helper_admission_update')
        if returning is None:
            journal = update.journal_path(Path(job['snapshot']))
            require(not journal.exists() and not journal.is_symlink())
            owned = job['id'], job['state']
        else:
            runner = load_sibling('orbis-host-upgrade-runner.py', 'orbis_helper_return_admission')
            profile = runner.helper_return_profile(_launcher_api(), admission, update, root, context, job, returning)
            owned = {'job': (job['id'], job['state']), 'profile': profile}
        admission.verify_bootstrap()
        yield owned
        admission.verify_bootstrap()


def run_worker(state, operation):
    operator()
    state = Path(state)
    job = decoded(read_file(state / 'job.json'))
    require(job.get('id') == operation)
    bootstrap = Bootstrap(state, operation, job.get('worker'))
    require(Path(__file__).resolve(strict=True) == bootstrap.directory / 'bootstrap/scripts/orbis-host-upgrade-launcher.py')
    with worker_lock(bootstrap):
        frame = bootstrap.verify_bootstrap()
        write_exclusive(bootstrap.directory / 'claim.json', canonical({
            'schema': 'orbis.host-upgrade-claim.v1', 'requestSha256': bootstrap.reference['requestSha256'], **frame}))
        bootstrap.verify_bootstrap()
        # This import is from the entire verified Root snapshot, never a
        # downloaded module or an installed copy that Host replacement edits.
        service_module = load_sibling('orbis-host-service.py', 'orbis_independent_update_service')
        intake = bootstrap.intake
        service = service_module.HostService(Path(intake['root']), intake['dockerContext'],
            Path(intake['snapshots']), state, recover_interrupted_job=False)
        require(service_module.read_private(service.job_file) == job)
        bootstrap.verify_bootstrap()
        service.write_component_progress(bootstrap, {'version': 1, 'job': {
            'id': operation, 'state': 'running', 'targetTag': job['targetTag'], 'phase': None}})
        try:
            checked = prepare_worker_source(bootstrap, service)
            runner = load_sibling('orbis-host-upgrade-runner.py', 'orbis_independent_component_runner')
            require(runner.PROTOCOL == 'orbis.component-upgrade-runner.v1')
            with hold_worker_target(bootstrap, checked) as admission:
                admission.verify_bootstrap()
                write_exclusive(bootstrap.directory / 'execution-intent.json', canonical({
                    'schema': 'orbis.host-upgrade-execution.v1', 'requestSha256': bootstrap.reference['requestSha256'], **frame}))
                outcome = runner.run(_launcher_api(), service, job, admission)
                admission.verify_bootstrap()
            # Resource/target admission exits while the accepted job is unchanged.
            # Only a registered whole-set outcome can publish completion.
            bootstrap.verify_bootstrap()
            runner.finalize(_launcher_api(), service, bootstrap, outcome)
        except Exception:
            try:
                service.write_component_progress(bootstrap, {'version': 1, 'job': {
                    'id': operation, 'state': 'interrupted', 'targetTag': job['targetTag'], 'phase': 'recovering'}})
            except Exception:
                pass
            raise


def _launcher_api():
    # importlib callers need not register modules in sys.modules. Preserve the
    # exact executing module globals rather than importing another copy with
    # different process/source registries.
    from types import SimpleNamespace
    return SimpleNamespace(**globals())


def absent(path):
    try:
        path.lstat()
    except FileNotFoundError:
        return True
    return False


def before_component_stage(directory_path):
    journal = directory_path / 'component-journal'
    if absent(journal):
        return True
    with directory(journal) as descriptor:
        return not os.listdir(descriptor)


def abort_before_execution(service, job, bootstrap):
    """Settle an accepted operation that lost dispatch before any component effect."""
    operator()
    require(not service.credentials_only and job['state'] == 'interrupted')
    operation = job['id']
    supervision = bootstrap.supervision if bootstrap else load_sibling(
        'orbis-host-upgrade-supervision.py', 'orbis_undispatched_worker_supervision')
    directory_path = supervision.operation_directory(service.state_dir, operation)
    runtime = supervision.Runtime()
    unit = supervision.reconciliation_unit_name(operation)
    service_module = load_sibling('orbis-host-service.py', 'orbis_pre_effect_job_writer')
    snapshot = Path(job['snapshot'])
    require(job.get('overlayId') == operation and snapshot == service.snapshots / f"orbis-{job['targetTag']}-{operation}")
    if bootstrap:
        require(bootstrap.intake['root'] == str(service.root) and bootstrap.intake['dockerContext'] == service.context)

    def verify():
        require(decoded(read_file(service.job_file)) == job)
        if bootstrap:
            bootstrap.verify_files()
            bootstrap.verify_original_claim()
        intent = directory_path / 'execution-intent.json'
        if not absent(intent):
            require(bootstrap is not None and bootstrap.original_claim is not None
                    and decoded(read_file(intent, 16384)) == {
                        'schema': 'orbis.host-upgrade-execution.v1',
                        'requestSha256': bootstrap.request_sha, **bootstrap.original_frame})
        if bootstrap is None:
            require(job.get('worker') is None)
        quiescence = supervision.observe_quiescence(Files(), service.state_dir, operation,
            bootstrap.original_frame if bootstrap else None, runtime=runtime)
        recovery_unit = runtime.unit(unit)
        require(recovery_unit['ActiveState'] in ('inactive', 'failed')
                and recovery_unit['MainPID'] == recovery_unit['ControlPID'] == '0'
                and not recovery_unit['Job']
                and runtime.cgroup_empty(unit))
        require(before_component_stage(directory_path) and all(absent(path) for path in (
            directory_path / 'host-forward-intent.json', service_module.UPDATE.journal_path(snapshot),
            snapshot, service.state_dir / 'helper-maintenance.json')))
        return quiescence['bootId']

    with ExitStack() as resources:
        if bootstrap:
            resources.enter_context(worker_lock(bootstrap))
        resources.enter_context(service.lock)
        resources.enter_context(service.HOST.host_lock(service.root))
        current_boot = verify()
        overlay = service.core_overlays()
        record = overlay.read(operation)
        require(record['current'] == job['current'] and record['target'] == job['target'] and overlay.accepted_job(record))
        overlay.verify_pre_effect_source(record, current_boot)
        require(verify() == current_boot)
        service_module.write_private(service.job_file, {**job, 'state': 'failed',
            'message': 'The update stopped before component installation. The original release is intact.',
            'finishedAt': time.time()})
    service.core_operation_maintenance()


def launch_reconciliation(service, job):
    """Dispatch the existing accepted operation through its separate fixed unit."""
    operator()
    if job.get('worker') is None:
        return abort_before_execution(service, job, None)
    bootstrap = ReconciliationBootstrap(service.state_dir, job['id'], job['worker'], allow_unclaimed=True)
    require(bootstrap.verify_files() == job and job['state'] == 'interrupted'
            and bootstrap.intake['root'] == str(service.root)
            and bootstrap.intake['dockerContext'] == service.context)
    supervision = bootstrap.supervision
    if absent(bootstrap.directory / 'execution-intent.json') or before_component_stage(bootstrap.directory):
        return abort_before_execution(service, job, bootstrap)
    require(bootstrap.original_claim is not None)
    unit = supervision.reconciliation_unit_name(job['id'])
    body = supervision.unit_body(service.state_dir, job['id'], reconciling=True)
    path = supervision.UNITS / unit
    with worker_lock(bootstrap):
        supervision.observe_quiescence(Files(), bootstrap.state_directory, bootstrap.operation, bootstrap.original_frame)
        try:
            write_exclusive(path, body, mode=0o644, private=False)
        except FileExistsError:
            pass
        require(read_file(path, 16384, private=False) == body)
        systemctl('daemon-reload')
        runtime = supervision.Runtime()
        runtime.supported()
        loaded = runtime.unit(unit)
        require(loaded['LoadState'] == 'loaded' and loaded['FragmentPath'] == str(path)
                and not loaded['DropInPaths'] and loaded['NeedDaemonReload'] == 'no'
                and loaded['ActiveState'] in ('inactive', 'failed')
                and loaded['MainPID'] == loaded['ControlPID'] == '0' and not loaded['Job'] and runtime.cgroup_empty(unit))
        bootstrap.verify_files()
    # The new worker acquires the same lock before admitting effects.
    systemctl('start', unit)


def dispatch_offline_reconciliation(state, operation):
    """Admit the same recovery unit when the installed Host cannot answer."""
    operator()
    state = Path(state)
    job = decoded(read_file(state / 'job.json'))
    require(job.get('id') == operation and type(job.get('worker')) is dict)
    bootstrap = ReconciliationBootstrap(state, operation, job['worker'], allow_unclaimed=True)
    require(Path(__file__).resolve(strict=True) ==
            bootstrap.directory / 'bootstrap/scripts/orbis-host-upgrade-launcher.py')
    service_module = load_sibling('orbis-host-service.py', 'orbis_offline_recovery_service')
    intake = bootstrap.intake
    service = service_module.HostService(Path(intake['root']), intake['dockerContext'],
        Path(intake['snapshots']), state, recover_interrupted_job=False)
    with worker_lock(bootstrap):
        require(bootstrap.verify_files() == job)
        bootstrap.verify_original_claim()
        bootstrap.supervision.observe_quiescence(Files(), state, operation, bootstrap.original_frame)
        service.require_restart_clear()
        service.require_package_clear()
        if job['state'] == 'running':
            require(bootstrap.verify_files() == job)
            bootstrap.verify_original_claim()
            job = {**job, 'state': 'interrupted',
                   'message': 'Update worker dispatch needs reconciliation; its execution records were preserved.'}
            service_module.write_private(service.job_file, job)
    launch_reconciliation(service, job)


def run_reconciliation(state, operation):
    operator()
    state = Path(state)
    job = decoded(read_file(state / 'job.json'))
    require(job['id'] == operation)
    bootstrap = ReconciliationBootstrap(state, operation, job['worker'], claimed=False)
    require(Path(__file__).resolve(strict=True) ==
            bootstrap.directory / 'bootstrap/scripts/orbis-host-upgrade-launcher.py')
    with worker_lock(bootstrap):
        claim_reconciliation(bootstrap)
        require(decoded(read_file(bootstrap.directory / 'execution-intent.json', 16384)) == {
            'schema': 'orbis.host-upgrade-execution.v1', 'requestSha256': bootstrap.request_sha,
            **bootstrap.original_frame})
        service_module = load_sibling('orbis-host-service.py', 'orbis_reconciliation_service')
        intake = bootstrap.intake
        service = service_module.HostService(Path(intake['root']), intake['dockerContext'],
            Path(intake['snapshots']), state, recover_interrupted_job=False)
        checked = decoded(read_file(bootstrap.directory / 'source-checked.json'))
        runner = load_sibling('orbis-host-upgrade-runner.py', 'orbis_reconciliation_runner')
        require(runner.PROTOCOL == 'orbis.component-upgrade-runner.v1')
        try:
            service.require_restart_clear()
            service.require_package_clear()
            with hold_worker_target(bootstrap, checked, existing=True) as admission:
                outcome = runner.reconcile(_launcher_api(), service, job, admission)
                admission.verify_bootstrap()
            runner.finalize(_launcher_api(), service, bootstrap, outcome)
        except Exception:
            service.write_component_progress(bootstrap, {'version': 1, 'job': {
                'id': operation, 'state': 'interrupted', 'targetTag': job['targetTag'], 'phase': 'recovering'}})
            raise


def main():
    parser = argparse.ArgumentParser(description='Run one accepted Orbis update outside the Host service.')
    parser.add_argument('action', choices=('run', 'source-check', 'reconcile', 'dispatch-reconciliation'))
    parser.add_argument('operation')
    parser.add_argument('--state-dir', type=Path, required=True)
    arguments = parser.parse_args()
    try:
        if arguments.action == 'source-check':
            check_source_child(arguments.state_dir, arguments.operation)
        elif arguments.action == 'dispatch-reconciliation':
            dispatch_offline_reconciliation(arguments.state_dir, arguments.operation)
        elif arguments.action == 'reconcile':
            run_reconciliation(arguments.state_dir, arguments.operation)
        else:
            run_worker(arguments.state_dir, arguments.operation)
    except (OSError, ValueError, RuntimeError):
        print('The accepted update requires reconciliation; its source and execution records were preserved.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
