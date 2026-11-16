"""Root-owned core-derived logical import; never a live activation endpoint.

The source is an actually checked, stopped isolated reconciliation target. Its
saved destination provenance remains explicit. This stage changes only its own
new marked database; the original database/configuration are never promoted.
"""
import copy
from dataclasses import dataclass
import hashlib
import ipaddress
import os
from pathlib import Path
import re
import stat
import time
import uuid


SCHEMA = 'orbis.core-derived-logical-stage.v1'
BINDING = 'orbis.core-imported-database-binding.v1'
VERIFIED = 'orbis.core-imported-database-verification.v1'
FLAGS = {'scope': 'core-derived-logical-stage-only', 'activation': False, 'restoreAuthority': False,
         'environmentProved': False, 'sourceWrites': False, 'liveDestinationProved': False,
         'destinationEvidence': 'saved-capture-only'}
LIMIT = 64 * 1024 ** 3
HEX = re.compile(r'[a-f0-9]{64}')
NAME = re.compile(r'[A-Za-z_][A-Za-z0-9_]{0,62}')


def require(value):
    if not value:
        raise ValueError('Core logical staging requires protected review. Original data was preserved.')


def quote(value):
    require(isinstance(value, str) and NAME.fullmatch(value))
    return '"' + value + '"'


def literal(value):
    require(isinstance(value, str) and '\0' not in value and len(value) <= 512)
    return "'" + value.replace("'", "''") + "'"


@dataclass(frozen=True)
class ImportedCoreStage:
    identifier: str
    stage_sha256: str
    receipt_sha256: str


