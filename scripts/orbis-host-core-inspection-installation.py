"""Root-installed inspection code and parser qualifications; no RPC enrollment."""
import copy
import fcntl
import hashlib
import importlib.util
import os
from pathlib import Path
import stat
import sys
from dataclasses import dataclass
import uuid
from contextlib import contextmanager


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    sys.modules[key] = module
    spec.loader.exec_module(module)
    return module


C = load('orbis-host-core-source-configuration.py', 'orbis_installed_configuration')
SCHEMA = 'orbis.core-inspection-installed-runtime.v1'
POINTER = 'orbis.core-inspection-installed-selection.v1'


class InstallationError(ValueError):
    pass


def fail():
    return InstallationError('Restore inspection code is not prepared or has changed. Saved points were kept.')


def require_root():
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise fail()


@dataclass(frozen=True)
class RootInstallationApproval:
    """Only the verified installer/operator supplies these independently approved hashes."""
    coordinator: C.TrustedCoordinator
    release_sha256: str
    inventory_sha256: str
    qualified_sources: dict


@dataclass(frozen=True)
class InstalledSelection:
    identifier: str
    installation_sha256: str


class InstalledInspectionRuntime:
    def __init__(self, enrollment):
        require_root()
        self.enrollment, self.a, self.P = enrollment, enrollment.a, enrollment.P
        self.base = Path(enrollment.state) / 'core-inspection-runtime'

    def digest(self, value):
        return hashlib.sha256(self.P.canonical(value)).hexdigest()

    def qualifications(self, value):
        if not isinstance(value, dict) or not 1 <= len(value) <= 128:
            raise fail()
        for image, qualification in value.items():
            if (not isinstance(image, str) or not C.IMAGE.fullmatch(image)
                    or not self.P.exact(qualification, {'parserProfile', 'qualificationSha256'})
                    or qualification['parserProfile'] != C.PARSER
                    or not isinstance(qualification['qualificationSha256'], str)
                    or not C.HEX.fullmatch(qualification['qualificationSha256'])):
                raise fail()
        return copy.deepcopy(value)

    def install(self, approval):
        """After independent release verification, copy a generation then atomically select it."""
        require_root()
        if (type(approval) is not RootInstallationApproval
                or type(approval.coordinator) is not C.TrustedCoordinator
                or not isinstance(approval.release_sha256, str) or not C.HEX.fullmatch(approval.release_sha256)
                or not isinstance(approval.inventory_sha256, str) or not C.HEX.fullmatch(approval.inventory_sha256)):
            raise fail()
        sources = self.qualifications(approval.qualified_sources)
        trust = approval.coordinator
        if (trust.source_controller_image_id not in sources
                or sources[trust.source_controller_image_id]['parserProfile'] != trust.parser_profile):
            raise fail()
        broker = C.CoreSourceConfigurationPreparation(self.enrollment, trust)
        broker.image()
        inventory = broker.code()
        if 'core-inspection-worker.mjs' not in inventory or self.digest(inventory) != approval.inventory_sha256:
            raise fail()
        base = self.enrollment.child(Path(self.enrollment.state), 'core-inspection-runtime')
        self.enrollment.sync(Path(self.enrollment.state))
        lock = os.open(base / 'install.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            details = os.fstat(lock)
            if (not stat.S_ISREG(details.st_mode) or details.st_uid != self.a.OWNER
                    or details.st_nlink != 1 or stat.S_IMODE(details.st_mode) != 0o600):
                raise fail()
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.a.protected_directory(base) as parent:
                if self.a.seal(details) != self.a.seal(os.stat('install.lock', dir_fd=parent, follow_symlinks=False)):
                    raise fail()
            generations = self.enrollment.child(base, 'generations')
            self.enrollment.sync(base)
            identifier = str(uuid.uuid4())
            generation = generations / identifier
            generation.mkdir(mode=0o700)
            code = generation / 'code'
            code.mkdir(mode=0o700)
            for name, expected in inventory.items():
                body = self.enrollment.read(trust.code_directory / name, 16 * 1024 * 1024)
                if len(body) != expected['bytes'] or C.sha(body) != expected['sha256']:
                    raise fail()
                self.enrollment.immutable(code / name, body)
            if broker.code() != inventory:
                raise fail()
            self.enrollment.immutable(generation / 'policy.lock', b'')
            record = {'schema': SCHEMA, 'id': identifier, 'releaseSha256': approval.release_sha256,
                      'inventorySha256': approval.inventory_sha256, 'qualifiedSources': sources,
                      'coordinator': {'imageId': trust.image_id, 'architecture': trust.architecture, 'files': inventory}}
            self.enrollment.immutable(generation / 'installation.json', self.P.canonical(record))
            selected = C.TrustedCoordinator(trust.image_id, trust.architecture, code, inventory,
                                            trust.source_controller_image_id, trust.parser_profile)
            installed = C.CoreSourceConfigurationPreparation(self.enrollment, selected)
            installed.image()
            if installed.code() != inventory:
                raise fail()
            self.enrollment.sync(code)
            self.enrollment.sync(generation)
            self.enrollment.sync(generations)
            self.a.atomic(base / 'current.json', self.P.canonical({'schema': POINTER, 'id': identifier,
                                                                'installationSha256': self.digest(record)}))
            return {'id': identifier, 'installationSha256': self.digest(record)}
        except (OSError, ValueError, TypeError, KeyError, AttributeError):
            # Failed generations remain unselected for explicit reconciliation.
            raise fail() from None
        finally:
            os.close(lock)

    @contextmanager
    def policy_lock(self, selection, *, exclusive=False):
        require_root()
        if (type(selection) is not InstalledSelection or not isinstance(selection.identifier, str)
                or not C.UUID.fullmatch(selection.identifier) or not isinstance(selection.installation_sha256, str)
                or not C.HEX.fullmatch(selection.installation_sha256)):
            raise fail()
        generation = self.base / 'generations' / selection.identifier
        with self.a.protected_directory(generation) as parent:
            descriptor = os.open('policy.lock', os.O_RDWR | os.O_NOFOLLOW, dir_fd=parent)
        try:
            before = os.fstat(descriptor)
            if (not stat.S_ISREG(before.st_mode) or before.st_uid != self.a.OWNER or before.st_nlink != 1
                    or stat.S_IMODE(before.st_mode) != 0o600):
                raise fail()
            fcntl.flock(descriptor, (fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH) | fcntl.LOCK_NB)
            with self.a.protected_directory(generation) as parent:
                if self.a.seal(before) != self.a.seal(os.stat('policy.lock', dir_fd=parent, follow_symlinks=False)):
                    raise fail()
            body = self.enrollment.read(generation / 'installation.json', 1024 * 1024)
            if C.sha(body) != selection.installation_sha256:
                raise fail()
            yield generation
        except (OSError, ValueError, TypeError, KeyError, AttributeError):
            raise fail() from None
        finally:
            os.close(descriptor)

    def not_revoked(self, generation):
        with self.a.protected_directory(generation) as parent:
            try:
                os.stat('revoked.json', dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                return
            raise fail()

    @contextmanager
    def authority(self, selection):
        with self.policy_lock(selection) as generation:
            self.not_revoked(generation)
            yield
            self.not_revoked(generation)

    def revoke(self, selection):
        """Fence admissions between phases; this never proves existing workers stopped."""
        with self.policy_lock(selection, exclusive=True) as generation:
            self.enrollment.immutable(generation / 'revoked.json', self.P.canonical({
                'schema': 'orbis.core-inspection-runtime-revoked.v1', 'id': selection.identifier,
                'installationSha256': selection.installation_sha256, 'workerQuiescenceProved': False}))

    def configuration(self, source_controller_image_id, selection=None):
        require_root()
        if not isinstance(source_controller_image_id, str) or not C.IMAGE.fullmatch(source_controller_image_id):
            raise fail()
        try:
            if selection is not None:
                if type(selection) is not InstalledSelection:
                    raise fail()
                pointer = {'schema': POINTER, 'id': selection.identifier,
                           'installationSha256': selection.installation_sha256}
                pointer_body = self.P.canonical(pointer)
            else:
                pointer_body = self.enrollment.read(self.base / 'current.json', 16384)
                pointer = self.P.metadata(pointer_body, byte_limit=16384)
            if (not self.P.exact(pointer, {'schema', 'id', 'installationSha256'}) or pointer['schema'] != POINTER
                    or not isinstance(pointer['id'], str) or not C.UUID.fullmatch(pointer['id'])
                    or pointer_body != self.P.canonical(pointer)):
                raise fail()
            generation = self.base / 'generations' / pointer['id']
            with self.a.protected_directory(generation) as parent:
                try:
                    os.stat('revoked.json', dir_fd=parent, follow_symlinks=False)
                except FileNotFoundError:
                    pass
                else:
                    raise fail()
            body = self.enrollment.read(generation / 'installation.json', 1024 * 1024)
            record = self.P.metadata(body, byte_limit=1024 * 1024)
            if (not self.P.exact(record, {'schema', 'id', 'releaseSha256', 'inventorySha256', 'qualifiedSources', 'coordinator'})
                    or record['schema'] != SCHEMA or record['id'] != pointer['id'] or body != self.P.canonical(record)
                    or self.digest(record) != pointer['installationSha256']
                    or not isinstance(record['releaseSha256'], str) or not C.HEX.fullmatch(record['releaseSha256'])):
                raise fail()
            sources = self.qualifications(record['qualifiedSources'])
            if source_controller_image_id not in sources:
                raise fail()
            coordinator = record['coordinator']
            if (not self.P.exact(coordinator, {'imageId', 'architecture', 'files'})
                    or self.digest(coordinator['files']) != record['inventorySha256']):
                raise fail()
            trust = C.TrustedCoordinator(coordinator['imageId'], coordinator['architecture'], generation / 'code',
                                         coordinator['files'], source_controller_image_id,
                                         sources[source_controller_image_id]['parserProfile'])
            broker = C.CoreSourceConfigurationPreparation(self.enrollment, trust)
            admitted = InstalledSelection(pointer['id'], pointer['installationSha256'])
            with self.authority(admitted):
                broker.image()
                if 'core-inspection-worker.mjs' not in broker.code():
                    raise fail()
            if selection is None and self.enrollment.read(self.base / 'current.json', 16384) != pointer_body:
                raise fail()
            broker.installed_selection = admitted
            broker.installed_authority = lambda: self.authority(admitted)
            return broker
        except (OSError, ValueError, TypeError, KeyError, AttributeError):
            raise fail() from None
