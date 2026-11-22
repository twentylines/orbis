"""Root-owned inspection supervision; deliberately absent from public execution routes."""
import copy
import importlib.util
import os
from pathlib import Path
import re
import secrets
import stat
import time


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


PROFILE = load('orbis-host-core-inspection-profile.py', 'orbis_supervised_core_inspection_profile')
HEX = re.compile('[a-f0-9]{64}')

STRUCTURE_V1 = 'orbis.core-database-structure.v1'
STRUCTURE_V2 = 'orbis.core-database-structure.v2'
STRUCTURE_V3 = 'orbis.core-database-structure.v3'
APP_MIGRATION_SQL_SHA256 = '931cd10ce91be3582efccc9c17d34d9042db48db925b90b2e88b75496060602a'
APP_MIGRATION_JOURNAL_TIME = '1795203554058'
APP_COMMIT_SQL_SHA256 = '838b363174dd85025ce1eff4d4a0c29aaa5cf68a9276b722ff8e8ca39153f3b8'
APP_COMMIT_JOURNAL_TIME = '1795305600000'


def structure_history_schema(history):
    commits = [row for row in history
               if row['hash'] == APP_COMMIT_SQL_SHA256 or row['created_at'] == APP_COMMIT_JOURNAL_TIME]
    if commits and (len(commits) != 1 or commits[0]['hash'] != APP_COMMIT_SQL_SHA256
                    or commits[0]['created_at'] != APP_COMMIT_JOURNAL_TIME):
        return None
    markers = [row for row in history
               if row['hash'] == APP_MIGRATION_SQL_SHA256 or row['created_at'] == APP_MIGRATION_JOURNAL_TIME]
    if not markers:
        return None if commits else STRUCTURE_V1
    if (len(markers) == 1 and markers[0]['hash'] == APP_MIGRATION_SQL_SHA256
            and markers[0]['created_at'] == APP_MIGRATION_JOURNAL_TIME):
        return STRUCTURE_V3 if commits else STRUCTURE_V2
    return None


def structure_row_tables(schema):
    legacy = {'user', 'link', 'app_store', 'app', 'orbis_reset_receipt', '__drizzle_migrations'}
    if schema == STRUCTURE_V1:
        return legacy
    if schema == STRUCTURE_V2:
        return legacy | {'app_migration'}
    if schema == STRUCTURE_V3:
        return legacy | {'app_migration', 'app_migration_commit'}
    return None


class ExecutorError(ValueError):
    pass


def validate_database_execution(profile, request, observation):
    PROFILE.validate_profile(profile)
    fields = {'schema', 'profileId', 'serverVersionNum', 'major', 'database', 'locale', 'localeProviderEvidence'}
    if (profile['schema'] != PROFILE.EXECUTION_SCHEMA or not isinstance(observation, dict) or set(observation) != fields
            or observation['schema'] != 'orbis.core-pg-execution-observation.v1'
            or observation['profileId'] != profile['profileId']
            or type(observation['major']) is not int or observation['major'] != profile['major']
            or type(observation['serverVersionNum']) is not int or not 100000 <= observation['serverVersionNum'] <= 999999
            or observation['serverVersionNum'] // 10000 != profile['major']
            or observation['database'] != request.get('database')
            or observation['localeProviderEvidence'] != ('postgresql14-libc-database-default' if profile['major'] == 14 else 'pg_database.datlocprovider')):
        raise ExecutorError('The PostgreSQL execution observation differs from its bounded profile')
    locale = observation['locale']
    if (not isinstance(locale, dict) or set(locale) != {'encoding', 'collate', 'ctype', 'provider'}
            or locale['encoding'] != 'UTF8' or locale['provider'] != 'c'):
        raise ExecutorError('The PostgreSQL execution locale is unsupported')
    for name in ('collate', 'ctype'):
        value = locale[name]
        try:
            valid = isinstance(value, str) and 0 < len(value.encode('utf-8')) <= 256 and all(ord(char) >= 32 and ord(char) != 127 for char in value)
        except UnicodeError:
            valid = False
        if not valid:
            raise ExecutorError('The PostgreSQL execution locale is unsupported')
    return observation


