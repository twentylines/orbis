"""Root-owned live reconciliation custody, ending before logical import or activation."""
import copy
import base64
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import ipaddress
import os
from pathlib import Path, PurePosixPath
import re
import stat
import threading
import time
import uuid


SCHEMA = 'orbis.core-live-restoration-job.v1'
ADMISSION = 'orbis.core-live-restoration-admission.v1'
CLAIM = 'orbis.core-live-restoration-claim.v1'
STAGE = 'orbis.core-live-held-derived-stage.v1'
AUTH_JOB = 'orbis.core-live-authentication-projection-job.v1'
PARSER = 'orbis.source-configuration.dotenv-17.2.3.v1'
ADMIT = 'admit-reviewed-live-restoration'
BEGIN = 'begin-reviewed-live-restoration'
ABORT = 'abort-before-activation'
FLAGS = {'activation': False, 'restoreAuthority': False, 'environmentProved': False}
WORKER_FLAGS = {'scope': 'reconcile-held-live-database-only', **FLAGS}
MAX_RECORD = 16 * 1024 ** 2
HEX = re.compile(r'[a-f0-9]{64}')
NAME = re.compile(r'[A-Za-z_][A-Za-z0-9_]{0,62}')
TERMINAL = frozenset({'aborted'})
OUTPUT_NAMES = frozenset({'worker-start.json', 'fence-intent.json', 'write-intent.json', 'completion.json', 'result.json'})
IMPORT_CLAIM = 'orbis.core-live-import-claim.v1'


@dataclass(frozen=True)
class CheckedLiveRestoration:
    owner: object
    admission: dict
    record: dict
    stage: dict
    guard: object

    def claim(self, stage_id):
        return self.owner._claim_live_import(self, stage_id)


def require(value):
    if not value:
        raise ValueError('Live restoration requires protected recovery review. Original data is retained.')


def quote(value):
    require(isinstance(value, str) and NAME.fullmatch(value))
    return '"' + value + '"'


def literal(value):
    require(isinstance(value, str) and '\0' not in value and len(value) <= 512)
    return "'" + value.replace("'", "''") + "'"