class CoreDerivedLogicalStage:
    def __init__(self, service):
        self.service = service
        self.review = service.core_restoration_reviews()
        self.V = service.core_restoration_review_module
        require(type(self.review) is self.V.CoreRestorationReview and self.review.service is service)
        self.runtime = self.review._graph()
        self.enrollment, self.P = self.review.enrollment, self.review.P
        self.C = self.review.C
        self.TARGET, self.SOURCE = self.C.R.TARGET, self.C.R.SOURCE

    def digest(self, value):
        return hashlib.sha256(self.P.canonical(value)).hexdigest()

    def _directory(self, identifier):
        self.review.reconciliations._identifier(identifier)
        return Path(self.enrollment.state) / 'core-derived-logical-stages' / identifier

    def read(self, identifier):
        body = self.enrollment.read(self._directory(identifier) / 'stage.json', 4 * 1024 ** 2)
        value = self.P.metadata(body, byte_limit=4 * 1024 ** 2, string_limit=2 * 1024 ** 2)
        require(body == self.P.canonical(value) and value.get('schema') == SCHEMA and value.get('id') == identifier
                and value.get('root') == str(self.enrollment.root) and value.get('context') == self.enrollment.context
                and all(type(value.get(key)) is type(expected) and value.get(key) == expected for key, expected in FLAGS.items()))
        return value

    def save(self, record):
        self.enrollment.a.atomic(self._directory(record['id']) / 'stage.json', self.P.canonical(record))

    def _require_no_unfinished(self):
        base = Path(self.enrollment.state) / 'core-derived-logical-stages'
        if not base.exists() and not base.is_symlink():
            return
        with self.enrollment.a.protected_directory(base):
            names = os.listdir(base)
        require(len(names) < 256)
        for identifier in names:
            self.review.reconciliations._identifier(identifier)
            prior = self.read(identifier)
            require(prior['phase'] == 'staged')
            receipt = self.enrollment.read(self._directory(identifier) / 'verification-receipt.json', 65536)
            require(hashlib.sha256(receipt).hexdigest() == prior['verificationSha256'])
            for role, worker in prior['workers'].items():
                raw = self._worker(prior, role)
                require(worker.get('intent') == 'complete' and worker.get('terminal') == raw.get('State')
                        and raw['State'].get('Status') == 'exited' and raw['State'].get('Running') is False)

    def _sql(self, record, query):
        database = self._current_database(record)
        body = self.runtime.bounded_output(['docker', '--context', self.enrollment.context, 'exec', database['Id'],
            self.SOURCE.PG.binary_for(record['currentProfile'], 'psql'), '-X', '-v', 'ON_ERROR_STOP=1',
            '--username', record['databaseRole'], '--dbname', 'postgres', '-Atqc', query], 65536, 30)
        require(len(body) <= 65536)
        return self.P.metadata(body.strip(), byte_limit=65536)

    def _current_database(self, record):
        raw = self.runtime.inspect(record['currentDatabase']['id'])
        require(raw['Id'] == record['currentDatabase']['id'] and self.runtime.definition(raw) == record['currentDatabase']['definition']
                and raw['State'].get('Running') is True and not raw['State'].get('Restarting') and not raw['State'].get('Paused')
                and raw['State'].get('StartedAt') == record['currentDatabase']['startedAt'])
        return raw

    def _facts(self, record):
        value = self._sql(record, "SELECT json_build_object('systemIdentifier',(pg_control_system()).system_identifier::text,"
            "'role',current_user,'serverVersionNum',current_setting('server_version_num')::int,"
            "'postmasterEpochUs',(extract(epoch from pg_postmaster_start_time())*1000000)::bigint)")
        require(self.P.exact(value, {'systemIdentifier', 'role', 'serverVersionNum', 'postmasterEpochUs'})
                and isinstance(value['systemIdentifier'], str) and re.fullmatch(r'[1-9][0-9]{0,19}', value['systemIdentifier'])
                and value['role'] == record['databaseRole'] and type(value['serverVersionNum']) is int
                and value['serverVersionNum'] // 10000 == record['currentProfile']['major']
                and type(value['postmasterEpochUs']) is int and value['postmasterEpochUs'] > 0)
        return value

    def _database_identity(self, record):
        name = record['databaseName']
        provider = 'datlocprovider' if record['currentProfile']['major'] >= 15 else "'c'"
        result = self._sql(record, "SELECT json_build_object('value',(SELECT json_build_object('databaseOid',oid::bigint,'database',datname,"
            "'owner',pg_get_userbyid(datdba),'marker',pg_catalog.shobj_description(oid,'pg_database'),'allowConnections',datallowconn,"
            "'locale',json_build_object('encoding',pg_encoding_to_char(encoding),'collate',datcollate,'ctype',datctype,'provider'," + provider + ")) "
            "FROM pg_database WHERE datname=" + literal(name) + "))")
        require(self.P.exact(result, {'value'}))
        value = result['value']
        if value is not None:
            require(self.P.exact(value, {'databaseOid', 'database', 'owner', 'marker', 'allowConnections', 'locale'})
                    and type(value['databaseOid']) is int and 0 < value['databaseOid'] < 2 ** 32
                    and value['database'] == name and value['owner'] == record['databaseRole']
                    and type(value['allowConnections']) is bool and value['locale'] == record['targetProfile']['locale'])
        return value

    def _owned_database(self, record):
        require(self._facts(record) == record['server'])
        value = self._database_identity(record)
        require(value is not None and value == record['databaseIdentity'] and value['marker'] == record['databaseMarker'])
        return value

    def _worker(self, record, role):
        worker = record['workers'][role]
        require(isinstance(worker.get('id'), str) and HEX.fullmatch(worker['id']))
        raw = self.runtime.inspect(worker['id'])
        self.runtime.check_intent(raw, worker['body'])
        require(raw['Id'] == worker['id'] and raw['Name'] == '/' + worker['name'] and raw['Image'] == worker['body']['Image']
                and (worker.get('definition') is None or self.runtime.definition(raw) == worker['definition']))
        if role in {'import', 'verify-imported'}:
            endpoint = raw.get('NetworkSettings', {}).get('Networks', {}).get(record['network']['name']) or {}
            require(endpoint.get('NetworkID') == record['network']['id'])
        return raw

    def _start(self, record, role, body):
        require(role not in record['workers'])
        name = 'orbis-core-logical-' + record['id'] + '-' + role
        record['workers'][role] = {'name': name, 'body': copy.deepcopy(body), 'intent': 'creating'}
        self.save(record)
        value = self.P.metadata(self.runtime.engine('POST', '/containers/create?name=' + name, body))
        require(isinstance(value.get('Id'), str) and HEX.fullmatch(value['Id']))
        worker = record['workers'][role]
        worker.update(id=value['Id'], intent='created')
        self.save(record)
        raw = self._worker(record, role)
        require(self.runtime.never_started(raw))
        worker.update(definition=self.runtime.definition(raw), intent='starting')
        self.save(record)
        self.runtime.change(['start', worker['id']])
        worker['intent'] = 'running'
        self.save(record)

    def _wait(self, record, role, timeout):
        worker = record['workers'][role]
        worker['intent'] = 'waiting'
        self.save(record)
        code = self.runtime.bounded_output(['docker', '--context', self.enrollment.context, 'wait', worker['id']], 32, timeout)
        raw = self._worker(record, role)
        state = raw.get('State') or {}
        require(code.strip() == b'0' and state.get('Status') == 'exited' and type(state.get('ExitCode')) is int
                and state['ExitCode'] == 0 and isinstance(state.get('FinishedAt'), str) and not state['FinishedAt'].startswith('0001-')
                and all(state.get(key) is False for key in ('Running', 'Restarting', 'Paused', 'Dead', 'OOMKilled')))
        worker.update(intent='complete', terminal=copy.deepcopy(state))
        self.save(record)

    def _stop_database(self, record):
        worker = record['workers'].get('database')
        if worker is None or 'id' not in worker:
            return
        raw = self._worker(record, 'database')
        worker['intent'] = 'stopping'
        self.save(record)
        if raw['State'].get('Running'):
            self.runtime.change(['stop', '--time', '30', worker['id']])
        self._wait(record, 'database', 45)

    def _body(self, record, role, image, entrypoint, args, mounts, *, network='none', environment=()):
        body = {'Image': image, 'User': '0:0', 'Entrypoint': [entrypoint], 'Cmd': args, 'Env': list(environment),
            'WorkingDir': '/', 'Healthcheck': {'Test': ['NONE']},
            'Labels': {'io.orbis.core-logical': record['id'], 'io.orbis.core-logical.nonce': record['nonce'],
                       'io.orbis.core-logical.role': role},
            'HostConfig': self.SOURCE.host({'pids': 64, 'memory': 512 * 1024 ** 2})}
        body['HostConfig']['NetworkMode'] = network if network == 'none' else record['network']['id']
        body['HostConfig']['Mounts'] = list(mounts)
        if role in {'dump', 'import'}:
            # PostgreSQL images declare this volume even for client tools. Mask it
            # so Docker cannot allocate untracked writable anonymous storage.
            body['HostConfig']['Mounts'].append(self.SOURCE.mount(
                self._directory(record['id']) / 'tool-data', '/var/lib/postgresql/data', True))
        body['NetworkingConfig'] = {'EndpointsConfig': {network: {}}}
        return body

    def _seal_dump(self, path):
        with self.enrollment.a.protected_directory(path.parent) as parent:
            with self.enrollment.a.protected_file(parent, path.name, LIMIT, digest_only=True) as digest:
                info = path.lstat()
                require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size > 5)
                descriptor = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                try:
                    require(self.enrollment.a.seal(info) == self.enrollment.a.seal(os.fstat(descriptor))
                            and os.read(descriptor, 5) == b'PGDMP'
                            and self.enrollment.a.seal(info) == self.enrollment.a.seal(os.fstat(descriptor)))
                finally:
                    os.close(descriptor)
                return {'bytes': info.st_size, 'sha256': digest.removeprefix('sha256:')}

    def _export(self, record):
        directory = self._directory(record['id'])
        target = Path(record['targetDirectory'])
        profile = record['targetProfile']
        body = self.TARGET.database_body(self.TARGET.TargetWorkspace(target, profile, record['workspace']['allocation'],
            record['workspace']['identities']), self.enrollment.a)
        self._start(record, 'database', body)
        try:
            deadline = time.monotonic() + 20
            while True:
                raw = self._worker(record, 'database')
                require(raw['State'].get('Running') is True and not raw['State'].get('Restarting'))
                socket = target / 'socket/.s.PGSQL.5432'
                if socket.exists():
                    details = socket.lstat()
                    require(stat.S_ISSOCK(details.st_mode) and details.st_uid == profile['uid'])
                    break
                require(time.monotonic() < deadline)
                time.sleep(0.1)
            mounts = [self.SOURCE.mount(target / 'socket', '/var/run/postgresql', True),
                      self.SOURCE.mount(directory / 'dump', '/core-dump', False)]
            require(not (directory / 'dump/target.dump').exists() and not (directory / 'dump/target.dump').is_symlink())
            dump_body = self._body(record, 'dump', profile['imageId'],
                self.SOURCE.PG.binary_for(profile, 'pg_dump'), ['--host=/var/run/postgresql', '--username=' + profile['role'],
                '--dbname=' + profile['database'], '--format=custom', '--no-owner', '--no-privileges', '--file=/core-dump/target.dump'], mounts)
            dump_body['User'] = '0:' + str(profile['gid'])
            self._start(record, 'dump', dump_body)
            self._wait(record, 'dump', 1200)
            require(set(os.listdir(directory / 'dump')) == {'target.dump'})
            record['dump'] = self._seal_dump(directory / 'dump/target.dump')
            self.enrollment.sync(directory / 'dump')
            self.save(record)
        finally:
            self._stop_database(record)

    def _create_database(self, record):
        require(self._facts(record) == record['server'] and self._database_identity(record) is None)
        record['phase'] = 'creating-database'
        self.save(record)
        locale = record['targetProfile']['locale']
        require(locale['provider'] == 'c')
        self._sql_command(record, 'CREATE DATABASE ' + quote(record['databaseName']) + ' WITH OWNER ' + quote(record['databaseRole'])
            + ' TEMPLATE template0 ENCODING ' + literal(locale['encoding']) + ' LC_COLLATE ' + literal(locale['collate'])
            + ' LC_CTYPE ' + literal(locale['ctype'])
            + (' LOCALE_PROVIDER libc' if record['currentProfile']['major'] >= 15 else ''))
        identity = self._database_identity(record)
        require(identity is not None and identity['marker'] is None and identity['allowConnections'] is True)
        record.update(databaseIdentity=identity, phase='marking-database')
        self.save(record)
        self._sql_command(record, 'COMMENT ON DATABASE ' + quote(record['databaseName']) + ' IS ' + literal(record['databaseMarker']))
        expected = {**identity, 'marker': record['databaseMarker']}
        require(self._database_identity(record) == expected)
        record['databaseIdentity'] = expected
        self.save(record)

    def _sql_command(self, record, query):
        current = self._current_database(record)
        self.runtime.bounded_output(['docker', '--context', self.enrollment.context, 'exec', current['Id'],
            self.SOURCE.PG.binary_for(record['currentProfile'], 'psql'), '-X', '-v', 'ON_ERROR_STOP=1',
            '--username', record['databaseRole'], '--dbname', 'postgres', '-c', query], 65536, 30)

    def _import(self, record):
        self._owned_database(record)
        directory = self._directory(record['id'])
        require(self._seal_dump(directory / 'dump/target.dump') == record['dump'])
        current = self._current_database(record)
        network = record['network']
        endpoint = current['NetworkSettings']['Networks'].get(network['name']) or {}
        require(endpoint.get('NetworkID') == network['id'] and endpoint.get('IPAddress') == network['address'])
        mounts = [self.SOURCE.mount(directory / 'dump', '/core-dump', True),
                  self.SOURCE.mount(directory / 'private', '/core-private', True)]
        body = self._body(record, 'import', current['Image'], self.SOURCE.PG.binary_for(record['currentProfile'], 'pg_restore'),
            ['--host=' + network['address'], '--port=5432', '--username=' + record['databaseRole'], '--dbname=' + record['databaseName'],
             '--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges', '--no-comments', '/core-dump/target.dump'], mounts,
            network=network['name'], environment=['PGPASSFILE=/core-private/pgpass', 'PGAPPNAME=orbis-core-logical-' + record['id']])
        record['phase'] = 'importing'
        self.save(record)
        self._start(record, 'import', body)
        self._wait(record, 'import', 1200)
        self._owned_database(record)
        require(self._seal_dump(directory / 'dump/target.dump') == record['dump'])

    def prepare(self, identifier, review_id, actor):
        """Stage a real new DB from checked isolated target; no live restore grant."""
        self.review.reconciliations._identifier(identifier)
        require(identifier != review_id)
        directory = self._directory(identifier)
        require(not directory.exists() and not directory.is_symlink())
        record = None
        with self.review._checked_review(review_id, actor) as checked:
            require(type(checked) is self.V.CheckedRestorationReview and checked.owner is self.review)
            with checked.guard():
                require('core-restoration-worker.mjs' in checked.reconciliation.manager.broker.code())
                self._require_no_unfinished()
                source = checked.reconciliation.manager
                target = source.approved['target']
                profile = self.TARGET.validate_profile(target['profile'])
                current = self.runtime.inspect('runtipi-db')
                labels = current['Config'].get('Labels') or {}
                require(current.get('Name') == '/runtipi-db' and labels.get('com.docker.compose.service') == 'runtipi-db'
                        and labels.get('com.docker.compose.project.working_dir') == str(self.enrollment.root)
                        and current['State'].get('Running') is True and not current['State'].get('Restarting'))
                current_profile = self.SOURCE.PG.execution_image_profile(self.runtime.image(current['Image']))
                require(current_profile['major'] == profile['major'])
                values = current['Config'].get('Env')
                require(type(values) is list and all(isinstance(item, str) and '=' in item for item in values))
                env = dict(item.split('=', 1) for item in values)
                require(len(env) == len(values) and isinstance(env.get('POSTGRES_USER'), str) and NAME.fullmatch(env['POSTGRES_USER'])
                        and isinstance(env.get('POSTGRES_PASSWORD'), str) and 1 <= len(env['POSTGRES_PASSWORD']) <= 4096
                        and all(char not in env['POSTGRES_PASSWORD'] for char in '\r\n\0'))
                common = set(current['NetworkSettings']['Networks']) & set(checked.record['snapshot']['container']['NetworkSettings']['Networks'])
                require(len(common) == 1)
                name = next(iter(common)); endpoint = current['NetworkSettings']['Networks'][name]
                require(isinstance(endpoint.get('IPAddress'), str) and str(ipaddress.IPv4Address(endpoint['IPAddress'])) == endpoint['IPAddress']
                        and isinstance(endpoint.get('NetworkID'), str) and HEX.fullmatch(endpoint['NetworkID']))
                base = self.enrollment.child(Path(self.enrollment.state), directory.parent.name)
                self.enrollment.sync(Path(self.enrollment.state));directory.mkdir(mode=0o700);self.enrollment.sync(base)
                for child in ('dump', 'private', 'verification', 'tool-data'):
                    self.enrollment.child(directory, child)
                record = {'schema': SCHEMA, 'id': identifier, 'reviewId': review_id, 'root': str(self.enrollment.root),
                    'context': self.enrollment.context, 'actor': copy.deepcopy(actor), 'nonce': str(uuid.uuid4()), 'phase': 'dumping',
                    'sourceReconciliationId': checked.reconciliation.admission['id'],
                    'sourceControllerImageId': source.broker.trust.source_controller_image_id,
                    'installedRuntime': copy.deepcopy(checked.reconciliation.intent['installedRuntime']),
                    'migrationPolicySha256': checked.reconciliation.intent['migrationPolicySha256'],
                    'currentSnapshotSha256': self.digest(checked.record['snapshot']),
                    'reconciliationReceiptSha256': checked.reconciliation.prepared_target.receipt_sha256,
                    'prepared': source.record(checked.reconciliation.admission['id'])['prepared'],
                    'targetDirectory': target['directory'], 'targetProfile': profile, 'workspace': target['workspace'],
                    'currentDatabase': {'id': current['Id'], 'definition': self.runtime.definition(current), 'startedAt': current['State']['StartedAt']},
                    'currentProfile': current_profile, 'databaseRole': env['POSTGRES_USER'], 'databaseName': 'orbis_restore_' + identifier.replace('-', ''),
                    'network': {'name': name, 'id': endpoint['NetworkID'], 'address': endpoint['IPAddress']}, 'workers': {}, **FLAGS}
                self.save(record)
                auth_path = source.approval.source_inspection.directory(source.approval.source_identifier) / 'execution/trusted-input/source-authentication.json'
                authentication = self.enrollment.read(auth_path, 2 * 1024 ** 2)
                self.enrollment.immutable(directory / 'private/authentication.json', authentication)
                self.enrollment.immutable(directory / 'private/connection.json', self.P.canonical({'host': endpoint['IPAddress'],
                    'port': 5432, 'user': record['databaseRole'], 'password': env['POSTGRES_PASSWORD'], 'database': record['databaseName']}))
                password = env['POSTGRES_PASSWORD'].replace('\\', '\\\\').replace(':', '\\:')
                self.enrollment.immutable(directory / 'private/pgpass', (endpoint['IPAddress'] + ':5432:' + record['databaseName'] + ':'
                    + record['databaseRole'] + ':' + password + '\n').encode())
                try:
                    self._export(record)
                    record['server'] = self._facts(record)
                    descriptor = {'schema': SCHEMA, 'id': identifier, 'nonce': record['nonce'], 'reviewId': review_id,
                        'reconciliationReceiptSha256': record['reconciliationReceiptSha256'], 'preparedSha256': self.digest(record['prepared']),
                        'sourceControllerImageId': record['sourceControllerImageId'], 'installedRuntime': record['installedRuntime'],
                        'migrationPolicySha256': record['migrationPolicySha256'], 'currentSnapshotSha256': record['currentSnapshotSha256'],
                        'currentDatabase': record['currentDatabase'], 'network': copy.deepcopy(record['network']),
                        'server': record['server'], 'dump': record['dump'],
                        'targetProfile': record['targetProfile'],
                        'databaseName': record['databaseName'], 'databaseRole': record['databaseRole'], **FLAGS}
                    self.enrollment.immutable(directory / 'descriptor.json', self.P.canonical(descriptor))
                    record['stageSha256'] = self.digest(descriptor)
                    record['databaseMarker'] = 'orbis.core-derived-logical.v1/' + identifier + '/' + record['nonce'] + '/' + record['stageSha256']
                    self.save(record)
                    self._create_database(record)
                    self._import(record)
                    record['phase'] = 'awaiting-verification'
                    self.save(record)
                except BaseException:
                    record['phase'] = 'recovery-required';self.save(record)
                    raise
        return self.binding(identifier)

    def binding(self, identifier):
        record = self.read(identifier)
        require(record['phase'] in {'awaiting-verification', 'staged'})
        return self.binding_for(record)

    def verify_imported(self, identifier):
        """Run the actual installed verifier entry; absence leaves the import held."""
        record = self.read(identifier)
        require(record['phase'] == 'awaiting-verification')
        with self.review._checked_review(record['reviewId'], record['actor']) as checked:
            require(checked.reconciliation.prepared_target.receipt_sha256 == record['reconciliationReceiptSha256'])
            with checked.guard():
                broker = checked.reconciliation.manager.broker
                code = broker.code()
                require('core-restoration-worker.mjs' in code)
                binding = self.binding(identifier)
                input_dir = self.enrollment.child(self._directory(identifier), 'verify-input')
                for name in ('authentication.json', 'connection.json'):
                    self.enrollment.immutable(input_dir / name, self.enrollment.read(self._directory(identifier) / 'private' / name, 2 * 1024 ** 2))
                descriptor = self.enrollment.read(self._directory(identifier) / 'descriptor.json', 65536)
                require(hashlib.sha256(descriptor).hexdigest() == record['stageSha256'])
                self.enrollment.immutable(input_dir / 'descriptor.json', descriptor)
                request = {'schema': 'orbis.core-imported-database-worker-input.v1', 'binding': binding,
                           'prepared': record['prepared'], 'authenticationSha256': hashlib.sha256(
                               self.enrollment.read(input_dir / 'authentication.json', 2 * 1024 ** 2)).hexdigest()}
                self.enrollment.immutable(input_dir / 'request.json', self.P.canonical(request))
                mounts = [self.SOURCE.mount(broker.trust.code_directory, '/app/core-restoration-code', True),
                    self.SOURCE.mount(input_dir, '/core-restoration-input', True),
                    self.SOURCE.mount(self._directory(identifier) / 'verification', '/core-restoration-output', False)]
                body = self._body(record, 'verify-imported', broker.trust.image_id, 'node',
                    ['/app/core-restoration-code/core-restoration-worker.mjs', '--verify-imported'], mounts,
                    network=record['network']['name'], environment=['NODE_ENV=production', 'TMPDIR=/core-restoration-output'])
                body['Labels']['io.orbis.core-import.stage'] = record['stageSha256']
                record['phase'] = 'verifying-import';self.save(record)
                try:
                    self._start(record, 'verify-imported', body)
                    self._wait(record, 'verify-imported', 180)
                    require(self.binding_for(record) == binding)
                    path = self._directory(identifier) / 'verification/result.json'
                    require(set(os.listdir(path.parent)) == {'result.json'})
                    value_body = self.enrollment.read(path, 65536)
                    value = self.P.metadata(value_body, byte_limit=65536)
                    expected = {**binding, 'schema': VERIFIED, 'logicalTargetVerified': True,
                                'environmentProved': False, 'restoreAuthority': False, 'activation': False}
                    require(value_body == self.P.canonical(value) and value == expected)
                    self.enrollment.immutable(self._directory(identifier) / 'verification-receipt.json', value_body)
                    record.update(phase='staged', verificationSha256=hashlib.sha256(value_body).hexdigest());self.save(record)
                except BaseException:
                    record['phase'] = 'recovery-required';self.save(record)
                    raise
        return ImportedCoreStage(identifier, record['stageSha256'], record['verificationSha256'])

    def binding_for(self, record):
        self._owned_database(record)
        identity = record['databaseIdentity']
        return {'schema': BINDING, 'id': record['id'], 'nonce': record['nonce'], 'stageSha256': record['stageSha256'],
            'dumpSha256': record['dump']['sha256'], 'preparedSha256': self.digest(record['prepared']),
            'database': {'systemIdentifier': record['server']['systemIdentifier'], 'databaseOid': str(identity['databaseOid']),
                'database': identity['database'], 'owner': identity['owner'], 'marker': identity['marker']}}
