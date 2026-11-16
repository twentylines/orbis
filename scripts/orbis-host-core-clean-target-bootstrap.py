"""Root-only fresh database orchestration; no RPC admission or restore activation.

Installed-release enrollment and the public caller must independently supply the
programmatic approval, catalog authority and installation/runtime lock below.
Hashes bind that decision; they do not authenticate historical environments.
"""
import copy
from dataclasses import dataclass
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import stat
import sys
import tarfile
import uuid


def load(filename, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    sys.modules[key] = module
    spec.loader.exec_module(module)
    return module


TARGET = load('orbis-host-core-clean-target-profile.py', 'orbis_bootstrap_target_profile')
SUPERVISOR = load('orbis-host-core-inspection-executor.py', 'orbis_bootstrap_supervisor')
HEX = re.compile(r'[a-f0-9]{64}')
IMAGE = re.compile(r'sha256:[a-f0-9]{64}')
SQL = re.compile(r'[0-9]{4}_[A-Za-z0-9_-]+\.sql')
SCHEMA = 'orbis.core-clean-target-bootstrap-job.v1'
POLICIES = {'scope': 'bootstrap-clean-target-only', 'activation': False,
            'environmentProved': False, 'restoreAuthority': False,
            'sanitationPolicy': 'orbis.core-clean-target-migrated-seed.v1',
            'migrationLedgerPolicy': 'orbis.core-clean-target-migration-ledger.v1'}
IDENTITY_SQL = """SELECT pg_catalog.json_build_object(
 'systemIdentifier',s.system_identifier::text,'databaseOid',d.oid::text,'database',d.datname,'role',CURRENT_USER,
 'locale',pg_catalog.json_build_object('encoding',pg_catalog.pg_encoding_to_char(d.encoding),'collate',d.datcollate,'ctype',d.datctype,'provider',d.datlocprovider))
 FROM pg_catalog.pg_control_system() s CROSS JOIN pg_catalog.pg_database d WHERE d.datname=pg_catalog.current_database()"""


class BootstrapError(ValueError):
    pass


class BootstrapCapacityError(BootstrapError):
    def __init__(self, reason, availableBytes, requiredBytes):
        if (reason not in {'memory', 'disk'} or type(availableBytes) is not int or availableBytes < 0
                or type(requiredBytes) is not int or requiredBytes <= 0):
            raise BootstrapError('Fresh database capacity could not be verified')
        self.reason, self.availableBytes, self.requiredBytes = reason, availableBytes, requiredBytes
        super().__init__('Fresh database preparation requires more ' + reason + '; existing data was preserved')


def require(condition):
    if not condition:
        raise BootstrapError('Fresh database preparation requires protected review; existing data was preserved')


def sha(body):
    return hashlib.sha256(body).hexdigest()


@dataclass(frozen=True)
class RootBootstrapApproval:
    """Construct only after independent Root approval, never from deserialized input.

    catalog_reader revalidates authenticated source evidence, including its actor,
    original system identifier, catalog and ledger. guard holds the enrolled
    installation/runtime exclusion across the entire operation and receipt check.
    No field authorizes stopping original services, takeover, retries or cleanup.
    """
    configuration_binding: dict
    profile: dict
    source_catalog: dict
    migration_inventory: dict
    migration_graph: list
    catalog_reader: object
    guard: object


@dataclass(frozen=True)
class PreparedCleanTarget:
    identifier: str
    receipt_sha256: str


def migration_bundle(body):
    """Read a bounded image archive; links, PAX and arbitrary paths never extract."""
    require(type(body) is bytes and 0 < len(body) <= 32 * 1024 ** 2)
    files, auxiliary, directories, seen, total = {}, {}, set(), set(), 0

    class PlainTar(tarfile.TarInfo):
        def _proc_member(self, archive):
            require(self.type in {tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE})
            return super()._proc_member(archive)

    with tarfile.open(fileobj=io.BytesIO(body), mode='r:', tarinfo=PlainTar) as archive:
        for item in archive:
            source_name = item.name.removeprefix('./')
            name = source_name.removeprefix('migrations/').rstrip('/')
            if item.isdir() and source_name == 'migrations':
                name = ''
            require(not item.pax_headers and not item.linkname and item.uid == 0)
            if item.isdir():
                require(name in {'', '.', 'meta'} and name not in directories)
                directories.add(name)
                continue
            executable = bool(SQL.fullmatch(name)) or name == 'meta/_journal.json'
            audit = bool(re.fullmatch(r'meta/[0-9]{4}_snapshot\.json', name)) or name in {'schema.ts', 'relations.ts', 'types.ts'}
            require(item.isfile() and (executable or audit) and name not in seen and len(seen) < 8192
                    and 0 < item.size <= 4 * 1024 ** 2)
            seen.add(name)
            value = archive.extractfile(item).read(4 * 1024 ** 2 + 1)
            total += len(value)
            require(len(value) == item.size and total <= 16 * 1024 ** 2)
            if executable:
                files[name] = value
            else:
                auxiliary[name] = {'bytes': len(value), 'sha256': sha(value)}
    require('meta/_journal.json' in files)
    journal = json.loads(files['meta/_journal.json'])
    require(isinstance(journal, dict) and set(journal) == {'version', 'dialect', 'entries'}
            and journal['version'] == '7' and journal['dialect'] == 'postgresql'
            and type(journal['entries']) is list and 1 <= len(journal['entries']) <= 4096)
    graph, names, last = [], {'meta/_journal.json'}, 0
    for index, entry in enumerate(journal['entries']):
        require(isinstance(entry, dict) and set(entry) == {'idx', 'version', 'when', 'tag', 'breakpoints'}
                and type(entry['idx']) is int and entry['idx'] == index and entry['version'] == '7'
                and type(entry['when']) is int and last < entry['when'] <= 9007199254740991
                and isinstance(entry['tag'], str) and entry['tag'].startswith(f'{index:04d}_')
                and SQL.fullmatch(entry['tag'] + '.sql') and type(entry['breakpoints']) is bool)
        name = entry['tag'] + '.sql'
        require(name in files and name not in names)
        files[name].decode('utf-8', errors='strict')
        require(b'\0' not in files[name])
        names.add(name)
        graph.append({'hash': sha(files[name]), 'created_at': str(entry['when'])})
        last = entry['when']
    require(set(files) == names)
    return files, auxiliary, graph


def validate_ledger(rows, graph):
    require(type(rows) is list and 1 <= len(rows) == len(graph) <= 4096)
    last = 0
    for row, expected in zip(rows, graph):
        require(isinstance(row, dict) and set(row) == {'id', 'hash', 'created_at'}
                and type(row['id']) is int and last < row['id'] <= 2147483647
                and row['hash'] == expected['hash'] and row['created_at'] == expected['created_at'])
        last = row['id']


class CoreCleanTargetBootstrap:
    schema = SCHEMA
    inspection_schema = 'orbis.core-restore-inspection.v3'
    worker_version = 1
    root_intent_schema = 'orbis.core-clean-target-root-intent.v1'
    stop_intent_schema = 'orbis.core-clean-target-owned-stop-intent.v1'
    receipt_schema = 'orbis.core-clean-target-bootstrap-receipt.v1'
    continuation_schema = 'orbis.core-clean-target-initialized-continuation.v1'

    @classmethod
    def from_source_inspection(cls, configuration_broker, inspection, identifier, actor, *,
                               profile, migration_inventory, migration_graph, guard):
        """Connect the completed source inspector; caller still supplies Root exclusion."""
        require(getattr(inspection, 'configuration', None) is configuration_broker
                and getattr(inspection, 'schema', None) == cls.inspection_schema
                and callable(getattr(inspection, 'bootstrap_catalog', None)) and callable(guard))
        actor = configuration_broker.enrollment.actor(actor)
        def catalog_reader():
            return inspection.bootstrap_catalog(identifier, actor)
        with guard():
            approval = RootBootstrapApproval(
                configuration_binding=configuration_broker.binding(), profile=profile,
                source_catalog=catalog_reader(), migration_inventory=migration_inventory,
                migration_graph=migration_graph, catalog_reader=catalog_reader, guard=guard)
            return cls(configuration_broker, approval)

    def __init__(self, configuration_broker, approval):
        # Reuse the actual broker capability instead of re-importing its dataclasses.
        require(type(approval) is RootBootstrapApproval)
        self.broker, self.approval = configuration_broker, approval
        self.enrollment = configuration_broker.enrollment
        self.a, self.P = self.enrollment.a, self.enrollment.P
        self.runtime, self.context = self.enrollment.runtime, self.enrollment.context
        self.approved = copy.deepcopy({
            'configuration': approval.configuration_binding, 'profile': approval.profile,
            'catalog': approval.source_catalog, 'inventory': approval.migration_inventory,
            'graph': approval.migration_graph})
        require(callable(approval.catalog_reader) and callable(approval.guard))

    def digest(self, value):
        return sha(self.P.canonical(value))

    def directory(self, identifier, create=False):
        require(isinstance(identifier, str) and TARGET.UUID.fullmatch(identifier))
        base = self.enrollment.state / 'core-clean-target-bootstraps'
        if create:
            base = self.enrollment.child(self.enrollment.state, base.name)
        with self.a.protected_directory(base):
            pass
        directory = base / identifier
        if create:
            # No existing/partial job is reusable, even before a worker exists.
            directory.mkdir(mode=0o700)
            self.enrollment.sync(base)
        with self.a.protected_directory(directory):
            pass
        return directory

    def save(self, record):
        self.a.atomic(self.directory(record['id']) / 'job.json', self.P.canonical(record))

    def record(self, identifier):
        record = self.enrollment.json(self.directory(identifier) / 'job.json', 4 * 1024 ** 2)
        require(record.get('schema') == self.schema and record.get('id') == identifier
                and record.get('root') == str(self.enrollment.root) and record.get('context') == self.context)
        return record

    def read(self, path, maximum):
        with self.a.protected_directory(path.parent) as fd:
            details = os.stat(path.name, dir_fd=fd, follow_symlinks=False)
            require(stat.S_ISREG(details.st_mode) and details.st_uid == 0 and details.st_nlink == 1
                    and stat.S_IMODE(details.st_mode) == 0o400 and 0 < details.st_size <= maximum)
            expected = TARGET.SOURCE.regular_digest(fd, path.name, self.a, maximum)
            value = self.enrollment.read(path, maximum)
            require(expected == {'bytes': len(value), 'sha256': sha(value)}
                    and self.a.seal(details) == self.a.seal(os.stat(path.name, dir_fd=fd, follow_symlinks=False)))
            return value

    def publish(self, path, body):
        """Create new immutable worker data; existing and partial names never replay."""
        TARGET.require_root()
        require(self.a.OWNER == 0 and type(body) is bytes and 0 < len(body) <= 16 * 1024 ** 2)
        path = Path(path)
        require(path.is_absolute() and path.name not in {'', '.', '..'})
        with self.a.protected_directory(path.parent) as parent:
            held = os.dup(parent)
            identity = TARGET.directory_identity(os.fstat(parent))
        descriptor = None
        try:
            descriptor = os.open(path.name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_NONBLOCK, 0o400, dir_fd=held)
            before = os.fstat(descriptor)
            require(stat.S_ISREG(before.st_mode) and before.st_uid == os.geteuid() and before.st_nlink == 1
                    and stat.S_IMODE(before.st_mode) == 0o400 and before.st_size == 0)
            offset = 0
            while offset < len(body):
                count = os.write(descriptor, body[offset:])
                require(count > 0)
                offset += count
            os.fchmod(descriptor, 0o400)
            os.fsync(descriptor)
            final = os.fstat(descriptor)
            require(stat.S_ISREG(final.st_mode) and final.st_uid == before.st_uid and final.st_gid == before.st_gid
                    and final.st_nlink == 1 and final.st_size == len(body) and stat.S_IMODE(final.st_mode) == 0o400)
            os.lseek(descriptor, 0, os.SEEK_SET)
            selected = bytearray()
            while block := os.read(descriptor, min(65536, len(body) + 1 - len(selected))):
                selected.extend(block)
                require(len(selected) <= len(body))
            require(bytes(selected) == body and self.a.seal(final) == self.a.seal(os.fstat(descriptor))
                    == self.a.seal(os.stat(path.name, dir_fd=held, follow_symlinks=False)))
            with self.a.protected_directory(path.parent) as current:
                require(TARGET.directory_identity(os.fstat(current)) == identity == TARGET.directory_identity(os.fstat(held))
                        and self.a.seal(final) == self.a.seal(os.stat(path.name, dir_fd=current, follow_symlinks=False)))
            os.fsync(held)
        finally:
            if descriptor is not None:
                os.close(descriptor)
            os.close(held)

    def validate(self, actor):
        TARGET.require_root()
        require(self.a.OWNER == 0)
        actor = self.enrollment.actor(actor)
        require(self.broker.binding() == self.approved['configuration'])
        profile = TARGET.validate_profile(self.approved['profile'])
        trust = self.broker.trust
        require(trust.architecture == profile['architecture'] == 'arm64'
                and IMAGE.fullmatch(trust.image_id) and IMAGE.fullmatch(trust.source_controller_image_id)
                and 'core-clean-target-bootstrap-worker.mjs' in trust.inventory)
        self.broker.image()
        TARGET.clean_target_profile(self.runtime.image(profile['imageId']), profile['role'], profile['database'], profile['locale'])
        image = self.runtime.image(trust.source_controller_image_id)
        require(image.get('Id') == trust.source_controller_image_id and image.get('Os') == 'linux'
                and image.get('Architecture') == 'arm64' and (image.get('Config') or {}).get('Volumes') in (None, {}))
        catalog = self.approved['catalog']
        require(self.approval.catalog_reader() == catalog and isinstance(catalog, dict)
                and set(catalog) == {'schema', 'actor', 'sourceWitnessSha256', 'sourceManifestSha256',
                                    'sourceControllerImageId', 'catalogSha256', 'systemIdentifier', 'ledger',
                                    'authenticationVerified', 'authorityScope', 'environmentProved', 'restoreAuthority'}
                and catalog['schema'] == 'orbis.core-root-authenticated-bootstrap-source.v1'
                and catalog['actor'] == actor and catalog['authenticationVerified'] is True
                and catalog['authorityScope'] == 'authenticated-source-catalog-and-ledger'
                and catalog['environmentProved'] is False and catalog['restoreAuthority'] is False
                and catalog['sourceControllerImageId'] == trust.source_controller_image_id
                and all(isinstance(catalog[k], str) and HEX.fullmatch(catalog[k]) for k in
                        ('sourceWitnessSha256', 'sourceManifestSha256', 'catalogSha256'))
                and self.number(catalog['systemIdentifier'], 18446744073709551615))
        validate_ledger(catalog['ledger'], self.approved['graph'])
        return actor

    @staticmethod
    def number(value, maximum):
        return isinstance(value, str) and bool(re.fullmatch(r'[1-9][0-9]{0,19}', value)) and int(value) <= maximum

    def capacity(self, directory):
        available = None
        with open('/proc/meminfo', encoding='ascii') as stream:
            for line in stream:
                if line.startswith('MemAvailable:'):
                    fields = line.split()
                    require(len(fields) == 3 and fields[2] == 'kB' and fields[1].isdigit())
                    available = int(fields[1]) * 1024
        space = os.statvfs(directory)
        require(available is not None)
        if available < 1536 * 1024 ** 2:
            raise BootstrapCapacityError('memory', available, 1536 * 1024 ** 2)
        free = space.f_bavail * space.f_frsize
        if free < 1024 ** 3:
            raise BootstrapCapacityError('disk', free, 1024 ** 3)

    def phase(self, record, phase):
        record['phase'] = phase
        record.setdefault('phases', []).append(phase)
        require(len(record['phases']) <= 16)
        self.save(record)

    def carrier_body(self, workspace):
        result = TARGET.body(workspace, 'migration-carrier', '/bin/true', [], [])
        result.update(Image=self.broker.trust.source_controller_image_id, User='0:0')
        result['HostConfig'] = TARGET.SOURCE.host({'pids': 32, 'memory': 64 * 1024 ** 2}) | {'Mounts': []}
        return result

    def carrier(self, supervisor, workspace):
        record = supervisor.record
        body = self.carrier_body(workspace)
        name = 'orbis-core-inspect-migration-carrier-' + record['id']
        worker = {'name': name, 'body': body, 'intent': 'creating'}
        record['inspectionWorkers'] = {'migration-carrier': worker}
        self.save(record)
        response = self.P.metadata(self.runtime.engine('POST', '/containers/create?name=' + name, body))
        require(isinstance(response.get('Id'), str) and HEX.fullmatch(response['Id']))
        worker.update(id=response['Id'], intent='created-never-start')
        self.save(record)
        raw = supervisor.inspect('migration-carrier')
        require(self.runtime.never_started(raw))
        worker['definitionSha256'] = self.runtime.definition(raw)
        self.save(record)
        archive = self.runtime.bounded_output(['docker', '--context', self.context, 'container', 'cp',
                                              worker['id'] + ':/app/assets/migrations/.', '-'], 32 * 1024 ** 2, 30)
        files, auxiliary, graph = migration_bundle(archive)
        require(graph == self.approved['graph'])
        inventory = {'schema': 'orbis.core-executable-migration-inventory.v1',
                     'files': {name: {'bytes': len(value), 'sha256': sha(value)} for name, value in sorted(files.items())}}
        require(inventory == self.approved['inventory'])
        raw = supervisor.inspect('migration-carrier')
        require(self.runtime.never_started(raw) and self.runtime.definition(raw) == worker['definitionSha256'])
        return files, auxiliary

    def initialized_body(self, workspace):
        # Initialization cannot be called again after initdb; reconstruct its exact body.
        locale = workspace.profile['locale']
        return TARGET.body(workspace, 'initialize', '/usr/local/bin/initdb', [
            '--pgdata=/var/lib/postgresql/data', '--username=' + workspace.profile['role'], '--encoding=' + locale['encoding'],
            '--locale-provider=libc', '--lc-collate=' + locale['collate'], '--lc-ctype=' + locale['ctype'],
            '--auth-local=reject', '--auth-host=reject', '--no-instructions'], [
                TARGET.SOURCE.mount(workspace.directory / 'pgdata', '/var/lib/postgresql/data', False)])

    def observer_body(self, workspace):
        body = TARGET.body(workspace, 'observer', '/usr/local/bin/psql', [
            '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '--no-password', '--host=/var/run/postgresql',
            '--username=' + workspace.profile['role'], '--dbname=' + workspace.profile['database'], '--command', IDENTITY_SQL], [
                TARGET.SOURCE.mount(workspace.directory / 'socket', '/var/run/postgresql', True),
                TARGET.SOURCE.mount(workspace.directory / 'pgdata', '/var/lib/postgresql/data', True)])
        body['Env'] = ['PGCONNECT_TIMEOUT=10', 'PGOPTIONS=-c default_transaction_read_only=on -c search_path=pg_catalog -c statement_timeout=15000']
        return body

    def bootstrap_body(self, workspace, directory):
        body = TARGET.body(workspace, 'bootstrap', 'node', [
            '/app/core-clean-target-bootstrap/core-clean-target-bootstrap-worker.mjs', '--bootstrap'], [
                TARGET.SOURCE.mount(self.broker.trust.code_directory, '/app/core-clean-target-bootstrap', True),
                TARGET.SOURCE.mount(directory / 'input', '/clean-target-bootstrap-input', True),
                TARGET.SOURCE.mount(directory / 'output', '/clean-target-bootstrap-output', False),
                TARGET.SOURCE.mount(self.migration_directory(self.record(workspace.allocation['id'])), '/clean-target-migrations', True),
                TARGET.SOURCE.mount(workspace.directory / 'socket', '/clean-target-target-socket', True)])
        body.update(Image=self.broker.trust.image_id, User='0:' + str(workspace.profile['gid']), WorkingDir='/app',
                    Env=['NODE_ENV=production', 'TMPDIR=/clean-target-bootstrap-output'])
        body['HostConfig']['LogConfig'] = {'Type': 'none', 'Config': {}}
        return body

    def identity(self, value, profile):
        require(isinstance(value, dict) and set(value) == {'systemIdentifier', 'databaseOid', 'database', 'role', 'locale'}
                and self.number(value['systemIdentifier'], 18446744073709551615)
                and self.number(value['databaseOid'], 4294967295)
                and value['database'] == profile['database'] and value['role'] == profile['role']
                and value['locale'] == profile['locale']
                and value['systemIdentifier'] != self.approved['catalog']['systemIdentifier'])
        return value

    def prepare(self, identifier, actor):
        with self.approval.guard():
            actor = self.validate(actor)
            self.capacity(self.enrollment.state)
            directory = self.directory(identifier, create=True)
            record = {'schema': self.schema, 'id': identifier, 'root': str(self.enrollment.root), 'context': self.context,
                      'actor': actor, 'phase': 'allocating', 'approvalSha256': self.digest(self.approved), **POLICIES}
            self.save(record)
            try:
                nonce = str(uuid.uuid4())
                intent = {'schema': self.root_intent_schema, 'id': identifier, 'nonce': nonce,
                          'approval': self.approved, 'actor': actor, **POLICIES}
                self.publish(directory / 'root-intent.json', self.P.canonical(intent))
                for name in ('target', 'input', 'output', 'migrations'):
                    self.enrollment.child(directory, name)
                self.enrollment.child(directory / 'migrations', 'meta')
                workspace = TARGET.allocate_workspace(directory / 'target', self.approved['profile'], self.a,
                                                      identifier, nonce, self.digest(intent))
                record['workspace'] = {'allocation': workspace.allocation, 'identities': workspace.identities}
                self.save(record)
                supervisor = SUPERVISOR.InspectionSupervisor(self, record)
                self.phase(record, 'selecting-migrations')
                files, auxiliary = self.carrier(supervisor, workspace)
                for name, value in files.items():
                    self.publish(directory / 'migrations' / name, value)
                self.publish(directory / 'migration-audit.json', self.P.canonical(auxiliary))
                self.validate(actor)
                self.phase(record, 'initializing')
                self.capacity(directory)
                supervisor.create_start('initialize', TARGET.initialization_body(workspace, self.a))
                supervisor.wait('initialize', 60)
                self.capture_initialized_custody(record, actor, workspace)
                return self._post_initialize(record, actor, workspace, supervisor)
            except BaseException as error:
                record.update(phase='recovery-required', failureClass=type(error).__name__)
                if type(error) is BootstrapCapacityError:
                    record['capacityFailure'] = {'reason': error.reason, 'availableBytes': error.availableBytes,
                                                 'requiredBytes': error.requiredBytes}
                self.save(record)
                raise BootstrapError('Fresh database preparation requires protected recovery review') from None

    def capture_initialized_custody(self, record, actor, workspace):
        pass

    def initialized_record_fields(self):
        return set()

    def verify_initialized_custody(self, record):
        pass

    def initialized_proof_fields(self, record):
        return {}

    def require_initialized_recheck(self, before, after):
        pass

    def require_prior_initialized_record(self, record, prior):
        pass

    def continuation_fields(self):
        return {}

    def _initialized_file(self, record, relative, expected):
        """Read only independently expected bytes of the validated old pre-SQL inputs."""
        allowed = {'root-intent.json', 'migration-audit.json'} | {'migrations/' + name for name in self.approved['inventory']['files']}
        require(relative in allowed and type(expected) is bytes and 0 < len(expected) <= 4 * 1024 ** 2)
        path = self.directory(record['id']) / relative
        mode = stat.S_IMODE(path.lstat().st_mode)
        if mode == 0o400:
            require(self.read(path, 4 * 1024 ** 2) == expected)
            return expected
        require(mode == 0o600 and record.get('phase') == 'recovery-required' and record.get('failureClass') == 'BootstrapError'
                and 'capacityFailure' not in record and 'continuation' not in record
                and record.get('phases') == ['selecting-migrations', 'initializing', 'starting-database']
                and record.get('actor') == self.approved['catalog']['actor']
                and record.get('approvalSha256') == self.digest(self.approved)
                and set(record.get('inspectionWorkers', {})) == {'migration-carrier', 'initialize'})
        TARGET.require_root()
        with self.a.protected_directory(path.parent) as parent:
            descriptor = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                before = os.fstat(descriptor)
                require(stat.S_ISREG(before.st_mode) and before.st_uid == os.geteuid() and before.st_nlink == 1
                        and stat.S_IMODE(before.st_mode) == 0o600 and before.st_size == len(expected))
                body = bytearray()
                while block := os.read(descriptor, min(65536, len(expected) + 1 - len(body))):
                    body.extend(block)
                    require(len(body) <= len(expected))
                require(bytes(body) == expected and self.a.seal(before) == self.a.seal(os.fstat(descriptor))
                        == self.a.seal(os.stat(path.name, dir_fd=parent, follow_symlinks=False)))
                return expected
            finally:
                os.close(descriptor)

    def migration_directory(self, record):
        if 'continuation' not in record:
            return self.directory(record['id']) / 'migrations'
        binding = record['continuation']
        require(isinstance(binding.get('id'), str) and TARGET.UUID.fullmatch(binding['id'])
                and binding.get('migrationPath') == 'continuations/' + binding['id'] + '/migrations')
        return self.directory(record['id']) / binding['migrationPath']

    def _initialized_evidence(self, record, actor, *, preflight):
        required = {'schema', 'id', 'root', 'context', 'actor', 'phase', 'approvalSha256', 'workspace',
                    'inspectionWorkers', 'phases', 'failureClass'} | set(POLICIES) | self.initialized_record_fields()
        require(set(record) in (required, required | {'capacityFailure'})
                and record['schema'] == self.schema and record['root'] == str(self.enrollment.root)
                and record['context'] == self.context and record['actor'] == self.validate(actor)
                and record['phase'] == 'recovery-required' and record['approvalSha256'] == self.digest(self.approved)
                and record['phases'] == ['selecting-migrations', 'initializing', 'starting-database']
                and isinstance(record['failureClass'], str) and re.fullmatch(r'[A-Za-z_][A-Za-z_0-9]{0,63}', record['failureClass'])
                and all(record.get(k) == v for k, v in POLICIES.items()))
        self.verify_initialized_custody(record)
        if 'capacityFailure' in record:
            failure = record['capacityFailure']
            require(isinstance(failure, dict) and set(failure) == {'reason', 'availableBytes', 'requiredBytes'}
                    and failure['reason'] in {'memory', 'disk'} and type(failure['availableBytes']) is int
                    and 0 <= failure['availableBytes'] < failure['requiredBytes']
                    and failure['requiredBytes'] == (1536 * 1024 ** 2 if failure['reason'] == 'memory' else 1024 ** 3))
        directory = self.directory(record['id'])
        if preflight:
            with self.a.protected_directory(directory) as fd:
                require(set(os.listdir(fd)) == {'job.json', 'root-intent.json', 'target', 'input', 'output', 'migrations', 'migration-audit.json'})
            for name in ('input', 'output'):
                with self.a.protected_directory(directory / name) as fd:
                    require(not os.listdir(fd))
        require(isinstance(record['workspace'], dict) and set(record['workspace']) == {'allocation', 'identities'})
        allocation = record['workspace']['allocation']
        require(isinstance(allocation, dict) and isinstance(allocation.get('nonce'), str) and TARGET.UUID.fullmatch(allocation['nonce']))
        intent = {'schema': self.root_intent_schema, 'id': record['id'], 'nonce': allocation['nonce'],
                  'approval': self.approved, 'actor': actor, **POLICIES}
        require(self._initialized_file(record, 'root-intent.json', self.P.canonical(intent)) == self.P.canonical(intent)
                and allocation == {'schema': 'orbis.core-clean-target-allocation.v1', 'id': record['id'],
                    'nonce': allocation['nonce'], 'rootIntentSha256': self.digest(intent), 'profile': self.approved['profile'],
                    'scope': 'prepare-clean-target-only', 'activation': False, 'environmentProved': False, 'restoreAuthority': False})
        workspace = TARGET.TargetWorkspace(directory / 'target', self.approved['profile'], allocation, record['workspace']['identities'])
        TARGET.verify_workspace(workspace, self.a)
        workers = record['inspectionWorkers']
        require(isinstance(workers, dict) and set(workers) == {'migration-carrier', 'initialize'})
        supervisor = SUPERVISOR.InspectionSupervisor(self, record)
        for role, body in (('migration-carrier', self.carrier_body(workspace)), ('initialize', self.initialized_body(workspace))):
            worker = workers[role]
            require(worker['body'] == body)
            raw = supervisor.inspect(role)
            require(self.runtime.definition(raw) == worker['definitionSha256'])
            if role == 'migration-carrier':
                require(worker['intent'] == 'created-never-start' and self.runtime.never_started(raw))
            else:
                state = raw.get('State') or {}
                require(worker['intent'] == 'complete' and worker.get('terminal') == {'id': worker['id'],
                    'definitionSha256': worker['definitionSha256'], 'state': state}
                    and state.get('Status') == 'exited' and type(state.get('ExitCode')) is int and state['ExitCode'] == 0
                    and all(state.get(key) is False for key in ('Running', 'Restarting', 'Paused', 'Dead', 'OOMKilled'))
                    and isinstance(state.get('FinishedAt'), str) and not state['FinishedAt'].startswith('0001-'))
        # This validates initialized files and the absent postmaster, without running initdb.
        TARGET.database_body(workspace, self.a)
        if preflight:
            require(not list((workspace.directory / 'socket').iterdir()))
        archive = self.runtime.bounded_output(['docker', '--context', self.context, 'container', 'cp',
            workers['migration-carrier']['id'] + ':/app/assets/migrations/.', '-'], 32 * 1024 ** 2, 30)
        files, auxiliary, graph = migration_bundle(archive)
        require(graph == self.approved['graph'] and self.approved['inventory'] == {
            'schema': 'orbis.core-executable-migration-inventory.v1',
            'files': {name: {'bytes': len(value), 'sha256': sha(value)} for name, value in sorted(files.items())}})
        with self.a.protected_directory(directory / 'migrations') as fd:
            require(set(os.listdir(fd)) == {name for name in files if '/' not in name} | {'meta'})
        with self.a.protected_directory(directory / 'migrations/meta') as fd:
            require(set(os.listdir(fd)) == {'_journal.json'})
        for name, body in files.items():
            self._initialized_file(record, 'migrations/' + name, body)
        self._initialized_file(record, 'migration-audit.json', self.P.canonical(auxiliary))
        carrier = supervisor.inspect('migration-carrier')
        require(self.runtime.never_started(carrier) and self.runtime.definition(carrier) == workers['migration-carrier']['definitionSha256'])
        paths = ['root-intent.json', 'migration-audit.json', 'target/pgdata/PG_VERSION']
        paths.extend('migrations/' + name for name in sorted(files))
        directories = {}
        for name in ('', 'input', 'output', 'migrations', 'migrations/meta'):
            with self.a.protected_directory(directory / name) as fd:
                directories[name] = TARGET.directory_identity(os.fstat(fd))
        proof = {'approvalSha256': self.digest(self.approved), 'sourceCatalogSha256': self.digest(self.approved['catalog']),
                 'rootIntentSha256': self.digest(intent), 'workspaceSha256': self.digest(record['workspace']),
                 'workersSha256': self.digest(workers), 'directories': directories,
                 'inputMode': stat.S_IMODE((directory / 'root-intent.json').lstat().st_mode),
                 'fileSeals': {name: list(self.a.seal((directory / name).lstat())) for name in paths}, **self.initialized_proof_fields(record)}
        require({stat.S_IMODE((directory / name).lstat().st_mode) for name in paths if name != 'target/pgdata/PG_VERSION'} == {proof['inputMode']})
        return workspace, proof, files

    def continue_initialized(self, identifier, actor, continuation_identifier):
        """Explicit one-shot pre-SQL continuation; no worker or migration replay."""
        with self.approval.guard():
            actor = self.validate(actor)
            require(isinstance(continuation_identifier, str) and TARGET.UUID.fullmatch(continuation_identifier))
            directory = self.directory(identifier)
            record = self.record(identifier)
            raw = self.enrollment.read(directory / 'job.json', 4 * 1024 ** 2)
            prior_seal = list(self.a.seal((directory / 'job.json').lstat()))
            require(raw == self.P.canonical(record))
            _, before_proof, _ = self._initialized_evidence(record, actor, preflight=True)
            # No intent, directory or failed-job mutation precedes this admission check.
            self.capacity(directory)
            workspace, proof, files = self._initialized_evidence(record, actor, preflight=True)
            self.require_initialized_recheck(before_proof, proof)
            require(self.enrollment.read(directory / 'job.json', 4 * 1024 ** 2) == raw
                    and list(self.a.seal((directory / 'job.json').lstat())) == prior_seal)
            base = directory / 'continuations'
            base.mkdir(mode=0o700)
            self.enrollment.sync(directory)
            attempt = base / continuation_identifier
            attempt.mkdir(mode=0o700)
            self.enrollment.sync(base)
            self.publish(attempt / 'prior-failure.json', raw)
            (attempt / 'migrations').mkdir(mode=0o700)
            (attempt / 'migrations/meta').mkdir(mode=0o700)
            for name, body in files.items():
                self.publish(attempt / 'migrations' / name, body)
            migration_path = 'continuations/' + continuation_identifier + '/migrations'
            intent = {'schema': self.continuation_schema, 'id': identifier,
                      'continuationId': continuation_identifier, 'actor': actor, 'priorFailureSha256': sha(raw),
                      'priorJobSeal': prior_seal, 'proof': proof, 'migrationPath': migration_path, **POLICIES, **self.continuation_fields()}
            self.publish(attempt / 'intent.json', self.P.canonical(intent))
            record['continuation'] = {'id': continuation_identifier, 'priorFailureSha256': sha(raw), 'migrationPath': migration_path,
                'intentSha256': self.digest(intent),
                'directorySeals': {name: list(self.a.seal(path.lstat())) for name, path in (('base', base), ('attempt', attempt), ('migrations', attempt / 'migrations'), ('meta', attempt / 'migrations/meta'))},
                'fileSeals': {name: list(self.a.seal((attempt / name).lstat())) for name in ['prior-failure.json', 'intent.json'] + ['migrations/' + name for name in sorted(self.approved['inventory']['files'])]}}
            record.pop('failureClass', None)
            record.pop('capacityFailure', None)
            try:
                self.phase(record, 'continuing-initialized')
                self._checked_continuation(record, actor)
                return self._post_initialize(record, actor, workspace, SUPERVISOR.InspectionSupervisor(self, record))
            except BaseException as error:
                record.update(phase='recovery-required', failureClass=type(error).__name__)
                if type(error) is BootstrapCapacityError:
                    record['capacityFailure'] = {'reason': error.reason, 'availableBytes': error.availableBytes,
                                                 'requiredBytes': error.requiredBytes}
                self.save(record)
                raise BootstrapError('Initialized database continuation requires protected recovery review') from None

    def _checked_continuation(self, record, actor):
        directory = self.directory(record['id'])
        if 'continuation' not in record:
            require(not os.path.lexists(directory / 'continuations'))
            return None
        binding = record['continuation']
        require(isinstance(binding, dict) and set(binding) == {'id', 'priorFailureSha256', 'intentSha256', 'directorySeals', 'fileSeals', 'migrationPath'}
                and isinstance(binding['id'], str) and TARGET.UUID.fullmatch(binding['id']))
        base, attempt = directory / 'continuations', directory / 'continuations' / binding['id']
        for path, expected in ((base, {binding['id']}), (attempt, {'prior-failure.json', 'intent.json', 'migrations'})):
            with self.a.protected_directory(path) as fd:
                require(set(os.listdir(fd)) == expected)
        require(binding['directorySeals'] == {name: list(self.a.seal(path.lstat())) for name, path in (('base', base), ('attempt', attempt), ('migrations', attempt / 'migrations'), ('meta', attempt / 'migrations/meta'))}
                and binding['fileSeals'] == {name: list(self.a.seal((attempt / name).lstat())) for name in ['prior-failure.json', 'intent.json'] + ['migrations/' + name for name in sorted(self.approved['inventory']['files'])]})
        prior_raw = self.read(attempt / 'prior-failure.json', 4 * 1024 ** 2)
        prior = self.P.metadata(prior_raw, byte_limit=4 * 1024 ** 2)
        require(prior_raw == self.P.canonical(prior) and sha(prior_raw) == binding['priorFailureSha256']
                and prior['id'] == record['id'] and prior['workspace'] == record['workspace']
                and all(record['inspectionWorkers'].get(role) == worker for role, worker in prior['inspectionWorkers'].items()))
        self.require_prior_initialized_record(record, prior)
        _, proof, _ = self._initialized_evidence(prior, actor, preflight=False)
        require(self.migration_directory(record) == attempt / 'migrations')
        self.verify_migrations(attempt / 'migrations')
        raw_intent = self.read(attempt / 'intent.json', 4 * 1024 ** 2)
        intent = self.P.metadata(raw_intent, byte_limit=4 * 1024 ** 2)
        require(isinstance(intent, dict) and set(intent) == {'schema', 'id', 'continuationId', 'actor', 'priorFailureSha256', 'priorJobSeal', 'proof', 'migrationPath'} | set(POLICIES) | set(self.continuation_fields())
                and type(intent['priorJobSeal']) is list and len(intent['priorJobSeal']) == 9
                and all(type(value) is int for value in intent['priorJobSeal'])
                and raw_intent == self.P.canonical(intent) and sha(raw_intent) == binding['intentSha256']
                and intent == {'schema': self.continuation_schema, 'id': record['id'],
                    'continuationId': binding['id'], 'actor': actor, 'priorFailureSha256': sha(prior_raw),
                    'priorJobSeal': intent['priorJobSeal'], 'proof': proof, 'migrationPath': binding['migrationPath'], **POLICIES, **self.continuation_fields()})
        return self.digest(binding)

    def _post_initialize(self, record, actor, workspace, supervisor):
        directory = self.directory(record['id'])
        for phase, role, factory in (
                ('starting-database', 'database', TARGET.database_body),
                ('creating-database', 'creation', TARGET.creation_body)):
            self.phase(record, phase)
            self.capacity(directory)
            supervisor.create_start(role, factory(workspace, self.a))
            if role == 'database':
                supervisor.socket_available(workspace.directory, workspace.profile)
            else:
                supervisor.wait(role, 60)
        self.phase(record, 'identifying-target')
        supervisor.create_start('observer', self.observer_body(workspace))
        supervisor.wait('observer', 60)
        observed = self.P.metadata(self.runtime.bounded_output([
            'docker', '--context', self.context, 'logs', record['inspectionWorkers']['observer']['id']], 65536, 10))
        target = self.observed_identity(observed, workspace.profile)
        self.publish(directory / 'target-identity.json', self.P.canonical(target))
        self.publish_observer_evidence(directory, observed, workspace.profile)
        request = self.bootstrap_request(record, workspace, target)
        authorization = self.bootstrap_authorization(request)
        for name, value in [('request.json', request), ('authorization.json', authorization),
                            ('migration-inventory.json', self.approved['inventory'])]:
            self.publish(directory / 'input' / name, self.P.canonical(value))
        record.update(request=request, authorization=authorization)
        self.phase(record, 'bootstrapping')
        self.validate(actor)
        self.capacity(directory)
        self.verify_inputs(directory, record)
        supervisor.create_start('bootstrap', self.bootstrap_body(workspace, directory))
        supervisor.wait('bootstrap', 330)
        self.outputs(directory, record)
        self.phase(record, 'stopping-owned-database')
        self.publish(directory / 'stop-intent.json', self.P.canonical({
            'schema': self.stop_intent_schema, 'id': record['id'],
            'requestSha256': self.digest(request), 'database': record['inspectionWorkers']['database']}))
        supervisor.stop_database()
        self.phase(record, 'terminal')
        return self._checked(record, actor, finalize=True)

    def bootstrap_request(self, record, workspace, target):
        return {'schema': 'orbis.core-clean-target-bootstrap-input.v' + str(self.worker_version),
                'id': record['id'], 'nonce': workspace.allocation['nonce'],
                'rootIntentSha256': workspace.allocation['rootIntentSha256'], 'target': target,
                'sourceControllerImageId': self.broker.trust.source_controller_image_id,
                'migrationInventorySha256': self.digest(self.approved['inventory']),
                'expectedCatalogSha256': self.approved['catalog']['catalogSha256'],
                'expectedMigrationLedgerSha256': self.ledger_hash(self.approved['catalog']['ledger']),
                'expectedMigrationLedger': self.approved['catalog']['ledger'], **POLICIES}

    def bootstrap_authorization(self, request):
        return {'schema': 'orbis.core-clean-target-bootstrap-authorization.v' + str(self.worker_version),
                'decision': 'approved', 'requestSha256': self.digest(request),
                **{k: v for k, v in request.items() if k != 'schema'}}

    def structure_major(self):
        return 17

    def observed_identity(self, value, profile):
        return self.identity(value, profile)

    def publish_observer_evidence(self, directory, value, profile):
        pass

    def verify_observer_evidence(self, directory, value, profile):
        pass

    def receipt_fields(self, record):
        return {}

    def ledger_hash(self, rows):
        return self.digest(sorted(rows, key=lambda row: self.P.canonical(row)))

    def verify_inputs(self, directory, record):
        request, authorization = record['request'], record['authorization']
        expected = {'request.json': request, 'authorization.json': authorization,
                    'migration-inventory.json': self.approved['inventory']}
        with self.a.protected_directory(directory / 'input') as fd:
            require(set(os.listdir(fd)) == set(expected))
        for name, value in expected.items():
            require(self.read(directory / 'input' / name, 1024 ** 2) == self.P.canonical(value))
        self.verify_migrations(self.migration_directory(record))

    def verify_migrations(self, directory):
        inventory = self.approved['inventory']['files']
        with self.a.protected_directory(directory) as fd:
            require(set(os.listdir(fd)) == {name for name in inventory if '/' not in name} | {'meta'})
        with self.a.protected_directory(directory / 'meta') as fd:
            require(set(os.listdir(fd)) == {'_journal.json'})
        for name, binding in inventory.items():
            value = self.read(directory / name, 4 * 1024 ** 2)
            require(binding == {'bytes': len(value), 'sha256': sha(value)})

    def outputs(self, directory, record):
        names = {'worker-start.json': 'start', 'migration-intent.json': 'migration-intent',
                 'ledger-intent.json': 'ledger-intent', 'migration-completion.json': 'migration-completion',
                 'sanitation-intent.json': 'sanitation-intent', 'result.json': 'result'}
        with self.a.protected_directory(directory / 'output') as fd:
            require(set(os.listdir(fd)) == set(names))
        raw = {name: self.read(directory / 'output' / name, 65536) for name in names}
        values = {name: self.P.metadata(body) for name, body in raw.items()}
        bound = {k: v for k, v in record['request'].items() if k not in {'schema', 'expectedMigrationLedger'}}
        bound.update(requestSha256=self.digest(record['request']), authorizationSha256=self.digest(record['authorization']))
        schemas = {'worker-start.json': 'orbis.core-clean-target-bootstrap-start.v' + str(self.worker_version),
                   'result.json': 'orbis.core-clean-target-bootstrap-result.v' + str(self.worker_version)}
        extra = {'worker-start.json': set(), 'migration-intent.json': {'serverBeforeSeconds'},
                 'ledger-intent.json': {'migrationIntentSha256', 'generatedLedgerSha256', 'ledgerRows'},
                 'migration-completion.json': {'migrationIntentSha256', 'serverBeforeSeconds', 'serverAfterSeconds',
                                               'migrationCommitAcknowledged', 'ledgerCommitAcknowledged', 'sanitationPending'},
                 'sanitation-intent.json': {'migrationIntentSha256', 'seedSha256', 'serverBeforeSeconds', 'serverAfterSeconds'},
                 'result.json': {'migrationIntentSha256', 'seedSha256', 'structure', 'ledgerCommitAcknowledged',
                                 'sanitationCommitAcknowledged', 'applicationTablesEmpty', 'serverQuiescenceProved'}}
        for name, value in values.items():
            schema = schemas.get(name, 'orbis.core-clean-target-' + names[name] + '.v' + str(self.worker_version))
            require(isinstance(value, dict) and set(value) == {'schema'} | set(bound) | extra[name]
                    and raw[name] == self.P.canonical(value) and value.get('schema') == schema
                    and all(self.P.canonical(value.get(k)) == self.P.canonical(v) for k, v in bound.items()))
            if name not in {'worker-start.json', 'migration-intent.json'}:
                require(value.get('migrationIntentSha256') == sha(raw['migration-intent.json']))
        report = values['result.json']
        structure = report.get('structure')
        require(isinstance(structure, dict) and set(structure) == {'schema', 'sha256', 'major', 'catalogSha256', 'rows', 'authenticationVerified', 'restoreAuthority'}
                and structure['schema'] == 'orbis.core-database-structure.v1' and type(structure['major']) is int and structure['major'] == self.structure_major()
                and isinstance(structure['sha256'], str) and HEX.fullmatch(structure['sha256'])
                and structure['catalogSha256'] == bound['expectedCatalogSha256']
                and structure['authenticationVerified'] is False and structure['restoreAuthority'] is False
                and isinstance(structure['rows'], dict) and all(type(value) is int for value in structure['rows'].values())
                and structure['rows'] == {'user': 0, 'link': 0, 'app_store': 0, 'app': 0,
                                         'orbis_reset_receipt': 0, '__drizzle_migrations': len(record['request']['expectedMigrationLedger'])}
                and report.get('applicationTablesEmpty') is True and report.get('ledgerCommitAcknowledged') is True
                and report.get('sanitationCommitAcknowledged') is True and report.get('serverQuiescenceProved') is False)
        before, after = values['migration-intent.json'].get('serverBeforeSeconds'), values['migration-completion.json'].get('serverAfterSeconds')
        require(type(before) is int and type(after) is int and 0 < before <= after <= 9007199254740991)
        generated = [{'id': i + 1, **row} for i, row in enumerate(self.approved['graph'])]
        require(values['ledger-intent.json'].get('generatedLedgerSha256') == self.ledger_hash(generated)
                and type(values['ledger-intent.json'].get('ledgerRows')) is int
                and values['ledger-intent.json'].get('ledgerRows') == len(generated)
                and values['migration-completion.json'].get('serverBeforeSeconds') == before
                and values['migration-completion.json'].get('migrationCommitAcknowledged') is True
                and values['migration-completion.json'].get('ledgerCommitAcknowledged') is True
                and values['migration-completion.json'].get('sanitationPending') is True
                and values['sanitation-intent.json'].get('serverBeforeSeconds') == before
                and values['sanitation-intent.json'].get('serverAfterSeconds') == after
                and isinstance(report.get('seedSha256'), str) and HEX.fullmatch(report['seedSha256'])
                and values['sanitation-intent.json'].get('seedSha256') == report['seedSha256'])
        return {name: sha(value) for name, value in raw.items()}

    def checked(self, prepared, actor):
        require(type(prepared) is PreparedCleanTarget)
        with self.approval.guard():
            result = self._checked(self.record(prepared.identifier), actor, finalize=False)
            require(result == prepared)
            return result

    def _checked(self, record, actor, finalize):
        actor = self.validate(actor)
        require(record['actor'] == actor and record['phase'] == ('terminal' if finalize else 'complete')
                and record['approvalSha256'] == self.digest(self.approved)
                and all(record.get(k) == v for k, v in POLICIES.items()))
        directory = self.directory(record['id'])
        continuation_sha = self._checked_continuation(record, actor)
        request = record['request']
        self.identity(request['target'], self.approved['profile'])
        intent = {'schema': self.root_intent_schema, 'id': record['id'], 'nonce': request['nonce'],
                  'approval': self.approved, 'actor': actor, **POLICIES}
        if continuation_sha is None:
            require(self.read(directory / 'root-intent.json', 2 * 1024 ** 2) == self.P.canonical(intent))
        allocation = record['workspace']['allocation']
        expected_allocation = {'schema': 'orbis.core-clean-target-allocation.v1', 'id': record['id'], 'nonce': request['nonce'],
                               'rootIntentSha256': self.digest(intent), 'profile': self.approved['profile'],
                               'scope': 'prepare-clean-target-only', 'activation': False, 'environmentProved': False, 'restoreAuthority': False}
        require(allocation == expected_allocation)
        workspace = TARGET.TargetWorkspace(directory / 'target', self.approved['profile'], allocation, record['workspace']['identities'])
        TARGET.verify_workspace(workspace, self.a)
        expected_request = self.bootstrap_request(record, workspace, request['target'])
        require(TARGET.UUID.fullmatch(request['nonce']) and request == expected_request)
        authorization = self.bootstrap_authorization(request)
        require(record['authorization'] == authorization)
        self.verify_inputs(directory, record)
        outputs = self.outputs(directory, record)
        workers = record['inspectionWorkers']
        require(set(workers) == {'migration-carrier', 'initialize', 'database', 'creation', 'observer', 'bootstrap'})
        initialize = self.initialized_body(workspace)
        bodies = {'migration-carrier': self.carrier_body(workspace), 'initialize': initialize,
                  'database': TARGET.database_body(workspace, self.a), 'creation': TARGET.creation_body(workspace, self.a),
                  'observer': self.observer_body(workspace), 'bootstrap': self.bootstrap_body(workspace, directory)}
        supervisor = SUPERVISOR.InspectionSupervisor(self, record)
        for role, worker in workers.items():
            require(worker['body'] == bodies[role])
            raw = supervisor.inspect(role)
            require(self.runtime.definition(raw) == worker['definitionSha256'])
            if role == 'migration-carrier':
                require(worker['intent'] == 'created-never-start' and self.runtime.never_started(raw))
                continue
            state, terminal = raw.get('State') or {}, worker.get('terminal') or {}
            require(worker['intent'] == 'complete' and terminal.get('id') == worker['id']
                    and terminal.get('definitionSha256') == worker['definitionSha256'] and terminal.get('state') == state
                    and state.get('Status') == 'exited' and state.get('Running') is False
                    and state.get('Restarting') is False and state.get('Dead') is False and state.get('OOMKilled') is False
                    and state.get('ExitCode') == 0 and isinstance(state.get('FinishedAt'), str)
                    and not state['FinishedAt'].startswith('0001-'))
        observed = self.P.metadata(self.runtime.bounded_output([
            'docker', '--context', self.context, 'logs', workers['observer']['id']], 65536, 10))
        observed_target = self.observed_identity(observed, self.approved['profile'])
        require(observed_target == request['target']
                and self.read(directory / 'target-identity.json', 65536) == self.P.canonical(observed_target))
        self.verify_observer_evidence(directory, observed, self.approved['profile'])
        stopped = copy.deepcopy(workers['database'])
        stopped.pop('terminal', None)
        stopped['intent'] = 'running'
        stop_intent = {'schema': self.stop_intent_schema, 'id': record['id'],
                       'requestSha256': self.digest(request), 'database': stopped}
        require(self.read(directory / 'stop-intent.json', 65536) == self.P.canonical(stop_intent))
        self.namespace_bounds(directory)
        receipt = {'schema': self.receipt_schema, 'id': record['id'],
                   'approvalSha256': self.digest(self.approved), 'requestSha256': self.digest(request),
                   'authorizationSha256': self.digest(authorization), 'target': request['target'],
                   'outputs': outputs, 'workersSha256': self.digest(workers), 'ownedDatabaseStopped': True,
                   'targetState': 'empty-migrated-target', **POLICIES, **self.receipt_fields(record)}
        if continuation_sha is not None:
            receipt['continuationSha256'] = continuation_sha
        receipt_sha = self.digest(receipt)
        if finalize:
            self.publish(directory / 'receipt.json', self.P.canonical(receipt))
            record.update(phase='complete', receiptSha256=receipt_sha)
            self.save(record)
        else:
            require(record.get('receiptSha256') == receipt_sha
                    and self.read(directory / 'receipt.json', 65536) == self.P.canonical(receipt))
        return PreparedCleanTarget(record['id'], receipt_sha)

    def namespace_bounds(self, directory):
        total, count = 0, 0
        for parent, dirs, files in os.walk(directory, followlinks=False):
            for name in dirs + files:
                details = (Path(parent) / name).lstat()
                count += 1
                require(count <= 100000 and not stat.S_ISLNK(details.st_mode))
                if stat.S_ISREG(details.st_mode):
                    require(details.st_nlink == 1)
                    total += details.st_size
                    require(total <= 1024 ** 3)
                else:
                    require(stat.S_ISDIR(details.st_mode))


class CoreVersionedCleanTargetBootstrap(CoreCleanTargetBootstrap):
    """Explicit same-profile preparation; prior jobs retain their original protocol."""
    schema = 'orbis.core-clean-target-bootstrap-job.v2'
    inspection_schema = 'orbis.core-restore-inspection.v4'
    worker_version = 2
    root_intent_schema = 'orbis.core-clean-target-root-intent.v2'
    stop_intent_schema = 'orbis.core-clean-target-owned-stop-intent.v2'
    receipt_schema = 'orbis.core-clean-target-bootstrap-receipt.v2'
    continuation_schema = 'orbis.core-clean-target-initialized-continuation.v2'

    def validate(self, actor):
        TARGET.require_root()
        require(self.a.OWNER == 0)
        actor = self.enrollment.actor(actor)
        require(self.broker.binding() == self.approved['configuration'])
        profile = TARGET.validate_profile(self.approved['profile'])
        require(profile['schema'] == TARGET.BOUNDED_SCHEMA)
        trust = self.broker.trust
        require(trust.architecture == profile['architecture']
                and IMAGE.fullmatch(trust.image_id) and IMAGE.fullmatch(trust.source_controller_image_id)
                and 'core-clean-target-bootstrap-worker.mjs' in trust.inventory)
        self.broker.image()
        require(TARGET.bounded_clean_target_profile(self.runtime.image(profile['imageId']), profile['role'], profile['database'], profile['locale']) == profile)
        image = self.runtime.image(trust.source_controller_image_id)
        require(image.get('Id') == trust.source_controller_image_id and image.get('Os') == 'linux'
                and image.get('Architecture') == profile['architecture'] and (image.get('Config') or {}).get('Volumes') in (None, {}))
        catalog = self.approved['catalog']
        require(self.approval.catalog_reader() == catalog and isinstance(catalog, dict)
                and set(catalog) == {'schema', 'actor', 'sourceWitnessSha256', 'sourceManifestSha256',
                    'sourceControllerImageId', 'catalogSha256', 'systemIdentifier', 'ledger',
                    'authenticationVerified', 'authorityScope', 'environmentProved', 'restoreAuthority',
                    'executionProfile', 'databaseExecution'}
                and catalog['schema'] == 'orbis.core-root-authenticated-bootstrap-source.v2'
                and catalog['actor'] == actor and catalog['authenticationVerified'] is True
                and catalog['authorityScope'] == 'authenticated-source-catalog-and-ledger'
                and catalog['environmentProved'] is False and catalog['restoreAuthority'] is False
                and catalog['sourceControllerImageId'] == trust.source_controller_image_id
                and all(isinstance(catalog[k], str) and HEX.fullmatch(catalog[k]) for k in
                    ('sourceWitnessSha256', 'sourceManifestSha256', 'catalogSha256'))
                and self.number(catalog['systemIdentifier'], 18446744073709551615))
        source = TARGET.SOURCE.validate_profile(catalog['executionProfile'])
        require(source['schema'] == TARGET.SOURCE.EXECUTION_SCHEMA
                and all(source[key] == profile[key] for key in TARGET.SOURCE.PG.BASE_FIELDS))
        require(isinstance(catalog['databaseExecution'], dict)
                and isinstance(catalog['databaseExecution'].get('database'), str)
                and TARGET.SOURCE.NAME.fullmatch(catalog['databaseExecution']['database']))
        observation = SUPERVISOR.validate_database_execution(source,
            {'database': catalog['databaseExecution']['database']}, catalog['databaseExecution'])
        require(observation['locale'] == profile['locale'])
        validate_ledger(catalog['ledger'], self.approved['graph'])
        return actor

    def initialized_body(self, workspace):
        profile, locale = workspace.profile, workspace.profile['locale']
        return TARGET.body(workspace, 'initialize', TARGET.binary_for(profile, 'initdb'), [
            '--pgdata=/var/lib/postgresql/data', '--username=' + profile['role'], '--encoding=' + locale['encoding'],
            *TARGET.locale_provider_options(profile), '--lc-collate=' + locale['collate'], '--lc-ctype=' + locale['ctype'],
            '--auth-local=reject', '--auth-host=reject', '--no-instructions'], [
                TARGET.SOURCE.mount(workspace.directory / 'pgdata', '/var/lib/postgresql/data', False)])

    def observer_body(self, workspace):
        profile = workspace.profile
        # PG14 database locales use libc; this policy does not claim a catalog provider column.
        query = IDENTITY_SQL.replace('d.datlocprovider', "'c'::text") if profile['major'] == 14 else IDENTITY_SQL
        label = 'postgresql14-libc-database-default' if profile['major'] == 14 else 'pg_database.datlocprovider'
        query = query.replace(" 'locale',", " 'serverVersionNum',pg_catalog.current_setting('server_version_num')::pg_catalog.int4,"
            + "'localeProviderEvidence','" + label + "','locale',", 1)
        body = TARGET.body(workspace, 'observer', TARGET.binary_for(profile, 'psql'), [
            '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '--no-password', '--host=/var/run/postgresql',
            '--username=' + profile['role'], '--dbname=' + profile['database'], '--command', query], [
                TARGET.SOURCE.mount(workspace.directory / 'socket', '/var/run/postgresql', True),
                TARGET.SOURCE.mount(workspace.directory / 'pgdata', '/var/lib/postgresql/data', True)])
        body['Env'] = ['PGCONNECT_TIMEOUT=10', 'PGOPTIONS=-c default_transaction_read_only=on -c search_path=pg_catalog -c statement_timeout=15000']
        return body

    def bootstrap_request(self, record, workspace, target):
        return {**super().bootstrap_request(record, workspace, target), 'executionProfile': self.approved['profile']['profileId']}

    def structure_major(self):
        return self.approved['profile']['major']

    def observer_execution(self, value, profile):
        fields = {'systemIdentifier', 'databaseOid', 'database', 'role', 'locale', 'serverVersionNum', 'localeProviderEvidence'}
        require(isinstance(value, dict) and set(value) == fields)
        source = self.approved['catalog']['executionProfile']
        observation = {'schema': 'orbis.core-pg-execution-observation.v1', 'profileId': profile['profileId'],
            'serverVersionNum': value['serverVersionNum'], 'major': profile['major'], 'database': value['database'],
            'locale': value['locale'], 'localeProviderEvidence': value['localeProviderEvidence']}
        return SUPERVISOR.validate_database_execution(source, {'database': profile['database']}, observation)

    def observed_identity(self, value, profile):
        self.observer_execution(value, profile)
        return self.identity({key: item for key, item in value.items() if key not in {'serverVersionNum', 'localeProviderEvidence'}}, profile)

    def publish_observer_evidence(self, directory, value, profile):
        self.publish(directory / 'target-execution.json', self.P.canonical(self.observer_execution(value, profile)))

    def verify_observer_evidence(self, directory, value, profile):
        require(self.read(directory / 'target-execution.json', 65536) == self.P.canonical(self.observer_execution(value, profile)))

    def receipt_fields(self, record):
        return {'executionProfile': self.approved['profile']['profileId'],
                'targetExecutionSha256': sha(self.read(self.directory(record['id']) / 'target-execution.json', 65536))}

    def initialized_record_fields(self):
        return {'initializedCustody'}

    def validate_initialized_child(self, record, child, details):
        require(child in {'pgdata', 'config'})
        profile = self.approved['profile']
        uid, mode = (profile['uid'], 0o700) if child == 'pgdata' else (0, 0o550)
        require(stat.S_ISDIR(details.st_mode) and details.st_uid == uid and details.st_gid == profile['gid']
                and stat.S_IMODE(details.st_mode) == mode
                and TARGET.directory_identity(details) == record['workspace']['identities'][child])

    def initialized_file_seals(self, record):
        directory = self.directory(record['id'])
        result = {}
        def capture(parent, name, key, mode, maximum, root_owned):
            before = os.stat(name, dir_fd=parent, follow_symlinks=False)
            require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
                    and stat.S_IMODE(before.st_mode) == mode
                    and (not root_owned or before.st_uid == os.geteuid()))
            TARGET.SOURCE.regular_digest(parent, name, self.a, maximum)
            require(self.a.seal(before) == self.a.seal(os.stat(name, dir_fd=parent, follow_symlinks=False)))
            result[key] = list(self.a.seal(before))
        names = ['root-intent.json', 'migration-audit.json']
        names.extend('migrations/' + name for name in sorted(self.approved['inventory']['files']))
        for name in names:
            path = directory / name
            with self.a.protected_directory(path.parent) as parent:
                capture(parent, path.name, name, 0o400, 4 * 1024 ** 2, True)
        workspace = directory / 'target'
        with self.a.protected_directory(workspace) as parent:
            require(TARGET.directory_identity(os.fstat(parent)) == record['workspace']['identities'][''])
            capture(parent, 'allocation.json', 'target/allocation.json', 0o400, 32768, True)
            for child in ('pgdata', 'config'):
                before = os.stat(child, dir_fd=parent, follow_symlinks=False)
                descriptor = os.open(child, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
                try:
                    self.validate_initialized_child(record, child, before)
                    self.validate_initialized_child(record, child, os.fstat(descriptor))
                    names = sorted(os.listdir(descriptor))
                    expected = {'PG_VERSION': 3, 'postgresql.auto.conf': 4096} if child == 'pgdata' else {
                        name: 32768 for name in TARGET.config_for(self.approved['profile'])}
                    require(set(expected) <= set(names) and (child == 'pgdata' or set(expected) == set(names)))
                    for name, maximum in expected.items():
                        capture(descriptor, name, 'target/' + child + '/' + name,
                                0o600 if child == 'pgdata' else 0o440, maximum, child == 'config')
                    self.validate_initialized_child(record, child, os.fstat(descriptor))
                    self.validate_initialized_child(record, child, os.stat(child, dir_fd=parent, follow_symlinks=False))
                    require(sorted(os.listdir(descriptor)) == names and self.a.seal(before) == self.a.seal(os.fstat(descriptor)))
                finally:
                    os.close(descriptor)
            require(TARGET.directory_identity(os.fstat(parent)) == record['workspace']['identities'][''])
        return result

    def capture_initialized_custody(self, record, actor, workspace):
        require(record['schema'] == self.schema and 'initializedCustody' not in record
                and record['phase'] == 'initializing'
                and set(record['inspectionWorkers']) == {'migration-carrier', 'initialize'})
        self.validate(actor)
        TARGET.verify_workspace(workspace, self.a)
        TARGET.database_body(workspace, self.a)
        self.verify_migrations(self.directory(record['id']) / 'migrations')
        seals = self.initialized_file_seals(record)
        custody = {'schema': 'orbis.core-clean-target-initialized-custody.v2',
            'executionProfile': self.approved['profile']['profileId'], 'profile': copy.deepcopy(self.approved['profile']),
            'approvalSha256': self.digest(self.approved), 'workspaceSha256': self.digest(record['workspace']),
            'initialWorkersSha256': self.digest(record['inspectionWorkers']), 'fileSeals': seals}
        require(seals == self.initialized_file_seals(record))
        candidate = copy.deepcopy(record)
        candidate['initializedCustody'] = custody
        self.save(candidate)
        record['initializedCustody'] = custody

    def verify_initialized_custody(self, record):
        custody = record.get('initializedCustody')
        require(isinstance(custody, dict) and set(custody) == {'schema', 'executionProfile', 'profile',
            'approvalSha256', 'workspaceSha256', 'initialWorkersSha256', 'fileSeals'}
            and custody['schema'] == 'orbis.core-clean-target-initialized-custody.v2'
            and custody['executionProfile'] == self.approved['profile']['profileId']
            and TARGET.validate_profile(custody['profile']) == self.approved['profile']
            and custody['approvalSha256'] == self.digest(self.approved)
            and custody['workspaceSha256'] == self.digest(record['workspace'])
            and custody['initialWorkersSha256'] == self.digest(record['inspectionWorkers'])
            and isinstance(custody['fileSeals'], dict)
            and all(type(seal) is list and len(seal) == 9 and all(type(value) is int for value in seal)
                    for seal in custody['fileSeals'].values())
            and custody['fileSeals'] == self.initialized_file_seals(record))

    def initialized_proof_fields(self, record):
        return {'initializedCustodySha256': self.digest(record['initializedCustody']),
                'executionProfile': self.approved['profile']['profileId']}

    def require_initialized_recheck(self, before, after):
        require(before == after)

    def require_prior_initialized_record(self, record, prior):
        require(record.get('initializedCustody') == prior.get('initializedCustody'))

    def continuation_fields(self):
        return {'executionProfile': self.approved['profile']['profileId']}

    def _initialized_file(self, record, relative, expected):
        # Historical0600 evidence belongs only to the original schema1 continuation contract.
        allowed = {'root-intent.json', 'migration-audit.json'} | {'migrations/' + name for name in self.approved['inventory']['files']}
        require(record.get('schema') == self.schema and relative in allowed
                and type(expected) is bytes and 0 < len(expected) <= 4 * 1024 ** 2)
        require(self.read(self.directory(record['id']) / relative, 4 * 1024 ** 2) == expected)
        return expected