class InspectionSupervisor:
    """The manager is an internal Root capability, never a serialized worker grant."""
    def __init__(self, manager, record):
        self.manager, self.record = manager, record
        self.runtime, self.a, self.P = manager.enrollment.runtime, manager.a, manager.P

    def save(self):
        if hasattr(self, '_start_claim'):
            body = self.manager.enrollment.read(self._start_path, 16384)
            if (body != self.P.canonical(self._start_claim)
                    or self.record.get('inspectionSupervisorSha256') != self.manager.digest(self._start_claim)):
                raise ExecutorError('Inspection supervisor ownership changed')
        self.manager.save(self.record)

    def inspect(self, role):
        worker = self.record['inspectionWorkers'][role]
        raw = self.runtime.inspect(worker['id'])
        if (raw.get('Id') != worker['id'] or raw.get('Image') != worker['body']['Image']
                or raw.get('Name') != '/' + worker['name']):
            raise ExecutorError('Inspection worker identity changed')
        expected = copy.deepcopy(worker['body'])
        # The shared intent reader requires an explicit network projection even
        # though Docker derives it from NetworkMode=none for this create body.
        expected['NetworkingConfig'] = {'EndpointsConfig': {'none': {}}}
        health = (raw.get('Config') or {}).get('Healthcheck')
        if (not isinstance(health, dict) or health.get('Test') != ['NONE']
                or set(health) - {'Test', 'Interval', 'Timeout', 'StartPeriod', 'StartInterval', 'Retries'}
                or any(type(value) is not int or value < 0 for key, value in health.items() if key != 'Test')):
            raise ExecutorError('Inspection health commands must remain disabled')
        # Disabled health metadata may retain image defaults after Docker merges
        # config. It cannot execute a probe and remains in the pinned definition.
        expected['Healthcheck'] = health
        self.runtime.check_intent(raw, expected)
        host = raw['HostConfig']
        if (host.get('NetworkMode') != 'none' or host.get('ReadonlyRootfs') is not True
                or host.get('Privileged') is not False or host.get('AutoRemove') is not False
                or host.get('CapAdd') or host.get('CapDrop') != ['ALL']
                or host.get('SecurityOpt') != ['no-new-privileges'] or host.get('CgroupnsMode') != 'private'
                or host.get('PidMode') not in {'', None} or host.get('IpcMode') != 'private'
                or host.get('Binds') or host.get('VolumesFrom') or host.get('Devices')
                or not set(raw.get('NetworkSettings', {}).get('Networks', {})) <= {'none'}):
            raise ExecutorError('Inspection worker isolation changed')
        return raw

    def create_start(self, role, body):
        workers = self.record.setdefault('inspectionWorkers', {})
        if role in workers:
            raise ExecutorError('A prior inspection worker requires protected review')
        name = 'orbis-core-inspect-' + role + '-' + self.record['id']
        worker = {'name': name, 'body': body, 'intent': 'creating'}
        workers[role] = worker
        self.save()
        response = self.P.metadata(self.runtime.engine('POST', '/containers/create?name=' + name, body))
        identifier = response.get('Id')
        if not isinstance(identifier, str) or not HEX.fullmatch(identifier):
            raise ExecutorError('Inspection worker creation was not identified')
        worker.update(id=identifier, intent='created')
        self.save()
        raw = self.inspect(role)
        if not self.runtime.never_started(raw):
            raise ExecutorError('Inspection worker ran before its durable start intent')
        worker['definitionSha256'] = self.runtime.definition(raw)
        worker['intent'] = 'starting'
        self.save()
        self.runtime.change(['start', identifier])
        worker['intent'] = 'running'
        self.save()

    def wait(self, role, timeout):
        worker = self.record['inspectionWorkers'][role]
        worker['intent'] = 'waiting'
        self.save()
        status = self.runtime.bounded_output(['docker', '--context', self.manager.context, 'wait', worker['id']], 32, timeout)
        raw = self.inspect(role)
        state = raw.get('State') or {}
        if (status.strip() != b'0' or state.get('Status') != 'exited' or state.get('Running') is not False
                or state.get('Restarting') is not False or state.get('Dead') is not False or state.get('OOMKilled') is not False
                or state.get('ExitCode') != 0 or not isinstance(state.get('FinishedAt'), str)
                or state['FinishedAt'].startswith('0001-') or self.runtime.definition(raw) != worker['definitionSha256']):
            raise ExecutorError('Inspection worker did not positively settle')
        worker.update(intent='complete', terminal={'id': worker['id'], 'definitionSha256': worker['definitionSha256'], 'state': copy.deepcopy(state)})
        self.save()

    def socket_available(self, directory, profile):
        deadline = time.monotonic() + 15
        while True:
            raw = self.inspect('database')
            state = raw.get('State') or {}
            if (state.get('Status') != 'running' or state.get('Running') is not True
                    or state.get('Restarting') is not False or state.get('Paused') is not False):
                raise ExecutorError('The isolated PostgreSQL startup did not remain bound and running')
            try:
                details = (directory / 'socket/.s.PGSQL.5432').lstat()
            except FileNotFoundError:
                details = None
            if details is not None:
                if (not stat.S_ISSOCK(details.st_mode) or details.st_uid != profile['uid']
                        or details.st_gid != profile['gid'] or stat.S_IMODE(details.st_mode) != 0o770):
                    raise ExecutorError('The isolated PostgreSQL transport identity is unsupported')
                # A transport hint only: the trusted coordinator must perform
                # actual SQL/settings checks; this never proves health or exit.
                return
            if time.monotonic() >= deadline:
                raise ExecutorError('The isolated PostgreSQL transport did not become available')
            time.sleep(0.1)

    def stop_database(self):
        worker = self.record['inspectionWorkers']['database']
        state = self.inspect('database').get('State') or {}
        if state.get('Running') is not True or state.get('Status') != 'running' or state.get('Restarting') is not False:
            raise ExecutorError('PostgreSQL did not remain bound before its owned stop')
        worker['intent'] = 'stopping'
        self.save()
        self.runtime.change(['stop', '--time', '20', worker['id']])
        self.wait('database', 45)

    def require_request(self, profile, request):
        """Bind the manager's projection without creating source-environment authority."""
        PROFILE.validate_profile(profile)
        versioned = profile['schema'] == PROFILE.EXECUTION_SCHEMA
        role_bound = profile['schema'] in {PROFILE.ROLE_SCHEMA, PROFILE.EXECUTION_SCHEMA}
        bootstrap = request.get('schema') in {'orbis.core-inspection-worker-input.v3', 'orbis.core-inspection-worker-input.v4'}
        extra = {'role', 'sourceProjectionSha256'} if role_bound else set()
        if bootstrap:
            extra.add('evidenceScope')
        if versioned:
            extra.add('executionProfile')
        fields = {'schema', 'id', 'nonce', 'permitSha256', 'resourcesSha256', 'sourceManifestSha256',
                  'database', 'sourceOwnerId', 'sourceImageId', 'sourceAuthenticationSha256', 'settingsSha256'} | extra
        if (not self.P.exact(request, fields)
                or request.get('schema') != 'orbis.core-inspection-worker-input.' + ('v4' if versioned else 'v3' if bootstrap else 'v2' if role_bound else 'v1')
                or bootstrap and (not role_bound or request.get('evidenceScope') != 'authenticated-bootstrap-source')
                or not isinstance(request.get('database'), str) or not PROFILE.NAME.fullmatch(request['database'])):
            raise ExecutorError('The inspection request version or database is unsupported')
        if versioned:
            source = self.record['evidence']['source']
            compatibility = source.get('compatibility')
            if (self.record.get('schema') != 'orbis.core-restore-inspection.v4'
                    or source.get('origin') != 'genuine-root-local-capture'
                    or self.record.get('sandboxProfile') != PROFILE.EXECUTION_SCHEMA
                    or self.record['evidence'].get('profile') != profile
                    or request.get('executionProfile') != profile['profileId']
                    or request.get('sourceImageId') != profile['imageId']
                    or request.get('settingsSha256') != PROFILE.digest(self.P.canonical(PROFILE.settings_for(profile)))
                    or not isinstance(compatibility, dict)
                    or any(compatibility.get(key) != profile[key] for key in ('os', 'architecture'))
                    or compatibility.get('database') != {'engine': 'postgresql', 'major': profile['major']}
                    or source.get('images', {}).get('database') != profile['imageId']):
                raise ExecutorError('The versioned inspection is not bound to a fresh exact source profile')
        if role_bound:
            projection = self.record['evidence']['source'].get('environmentProjection')
            if (not isinstance(projection, dict) or projection.get('schema') != 'orbis.core-source-environment.v2'
                    or projection.get('sourceManifestSha256') != request['sourceManifestSha256']
                    or request['role'] != profile['role'] or request['sourceProjectionSha256'] != profile['sourceProjectionSha256']
                    or self.manager.digest(projection) != request['sourceProjectionSha256']
                    or any(projection.get(key) != request[key] for key in ('role', 'database', 'sourceAuthenticationSha256'))
                    or not isinstance(request['sourceAuthenticationSha256'], str)
                    or not HEX.fullmatch(request['sourceAuthenticationSha256'])):
                raise ExecutorError('The role-bound source projection differs from the inspection request')
        return role_bound

    def checked_result(self, directory, request, profile=None):
        if profile is None and (request.get('schema') != 'orbis.core-inspection-worker-input.v1'
                                or any(key in request for key in ('role', 'sourceProjectionSha256'))):
            raise ExecutorError('A role-bound inspection result requires its exact profile')
        role_bound = self.require_request(profile, request) if profile is not None else False
        versioned = request.get('schema') == 'orbis.core-inspection-worker-input.v4'
        bootstrap = request.get('schema') in {'orbis.core-inspection-worker-input.v3', 'orbis.core-inspection-worker-input.v4'}
        with self.a.protected_directory(directory / 'output'):
            if set(os.listdir(directory / 'output')) != {'result.json'}:
                raise ExecutorError('Inspection output custody is incomplete')
        report = self.manager.enrollment.json(directory / 'output/result.json', 16 * 1024 * 1024)
        fields = {'schema', 'id', 'nonce', 'inputSha256', 'permitSha256', 'resourcesSha256', 'sourceManifestSha256',
                  'sourceImageId', 'settingsSha256', 'structure', 'sourceAuthenticationSha256', 'sourceOwner', 'compatibilityRefusal', 'restoreAuthority'}
        extra = ('role', 'sourceProjectionSha256') if role_bound else ()
        if bootstrap:
            extra += ('evidenceScope',)
            fields.add('bootstrapSource')
        if versioned:
            extra += ('executionProfile',)
            fields.add('databaseExecution')
        fields.update(extra)
        if (not self.P.exact(report, fields) or report['schema'] != 'orbis.core-inspection-worker-result.' + ('v4' if versioned else 'v3' if bootstrap else 'v2' if role_bound else 'v1')
                or report['restoreAuthority'] is not False
                or report['inputSha256'] != self.manager.digest(request)
                or any(report[key] != request[key] for key in ('id', 'nonce', 'permitSha256', 'resourcesSha256', 'sourceManifestSha256',
                                                             'sourceImageId', 'settingsSha256', 'sourceAuthenticationSha256', *extra))):
            raise ExecutorError('Inspection output did not bind its exact admitted input')
        structure = report['structure']
        expected_major = profile['major'] if versioned else 17
        row_tables = structure_row_tables(structure.get('schema')) if isinstance(structure, dict) else None
        if (not self.P.exact(structure, {'schema', 'sha256', 'major', 'catalogSha256', 'rows', 'authenticationVerified', 'restoreAuthority'})
                or row_tables is None
                or type(structure['major']) is not int or structure['major'] != expected_major
                or structure['authenticationVerified'] is not False or structure['restoreAuthority'] is not False
                or any(not isinstance(structure[key], str) or not HEX.fullmatch(structure[key]) for key in ('sha256', 'catalogSha256'))
                or not self.P.exact(structure['rows'], row_tables)
                or any(type(value) is not int or not 0 <= value <= 100000 for value in structure['rows'].values())):
            raise ExecutorError('Inspection structure evidence is invalid')
        owner = report['sourceOwner']
        if request['sourceAuthenticationSha256'] is None:
            if owner is not None or report['compatibilityRefusal'] != 'source-authentication-unavailable':
                raise ExecutorError('Missing source authentication was concealed')
        elif (not self.P.exact(owner, {'schema', 'sourceOwnerId', 'sourceSha256', 'identitySha256', 'authenticationSha256', 'restoreAuthority'})
                or owner['schema'] != 'orbis.core-source-owner.v1' or owner['sourceOwnerId'] != request['sourceOwnerId']
                or owner['sourceSha256'] != structure['sha256'] or owner['restoreAuthority'] is not False
                or report['compatibilityRefusal'] != ('source-effective-environment-unproved' if role_bound else None)
                or any(not isinstance(owner[key], str) or not HEX.fullmatch(owner[key]) for key in ('identitySha256', 'authenticationSha256'))):
            raise ExecutorError('The source account or authentication evidence is invalid')
        if versioned:
            validate_database_execution(profile, request, report['databaseExecution'])
            if not isinstance(report['bootstrapSource'], dict) or report['bootstrapSource'].get('schema') != 'orbis.core-source-bootstrap-evidence.v2':
                raise ExecutorError('Versioned bootstrap inspection requires complete authenticated catalog identities')
        if bootstrap:
            self.check_bootstrap_source(report['bootstrapSource'], request, structure, owner)
        return report

    def check_bootstrap_source(self, evidence, request, structure, owner):
        fields = {'schema', 'sourceSha256', 'catalogSha256', 'authenticationSha256', 'sourceOwnerId',
                  'identitySha256', 'database', 'systemIdentifier', 'migrationLedger',
                  'authenticationVerified', 'environmentProved', 'restoreAuthority'}
        catalog = isinstance(evidence, dict) and evidence.get('schema') == 'orbis.core-source-bootstrap-evidence.v2'
        if catalog:
            fields.add('catalogUserIdentities')
        if (not self.P.exact(evidence, fields)
                or evidence['schema'] not in {'orbis.core-source-bootstrap-evidence.v1', 'orbis.core-source-bootstrap-evidence.v2'}
                or not isinstance(owner, dict) or evidence['sourceSha256'] != structure['sha256']
                or evidence['catalogSha256'] != structure['catalogSha256']
                or type(evidence['sourceOwnerId']) is not int or evidence['sourceOwnerId'] != request['sourceOwnerId']
                or evidence['identitySha256'] != owner['identitySha256']
                or evidence['authenticationSha256'] != owner['authenticationSha256']
                or evidence['database'] != request['database'] or evidence['authenticationVerified'] is not True
                or evidence['environmentProved'] is not False or evidence['restoreAuthority'] is not False
                or not isinstance(evidence['systemIdentifier'], str)
                or not re.fullmatch(r'[1-9][0-9]{0,19}', evidence['systemIdentifier'])
                or int(evidence['systemIdentifier']) > 18446744073709551615
                or type(evidence['migrationLedger']) is not list
                or not 1 <= len(evidence['migrationLedger']) <= 4096
                or len(evidence['migrationLedger']) != structure['rows']['__drizzle_migrations']):
            raise ExecutorError('Authenticated source bootstrap evidence is invalid')
        previous = 0
        for row in evidence['migrationLedger']:
            if (not self.P.exact(row, {'id', 'hash', 'created_at'}) or type(row['id']) is not int
                    or not previous < row['id'] <= 2147483647 or not isinstance(row['hash'], str)
                    or not HEX.fullmatch(row['hash']) or not isinstance(row['created_at'], str)
                    or not re.fullmatch(r'[1-9][0-9]{0,15}', row['created_at'])
                    or int(row['created_at']) > 9007199254740991):
                raise ExecutorError('Authenticated source migration history is invalid')
            previous = row['id']
        if structure_history_schema(evidence['migrationLedger']) != structure['schema']:
            raise ExecutorError('The inspection structure differs from authenticated migration history')
        if catalog:
            users = evidence['catalogUserIdentities']
            if (type(users) is not list or not 1 <= len(users) <= 250000
                    or len(users) != structure['rows']['user']):
                raise ExecutorError('Authenticated source catalog identities are invalid')
            previous, source_identity = 0, None
            for row in users:
                if (not self.P.exact(row, {'ownerId', 'identitySha256'}) or type(row['ownerId']) is not int
                        or not previous < row['ownerId'] <= 2147483647
                        or not isinstance(row['identitySha256'], str) or not HEX.fullmatch(row['identitySha256'])):
                    raise ExecutorError('Authenticated source catalog identities are invalid')
                previous = row['ownerId']
                if row['ownerId'] == evidence['sourceOwnerId']:
                    source_identity = row['identitySha256']
            if source_identity != evidence['identitySha256']:
                raise ExecutorError('Authenticated source catalog owner is invalid')

    def checked_completion(self, directory, profile):
        """Read a completed owned execution; no waits, replay or worker changes."""
        record = self.record
        if (record.get('phase') != 'inspection-complete' or record.get('scope') != 'inspection-only'
                or record.get('activationAuthorized') is not False
                or self.manager.record(record['id']) != record):
            raise ExecutorError('Source inspection has no verified completion')
        self.manager.validate_execution_claim(record)
        binding = record.get('executionDirectory')
        if not isinstance(binding, dict) or str(directory) != binding.get('path'):
            raise ExecutorError('Completed source directory binding changed')
        with self.a.protected_directory(directory) as descriptor:
            details = os.fstat(descriptor)
            if any(getattr(details, 'st_' + field) != binding.get(key) for key, field in (
                    ('device', 'dev'), ('inode', 'ino'), ('mode', 'mode'), ('uid', 'uid'), ('gid', 'gid'))):
                raise ExecutorError('Completed source directory identity changed')
        start = self.manager.enrollment.json(directory / 'supervisor-start.json', 16384)
        if (not self.P.exact(start, {'schema', 'id', 'executionClaimSha256', 'directory',
                                    'permitSha256', 'requestSha256', 'nonce'})
                or start.get('schema') != 'orbis.core-inspection-supervisor-start.v1'
                or start.get('id') != record['id'] or start.get('directory') != binding
                or start.get('executionClaimSha256') != record['executionClaimSha256']
                or start.get('permitSha256') != record['executionPermitSha256']
                or start.get('requestSha256') != record['executionRequestSha256']
                or not isinstance(start.get('nonce'), str) or not HEX.fullmatch(start['nonce'])
                or self.manager.digest(start) != record.get('inspectionSupervisorSha256')):
            raise ExecutorError('Completed source supervisor ownership changed')
        workers = record.get('inspectionWorkers')
        if not isinstance(workers, dict) or set(workers) != {'database', 'coordinator'}:
            raise ExecutorError('Completed source workers are incomplete')
        for role, worker in workers.items():
            raw = self.inspect(role)
            terminal = worker.get('terminal')
            state = raw.get('State') or {}
            if (not self.P.exact(terminal, {'id', 'definitionSha256', 'state'})
                    or worker.get('intent') != 'complete' or terminal['id'] != worker['id']
                    or terminal['definitionSha256'] != worker['definitionSha256']
                    or self.runtime.definition(raw) != worker['definitionSha256'] or state != terminal['state']
                    or state.get('Status') != 'exited' or state.get('ExitCode') != 0
                    or any(state.get(key) is not False for key in ('Running', 'Restarting', 'Paused', 'Dead', 'OOMKilled'))
                    or not isinstance(state.get('FinishedAt'), str) or state['FinishedAt'].startswith('0001-')):
                raise ExecutorError('Completed source worker terminal proof changed')
        request = self.manager.enrollment.json(directory / 'trusted-input/request.json', 16384)
        if (self.manager.digest(request) != record['executionRequestSha256']
                or request.get('permitSha256') != record['executionPermitSha256']):
            raise ExecutorError('Completed source request binding changed')
        report = self.checked_result(directory, request, profile)
        terminal_sha = self.manager.digest({key: value['terminal'] for key, value in workers.items()})
        completion = self.manager.enrollment.json(directory / 'inspection-complete.json', 16384)
        if (record.get('inspectionResultSha256') != self.manager.digest(report)
                or record.get('inspectionTerminalSha256') != terminal_sha
                or completion != {'schema': 'orbis.core-inspection-completion.v1', 'id': record['id'],
                                  'permitSha256': request['permitSha256'], 'resultSha256': self.manager.digest(report),
                                  'terminalSha256': terminal_sha, 'restoreAuthority': False}):
            raise ExecutorError('Completed source receipt changed')
        return report

    def run_workers(self, directory, profile, request):
        with self.manager.runtime_authority():
            return self._run_workers(directory, profile, request)

    def _run_workers(self, directory, profile, request):
        if (self.record.get('phase') != 'inspecting' or 'inspectionWorkers' in self.record
                or self.record.get('scope') != 'inspection-only' or self.record.get('activationAuthorized') is not False
                or self.record.get('executionPermitSha256') != request.get('permitSha256')
                or self.record.get('executionRequestSha256') != self.manager.digest(request)
                or self.manager.record(self.record['id']) != self.record):
            raise ExecutorError('Inspection execution requires a fresh claimed Root inspection permit')
        directory = Path(directory)
        binding = self.record.get('executionDirectory')
        if (not self.P.exact(binding, {'path', 'device', 'inode', 'mode', 'uid', 'gid'})
                or str(directory) != binding['path']):
            raise ExecutorError('Inspection directory differs from its consumed claim')
        with self.a.protected_directory(directory) as descriptor:
            details = os.fstat(descriptor)
            if any(getattr(details, 'st_' + field) != binding[key] for key, field in (
                    ('device', 'dev'), ('inode', 'ino'), ('mode', 'mode'), ('uid', 'uid'), ('gid', 'gid'))):
                raise ExecutorError('Inspection directory identity changed')
        self.manager.validate_execution_claim(self.record)
        start_claim = {'schema': 'orbis.core-inspection-supervisor-start.v1', 'id': self.record['id'],
                       'executionClaimSha256': self.record['executionClaimSha256'], 'directory': binding,
                       'permitSha256': request['permitSha256'], 'requestSha256': self.manager.digest(request),
                       'nonce': secrets.token_hex(32)}
        start_path = directory / 'supervisor-start.json'
        try:
            self.manager.enrollment.immutable(start_path, self.P.canonical(start_claim))
        except (OSError, ValueError):
            # A duplicate never enters the job-writing exception handler.
            raise ExecutorError('A prior inspection supervisor requires protected review') from None
        self._start_claim, self._start_path = start_claim, start_path
        self.record['inspectionSupervisorSha256'] = self.manager.digest(start_claim)
        try:
            self.save()
            self.manager.require_current(self.record)
            role_bound = self.require_request(profile, request)
            image = self.runtime.image(profile['imageId'])
            expected_profile = (PROFILE.role_bound_execution_profile(image, profile['role'], profile['sourceProjectionSha256'])
                                if profile['schema'] == PROFILE.EXECUTION_SCHEMA else
                                PROFILE.role_bound_image_profile(image, profile['role'], profile['sourceProjectionSha256'])
                                if role_bound else PROFILE.image_profile(image))
            if (expected_profile != profile
                    or request['sourceImageId'] != profile['imageId']
                    or request['settingsSha256'] != PROFILE.digest(self.P.canonical(PROFILE.settings_for(profile)))):
                raise ExecutorError('The admitted source image or effective-settings profile changed')
            destination = self.record['evidence']['destination']
            local_origin = (self.record.get('schema') in {'orbis.core-restore-inspection.v2', 'orbis.core-restore-inspection.v3', 'orbis.core-restore-inspection.v4'}
                            and self.record['evidence']['source'].get('origin') == 'genuine-root-local-capture')
            node_image_id = destination['inspectionCoordinatorImageId'] if local_origin else destination['imageId']
            node_image = self.runtime.image(node_image_id)
            if (node_image.get('Id') != node_image_id
                    or node_image.get('Os') != 'linux' or node_image.get('Architecture') != profile['architecture']
                    or node_image.get('Config', {}).get('Volumes') not in (None, {})):
                raise ExecutorError('The trusted coordinator image platform changed')
            overlay = self.manager.enrollment.json(directory / 'overlay.json')
            if self.manager.digest(overlay) != self.record['executionOverlaySha256']:
                raise ExecutorError('Inspection overlay custody changed')
            PROFILE.verify_overlay(directory, overlay, self.a)
            if overlay.get('profile') != profile:
                raise ExecutorError('The inspection overlay profile changed')
            body = self.manager.enrollment.read(directory / 'trusted-input/request.json', 16384)
            if (body != self.P.canonical(request)
                    or request.get('id') != self.record['id'] or not isinstance(request.get('nonce'), str) or not HEX.fullmatch(request['nonce'])
                    or request.get('resourcesSha256') != self.record['evidence']['source']['resourcesSha256']
                    or request.get('sourceManifestSha256') != self.record['evidence']['source']['payload']['manifestSha256']
                    or request.get('sourceOwnerId') != self.record['evidence']['source']['sourceOwnerId']):
                raise ExecutorError('Inspection input custody changed')
            expected = {'request.json'}
            if request.get('sourceAuthenticationSha256') is not None:
                expected.add('source-authentication.json')
                authentication = self.manager.enrollment.read(directory / 'trusted-input/source-authentication.json', 2 * 1024 * 1024)
                if PROFILE.digest(authentication) != request['sourceAuthenticationSha256']:
                    raise ExecutorError('Trusted source authentication custody changed')
                decoded = self.P.metadata(authentication, byte_limit=2 * 1024 * 1024, string_limit=2 * 1024 * 1024)
                if (not self.P.exact(decoded, {'jwtSecret', 'passkeys'}) or not isinstance(decoded['jwtSecret'], str)
                        or not 32 <= len(decoded['jwtSecret']) <= 4096):
                    raise ExecutorError('Only bounded source authentication is accepted by the trusted coordinator')
            with self.a.protected_directory(directory / 'trusted-input'):
                if set(os.listdir(directory / 'trusted-input')) != expected:
                    raise ExecutorError('Unexpected trusted inspection input')
            if self.manager.digest(PROFILE.coordinator_inventory(directory / 'coordinator', self.a)) != self.record['executionCoordinatorSha256']:
                raise ExecutorError('The trusted coordinator closure changed')
            self.manager.validate_prepared_execution(self.record, directory)
            self.create_start('database', PROFILE.database_body(self.record['id'], request['nonce'], directory, profile))
            self.socket_available(directory, profile)
            self.create_start('coordinator', PROFILE.coordinator_body(self.record['id'], request['nonce'], directory, profile,
                                                                      node_image_id))
            self.wait('coordinator', 180)
            report = self.checked_result(directory, request, profile)
            self.stop_database()
            self.record.update(phase='inspection-complete', inspectionResultSha256=self.manager.digest(report),
                               inspectionTerminalSha256=self.manager.digest({key: value['terminal'] for key, value in self.record['inspectionWorkers'].items()}))
            self.manager.enrollment.immutable(directory / 'inspection-complete.json', self.P.canonical({
                'schema': 'orbis.core-inspection-completion.v1', 'id': self.record['id'], 'permitSha256': request['permitSha256'],
                'resultSha256': self.record['inspectionResultSha256'], 'terminalSha256': self.record['inspectionTerminalSha256'],
                'restoreAuthority': False}))
            self.save()
            return report
        except BaseException as error:
            self.record.update(phase='recovery-required', inspectionFailureClass=type(error).__name__)
            self.save()
            raise