class CoreLiveRestorationService:
    def __init__(self, service, *, worker_factory=threading.Thread):
        self.service = service
        self.review = service.core_restoration_reviews()
        self.V = service.core_restoration_review_module
        self.enrollment, self.P = self.review.enrollment, self.review.P
        self.C = self.review.C
        self.preparation = self.review.reconciliations.preparation
        self.SOURCE, self.TARGET = self.C.R.SOURCE, self.C.R.TARGET
        self.worker_factory = worker_factory
        self._condition = threading.Condition()
        self._active = {}
        self._aborting = set()
        self.runtime = self._graph()

    def _graph(self):
        require(type(self.review) is self.V.CoreRestorationReview and self.review.service is self.service
                and self.service.core_restoration_reviews() is self.review
                and self.service.core_restoration_review_module is self.V
                and self.review.reconciliations.preparation is self.preparation
                and self.preparation.enrollment is self.enrollment)
        return self.review._graph()

    def digest(self, value):
        return hashlib.sha256(self.P.canonical(value)).hexdigest()

    def _identifier(self, value):
        return self.review.reconciliations._identifier(value)

    def _base(self):
        return Path(self.enrollment.state) / 'core-live-restorations'

    def _directory(self, identifier):
        return self._base() / self._identifier(identifier)

    def _marker_value(self, identifier):
        return {'schema': SCHEMA, 'id': identifier, 'root': str(self.enrollment.root), 'context': self.enrollment.context}

    def _marker_path(self):
        return self.service.HOST.restore_selector_path(self.enrollment.root)

    def _read_at(self, path):
        body = self.enrollment.read(path, MAX_RECORD)
        value = self.P.metadata(body, byte_limit=MAX_RECORD, string_limit=MAX_RECORD)
        require(body == self.P.canonical(value))
        return value

    def _read(self, identifier, name):
        return self._read_at(self._directory(identifier) / name)

    def _immutable(self, identifier, name, value):
        self.enrollment.immutable(self._directory(identifier) / name, self.P.canonical(value))
        self.enrollment.sync(self._directory(identifier))

    def _admission(self, identifier, actor=None):
        value = self._read(identifier, 'admission.json')
        fields = {'schema', 'id', 'reviewId', 'targetPreparationId', 'actor', 'root', 'context', 'action', 'nonce', 'evidence', *FLAGS}
        require(self.P.exact(value, fields) and value['schema'] == ADMISSION and value['id'] == identifier
                and value['root'] == str(self.enrollment.root) and value['context'] == self.enrollment.context
                and value['actor'] == self.enrollment.actor(value['actor'])
                and (actor is None or value['actor'] == actor) and value['action'] == ADMIT
                and all(type(value[key]) is type(expected) and value[key] == expected for key, expected in FLAGS.items()))
        require(len({self._identifier(value[key]) for key in ('id', 'reviewId', 'targetPreparationId', 'nonce')}) == 4)
        require(type(value['evidence']) is dict)
        return value

    def _record(self, identifier, actor=None):
        admission = self._admission(identifier, actor)
        value = self._read(identifier, 'job.json')
        require(value.get('schema') == SCHEMA and value.get('id') == identifier
                and value.get('admissionSha256') == self.digest(admission)
                and type(value.get('phase')) is str and re.fullmatch(r'[a-z][a-z0-9-]{0,63}', value['phase'])
                and type(value.get('workers')) is dict and type(value.get('operations')) is list
                and len(value['operations']) <= 64 and all(value.get(key) is expected for key, expected in FLAGS.items()))
        evidence = admission['evidence']
        require(value.get('source') == evidence['sourceSnapshot'] and value.get('normalBootstrapQueue') == evidence['queueBinding']
                and value.get('nonce') == admission['nonce']
                and all(value.get(key) == item for key, item in evidence['current'].items()))
        for operation in value['operations']:
            require(self.P.exact(operation, {'name', 'body', 'state'}) and type(operation['name']) is str
                    and re.fullmatch(r'[a-z][a-z0-9-]{0,62}', operation['name'])
                    and operation['state'] in {'intent', 'acknowledged'})
            intent = self._read(identifier, 'operations/' + operation['name'] + '.json')
            require(intent == {'schema': SCHEMA, 'id': identifier, 'admissionSha256': value['admissionSha256'],
                              **operation, 'state': 'intent'})
        require(len({item['name'] for item in value['operations']}) == len(value['operations']))
        return value

    def _record_directory(self, record):
        if record['schema'] == AUTH_JOB:
            return Path(self.enrollment.state) / 'core-live-authentication-projections' / self._identifier(record['id'])
        return self._directory(record['id'])

    def save(self, record):
        require(len(self.P.canonical(record)) <= MAX_RECORD)
        self.enrollment.a.atomic(self._record_directory(record) / 'job.json', self.P.canonical(record))
        self.enrollment.sync(self._record_directory(record))

    def _request(self, request, peer, action=None):
        require(peer is True)
        self.C.P.F.I.require_root()
        fields = {'id', 'actor'} | ({'action'} if action else set())
        if action == ADMIT:
            fields |= {'reviewId', 'targetPreparationId'}
        require(self.P.exact(request, fields))
        identifier = self._identifier(request['id'])
        actor = copy.deepcopy(self.enrollment.actor(request['actor']))
        if action:
            require(request['action'] == action)
        if action == ADMIT:
            require(len({identifier, self._identifier(request['reviewId']), self._identifier(request['targetPreparationId'])}) == 3)
        self._graph()
        return identifier, actor

    @contextmanager
    def _operation(self, identifier, *, queued=False):
        host = self.service.HOST
        require(hasattr(host, 'CORE_LIVE_TRANSACTION'))
        acquired = self.service.lock.acquire(timeout=30) if queued else self.service.lock.acquire(blocking=False)
        if not acquired:
            raise BlockingIOError('Another operation is running.')
        token = host.CORE_LIVE_TRANSACTION.set(identifier)
        active = False
        try:
            with host.host_lock(self.enrollment.root) as descriptor:
                require(type(descriptor) is int)
                identity, thread, active = os.fstat(descriptor), threading.get_ident(), True

                @contextmanager
                def guard():
                    require(active and threading.get_ident() == thread and self.service.lock.locked()
                            and host.LOCK_DESCRIPTOR.get() == descriptor and os.fstat(descriptor) == identity
                            and host.CORE_LIVE_TRANSACTION.get() == identifier)
                    yield
                    require(active and threading.get_ident() == thread and self.service.lock.locked()
                            and host.LOCK_DESCRIPTOR.get() == descriptor and os.fstat(descriptor) == identity)

                try:
                    yield guard
                finally:
                    active = False
        finally:
            host.CORE_LIVE_TRANSACTION.reset(token)
            self.service.lock.release()

    def _claims(self):
        return Path(self.enrollment.state) / 'core-live-restoration-claims'

    def _claim(self, admission):
        return {'schema': CLAIM, 'id': admission['id'], 'admissionSha256': self.digest(admission),
                'sourceInspectionId': admission['evidence']['preparationIntent']['sourceInspectionId'],
                'targetPreparationId': admission['targetPreparationId']}

    def _claim_paths(self, admission):
        claim = self._claim(admission)
        return [self._claims() / (role + '-' + claim[key] + '.json') for role, key in
                (('source', 'sourceInspectionId'), ('target', 'targetPreparationId'))]

    def _check_claims(self, admission):
        require(all(self._read_at(path) == self._claim(admission) for path in self._claim_paths(admission)))

    def _check_marker(self, identifier):
        require(self._read_at(self._marker_path()) == self._marker_value(identifier))

    def _names(self):
        base = self._base()
        if not base.exists() and not base.is_symlink():
            return []
        with self.enrollment.a.protected_directory(base):
            names = os.listdir(base)
        require(len(names) <= 128)
        return [self._identifier(name) for name in names]

    def _no_pending(self):
        for identifier in self._names():
            record = self._record(identifier)
            require(record['phase'] in TERMINAL and self._read(identifier, 'abort-complete.json')['jobSha256'] == self.digest(record))
        require(not self._marker_path().exists() and not self._marker_path().is_symlink())

    def _environment(self, raw):
        values = raw['Config'].get('Env')
        require(type(values) is list and all(type(item) is str and '=' in item for item in values))
        result = dict(item.split('=', 1) for item in values)
        require(len(result) == len(values))
        return result

    def _mapped(self, raw, destination):
        destination = PurePosixPath(destination)
        mounts = [item for item in raw['Mounts'] if item.get('Type') == 'bind'
                  and destination.is_relative_to(PurePosixPath(item.get('Destination', '/invalid')))]
        require(bool(mounts))
        mounts.sort(key=lambda item: len(PurePosixPath(item['Destination']).parts), reverse=True)
        require(len(mounts) == 1 or len(PurePosixPath(mounts[0]['Destination']).parts) > len(PurePosixPath(mounts[1]['Destination']).parts))
        mount = mounts[0]
        source = Path(mount['Source'])
        require(source.is_absolute() and source == source.resolve())
        path = source / destination.relative_to(PurePosixPath(mount['Destination']))
        require(path == path.resolve())
        return path

    def _optional_live_file(self, path, maximum):
        parent = path.parent
        missing = []
        while not parent.exists() and not parent.is_symlink():
            missing.append(parent.name)
            parent = parent.parent
        options = {'private': False} if missing else {}
        with self.enrollment.a.protected_directory(parent, **options) as descriptor:
            if missing:
                # Prove absence beneath the pinned existing ancestor without
                # creating optional storage or following a newly inserted path.
                try:
                    os.stat(missing[-1], dir_fd=descriptor, follow_symlinks=False)
                except FileNotFoundError:
                    return None
                require(False)
            try:
                os.stat(path.name, dir_fd=descriptor, follow_symlinks=False)
            except FileNotFoundError:
                return None
            with self.enrollment.a.protected_file(descriptor, path.name, maximum) as body:
                return body

    def _live_files(self, snapshot, database):
        controller = snapshot['container']
        configuration = self._mapped(controller, '/data/.env')
        passkeys = self._mapped(controller, '/data/state/auth/passkeys.json')
        files = {'configuration.env': self.enrollment.read(configuration, 1024 * 1024),
            'controller-environment.json': self.P.canonical(controller['Config']['Env']),
            'database-environment.json': self.P.canonical(database['Config']['Env'])}
        keys = self._optional_live_file(passkeys, 512 * 1024)
        if keys is not None:
            files['passkeys.json'] = keys
        return files

    def _authentication(self, identifier, snapshot, database, broker):
        """Execute the installed dotenv parser on sealed current configuration."""
        base = Path(self.enrollment.state) / 'core-live-authentication-projections'
        directory = base / identifier
        files = self._live_files(snapshot, database)
        hashes = {name: hashlib.sha256(body).hexdigest() for name, body in files.items()}
        request = {'schema': 'orbis.core-live-authentication-input.v1', 'id': identifier,
            'nonce': self.digest({'id': identifier, 'snapshot': snapshot}), 'parserProfile': PARSER,
            'liveSnapshotSha256': self.digest(snapshot), 'publicationSha256': self.digest(snapshot['publication']),
            'controllerId': snapshot['controllerId'], 'controllerImageId': snapshot['imageId'],
            'controllerEnvironmentSha256': hashes['controller-environment.json'],
            'databaseEnvironmentSha256': hashes['database-environment.json'],
            'configurationSha256': hashes['configuration.env'], 'passkeysSha256': hashes.get('passkeys.json')}
        if directory.exists() or directory.is_symlink():
            record = self._read_at(directory / 'job.json')
            require(record.get('schema') == AUTH_JOB and record.get('id') == identifier
                    and record.get('request') == request and record.get('broker') == broker)
            self._no_ambiguous(record)
            self._settled(record, 'authentication')
            require(record['workers']['authentication'].get('intent') == 'complete')
        else:
            base = self.enrollment.child(Path(self.enrollment.state), base.name)
            with self.enrollment.a.protected_directory(base):
                require(len(os.listdir(base)) < 128)
            directory.mkdir(mode=0o700)
            self.enrollment.sync(base)
            for name in ('input', 'output', 'operations'):
                self.enrollment.child(directory, name)
            self.enrollment.immutable(directory / 'input/request.json', self.P.canonical(request))
            for name, body in files.items():
                self.enrollment.immutable(directory / 'input' / name, body)
            record = {'schema': AUTH_JOB, 'id': identifier, 'nonce': request['nonce'], 'admissionSha256': self.digest(request),
                'request': request, 'broker': copy.deepcopy(broker), 'workers': {}, 'operations': [], **FLAGS}
            record['inputSeals'] = self._seals(directory / 'input', {'request.json', *files})
            self.save(record)
            body = {'Image': broker['configuration']['imageId'], 'User': '0:0', 'Entrypoint': ['node'],
                'Cmd': ['/app/core-live-code/core-source-configuration-worker.mjs', '--project-live-authentication'],
                'Env': ['NODE_ENV=production'], 'WorkingDir': '/app', 'Healthcheck': {'Test': ['NONE']},
                'Labels': self._labels(record, 'authentication'),
                'HostConfig': self.SOURCE.host({'pids': 64, 'memory': 512 * 1024 ** 2}),
                'NetworkingConfig': {'EndpointsConfig': {'none': {}}}}
            body['HostConfig']['Mounts'] = [self.SOURCE.mount(Path(broker['configuration']['codeDirectory']), '/app/core-live-code', True),
                self.SOURCE.mount(directory / 'input', '/source-configuration-input', True),
                self.SOURCE.mount(directory / 'output', '/source-configuration-output', False)]
            body['HostConfig']['LogConfig'] = {'Type': 'none', 'Config': {}}
            self._start(record, 'authentication', body)
            self._wait_worker(record, 'authentication', 45)
        require(self._seals(directory / 'input', {'request.json', *files}) == record['inputSeals'])
        require(all(self.enrollment.read(directory / 'input' / name, 2 * 1024 ** 2) == body for name, body in files.items()))
        output_seals = self._seals(directory / 'output', {'authentication.json', 'database.json', 'result.json'}, output=True)
        authentication = self._read_at(directory / 'output/authentication.json')
        selected = self._read_at(directory / 'output/database.json')
        report = self._read_at(directory / 'output/result.json')
        projection = {'schema': 'orbis.core-live-authentication-projection.v1', **{key: request[key] for key in
            ('parserProfile', 'liveSnapshotSha256', 'publicationSha256', 'controllerId', 'controllerImageId', 'configurationSha256',
             'controllerEnvironmentSha256', 'databaseEnvironmentSha256', 'passkeysSha256')},
            'authenticationSha256': output_seals['authentication.json']['sha256'],
            'databaseSha256': output_seals['database.json']['sha256'], 'basis': 'current-controller-configuration-candidate', **FLAGS}
        require(report == {'schema': 'orbis.core-live-authentication-result.v1', 'id': identifier, 'nonce': request['nonce'],
            'inputSha256': self.digest(request), 'projection': projection, 'restoreAuthority': False})
        require(self.P.exact(authentication, {'jwtSecret', 'passkeys'}) and type(authentication['jwtSecret']) is str
                and 32 <= len(authentication['jwtSecret']) <= 4096
                and (authentication['passkeys'] is None or type(authentication['passkeys']) is dict))
        require(self.P.exact(selected, {'host', 'port', 'user', 'password', 'database'}) and selected['port'] == 5432
                and type(selected['port']) is int)
        require(self._live_files(snapshot, database) == files)
        require(self._seals(directory / 'output', output_seals, output=True) == output_seals)
        self._settled(record, 'authentication')
        binding = {'requestSha256': self.digest(request), 'jobSha256': self.digest(record),
            'inputSeals': record['inputSeals'], 'outputSeals': output_seals, 'projection': projection}
        return selected, self.P.canonical(authentication), binding

    def _database(self, record, *, allow_restart=False):
        expected = record['originalDatabase']
        raw = self.runtime.inspect(expected['id'])
        state = raw['State']
        require(raw['Id'] == expected['id'] and raw['Image'] == expected['imageId']
                and self.runtime.definition(raw) == expected['definition']
                and state.get('Status') == 'running' and state.get('Running') is True
                and all(state.get(key) is False for key in ('Restarting', 'Paused', 'Dead', 'OOMKilled'))
                and (allow_restart or state.get('StartedAt') == expected['startedAt'])
                and raw['Mounts'] == expected['mounts'])
        require({name: row.get('NetworkID') for name, row in raw['NetworkSettings']['Networks'].items()} == expected['networks'])
        network = record['network']
        live_network = self.runtime.reader._object(['network', 'inspect', '--format', '{{json .}}', network['id']])
        require(live_network.get('Id') == network['id'] and live_network.get('Name') == network['name']
                and live_network.get('Driver') == network['driver'] and live_network.get('Scope') == network['scope']
                and live_network.get('Internal') is network['internal'])
        endpoint = raw['NetworkSettings']['Networks'].get(network['name']) or {}
        require(endpoint.get('NetworkID') == network['id'] and endpoint.get('IPAddress') == network['address'])
        return raw

    def _sql(self, record, query, *, allow_restart=False):
        raw = self._database(record, allow_restart=allow_restart)
        body = self.runtime.bounded_output(['docker', '--context', self.enrollment.context, 'exec', raw['Id'],
            self.SOURCE.PG.binary_for(record['databaseProfile'], 'psql'), '-X', '-v', 'ON_ERROR_STOP=1',
            '--username', record['databaseRole'], '--dbname', 'postgres', '-Atqc', query], 65536, 30)
        require(len(body) <= 65536)
        return self.P.metadata(body.strip(), byte_limit=65536)

    def _facts(self, record, *, allow_restart=False):
        name = literal(record['databaseName'])
        value = self._sql(record, "SELECT json_build_object('systemIdentifier',(pg_control_system()).system_identifier::text,"
            "'database',d.datname,'databaseOid',d.oid::text,'role',current_user,'roleOid',r.oid::text,"
            "'serverVersionNum',current_setting('server_version_num')::int,"
            "'postmasterEpochUs',(extract(epoch from pg_postmaster_start_time())*1000000)::bigint::text,"
            "'allowConnections',d.datallowconn) FROM pg_database d CROSS JOIN pg_roles r WHERE d.datname=" + name
            + " AND r.rolname=current_user AND d.datdba=r.oid", allow_restart=allow_restart)
        require(self.P.exact(value, {'systemIdentifier', 'database', 'databaseOid', 'role', 'roleOid',
                'serverVersionNum', 'postmasterEpochUs', 'allowConnections'})
                and value['database'] == record['databaseName'] and value['role'] == record['databaseRole']
                and type(value['serverVersionNum']) is int and value['serverVersionNum'] // 10000 == record['databaseProfile']['major']
                and type(value['allowConnections']) is bool)
        for key, maximum in (('systemIdentifier', 2 ** 64 - 1), ('databaseOid', 2 ** 32 - 1),
                             ('roleOid', 2 ** 32 - 1), ('postmasterEpochUs', 2 ** 63 - 1)):
            require(type(value[key]) is str and re.fullmatch(r'[1-9][0-9]{0,19}', value[key]) and int(value[key]) <= maximum)
        return value

    def _sql_isolated(self, record, *, allow_restart=False):
        oid = record['databaseFacts']['databaseOid']
        # PostgreSQL startup takes this lock before its activity row appears.
        locks = self._sql(record, "SELECT json_build_object('count',count(*)::int) FROM pg_locks WHERE locktype='object'"
            " AND classid='pg_catalog.pg_database'::regclass AND objid=" + oid + "::oid AND mode='RowExclusiveLock'",
            allow_restart=allow_restart)
        sessions = self._sql(record, "SELECT json_build_object('count',count(*)::int) FROM pg_stat_activity WHERE datid=" + oid
            + "::oid", allow_restart=allow_restart)
        prepared = self._sql(record, "SELECT json_build_object('count',count(*)::int) FROM pg_prepared_xacts WHERE database=" + literal(record['databaseName']), allow_restart=allow_restart)
        require(all(value == {'count': 0} and type(value['count']) is int for value in (locks, sessions, prepared)))
        return {'startupLocks': 0, 'databaseSessions': 0, 'preparedTransactions': 0}

    def _current_material(self, identifier, snapshot, target_profile, broker):
        current = self.runtime.inspect('runtipi-db')
        labels, state = current['Config'].get('Labels') or {}, current['State']
        require(current.get('Name') == '/runtipi-db' and labels.get('com.docker.compose.project') == 'runtipi'
                and labels.get('com.docker.compose.service') == 'runtipi-db'
                and labels.get('com.docker.compose.project.working_dir') == str(self.enrollment.root)
                and state.get('Status') == 'running' and state.get('Running') is True
                and all(state.get(key) is False for key in ('Restarting', 'Paused', 'Dead', 'OOMKilled'))
                and not current['HostConfig'].get('Privileged') and not current['HostConfig'].get('AutoRemove'))
        profile = self.SOURCE.PG.execution_image_profile(self.runtime.image(current['Image']))
        require(all(profile[key] == target_profile[key] for key in self.SOURCE.PG.BASE_FIELDS))
        environment = self._environment(current)
        selected, authentication, auth_binding = self._authentication(identifier, snapshot, current, broker)
        role, database, password = selected['user'], selected['database'], selected['password']
        require(type(role) is str and NAME.fullmatch(role) and role == environment.get('POSTGRES_USER')
                and type(database) is str and NAME.fullmatch(database) and database not in {'postgres', 'template0', 'template1'}
                and database == environment.get('POSTGRES_DB'))
        require(type(password) is str and 1 <= len(password.encode()) <= 4096
                and not any(char in password for char in '\r\n\0') and password == environment.get('POSTGRES_PASSWORD'))
        common = set(current['NetworkSettings']['Networks']) & set(snapshot['container']['NetworkSettings']['Networks'])
        require(len(common) == 1)
        name = next(iter(common))
        endpoint = current['NetworkSettings']['Networks'][name]
        address, network_id = endpoint.get('IPAddress'), endpoint.get('NetworkID')
        require(type(address) is str and str(ipaddress.IPv4Address(address)) == address
                and type(network_id) is str and HEX.fullmatch(network_id)
                and snapshot['container']['NetworkSettings']['Networks'][name].get('NetworkID') == network_id)
        aliases = endpoint.get('Aliases') or []
        require(type(aliases) is list and selected['host'] in {address, current['Id'], current['Name'].removeprefix('/'), *aliases})
        network = self.runtime.reader._object(['network', 'inspect', '--format', '{{json .}}', network_id])
        require(network.get('Id') == network_id and network.get('Name') == name and type(network.get('Internal')) is bool
                and network.get('Driver') == 'bridge' and network.get('Scope') == 'local'
                and network.get('Ingress') in {None, False})
        record = {'originalDatabase': {'id': current['Id'], 'imageId': current['Image'], 'definition': self.runtime.definition(current),
            'startedAt': state['StartedAt'], 'mounts': copy.deepcopy(current['Mounts']),
            'networks': {name: row.get('NetworkID') for name, row in current['NetworkSettings']['Networks'].items()}},
            'databaseProfile': profile, 'databaseRole': role, 'databaseName': database,
            'network': {'name': name, 'id': network_id, 'address': address, 'driver': network['Driver'],
                        'scope': network['Scope'], 'internal': network['Internal']}}
        facts = self._facts(record)
        require(facts['allowConnections'] is True)
        return record | {'databaseFacts': facts}, self.P.canonical({'host': address, 'port': 5432, 'user': role,
            'password': password, 'database': database}), authentication, auth_binding

    def _proof(self, identifier, checked, target_id, actor):
        require(type(checked) is self.V.CheckedRestorationReview and checked.owner is self.review)
        reconciliation = checked.reconciliation
        manager = reconciliation.manager
        prepared = self.preparation._checked_preparation(target_id, actor, checked.guard)
        require(type(prepared) is self.C.P.CheckedPreparation
                and prepared.manager.enrollment is self.enrollment and prepared.source_inspection.enrollment is self.enrollment
                and prepared.prepared_target.identifier == target_id and target_id != reconciliation.admission['sourcePreparationId'])
        intent = prepared.intent
        require(all(intent[key] == reconciliation.intent[key] for key in
                ('sourceInspectionId', 'sourceRecordSha256', 'migrationPolicySha256', 'installedRuntime')))
        with checked.guard():
            bootstrap = prepared.manager
            require(type(bootstrap) is self.C.P.POLICY.B.CoreVersionedCleanTargetBootstrap)
            bootstrap.checked(prepared.prepared_target, actor)
            source = manager.endpoint(prepared.source_inspection, intent['sourceInspectionId'])
            require(source == manager.approved['source'] and source['catalog'] == bootstrap.approved['catalog'])
            broker = manager.coordinator_binding(bootstrap.broker)
            require(broker == source['configuration'] and 'core-live-reconciliation-worker.mjs' in broker['configuration']['inventory'])
            target_record = bootstrap.record(target_id)
            target_directory = bootstrap.directory(target_id) / 'target'
            receipt = self.enrollment.read(bootstrap.directory(target_id) / 'receipt.json', 65536)
            require(hashlib.sha256(receipt).hexdigest() == prepared.prepared_target.receipt_sha256)
            target = {'id': target_id, 'receiptSha256': prepared.prepared_target.receipt_sha256,
                'recordSha256': self.digest(target_record), 'target': target_record['request']['target'],
                'workspace': target_record['workspace'], 'directory': str(target_directory), 'profile': bootstrap.approved['profile']}
            workspace = self.TARGET.TargetWorkspace(target_directory, target['profile'],
                target['workspace']['allocation'], target['workspace']['identities'])
            self.TARGET.verify_workspace(workspace, self.enrollment.a)
            prior_claim = self.review.reconciliations._claims() / (target_id + '.json')
            require(not prior_claim.exists() and not prior_claim.is_symlink())
            roots = [manager.identity(Path(endpoint['directory']) / 'pgdata') for endpoint in
                     (source, manager.approved['target'], target)]
            require(len({(row['dev'], row['ino']) for row in roots}) == 3)
            paths = [Path(row['path']) for row in roots]
            require(all(not left.is_relative_to(right) for left in paths for right in paths if left != right))
            snapshot = self.runtime.source_snapshot()
            require(snapshot == checked.record['snapshot'])
            current, connection, authentication, auth_binding = self._current_material(identifier, snapshot, target['profile'], broker)
            queue = self.runtime.bootstrap_queue_binding({'source': snapshot})
            source_authentication = manager.source_authentication('source')
            evidence = {'review': copy.deepcopy(checked.record), 'preparationIntent': copy.deepcopy(intent),
                'source': source, 'target': target, 'broker': broker, 'catalog': copy.deepcopy(manager.approved['catalog']),
                'ownership': copy.deepcopy(manager.approved['ownership']), 'catalogOwnerIds': manager.approved['catalogOwnerIds'],
                'migrationsSha256': bootstrap.ledger_hash(source['catalog']['ledger']), 'sourceSnapshot': snapshot,
                'queueBinding': queue, 'originalRestartPolicy': copy.deepcopy(snapshot['container']['HostConfig']['RestartPolicy']),
                'current': current, 'connectionSha256': hashlib.sha256(connection).hexdigest(),
                'sourceAuthenticationSha256': hashlib.sha256(source_authentication).hexdigest(),
                'destinationAuthenticationSha256': hashlib.sha256(authentication).hexdigest(), 'liveAuthentication': auth_binding}
            require(self.runtime.source_snapshot() == snapshot)
            return evidence, {'connection.json': connection, 'source-authentication.json': source_authentication,
                              'destination-authentication.json': authentication}

    def admit(self, request, *, privileged_peer=False):
        identifier, actor = self._request(request, privileged_peer, ADMIT)
        directory = self._directory(identifier)
        if directory.exists() or directory.is_symlink():
            admission = self._admission(identifier, actor)
            require(admission['reviewId'] == request['reviewId'] and admission['targetPreparationId'] == request['targetPreparationId'])
            return self.status({'id': identifier, 'actor': actor}, privileged_peer=True)
        with self.review._checked_review(request['reviewId'], actor) as checked:
            self._no_pending()
            evidence, private = self._proof(identifier, checked, request['targetPreparationId'], actor)
        # The review's postcondition runs while the original controller is healthy.
        # A new exclusion scope seals the handoff before any lifecycle mutation.
        with self._operation(identifier):
            self._no_pending()
            require(self.runtime.source_snapshot() == evidence['sourceSnapshot'])
            admission = {'schema': ADMISSION, 'id': identifier, 'reviewId': request['reviewId'],
                'targetPreparationId': request['targetPreparationId'], 'actor': actor, 'root': str(self.enrollment.root),
                'context': self.enrollment.context, 'action': ADMIT, 'nonce': str(uuid.uuid4()), 'evidence': evidence, **FLAGS}
            for path in self._claim_paths(admission):
                require(not path.exists() and not path.is_symlink())
            base = self.enrollment.child(Path(self.enrollment.state), self._base().name)
            self.enrollment.sync(Path(self.enrollment.state))
            directory.mkdir(mode=0o700)
            self.enrollment.sync(base)
            for name in ('private', 'input', 'output', 'operations'):
                self.enrollment.child(directory, name)
            self._immutable(identifier, 'admission.json', admission)
            for name, body in private.items():
                self.enrollment.immutable(directory / 'private' / name, body)
            claims = self.enrollment.child(Path(self.enrollment.state), self._claims().name)
            for path in self._claim_paths(admission):
                self.enrollment.immutable(path, self.P.canonical(self._claim(admission)))
            self.enrollment.sync(claims)
            record = {'schema': SCHEMA, 'id': identifier, 'admissionSha256': self.digest(admission), 'phase': 'admitted',
                'source': copy.deepcopy(evidence['sourceSnapshot']), 'normalBootstrapQueue': copy.deepcopy(evidence['queueBinding']),
                'nonce': admission['nonce'], 'workers': {}, 'operations': [], **copy.deepcopy(evidence['current']), **FLAGS}
            self.save(record)
            self.enrollment.immutable(self._marker_path(), self.P.canonical(self._marker_value(identifier)))
            self.enrollment.sync(self._marker_path().parent)
            self._check_claims(admission)
            self._check_marker(identifier)
        return self._public(admission, 'admitted')

    def _public(self, admission, phase, *, active=False, ready=False):
        return {'version': 1, 'id': admission['id'], 'reviewId': admission['reviewId'],
                'targetPreparationId': admission['targetPreparationId'], 'phase': phase, 'active': active,
                'readyForImport': ready, **FLAGS}

    def _phase(self, record, phase):
        record['phase'] = phase
        self.save(record)
        with self._condition:
            self._condition.notify_all()

    def _mutate(self, record, name, body, action):
        require(re.fullmatch(r'[a-z][a-z0-9-]{0,62}', name) and len(record['operations']) < 64
                and all(item['name'] != name for item in record['operations']))
        operation = {'name': name, 'body': copy.deepcopy(body), 'state': 'intent'}
        self.enrollment.immutable(self._record_directory(record) / 'operations' / (name + '.json'),
            self.P.canonical({'schema': record['schema'], 'id': record['id'],
                'admissionSha256': record['admissionSha256'], **operation}))
        self.enrollment.sync(self._record_directory(record) / 'operations')
        record['operations'].append(operation)
        self.save(record)
        result = action()
        operation['state'] = 'acknowledged'
        self.save(record)
        return result

    def _no_ambiguous(self, record):
        require(all(item.get('state') == 'acknowledged' for item in record['operations']))

    def _worker(self, record, role):
        worker = record['workers'][role]
        require(type(worker.get('id')) is str and HEX.fullmatch(worker['id']))
        raw = self.runtime.inspect(worker['id'])
        require(raw.get('Id') == worker['id'] and raw.get('Image') == worker['body']['Image']
                and raw.get('Name') == '/' + worker['name'])
        expected_body = copy.deepcopy(worker['body'])
        if role == 'responder' and any(item['name'] == 'abort-disable-responder-restart'
                and item['state'] == 'acknowledged' for item in record['operations']):
            expected_body['HostConfig']['RestartPolicy'] = {'Name': 'no', 'MaximumRetryCount': 0}
        health = (raw.get('Config') or {}).get('Healthcheck')
        require(type(health) is dict and health.get('Test') == ['NONE']
                and not set(health) - {'Test', 'Interval', 'Timeout', 'StartPeriod', 'StartInterval', 'Retries'}
                and all(type(value) is int and value >= 0 for key, value in health.items() if key != 'Test'))
        expected_body['Healthcheck'] = health
        self.runtime.check_intent(raw, expected_body)
        if 'definition' in worker:
            require(self.runtime.definition(raw) == worker['definition'])
        if role == 'live-worker':
            network = record['network']
            require(set(raw['NetworkSettings']['Networks']) == {network['name']}
                    and raw['NetworkSettings']['Networks'][network['name']].get('NetworkID') == network['id'])
        return raw

    def _start(self, record, role, body):
        require(role not in record['workers'])
        name = 'orbis-core-live-' + record['id'] + '-' + role
        worker = record['workers'][role] = {'name': name, 'body': copy.deepcopy(body), 'intent': 'creating'}
        self.save(record)
        response = self._mutate(record, role + '-create', body,
            lambda: self.runtime.engine('POST', '/containers/create?name=' + name, body))
        value = self.P.metadata(response)
        require(type(value.get('Id')) is str and HEX.fullmatch(value['Id']))
        worker.update(id=value['Id'], intent='created')
        self.save(record)
        raw = self._worker(record, role)
        require(self.runtime.never_started(raw))
        worker.update(definition=self.runtime.definition(raw), intent='starting')
        self.save(record)
        self._mutate(record, role + '-start', {'id': worker['id']}, lambda: self.runtime.change(['start', worker['id']]))
        worker['intent'] = 'running'
        self.save(record)
        if role == 'responder':
            record.setdefault('definitions', {})['responder'] = worker['definition']
            record.setdefault('intents', {})['responder'] = {'body': copy.deepcopy(body)}
            record['responderId'] = worker['id']
            self.save(record)

    def _settled(self, record, role, *, success=True):
        worker = record['workers'][role]
        raw = self._worker(record, role)
        state = raw.get('State') or {}
        require(state.get('Status') == 'exited' and type(state.get('ExitCode')) is int
                and (not success or state['ExitCode'] == 0) and type(state.get('Pid')) is int and state['Pid'] == 0
                and all(state.get(key) is False for key in ('Running', 'Restarting', 'Paused', 'Dead', 'OOMKilled'))
                and type(state.get('FinishedAt')) is str and not state['FinishedAt'].startswith('0001-')
                and (worker.get('terminal') is None or worker['terminal'] == state))
        return copy.deepcopy(state)

    def _wait_worker(self, record, role, timeout, *, success=True):
        worker = record['workers'][role]
        worker['intent'] = 'waiting'
        self.save(record)
        output = self.runtime.bounded_output(['docker', '--context', self.enrollment.context, 'wait', worker['id']], 32, timeout)
        state = self._settled(record, role, success=success)
        require(output.strip() == str(state['ExitCode']).encode())
        worker.update(intent='complete', terminal=state)
        self.save(record)

    def _stop_worker(self, record, role, *, success=True):
        raw = self._worker(record, role)
        worker = record['workers'][role]
        if raw['State'].get('Running') is True:
            require(raw['State'].get('Status') == 'running' and raw['State'].get('Restarting') is False
                    and raw['State'].get('Paused') is False)
            worker['intent'] = 'stopping'
            self.save(record)
            self._mutate(record, role + '-stop', {'id': worker['id']},
                lambda: self.runtime.change(['stop', '--time', '30', worker['id']]))
        self._wait_worker(record, role, 45, success=success)

    def _source_files(self, record):
        source = record['source']
        host = self.service.HOST
        require(base64.b64encode(host.enrollment_bytes(self.enrollment.root)).decode() == source['enrollment']
                and self.service.current_manifest() == source['publication']
                and self.runtime.reader.socket() == source['daemonSocket']
                and self.runtime.reader._object(['info', '--format', '{{json .}}']).get('ID') == source['daemonId'])
        if self.enrollment.a.LAYOUT.selected_path(self.enrollment.root, 'host-lock') == self.enrollment.a.LAYOUT.legacy_path(self.enrollment.root, 'host-lock'):
            files = {name: host.file_digest(self.enrollment.root / name) for name in source['files']}
        else:
            files = self.enrollment.a.installation_observations(self.enrollment.root, source['files'],
                daemon=source['daemonId'], context=self.enrollment.context)
        require(files == source['files'])
        self.runtime.require_reset_authority(record)

    def _controller(self, record, *, stopped=False):
        expected = record['source']
        self._source_files(record)
        raw = self.runtime.inspect(expected['controllerId'])
        require(raw['Id'] == expected['controllerId'] and raw['Image'] == expected['imageId']
                and self.runtime.definition(raw) == expected['definition'] and raw['Mounts'] == expected['container']['Mounts'])
        self.runtime.verify_networks(record, raw)
        state = raw['State']
        require(all(state.get(key) is False for key in ('Restarting', 'Paused', 'Dead', 'OOMKilled')))
        if stopped:
            require(state.get('Status') == 'exited' and state.get('Running') is False
                    and type(state.get('Pid')) is int and state['Pid'] == 0
                    and raw['HostConfig']['RestartPolicy'] == {'Name': 'no', 'MaximumRetryCount': 0})
        return raw

    def _stop_controller(self, record):
        raw = self._controller(record)
        require(raw['State'].get('Status') == 'running' and raw['State'].get('Running') is True
                and raw['State'].get('StartedAt') == record['source']['container']['State']['StartedAt'])
        self._mutate(record, 'controller-disable-restart', {'id': raw['Id'], 'restart': 'no'},
            lambda: self.runtime.change(['update', '--restart', 'no', raw['Id']]))
        self._mutate(record, 'controller-stop', {'id': raw['Id']},
            lambda: self.runtime.change(['stop', '--time', '30', raw['Id']]))
        self._controller(record, stopped=True)

    def _overlay(self, record):
        self._start(record, 'responder', self.runtime.overlay_body(record))
        deadline = time.monotonic() + 30
        while True:
            try:
                self.runtime.validate_overlay(record)
                self._probe(record['responderId'], '/dashboard', html=True)
                return
            except (OSError, ValueError, RuntimeError):
                require(time.monotonic() < deadline)
                time.sleep(0.25)

    def _probe(self, identifier, route, *, html=False):
        command = "const r=await fetch('http://127.0.0.1:3000" + route + "',{signal:AbortSignal.timeout(2000)});if(!r.ok"
        if html:
            command += "||!(r.headers.get('content-type')||'').startsWith('text/html')"
        command += ")process.exit(2);process.stdout.write('ok');"
        result = self.runtime.bounded_output(['docker', '--context', self.enrollment.context, 'exec', identifier,
            'node', '--input-type=module', '-e', command], 1024, 5)
        require(result == b'ok')

    def _seals(self, directory, names, *, output=False):
        result = {}
        with self.enrollment.a.protected_directory(directory) as fd:
            require(set(os.listdir(fd)) == set(names))
            for name in sorted(names):
                details = os.stat(name, dir_fd=fd, follow_symlinks=False)
                require(stat.S_ISREG(details.st_mode) and details.st_uid == os.geteuid()
                        and details.st_nlink == 1 and stat.S_IMODE(details.st_mode) in ({0o400} if output else {0o400, 0o600}))
                result[name] = {'identity': list(self.enrollment.a.seal(details)),
                    **self.enrollment.digest(directory / name, MAX_RECORD)}
                require(list(self.enrollment.a.seal(os.stat(name, dir_fd=fd, follow_symlinks=False))) == result[name]['identity'])
        return result

    def _check_broker(self, admission):
        evidence = admission['evidence']
        intent = evidence['preparationIntent']
        inspection, _, _, _, _ = self.preparation._source(intent['sourceInspectionId'], admission['actor'], intent,
            enrollment=self.enrollment)
        broker = inspection.configuration
        with broker.installed_authority():
            require(broker.binding() == evidence['broker']['configuration'])
            directory = Path(broker.trust.code_directory)
            with self.enrollment.a.protected_directory(directory) as fd:
                require(set(os.listdir(fd)) == set(evidence['broker']['codeSeals']))
                for name, expected in evidence['broker']['codeSeals'].items():
                    require(list(self.enrollment.a.seal(os.stat(name, dir_fd=fd, follow_symlinks=False))) == expected)

    def _check_authentication(self, record, admission, *, allow_restart=False):
        evidence = admission['evidence']
        self._check_broker(admission)
        _, authentication, binding = self._authentication(record['id'], record['source'],
            self._database(record, allow_restart=allow_restart), evidence['broker'])
        require(binding == evidence['liveAuthentication']
                and hashlib.sha256(authentication).hexdigest() == evidence['destinationAuthenticationSha256'])

    def _inputs(self, record, admission):
        evidence = admission['evidence']
        directory = self._directory(record['id'])
        facts = record['databaseFacts']
        identity = {key: facts[key] for key in ('systemIdentifier', 'database', 'databaseOid', 'role', 'roleOid', 'serverVersionNum')}
        target = evidence['target']['target']
        target_identity = {key: target[key] for key in ('systemIdentifier', 'databaseOid', 'database')}
        source = evidence['source']
        owners = {'schema': 'orbis.core-catalog-ownership-identities.v1',
            **{key: evidence['ownership'][key] for key in ('sourceOwnerId', 'destinationOwnerId', 'owners', 'aliases', 'restoreAuthority')}}
        request = {'schema': 'orbis.core-live-reconciliation-worker-input.v1', 'id': record['id'], 'nonce': admission['nonce'],
            'rootIntentSha256': self.digest(admission), 'sourceControllerImageId': evidence['preparationIntent']['installedRuntime']['sourceControllerImageId'],
            'source': copy.deepcopy(source['request']), 'destination': {'identity': identity, 'address': record['network']['address'],
                'postmasterEpochUs': facts['postmasterEpochUs'], 'authenticationSha256': evidence['destinationAuthenticationSha256']},
            'target': {'identity': target_identity, 'role': evidence['target']['profile']['role']},
            'expected': {'catalogSha256': source['evidence']['catalogSha256'], 'migrationsSha256': evidence['migrationsSha256'], 'catalogOwnership': owners},
            'sourceOwnerId': admission['actor']['ownerId'], 'destinationOwnerId': admission['actor']['ownerId'],
            'catalogOwnerIds': evidence['catalogOwnerIds'], 'sequencePolicy': {'schema': 'orbis.core-clean-target-sequence-policy.v2',
                'sourceControllerImageId': evidence['preparationIntent']['installedRuntime']['sourceControllerImageId'],
                'catalogSha256': source['evidence']['catalogSha256']}, **WORKER_FLAGS}
        authorization = {'schema': 'orbis.core-live-reconciliation-authorization.v1', 'decision': 'approved',
            'id': record['id'], 'nonce': admission['nonce'], 'requestSha256': self.digest(request),
            'rootIntentSha256': self.digest(admission), 'controllerStopped': True, 'queueDrained': True, **WORKER_FLAGS}
        # These booleans are derived here only after the Root witnesses below.
        self._controller(record, stopped=True)
        self.runtime.bootstrap_queues_quiet(record)
        self._check_authentication(record, admission)
        require(self._facts(record) == facts)
        for name, value in (('request.json', request), ('authorization.json', authorization)):
            self.enrollment.immutable(directory / 'input' / name, self.P.canonical(value))
        for name, digest in (('connection.json', evidence['connectionSha256']),
                ('source-authentication.json', evidence['sourceAuthenticationSha256']),
                ('destination-authentication.json', evidence['destinationAuthenticationSha256'])):
            body = self.enrollment.read(directory / 'private' / name, 2 * 1024 ** 2)
            require(hashlib.sha256(body).hexdigest() == digest)
            self.enrollment.immutable(directory / 'input' / name, body)
        record['request'], record['authorization'] = request, authorization
        record['inputSeals'] = self._seals(directory / 'input',
            {'request.json', 'authorization.json', 'connection.json', 'source-authentication.json', 'destination-authentication.json'})
        self.save(record)

    def _auxiliary_body(self, record, admission, role):
        target = admission['evidence']['target']
        if role == 'source-database':
            source = admission['evidence']['source']
            body = self.SOURCE.database_body(record['id'], record['admissionSha256'], Path(source['directory']), source['profile'])
        else:
            workspace = self.TARGET.TargetWorkspace(Path(target['directory']), target['profile'],
                target['workspace']['allocation'], target['workspace']['identities'])
            body = self.TARGET.database_body(workspace, self.enrollment.a)
        body['Labels'].update(self._labels(record, role))
        body['NetworkingConfig'] = {'EndpointsConfig': {'none': {}}}
        return body

    def _labels(self, record, role):
        return {'io.orbis.core-live': record['id'], 'io.orbis.core-live.nonce': record['nonce'],
                'io.orbis.core-live.admission': record['admissionSha256'], 'io.orbis.core-live.role': role}

    def _live_body(self, record, admission):
        evidence = admission['evidence']
        directory = self._directory(record['id'])
        body = {'Image': evidence['broker']['configuration']['imageId'], 'User': '0:' + str(evidence['target']['profile']['gid']),
            'Entrypoint': ['node'], 'Cmd': ['/app/core-live-code/core-live-reconciliation-worker.mjs', '--reconcile-live'],
            'Env': ['NODE_ENV=production', 'TMPDIR=/core-live-output'], 'WorkingDir': '/app',
            'Healthcheck': {'Test': ['NONE']}, 'Labels': self._labels(record, 'live-worker'),
            'HostConfig': self.SOURCE.host({'pids': 64, 'memory': 512 * 1024 ** 2}),
            'NetworkingConfig': {'EndpointsConfig': {record['network']['name']: {}}}}
        body['HostConfig'].update(NetworkMode=record['network']['id'], LogConfig={'Type': 'none', 'Config': {}},
            PublishAllPorts=False, PortBindings={}, CapAdd=[])
        body['HostConfig']['Mounts'] = [self.SOURCE.mount(Path(evidence['broker']['configuration']['codeDirectory']), '/app/core-live-code', True),
            self.SOURCE.mount(directory / 'input', '/core-live-input', True), self.SOURCE.mount(directory / 'output', '/core-live-output', False),
            self.SOURCE.mount(Path(evidence['source']['directory']) / 'socket', '/core-live-source-socket', True),
            self.SOURCE.mount(Path(evidence['target']['directory']) / 'socket', '/core-live-target-socket', True)]
        return body

    def _socket(self, record, admission, role):
        endpoint = admission['evidence']['source' if role == 'source-database' else 'target']
        deadline = time.monotonic() + 15
        while True:
            raw = self._worker(record, role)
            require(raw['State'].get('Status') == 'running' and raw['State'].get('Running') is True
                    and raw['State'].get('Restarting') is False and raw['State'].get('Paused') is False)
            path = Path(endpoint['directory']) / 'socket/.s.PGSQL.5432'
            try:
                details = path.lstat()
            except FileNotFoundError:
                details = None
            if details is not None:
                require(stat.S_ISSOCK(details.st_mode) and details.st_uid == endpoint['profile']['uid']
                        and details.st_gid == endpoint['profile']['gid'] and stat.S_IMODE(details.st_mode) == 0o770)
                return
            require(time.monotonic() < deadline)
            time.sleep(0.1)

    def begin(self, request, *, privileged_peer=False):
        identifier, actor = self._request(request, privileged_peer, BEGIN)
        admission, record = self._admission(identifier, actor), self._record(identifier, actor)
        with self._condition:
            require(identifier not in self._aborting)
            if identifier in self._active:
                return self._public(admission, record['phase'], active=True)
            if record['phase'] != 'admitted':
                return self.status({'id': identifier, 'actor': actor}, privileged_peer=True)
            require(not self._active)
            token = object()
            self._active[identifier] = token
        try:
            worker = self.worker_factory(target=self._execute, args=(identifier, token), daemon=True, name='orbis-core-live-' + identifier)
            worker.start()
        except BaseException:
            with self._condition:
                self._active.pop(identifier, None)
                self._condition.notify_all()
            raise
        return self._public(admission, record['phase'], active=True)

    @contextmanager
    def _checked_review(self, admission):
        host = self.service.HOST
        token = host.CORE_LIVE_TRANSACTION.set(admission['id'])
        try:
            with self.review._checked_review(admission['reviewId'], admission['actor']) as checked:
                yield checked
        finally:
            host.CORE_LIVE_TRANSACTION.reset(token)

    def _execute(self, identifier, token):
        record = None
        try:
            admission = self._admission(identifier)
            # Do not carry the saved snapshot's postcondition across shutdown.
            with self._checked_review(admission) as checked:
                evidence, private = self._proof(identifier, checked, admission['targetPreparationId'], admission['actor'])
                require(evidence == admission['evidence'])
                require(all(hashlib.sha256(body).hexdigest() == admission['evidence'][key] for name, body in private.items()
                    for key in [{'connection.json': 'connectionSha256', 'source-authentication.json': 'sourceAuthenticationSha256',
                                 'destination-authentication.json': 'destinationAuthenticationSha256'}[name]]))
            with self._operation(identifier, queued=True) as guard:
                record = self._record(identifier)
                require(record['phase'] == 'admitted' and record['workers'] == {} and record['operations'] == [])
                self._check_claims(admission)
                self._check_marker(identifier)
                require(self.runtime.source_snapshot() == record['source'])
                # Rebind the installed generation and newly prepared empty target
                # under this live operation's own guard, before any downtime.
                prepared = self.preparation._checked_preparation(admission['targetPreparationId'], admission['actor'], guard)
                broker = prepared.manager.broker
                with broker.installed_authority():
                    require(broker.binding() == admission['evidence']['broker']['configuration'])
                    self.runtime.bootstrap_queues_quiet(record)
                    self._phase(record, 'preparing-maintenance')
                    self._overlay(record)
                    self.runtime.bootstrap_queues_quiet(record)
                    self._phase(record, 'stopping-controller')
                    self._stop_controller(record)
                    self.runtime.bootstrap_queues_quiet(record)
                    self.runtime.validate_overlay(record)
                    require(self._facts(record) == record['databaseFacts'])
                    self._inputs(record, admission)
                    self._phase(record, 'reconciling-live')
                    for role in ('source-database', 'target-database'):
                        self._start(record, role, self._auxiliary_body(record, admission, role))
                        self._socket(record, admission, role)
                    require(self._seals(self._directory(identifier) / 'input', record['inputSeals']) == record['inputSeals'])
                    self._start(record, 'live-worker', self._live_body(record, admission))
                    self._wait_worker(record, 'live-worker', 330)
                    outputs = self._outputs(record, admission)
                    self._retired(record)
                    for role in ('target-database', 'source-database'):
                        self._stop_worker(record, role)
                    self._retired(record)
                    stage = {'schema': STAGE, 'id': identifier, 'admissionSha256': record['admissionSha256'],
                        'destinationEvidence': 'live-held-derived', 'prepared': outputs['prepared'], 'evidence': outputs['evidence'],
                        'outputSeals': outputs['seals'], 'retiredFence': copy.deepcopy(record['retiredFence']),
                        'target': copy.deepcopy(admission['evidence']['target']), 'admissionReopened': False, **FLAGS}
                    self._immutable(identifier, 'live-held-stage.json', stage)
                    record['stageSha256'] = self.digest(stage)
                    self._phase(record, 'awaiting-import')
        except BaseException as error:
            try:
                record = self._record(identifier)
                record['failureClass'] = type(error).__name__
                record['failurePhase'] = record['phase']
                self._phase(record, 'recovery-required')
            except (OSError, ValueError, TypeError, KeyError):
                pass
        finally:
            with self._condition:
                if self._active.get(identifier) is token:
                    del self._active[identifier]
                    self._condition.notify_all()

    def _outputs(self, record, admission):
        directory = self._directory(record['id']) / 'output'
        seals = self._seals(directory, OUTPUT_NAMES, output=True)
        values = {name: self._read(record['id'], 'output/' + name) for name in OUTPUT_NAMES}
        hashes = {name: row['sha256'] for name, row in seals.items()}
        request = record['request']
        bound = {'id': record['id'], 'nonce': record['nonce'], 'requestSha256': self.digest(request),
            'authorizationSha256': self.digest(record['authorization']), 'rootIntentSha256': record['admissionSha256'], **WORKER_FLAGS}
        for value in values.values():
            require(type(value) is dict and all(self.P.canonical(value.get(key)) == self.P.canonical(item) for key, item in bound.items()))
        start, fence, intent, completion, result = (values[name] for name in
            ('worker-start.json', 'fence-intent.json', 'write-intent.json', 'completion.json', 'result.json'))
        require(start == {'schema': 'orbis.core-live-reconciliation-start.v1', **bound})
        require(self.P.exact(fence, {'schema', *bound, 'fence'}) and fence['schema'] == 'orbis.core-live-reconciliation-fence-intent.v1')
        raw_fence = fence['fence']
        identity = request['destination']['identity']
        require(self.P.exact(raw_fence, {'schema', 'id', 'nonce', 'rootIntentSha256', 'identity', 'livePid',
                'maintenancePid', 'originalAllowConnections', 'startedAt'})
                and raw_fence['schema'] == 'orbis.core-live-database-fence.v1' and raw_fence['id'] == record['id']
                and raw_fence['nonce'] == record['nonce'] and raw_fence['rootIntentSha256'] == record['admissionSha256']
                and raw_fence['identity'] == identity and raw_fence['originalAllowConnections'] is True
                and all(type(raw_fence[key]) is str and re.fullmatch(r'[1-9][0-9]{0,9}', raw_fence[key]) for key in ('livePid', 'maintenancePid'))
                and raw_fence['livePid'] != raw_fence['maintenancePid']
                and type(raw_fence['startedAt']) is str and re.fullmatch(r'[0-9]+\.[0-9]{6}', raw_fence['startedAt'])
                and raw_fence['startedAt'].replace('.', '') == request['destination']['postmasterEpochUs'])
        require(self.P.exact(intent, {'schema', *bound, 'fenceIntentSha256', 'prepared', 'evidence'})
                and intent['schema'] == 'orbis.core-live-reconciliation-write-intent.v1'
                and intent['fenceIntentSha256'] == hashes['fence-intent.json'])
        prepared, evidence = intent['prepared'], intent['evidence']
        self._prepared(record, admission, prepared)
        expected_evidence = {'schema': 'orbis.core-live-target-reconciliation.v1', 'id': record['id'], 'nonce': record['nonce'],
            'rootIntentSha256': record['admissionSha256'], 'fenceIntentSha256': self.digest(raw_fence),
            'preparedSha256': self.digest(prepared), 'destinationSha256': prepared['destinationSha256'],
            'destinationEvidence': 'held-live-database', **FLAGS}
        require(evidence == expected_evidence)
        require(completion == {'schema': 'orbis.core-live-reconciliation-completion.v1', **bound,
            'writeIntentSha256': hashes['write-intent.json'], 'preparedSha256': self.digest(prepared),
            'databaseCommitAcknowledged': True, 'targetVerified': False})
        require(result == {'schema': 'orbis.core-live-reconciliation-result.v1', **bound,
            'fenceIntentSha256': hashes['fence-intent.json'], 'writeIntentSha256': hashes['write-intent.json'],
            'prepared': prepared, 'evidence': evidence, 'targetVerified': True, 'admissionReopened': False, 'rootMustVerifyRetiredFence': True})
        require(self._seals(directory, OUTPUT_NAMES, output=True) == seals)
        return {'prepared': prepared, 'evidence': evidence, 'seals': seals}

    def _prepared(self, record, admission, prepared):
        request = record['request']
        fields = {'schema', 'id', 'nonce', 'sourceIdentity', 'destinationIdentity', 'targetIdentity', 'sourceSha256',
            'destinationSha256', 'catalogSha256', 'authenticationSha256', 'sourceAccountsSha256', 'destinationAppsSha256',
            'destinationRecoverySha256', 'sourceOwnerId', 'destinationOwnerId', 'catalogOwnershipSha256',
            'catalogContext', 'major', 'environmentProved', 'restoreAuthority', 'marker', 'sequencePolicy'}
        require(self.P.exact(prepared, fields))
        expected = {'schema': 'orbis.core-clean-target-reconciliation.v2', 'id': record['id'], 'nonce': record['nonce'],
            'targetIdentity': request['target']['identity'], 'sourceSha256': request['source']['snapshotSha256'],
            'catalogSha256': request['expected']['catalogSha256'], 'sourceOwnerId': request['sourceOwnerId'],
            'destinationOwnerId': request['destinationOwnerId'], 'catalogContext': 'pg_catalog',
            'major': admission['evidence']['target']['profile']['major'], 'sequencePolicy': request['sequencePolicy'],
            'environmentProved': False, 'restoreAuthority': False}
        require(all(self.P.canonical(prepared[key]) == self.P.canonical(value) for key, value in expected.items()))
        for key in ('destinationSha256', 'sourceAccountsSha256', 'destinationAppsSha256', 'destinationRecoverySha256'):
            require(type(prepared[key]) is str and HEX.fullmatch(prepared[key]))
        source_identity = prepared['sourceIdentity']
        require(self.P.exact(source_identity, {'database', 'databaseOid', 'systemIdentifier'})
                and source_identity['database'] == request['source']['database']
                and source_identity['systemIdentifier'] == admission['evidence']['source']['evidence']['systemIdentifier']
                and type(source_identity['databaseOid']) is str and re.fullmatch(r'[1-9][0-9]{0,9}', source_identity['databaseOid'])
                and int(source_identity['databaseOid']) <= 2 ** 32 - 1)
        require(prepared['destinationIdentity'] == {key: request['destination']['identity'][key]
            for key in ('database', 'databaseOid', 'systemIdentifier')})
        require(len({prepared[key]['systemIdentifier'] for key in ('sourceIdentity', 'destinationIdentity', 'targetIdentity')}) == 3)
        ownership = {'schema': 'orbis.core-catalog-ownership-compatibility.v1', 'sourceSha256': request['source']['snapshotSha256'],
            'destinationSha256': prepared['destinationSha256'], **{key: request['expected']['catalogOwnership'][key]
                for key in ('sourceOwnerId', 'destinationOwnerId', 'owners', 'aliases', 'restoreAuthority')}}
        require(prepared['catalogOwnershipSha256'] == self.digest(ownership))
        auth = self._read(record['id'], 'input/source-authentication.json')
        normalized = {'jwtSecret': auth['jwtSecret']}
        if auth['passkeys'] is not None:
            normalized['passkeys'] = auth['passkeys']
        require(prepared['authenticationSha256'] == self.digest(normalized))
        descriptor = {key: value for key, value in prepared.items() if key != 'marker'}
        require(prepared['marker'] == 'orbis.core-clean-target.v2/' + record['id'] + '/' + record['nonce'] + '/' + self.digest(descriptor))

    def _retired(self, record):
        self._no_ambiguous(record)
        self._check_marker(record['id'])
        self._check_authentication(record, self._admission(record['id']))
        self._controller(record, stopped=True)
        self.runtime.bootstrap_queues_quiet(record)
        self.runtime.validate_overlay(record)
        self._settled(record, 'live-worker')
        facts = self._facts(record)
        require(facts == record['databaseFacts'] | {'allowConnections': False})
        isolated = self._sql_isolated(record)
        require(self._facts(record) == facts)
        self._settled(record, 'live-worker')
        record['retiredFence'] = {'schema': 'orbis.core-live-retired-fence.v1', 'facts': facts, **isolated,
            'workerId': record['workers']['live-worker']['id'], 'workerDefinitionSha256': record['workers']['live-worker']['definition'], **FLAGS}
        self.save(record)
        return record['retiredFence']

    def _ready(self, record, admission):
        require(record['phase'] == 'awaiting-import')
        self._check_claims(admission)
        self.TARGET.verify_workspace(self.TARGET.TargetWorkspace(Path(admission['evidence']['target']['directory']),
            admission['evidence']['target']['profile'], admission['evidence']['target']['workspace']['allocation'],
            admission['evidence']['target']['workspace']['identities']), self.enrollment.a)
        stage = self._read(record['id'], 'live-held-stage.json')
        require(self.digest(stage) == record.get('stageSha256') and stage.get('schema') == STAGE
                and stage.get('destinationEvidence') == 'live-held-derived' and stage.get('admissionSha256') == record['admissionSha256']
                and all(stage.get(key) is expected for key, expected in FLAGS.items()))
        outputs = self._outputs(record, admission)
        require(stage['prepared'] == outputs['prepared'] and stage['evidence'] == outputs['evidence']
                and stage['outputSeals'] == outputs['seals'])
        for role in ('source-database', 'target-database'):
            require(record['workers'][role].get('intent') == 'complete')
            self._settled(record, role)
        require(self._retired(record) == stage['retiredFence'])

    def status(self, request, *, privileged_peer=False):
        identifier, actor = self._request(request, privileged_peer)
        admission, record = self._admission(identifier, actor), self._record(identifier, actor)
        with self._condition:
            active = identifier in self._active
        if active:
            return self._public(admission, record['phase'], active=True)
        try:
            with self._operation(identifier):
                self._check_claims(admission)
                if record['phase'] == 'awaiting-import':
                    self._ready(record, admission)
                    return self._public(admission, 'awaiting-import', ready=True)
                if record['phase'] == 'admitted':
                    self._check_marker(identifier)
                    require(record['workers'] == {} and record['operations'] == [])
                    return self._public(admission, 'admitted')
                if record['phase'] == 'aborted':
                    require(self._read(identifier, 'abort-complete.json')['jobSha256'] == self.digest(record))
                    require(not self._marker_path().exists() and not self._marker_path().is_symlink())
                    return self._public(admission, 'aborted')
        except BlockingIOError:
            return self._public(admission, 'checking')
        except (OSError, ValueError, RuntimeError, KeyError, TypeError):
            pass
        return self._public(admission, 'recovery-required')

    def wait(self, request, *, privileged_peer=False):
        identifier, actor = self._request(request, privileged_peer)
        self._admission(identifier, actor)
        with self._condition:
            self._condition.wait_for(lambda: identifier not in self._active, timeout=25)
        return self.status(request, privileged_peer=True)

    @contextmanager
    def _checked_stage(self, identifier, actor):
        self.C.P.F.I.require_root()
        identifier = self._identifier(identifier)
        actor = self.enrollment.actor(actor)
        token = object()
        with self._condition:
            require(not self._active and identifier not in self._aborting)
            self._active[identifier] = token
        try:
            with self._operation(identifier, queued=True) as guard:
                admission = self._admission(identifier, actor)
                record = self._record(identifier, actor)
                self._ready(record, admission)
                stage = self._read(identifier, 'live-held-stage.json')
                checked = CheckedLiveRestoration(self, admission, record, stage, guard)
                yield checked
                with guard():
                    require(self._admission(identifier, actor) == admission
                            and self._record(identifier, actor) == record
                            and self._read(identifier, 'live-held-stage.json') == stage)
                    self._ready(record, admission)
        finally:
            with self._condition:
                if self._active.get(identifier) is token:
                    del self._active[identifier]
                    self._condition.notify_all()

    def _claim_live_import(self, checked, stage_id):
        require(type(checked) is CheckedLiveRestoration and checked.owner is self)
        identifier = checked.admission['id']
        stage_id = self._identifier(stage_id)
        require(stage_id not in {identifier, checked.admission['reviewId'], checked.admission['targetPreparationId']})
        with checked.guard():
            require(self._admission(identifier) == checked.admission
                    and self._record(identifier) == checked.record
                    and self._read(identifier, 'live-held-stage.json') == checked.stage)
            path = self._directory(identifier) / 'import-claim.json'
            require(not path.exists() and not path.is_symlink())
            claim = {'schema': IMPORT_CLAIM, 'liveJobId': identifier,
                     'liveAdmissionSha256': self.digest(checked.admission), 'stageId': stage_id}
            self._immutable(identifier, 'import-claim.json', claim)
            return claim

    def _settle_live_import(self, record, actor):
        path = self._directory(record['id']) / 'import-claim.json'
        if not path.exists() and not path.is_symlink():
            return
        claim = self._read(record['id'], 'import-claim.json')
        require(self.P.exact(claim, {'schema', 'liveJobId', 'liveAdmissionSha256', 'stageId'})
                and claim['schema'] == IMPORT_CLAIM and claim['liveJobId'] == record['id']
                and claim['liveAdmissionSha256'] == record['admissionSha256']
                and self._identifier(claim['stageId']) != record['id'])
        require(self.service.core_live_imports().assert_settled_for_abort(record['id'], claim, actor) is True)

    def _restore_restart(self, record, policy):
        require(self.P.exact(policy, {'Name', 'MaximumRetryCount'}) and policy['Name'] in {'no', 'always', 'unless-stopped', 'on-failure'}
                and type(policy['MaximumRetryCount']) is int and 0 <= policy['MaximumRetryCount'] <= 2 ** 31 - 1)
        value = policy['Name']
        if value == 'on-failure' and policy['MaximumRetryCount']:
            value += ':' + str(policy['MaximumRetryCount'])
        self._mutate(record, 'abort-controller-restart-policy', {'id': record['source']['controllerId'], 'restartPolicy': policy},
            lambda: self.runtime.change(['update', '--restart', value, record['source']['controllerId']]))
        raw = self._controller(record)
        require(raw['HostConfig']['RestartPolicy'] == policy)

    def _original_healthy(self, record, policy):
        deadline = time.monotonic() + 60
        while True:
            try:
                raw = self._controller(record)
                require(raw['HostConfig']['RestartPolicy'] == policy and raw['State'].get('Status') == 'running'
                        and raw['State'].get('Running') is True and (raw['State'].get('Health') or {}).get('Status') == 'healthy')
                self._probe(raw['Id'], '/api/health')
                self._probe(raw['Id'], '/api/installation/status')
                return
            except (OSError, ValueError, RuntimeError):
                require(time.monotonic() < deadline)
                time.sleep(0.25)

    def abort(self, request, *, privileged_peer=False):
        identifier, actor = self._request(request, privileged_peer, ABORT)
        admission, record = self._admission(identifier, actor), self._record(identifier, actor)
        with self._condition:
            require(identifier not in self._active)
        if record['phase'] == 'aborted':
            return self.status({'id': identifier, 'actor': actor}, privileged_peer=True)
        with self._condition:
            require(identifier not in self._active and identifier not in self._aborting)
            self._aborting.add(identifier)
        try:
            with self._operation(identifier, queued=True):
                self._check_claims(admission)
                self._check_marker(identifier)
                self._no_ambiguous(record)
                self._settle_live_import(record, actor)
                decision = {'schema': 'orbis.core-live-abort-decision.v1', 'id': identifier,
                    'admissionSha256': record['admissionSha256'], 'action': ABORT, **FLAGS}
                self._immutable(identifier, 'abort-decision.json', decision)
                self._phase(record, 'aborting')
                # Every known worker is bound and positively settled. An unknown
                # create/start reply above remains recovery; it is never replayed.
                for role in ('live-worker', 'target-database', 'source-database'):
                    if role in record['workers']:
                        self._stop_worker(record, role, success=False)
                self._check_authentication(record, admission, allow_restart=True)
                facts = self._facts(record, allow_restart=True)
                expected = record['databaseFacts']
                require(all(facts[key] == expected[key] for key in expected if key in
                    {'systemIdentifier', 'database', 'databaseOid', 'role', 'roleOid', 'serverVersionNum'}))
                # An admitted operation may be cancelled before controller stop.
                stopped = any(item['name'] == 'controller-stop' for item in record['operations'])
                if stopped:
                    self._controller(record, stopped=True)
                    self.runtime.bootstrap_queues_quiet(record)
                    isolated = self._sql_isolated(record, allow_restart=True)
                    require(self._facts(record, allow_restart=True) == facts)
                    self._immutable(identifier, 'abort-quiescence.json', {'schema': 'orbis.core-live-abort-quiescence.v1',
                        'id': identifier, 'decisionSha256': self.digest(decision), 'facts': facts, **isolated, **FLAGS})
                    if facts['allowConnections'] is False:
                        query = 'ALTER DATABASE ' + quote(record['databaseName']) + ' ALLOW_CONNECTIONS true'
                        self._mutate(record, 'abort-open-original-admission', {'databaseOid': facts['databaseOid'], 'query': query},
                            lambda: self._sql(record, query + '; SELECT json_build_object(\'changed\',true)', allow_restart=True))
                    require(self._facts(record, allow_restart=True) == facts | {'allowConnections': True})
                    self._sql_isolated(record, allow_restart=True)
                else:
                    require(not any(role in record['workers'] for role in ('live-worker', 'source-database', 'target-database'))
                            and facts['allowConnections'] is True)
                policy = admission['evidence']['originalRestartPolicy']
                raw = self._controller(record)
                if raw['HostConfig']['RestartPolicy'] != policy:
                    self._restore_restart(record, policy)
                if raw['State'].get('Running') is not True:
                    self._mutate(record, 'abort-start-original', {'id': raw['Id']}, lambda: self.runtime.change(['start', raw['Id']]))
                self._original_healthy(record, policy)
                require(self._facts(record, allow_restart=True)['allowConnections'] is True)
                if 'responder' in record['workers']:
                    raw = self._worker(record, 'responder')
                    self._mutate(record, 'abort-disable-responder-restart', {'id': raw['Id']},
                        lambda: self.runtime.change(['update', '--restart', 'no', raw['Id']]))
                    self._stop_worker(record, 'responder', success=False)
                self._original_healthy(record, policy)
                self._phase(record, 'aborted')
                self._immutable(identifier, 'abort-complete.json', {'schema': 'orbis.core-live-abort-complete.v1',
                    'id': identifier, 'decisionSha256': self.digest(decision), 'jobSha256': self.digest(record), **FLAGS})
                self._check_marker(identifier)
                self._marker_path().unlink()
                self.enrollment.sync(self._marker_path().parent)
        except BaseException:
            self._phase(record, 'recovery-required')
            raise
        finally:
            with self._condition:
                self._aborting.discard(identifier)
                self._condition.notify_all()
        return self._public(admission, 'aborted')

    def resume_pending(self):
        """Observe only. Crash recovery never starts, retries, or adopts a worker."""
        try:
            pending = []
            for identifier in self._names():
                record = self._record(identifier)
                if record['phase'] in TERMINAL:
                    require(self._read(identifier, 'abort-complete.json')['jobSha256'] == self.digest(record))
                else:
                    self._check_claims(self._admission(identifier))
                    pending.append(identifier)
            marker_exists = self._marker_path().exists() or self._marker_path().is_symlink()
            if not pending:
                require(not marker_exists)
                return {'state': 'idle'}
            require(len(pending) == 1 and marker_exists)
            self._check_marker(pending[0])
            with self._condition:
                active = pending[0] in self._active or pending[0] in self._aborting
            return {'state': 'restoring' if active else 'recovery'}
        except (OSError, ValueError, RuntimeError, TypeError, KeyError):
            return {'state': 'recovery'}

    def maintenance(self):
        return self.resume_pending()
