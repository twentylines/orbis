#!/usr/bin/env python3
"""Root-only Fresh reservation, cutover, birth and activation outcomes.

This issuer consumes its own exact legacy decision witness, never a caller's
managed/unmanaged flag. It grants no Main credential authority. Its lifecycle
hold retires only after fixed live terminal verification. Entry points require
the exact live Root guard and positively approved legacy transaction.
"""
import copy
from contextlib import ExitStack, contextmanager
import hashlib
import importlib.util
import os
from pathlib import Path
import re
from types import SimpleNamespace


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


L = load('orbis-host-legacy-ownership.py', 'orbis_fresh_legacy_proof')
OWNER = 0
SCHEMA = 'orbis.fresh-ownership-permit.v1'
REFERENCE = 'orbis.fresh-ownership-reference.v1'
PHASE = 'orbis.fresh-ownership-phase.v1'
LIMIT = 262144
NO_RESTART = {'Name': 'no', 'MaximumRetryCount': 0}
_KEY = object()
_UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\Z')


def fail():
    raise ValueError('Fresh ownership requires the retained Root permit and lifecycle hold; preserve all custody for review.') from None


def operation(root, authorization_sha256):
    if not L.K.valid_hash(authorization_sha256):
        fail()
    return L.K.digest({'schema': SCHEMA, 'root': str(root), 'authorizationSha256': authorization_sha256})


def claim_path(root, identifier, host=None):
    root = Path(root)
    if (not root.is_absolute() or str(root) != os.path.realpath(root) or not L.K.valid_hash(identifier)):
        fail()
    return (L.B.control_directory(host, root) if host is not None else root.parent) / ('.orbis-fresh-ownership-' + L.K.digest({'root': str(root)}) + '-' + identifier + '.json')


def consumed_path(root, identifier, host=None):
    return claim_path(root, identifier, host).with_suffix('.authorization.json')


def phase_path(root, identifier, name, host=None):
    if name not in ('cutover', 'hold', 'reset-intent', 'reset', 'birth', 'resume', 'forward', 'normal', 'complete', 'rollback', 'restored', 'rolled-back', 'abort', 'aborted'):
        fail()
    return claim_path(root, identifier, host).with_suffix('.' + name + '.json')


def pinned_json(path, resources):
    pin = L.C.PinnedFile(path, limit=16 * 1024 * 1024, private=True)
    resources.callback(pin.close)
    value = L.C.json_body(pin.body)
    return value, pin


def file_reference(pin):
    return {'path': str(pin.path), 'sha256': hashlib.sha256(pin.body).hexdigest(), 'identity': list(pin.identity)}


def controller_reference(value, phase, transaction):
    if (type(value) is not dict or set(value) != {'id', 'definitionSha256', 'phase', 'transactionId'}
            or value['phase'] != phase or value['transactionId'] != transaction
            or not L.K.valid_hash(value['id']) or not L.K.valid_hash(value['definitionSha256'])):
        fail()
    return value


class ReplacementRuntime:
    """Fixed replacement reader/writer, supplied by the Root entry module only.

    No request chooses a phase callback or supplies an outcome assertion. The
    production entry must attach its own module, Host and validator together.
    """
    def __init__(self, issuer, replacement):
        if replacement.HOST is not issuer.host or replacement.validate_review is not issuer.validate_review:
            fail()
        self.issuer, self.r = issuer, replacement

    def record(self, record, resources):
        value = record['review']
        self.r.validate_review(value)
        if (record.get('schema') != self.r.SCHEMA or record.get('retainedName') != 'orbis-previous-' + record.get('id', '')
                or value['root'] != str(self.issuer.root) or value['dockerContext'] != self.issuer.reader.context):
            fail()
        named, pin = pinned_json(Path(value['journal']), resources)
        if named != record:
            fail()
        return pin

    def writers(self, record, *, infrastructure=False, environment=None, forward=False, retained=True):
        self.r.check_original_containers(record, self.issuer.reader)
        for item in record['review']['checkpoint']['storage']['resources']:
            actual = self.r.TX.STORAGE.resource_identity(item)
            if environment is not None and item['source'] == str(self.issuer.root / '.env'):
                expected = {'source': item['source'], 'kind': 'file', 'device': environment['identity'][0], 'inode': environment['identity'][1]}
            else:
                expected = item
            if actual != expected: fail()
        if retained:
            self.r.original(record, self.issuer.reader)
        expected = {item['id']: item for item in record['review']['checkpoint']['storage']['containerStates']}
        for identifier, role in record['review']['checkpoint']['roles'].items():
            if role == 'controller' and not retained:
                continue
            current = self.issuer.reader.app(identifier)
            allowed = forward and role != 'controller' or infrastructure and role in ('database', 'queue')
            policies = [NO_RESTART, expected[identifier]['restartPolicy']] if forward and role != 'controller' else [NO_RESTART]
            if (current.get('state') not in ('running', 'exited', 'created')
                    or not allowed and current.get('state') not in ('exited', 'created')
                    or current.get('restartPolicy') not in policies
                    or forward and expected[identifier]['state'] != 'running' and current.get('state') != expected[identifier]['state']):
                fail()

    def checkpoint(self, record, *, verify_payload, environment=None, forward=False, retained=True):
        with ExitStack() as resources:
            main = self.record(record, resources)
            value = record['review']['checkpoint']
            checkpoint, pin = pinned_json(Path(value['journal']), resources)
            self.r.TX.read_record(Path(value['journal']), self.issuer.root, self.issuer.reader)
            if checkpoint.get('stage') != 'ready' or checkpoint.get('review') != value:
                fail()
            manifest_path = Path(value['storage']['bundle']) / 'storage.json'
            manifest, manifest_pin = pinned_json(manifest_path, resources)
            if (manifest.get('plan') != value['storage'] or manifest.get('stage') != 'complete'
                    or checkpoint.get('backupFingerprint') != L.K.digest(manifest)):
                fail()
            if verify_payload and self.r.TX.STORAGE.verified_manifest(manifest_path.parent) != manifest:
                fail()
            self.writers(record, infrastructure=not verify_payload, environment=environment, forward=forward, retained=retained)
            for opened in (main, pin, manifest_pin): opened.verify()
            return {'checkpoint': file_reference(pin), 'manifest': file_reference(manifest_pin),
                    'backupFingerprint': checkpoint['backupFingerprint']}

    def staged(self, record, *, reset=None, reset_review=None, environment=None, forward=False, retained=True):
        with ExitStack() as resources:
            main = self.record(record, resources)
            path = self.issuer.root / 'orbis-compose.yml'
            pin = self.issuer.pin_data(path, resources)
            if pin.body != self.r.HOST.STAGE.staged_content(record['review']['target']).encode():
                fail()
            if reset is not None:
                current = self.reset_snapshot(record, reset, reset_review)
            else:
                current = None
            self.writers(record, infrastructure=True, environment=current['environment'] if current else environment,
                         forward=forward, retained=retained)
            main.verify(); pin.verify()
            return current

    def hold(self, record):
        self.staged(record)
        reader = self.issuer.reader
        raw = self.r.candidate(record, reader)
        if (record.get('candidatePhase') != 'hold' or raw is None or record.get('candidate', {}).get('validated') is not True
                or raw.get('State', {}).get('Status') != 'running'
                or raw.get('State', {}).get('Health', {}).get('Status') != 'healthy'
                or raw['HostConfig'].get('PortBindings') != {} or raw['HostConfig'].get('PublishAllPorts') is not False):
            fail()
        self.r.matches_intent(record, reader, raw)
        status = self.r.COMPAT.bounded_json(reader._read(['exec', raw['Id'], 'curl', '-fsS', '--max-time', '5',
                                                        'http://127.0.0.1:3000/api/installation/status']))
        if (status.get('schema') != self.r.HOST.PLAN.INSTALLATION_PROTOCOL or status.get('phase') != 'hold'
                or status.get('transactionId') != record['id']):
            fail()
        fresh = self.r.FRESH.review(self.issuer.root, reader, self.r.original(record, reader),
                                   self.r.role(record['review'], 'database'))
        return {'id': raw['Id'], 'definitionSha256': self.r.candidate_definition(raw), 'statusSha256': L.K.digest(status),
                'fresh': fresh}

    def reset_snapshot(self, record, result, reviewed):
        fresh, reader, root = self.r.FRESH, self.issuer.reader, self.issuer.root
        if type(reviewed) is not dict: fail()
        if (type(result) is not dict or result.get('cacheRevoked') is not True or result.get('passkeysRevoked') is not True
                or result.get('reviewSha256') != fresh.review_digest(reviewed)
                or not L.K.valid_hash(result.get('jwtHash')) or result['jwtHash'] == reviewed['jwtHash']
                or fresh.key_hash(fresh.secret(root)) != result['jwtHash']):
            fail()
        current = fresh.authentication(root)
        if current['passkeys'] is not None or fresh.review_digest(current) != result.get('authenticationSha256'):
            fail()
        fresh.cache(root / 'cache/cache.sqlite', require_empty=True)
        accounts = fresh.accounts(reader, self.r.role(record['review'], 'database'))
        if (accounts['users'] != 0 or accounts['links'] != 0
                or any(accounts[name] != reviewed['accounts'][name] or result.get(name) != accounts[name] for name in ('apps', 'stores'))
                or result.get('accountsRemoved') != reviewed['accounts']['users'] or result.get('linksRemoved') != reviewed['accounts']['links']):
            fail()
        with ExitStack() as resources:
            pin = self.issuer.pin_data(root / '.env', resources)
            return {'environment': file_reference(pin), 'authenticationSha256': result['authenticationSha256'],
                    'accountsSha256': L.K.digest(accounts)}

    def reset(self, record, reviewed, before_rotation):
        self.staged(record)
        if self.r.candidate(record, self.issuer.reader) is not None:
            fail()
        if self.r.FRESH.accounts(self.issuer.reader, self.r.role(record['review'], 'database')) != reviewed['accounts']:
            fail()
        result = self.r.FRESH.reset(self.issuer.root, self.issuer.reader, self.r.role(record['review'], 'database'),
                                    reviewed, before_rotation=before_rotation)
        return result, self.reset_snapshot(record, result, reviewed)

    def controller(self, record, phase, payload_sha):
        known = record.get('candidate')
        if (record.get('candidatePhase') != phase or type(known) is not dict
                or known.get('validated') is not True):
            fail()
        raw = self.r.candidate(record, self.issuer.reader)
        if (raw is None or raw['Id'] != known.get('id') or raw.get('Name') != '/' + record['review']['controllerName']
                or raw.get('State', {}).get('Status') != 'running'
                or raw.get('State', {}).get('Health', {}).get('Status') != 'healthy'):
            fail()
        intended = self.r._controller_payload(record, self.issuer.reader, phase)
        if L.K.digest(intended) != payload_sha:
            fail()
        self.r._matches_body(record, raw, intended)
        return self.controller_snapshot(record, raw, phase)

    def controller_snapshot(self, record, raw, phase, *, require_healthy=True):
        transaction = None if phase == 'normal' else record['id']
        if raw.get('State', {}).get('Status') not in ('created', 'exited', 'running'):
            fail()
        if require_healthy:
            status = self.r.COMPAT.bounded_json(self.issuer.reader._read(
                ['exec', raw['Id'], 'curl', '-fsS', '--max-time', '5', 'http://127.0.0.1:3000/api/installation/status']))
            if (raw.get('State', {}).get('Status') != 'running'
                    or raw.get('State', {}).get('Health', {}).get('Status') != 'healthy'
                    or status.get('schema') != self.r.HOST.PLAN.INSTALLATION_PROTOCOL
                    or status.get('phase') != phase or status.get('transactionId') != transaction):
                fail()
        return {'id': raw['Id'], 'definitionSha256': self.r.candidate_definition(raw),
                'phase': phase, 'transactionId': transaction}

    def state(self, record, *, required):
        path = self.issuer.root / self.r.HOST.STATE_NAME
        if not os.path.lexists(path):
            if required: fail()
            return None
        with ExitStack() as resources:
            pin = self.issuer.pin_data(path, resources, limit=16 * 1024 * 1024)
            value = L.C.json_body(pin.body)
            expected = self.r.HOST.published_installation_fingerprint(self.issuer.root, record['review']['target'], self.issuer.reader.context)
            if value != expected:
                fail()
            pin.verify()
            return file_reference(pin)

    def completed(self, record, normal):
        if record.get('stage') != 'complete': fail()
        with ExitStack() as resources:
            main = self.record(record, resources)
            if self.r.role(record['review'], 'controller') in {row['id'] for row in self.issuer.reader.containers()}:
                fail()
            raw = self.r.candidate(record, self.issuer.reader)
            if raw is None or self.controller_snapshot(record, raw, 'normal') != normal:
                fail()
            expected = {item['id']: item for item in record['review']['checkpoint']['storage']['containerStates']}
            rows = {row['id']: row for row in self.issuer.reader.containers()}
            for identifier, role in record['review']['checkpoint']['roles'].items():
                if role == 'controller':
                    if raw['HostConfig']['RestartPolicy'] != expected[identifier]['restartPolicy']: fail()
                    continue
                current, _ = self.r.TX.STORAGE.container_record(self.issuer.reader, rows[identifier])
                if current != expected[identifier]: fail()
            result = {'controller': normal, 'state': self.state(record, required=True), 'journal': file_reference(main)}
            main.verify()
            return result


def reference(value):
    if (type(value) is not dict or set(value) != {'schema', 'operationId', 'admissionBinding', 'authorizationSha256'}
            or value['schema'] != REFERENCE
            or any(not L.K.valid_hash(value[key]) for key in ('operationId', 'admissionBinding', 'authorizationSha256'))):
        fail()
    return copy.deepcopy(value)


class Issuer:
    def __init__(self, host, root, reader, validate_review):
        if not callable(validate_review):
            fail()
        self.host, self.root, self.reader = host, Path(root), reader
        self.validate_review = validate_review
        self.runtime = None

    def attach_replacement(self, replacement):
        if self.runtime is not None:
            fail()
        self.runtime = ReplacementRuntime(self, replacement)

    def _custody(self, plan=None):
        selected = L.B.custody(self.host, self.root, self.reader.daemon(), self.reader.context)
        if plan is not None and plan.get('custody') != selected: fail()
        return selected

    def _data(self, resources):
        if self._custody() is None: return None
        return resources.enter_context(L.E.data_root(SimpleNamespace(HOST=self.host, root=self.root)))

    def pin_data(self, path, resources, *, limit=1024 * 1024):
        data = self._data(resources)
        pin = (L.E.ObservedFile(self.root, data[0], data[2], path, limit=limit) if data
               else L.C.PinnedFile(path, limit=limit))
        resources.callback(pin.close)
        return pin

    def storage(self, resources):
        return L._storage(self.root, resources, data=self._data(resources))

    def _guard(self, guard):
        if (os.geteuid() != OWNER or not isinstance(guard, self.host.CREDENTIAL_FENCE._Guard)
                or guard._host.LOCK_DESCRIPTOR is not self.host.LOCK_DESCRIPTOR
                or guard._host.AUTHORITY is not self.host.AUTHORITY
                or guard._host.CREDENTIAL_FENCE is not self.host.CREDENTIAL_FENCE
                or guard._root != self.root or guard._context != self.reader.context
                or self.reader.lock_fd != self.host.LOCK_DESCRIPTOR.get()
                or guard._directory.path != L.B.control_directory(self.host, self.root)
                or not guard._directory.protected):
            fail()
        guard._check()

    def _review(self, value, transaction):
        self.validate_review(value)
        if (type(value) is not dict or value.get('mode') != 'fresh' or value.get('root') != str(self.root)
                or value.get('dockerContext') != self.reader.context or not L.K.valid_hash(value.get('reviewId'))
                or value['reviewId'] != L.K.digest({key: item for key, item in value.items() if key != 'reviewId'})
                or type(transaction) is not str or not _UUID.fullmatch(transaction)):
            fail()
        return L.K.digest(value)

    def _binding(self, value):
        return L.K.digest({key: item for key, item in value.items() if key != 'admissionBinding'})

    def _read(self, guard, selected, *, completed=False, rolled_back=False, aborted=False):
        self._guard(guard)
        selected = reference(selected)
        if selected['operationId'] != operation(self.root, selected['authorizationSha256']):
            fail()
        approval = None
        pin = L.C.PinnedFile(claim_path(self.root, selected['operationId'], self.host), limit=LIMIT, private=True)
        try:
            value = L.C.json_body(pin.body)
            fields = {'schema', 'root', 'context', 'operationId', 'admissionBinding', 'transactionId',
                      'reviewSha256', 'authorization', 'legacy', 'quiescentConfigurationSha256'}
            if (set(value) != fields or value['schema'] != SCHEMA or value['root'] != str(self.root)
                    or type(value.get('authorization')) is not dict or type(value.get('legacy')) is not dict
                    or value['context'] != self.reader.context or value['operationId'] != selected['operationId']
                    or value['admissionBinding'] != selected['admissionBinding']
                    or value['authorization'].get('authorizationSha256') != selected['authorizationSha256']
                    or value['admissionBinding'] != self._binding(value)
                    or type(value['transactionId']) is not str or not _UUID.fullmatch(value['transactionId'])
                    or not L.K.valid_hash(value['reviewSha256']) or not L.K.valid_hash(value['quiescentConfigurationSha256'])
                    or value['legacy'].get('schema') != L.SCHEMA or value['legacy'].get('policy') != L.POLICY
                    or value['legacy'].get('root') != str(self.root) or value['legacy'].get('context') != self.reader.context
                    or value['authorization'] != {'schema': L.AUTHORIZATION, 'planSha256': L.K.digest(value['legacy']),
                        'authorizationSha256': selected['authorizationSha256'], 'installationId': value['legacy']['installationId']}
                    or pin.body != L.K.canonical(value) + b'\n'):
                fail()
            self._custody(value['legacy'])
            if (completed or rolled_back or aborted) and guard.read() is None:
                terminal = 'aborted' if aborted else 'rolled-back' if rolled_back else 'complete'
                if not os.path.lexists(phase_path(self.root, selected['operationId'], terminal, self.host)):
                    fail()
            else:
                guard.check(selected['operationId'], selected['admissionBinding'])
            if os.path.lexists(L.authorization_path(self.root, self.host, self.reader)):
                fail()
            approval = L.C.PinnedFile(consumed_path(self.root, selected['operationId'], self.host), limit=L.LIMIT, private=True)
            policy = L.C.json_body(approval.body)
            if (set(policy) != {'schema', 'policy', 'planSha256', 'approvalId'}
                    or policy['schema'] != L.AUTHORIZATION or policy['policy'] != L.POLICY
                    or not L.K.valid_hash(policy['approvalId']) or policy['planSha256'] != L.K.digest(value['legacy'])
                    or hashlib.sha256(approval.body).hexdigest() != selected['authorizationSha256']
                    or approval.body != L.K.canonical(policy) + b'\n'):
                fail()
            return Permit(_KEY, self, guard, pin, approval, value, completed=completed, rolled_back=rolled_back, aborted=aborted)
        except BaseException:
            if approval is not None:
                approval.close()
            pin.close()
            raise

    def _write(self, guard, value):
        self._guard(guard)
        guard.check(value['operationId'], value['admissionBinding'])
        body = L.K.canonical(value) + b'\n'
        if len(body) > LIMIT:
            fail()
        path = claim_path(self.root, value['operationId'], self.host)
        if path.parent != guard._directory.path: fail()
        fd = os.open(path.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                     0o600, dir_fd=guard._directory.fd)
        try:
            os.fchmod(fd, 0o600)
            remaining = memoryview(body)
            while remaining:
                count = os.write(fd, remaining)
                if count <= 0:
                    fail()
                remaining = remaining[count:]
            os.fsync(fd)
        finally:
            os.close(fd)
        os.fsync(guard._directory.fd)

    def _publish(self, guard, path, body):
        self._guard(guard)
        if path.parent != guard._directory.path or not 0 < len(body) <= LIMIT:
            fail()
        fd = os.open(path.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                     0o600, dir_fd=guard._directory.fd)
        try:
            os.fchmod(fd, 0o600)
            remaining = memoryview(body)
            while remaining:
                count = os.write(fd, remaining)
                if count <= 0: fail()
                remaining = remaining[count:]
            os.fsync(fd)
        finally: os.close(fd)
        os.fsync(guard._directory.fd)

    def _consume(self, guard, value):
        """Archive the exact independent decision without overwriting custody.

        A crash with both hard links still present denies both readers. No
        interrupted archive is repaired or treated as a fresh decision here.
        """
        self._guard(guard)
        guard.check(value['operationId'], value['admissionBinding'])
        origin, destination = L.authorization_path(self.root, self.host, self.reader), consumed_path(self.root, value['operationId'], self.host)
        if origin.parent != guard._directory.path or destination.parent != guard._directory.path: fail()
        pin = L.C.PinnedFile(origin, limit=L.LIMIT, private=True)
        try:
            if hashlib.sha256(pin.body).hexdigest() != value['authorization']['authorizationSha256']:
                fail()
            pin.verify()
            before = pin.identity
            os.link(origin.name, destination.name, src_dir_fd=guard._directory.fd, dst_dir_fd=guard._directory.fd,
                    follow_symlinks=False)
            os.fsync(guard._directory.fd)
            linked = L.C.seal(os.fstat(pin.file))
            # link() changes link count/ctime; every other identity field must
            # stay fixed, and both names must identify this same opened file.
            if (linked[5] != 2 or any(linked[index] != before[index] for index in (0, 1, 2, 3, 4, 6, 7))
                    or any(L.C.seal(os.stat(name, dir_fd=guard._directory.fd, follow_symlinks=False)) != linked
                           for name in (origin.name, destination.name))):
                fail()
            self._guard(guard)
            guard.check(value['operationId'], value['admissionBinding'])
            os.unlink(origin.name, dir_fd=guard._directory.fd)
            os.fsync(guard._directory.fd)
        finally:
            pin.close()

    @contextmanager
    def begin(self, guard, reviewed, transaction):
        """Publish the shared hold before an exclusive immutable decision claim.

        Replays always use resume(), never a second issuance. Partial selectors
        or claims remain held for explicit reconciliation, even without a reply.
        """
        self._guard(guard)
        reviewed = copy.deepcopy(reviewed)
        review_sha = self._review(reviewed, transaction)
        if guard.read() is not None:
            fail()
        with L.authorized(self.host, self.root, self.reader, reviewed['target']) as proof:
            decision, plan = proof.verify(), proof.plan
            if reviewed.get('freshOwnership') != decision:
                fail()
            controllers = [key for key, role in reviewed['checkpoint']['roles'].items() if role == 'controller']
            if controllers != [plan['controller']['id']]:
                fail()
            raw = self.reader._object(['container', 'inspect', '--format', '{{json .}}', controllers[0]])
            definition = {key: raw[key] for key in ('Config', 'HostConfig', 'Mounts')}
            if L.K.digest(definition) != plan['controller']['configurationSha256']:
                fail()
            quiescent = copy.deepcopy(definition)
            quiescent['HostConfig']['RestartPolicy'] = dict(NO_RESTART)
            identifier = operation(self.root, decision['authorizationSha256'])
            value = {'schema': SCHEMA, 'root': str(self.root), 'context': self.reader.context, 'operationId': identifier,
                     'transactionId': transaction, 'reviewSha256': review_sha, 'authorization': decision, 'legacy': plan,
                     'quiescentConfigurationSha256': L.K.digest(quiescent)}
            value['admissionBinding'] = self._binding(value)
            if (os.path.lexists(claim_path(self.root, identifier, self.host)) or os.path.lexists(consumed_path(self.root, identifier, self.host))
                    or len(L.K.canonical(value) + b'\n') > LIMIT):
                fail()
        # The positive decision was checked under this same live lifecycle lock.
        # Its retained claim, not a later absence or re-created authorization,
        # supplies transaction identity after the producer has been stopped.
        guard.begin(identifier, value['admissionBinding'])
        self._write(guard, value)
        self._consume(guard, value)
        selected = {'schema': REFERENCE, 'operationId': identifier, 'admissionBinding': value['admissionBinding'],
                    'authorizationSha256': decision['authorizationSha256']}
        permit = self._read(guard, selected)
        try:
            permit.check(reviewed, transaction, original_state='running')
            yield permit
        finally:
            permit.close()

    @contextmanager
    def resume(self, guard, reviewed, transaction, selected, *, original_state):
        self._guard(guard)
        self._review(reviewed, transaction)
        permit = self._read(guard, selected)
        try:
            permit.check(reviewed, transaction, original_state=original_state)
            yield permit
        finally:
            permit.close()

    @contextmanager
    def resume_cutover(self, guard, record, selected):
        self._guard(guard)
        permit = self._read(guard, selected)
        try:
            permit._frame(record)
            if os.path.lexists(phase_path(self.root, selected['operationId'], 'resume', self.host)):
                permit.authorize_controller(record)
            elif os.path.lexists(phase_path(self.root, selected['operationId'], 'reset', self.host)):
                permit.reset_result(record)
            else:
                permit._cutover(record)
                permit._staged(record)
            yield permit
        finally: permit.close()

    @contextmanager
    def resume_completed(self, guard, record, selected):
        """Read an exact terminal outcome; never admit new transaction work."""
        permit = self._read(guard, selected, completed=True)
        try:
            permit.completed(record)
            yield permit
        finally: permit.close()

    @contextmanager
    def resume_rollback(self, guard, record, selected):
        selected = reference(selected)
        done = os.path.lexists(phase_path(self.root, selected['operationId'], 'rolled-back', self.host))
        permit = self._read(guard, selected, rolled_back=done)
        try:
            if done:
                permit.rolled_back(record)
            else:
                intent, _ = permit._read_phase('rollback', hashlib.sha256(permit._body).hexdigest())
                permit._rollback_guard(record, intent)
            yield permit
        finally: permit.close()

    @contextmanager
    def resume_abort(self, guard, record, selected):
        selected = reference(selected)
        done = os.path.lexists(phase_path(self.root, selected['operationId'], 'aborted', self.host))
        permit = self._read(guard, selected, aborted=done)
        try:
            permit._abort_guard(record)
            if done: permit.aborted(record)
            yield permit
        finally: permit.close()

    @contextmanager
    def transaction(self, guard, record, selected):
        """Open exact active custody; each operation verifies its own phase."""
        permit = self._read(guard, selected)
        try:
            permit._frame(record)
            with ExitStack() as resources:
                pin = permit._runtime().record(record, resources)
                pin.verify()
            yield permit
        finally: permit.close()


class Permit:
    def __init__(self, key, issuer, guard, pin, approval, value, *, completed=False, rolled_back=False, aborted=False):
        if key is not _KEY:
            fail()
        self.issuer, self.guard, self.pin = issuer, guard, pin
        self.approval = approval
        self._body = bytes(pin.body)
        self._value = L.K.canonical(value)
        self.live = True
        self._completed_read = completed
        self._rollback_read = rolled_back
        self._aborted_read = aborted
        self._terminal_read = 'aborted' if aborted else 'rolled-back' if rolled_back else 'complete' if completed else None

    @property
    def reference(self):
        value = L.K.decoded(self._value)
        return {'schema': REFERENCE, 'operationId': value['operationId'], 'admissionBinding': value['admissionBinding'],
                'authorizationSha256': value['authorization']['authorizationSha256']}

    def _transition_vetoes(self):
        value = L.K.decoded(self._value)
        self.issuer._custody(value['legacy'])
        identifier, root, host = value['operationId'], self.issuer.root, self.issuer.host
        records = (claim_path(root, identifier, host), consumed_path(root, identifier, host),
                   *(phase_path(root, identifier, name, host) for name in
                     ('cutover', 'hold', 'reset-intent', 'reset', 'birth', 'resume', 'forward', 'normal',
                      'complete', 'rollback', 'restored', 'rolled-back', 'abort', 'aborted')))
        return L.transition_vetoes(host, root, fresh_records=records)

    def check(self, reviewed, transaction, *, original_state):
        if not self.live or self._terminal_read or original_state not in ('running', 'stopped'):
            fail()
        issuer = self.issuer
        issuer._guard(self.guard)
        value = L.K.decoded(self._value)
        issuer._custody(value['legacy'])
        if issuer._review(reviewed, transaction) != value['reviewSha256'] or transaction != value['transactionId']:
            fail()
        self.pin.verify()
        self.approval.verify()
        if os.path.lexists(L.authorization_path(issuer.root, issuer.host, issuer.reader)):
            fail()
        if self.pin.body != self._body:
            fail()
        self.guard.check(value['operationId'], value['admissionBinding'])
        plan, root, reader = value['legacy'], issuer.root, issuer.reader
        daemon = reader.daemon()
        if (L.B.root_identity(root) != plan['rootIdentity'] or type(daemon) is not str
                or hashlib.sha256(daemon.encode()).hexdigest() != plan['daemonSha256']
                or any(os.path.lexists(path) for path in self._transition_vetoes())):
            fail()
        with ExitStack() as resources:
            pins = []
            if issuer.storage(resources) != plan['storage']:
                fail()
            for name, expected in plan['files'].items():
                path = root / name
                if expected is None:
                    if os.path.lexists(path):
                        fail()
                else:
                    pin = issuer.pin_data(path, resources)
                    pins.append(pin)
                    if (hashlib.sha256(pin.body).hexdigest() != expected
                            or list(pin.identity) != plan['fileIdentities'][name]):
                        fail()
            if original_state == 'running':
                if L._controller(root, reader) != plan['controller']:
                    fail()
            else:
                raw = reader._object(['container', 'inspect', '--format', '{{json .}}', plan['controller']['id']])
                if type(raw) is not dict or type(raw.get('State')) is not dict:
                    fail()
                state = raw.get('State', {})
                if (raw.get('Id') != plan['controller']['id'] or raw.get('Image') != plan['controller']['imageId']
                        or raw.get('Name') not in ('/runtipi', '/orbis-previous-' + transaction)
                        or L.K.digest({key: raw[key] for key in ('Config', 'HostConfig', 'Mounts')}) != value['quiescentConfigurationSha256']
                        or state.get('Status') not in ('exited', 'created') or state.get('Running') is not False
                        or type(state.get('Pid')) is not int or state['Pid'] != 0
                        or state.get('Paused') is not False or state.get('Restarting') is not False or state.get('Dead') is not False):
                    fail()
            for pin in pins:
                pin.verify()
        self.pin.verify()
        self.approval.verify()
        self.guard.check(value['operationId'], value['admissionBinding'])
        return self.reference

    def close(self):
        self.live = False
        self.approval.close()
        self.pin.close()

    def _runtime(self):
        if not self.live or self.issuer.runtime is None:
            fail()
        return self.issuer.runtime

    def _frame(self, record):
        issuer = self.issuer
        issuer._guard(self.guard)
        value = L.K.decoded(self._value)
        issuer._custody(value['legacy'])
        if (not self.live or issuer._review(record['review'], record['id']) != value['reviewSha256']
                or record['id'] != value['transactionId'] or record.get('ownershipPermit') != self.reference):
            fail()
        self.pin.verify(); self.approval.verify()
        if self._terminal_read and self.guard.read() is None:
            if not os.path.lexists(phase_path(issuer.root, value['operationId'], self._terminal_read, issuer.host)): fail()
        else:
            self.guard.check(value['operationId'], value['admissionBinding'])
        return value

    def _read_phase(self, name, previous):
        value = L.K.decoded(self._value)
        path = phase_path(self.issuer.root, value['operationId'], name, self.issuer.host)
        pin = L.C.PinnedFile(path, limit=LIMIT, private=True)
        try:
            phase = L.C.json_body(pin.body)
            fields = {
                'cutover': {'checkpoint', 'manifest', 'backupFingerprint'},
                'hold': {'id', 'definitionSha256', 'statusSha256', 'fresh'},
                'reset-intent': {'resetReviewSha256', 'environment', 'jwtHash'},
                'reset': {'result', 'snapshot', 'resetReview'},
                'birth': {'reference'},
                'resume': {'environment', 'resumePayloadSha256', 'normalPayloadSha256'},
                'forward': {'controller'},
                'normal': {'controller'},
                'complete': {'controller', 'state', 'journal'},
                'rollback': {'checkpoint', 'checkpointId', 'environment', 'birth', 'staged'},
                'restored': {'restore', 'backupFingerprint', 'birth'},
                'rolled-back': {'controller', 'checkpoint', 'journal', 'birth'},
                'abort': {'checkpointId'},
                'aborted': {'controller', 'checkpointId', 'journal'},
            }
            if (set(phase) != {'schema', 'name', 'operationId', 'admissionBinding', 'transactionId', 'reviewSha256', 'previousSha256', 'data'}
                    or phase['schema'] != PHASE or phase['name'] != name
                    or any(phase[key] != value[key] for key in ('operationId', 'admissionBinding', 'transactionId', 'reviewSha256'))
                    or phase['previousSha256'] != previous or type(phase['data']) is not dict
                    or set(phase['data']) != fields[name]
                    or pin.body != L.K.canonical(phase) + b'\n'):
                fail()
            pin.verify()
            return phase['data'], hashlib.sha256(pin.body).hexdigest()
        finally: pin.close()

    def _publish_phase(self, record, name, previous, data):
        if self._terminal_read: fail()
        value = self._frame(record)
        phase = {key: value[key] for key in ('operationId', 'admissionBinding', 'transactionId', 'reviewSha256')}
        phase.update(schema=PHASE, name=name, previousSha256=previous, data=data)
        body = L.K.canonical(phase) + b'\n'
        self.issuer._publish(self.guard, phase_path(self.issuer.root, value['operationId'], name, self.issuer.host), body)
        return self._read_phase(name, previous)

    def record_cutover(self, record):
        self._frame(record)
        self.check(record['review'], record['id'], original_state='stopped')
        data = self._runtime().checkpoint(record, verify_payload=True)
        self.check(record['review'], record['id'], original_state='stopped')
        return self._publish_phase(record, 'cutover', hashlib.sha256(self._body).hexdigest(), data)[0]

    def _cutover(self, record, *, environment=None, forward=False, retained=True):
        self._frame(record)
        data, digest = self._read_phase('cutover', hashlib.sha256(self._body).hexdigest())
        if self._runtime().checkpoint(record, verify_payload=False, environment=environment,
                                      forward=forward, retained=retained) != data:
            fail()
        return digest

    def _staged(self, record, *, environment=None, birth=None, reset=None, reset_review=None, forward=False, retained=True):
        value = self._frame(record)
        root, reader, plan = self.issuer.root, self.issuer.reader, value['legacy']
        daemon = reader.daemon()
        if (L.B.root_identity(root) != plan['rootIdentity'] or type(daemon) is not str
                or hashlib.sha256(daemon.encode()).hexdigest() != plan['daemonSha256']
                or os.path.lexists(L.authorization_path(root, self.issuer.host, self.issuer.reader))):
            fail()
        allowed = {root / 'orbis-compose.yml'}
        if birth is not None:
            allowed.add(L.B.receipt_path(root, self.issuer.host))
        if forward:
            self._runtime().state(record, required=False)
            allowed.add(root / self._runtime().r.HOST.STATE_NAME)
        if any(os.path.lexists(path) for path in self._transition_vetoes() if path not in allowed):
            fail()
        with ExitStack() as resources:
            if self.issuer.storage(resources) != plan['storage']:
                fail()
            pins = []
            for name, expected in plan['files'].items():
                path = root / name
                if expected is None:
                    if os.path.lexists(path): fail()
                    continue
                pin = self.issuer.pin_data(path, resources); pins.append(pin)
                selected = environment if name == '.env' and environment is not None else {
                    'path': str(path), 'sha256': expected, 'identity': plan['fileIdentities'][name]}
                if file_reference(pin) != selected:
                    fail()
            if retained:
                raw = reader._object(['container', 'inspect', '--format', '{{json .}}', plan['controller']['id']])
                state = raw.get('State', {})
                if (raw.get('Id') != plan['controller']['id'] or raw.get('Image') != plan['controller']['imageId']
                        or raw.get('Name') not in ('/runtipi', '/orbis-previous-' + record['id'])
                        or L.K.digest({key: raw[key] for key in ('Config', 'HostConfig', 'Mounts')}) != value['quiescentConfigurationSha256']
                        or state.get('Status') not in ('exited', 'created') or state.get('Running') is not False
                        or type(state.get('Pid')) is not int or state['Pid'] != 0
                        or state.get('Paused') is not False or state.get('Restarting') is not False or state.get('Dead') is not False):
                    fail()
            if birth is not None and os.path.lexists(L.B.receipt_path(root, self.issuer.host)):
                pin = L.C.PinnedFile(L.B.receipt_path(root, self.issuer.host), limit=L.B.LIMIT, private=True)
                resources.callback(pin.close); pins.append(pin)
                if pin.body != L.K.canonical(birth) + b'\n': fail()
            self._runtime().staged(record, reset=reset, reset_review=reset_review, environment=environment,
                                   forward=forward, retained=retained)
            for pin in pins: pin.verify()
        self._frame(record)

    def record_hold(self, record):
        cutover = self._cutover(record)
        self._staged(record)
        data = self._runtime().hold(record)
        self._staged(record)
        return self._publish_phase(record, 'hold', cutover, data)[0]

    def _hold(self, record, *, environment=None):
        cutover = self._cutover(record, environment=environment)
        return self._read_phase('hold', cutover)[1]

    def reset_accounts(self, record):
        if self._terminal_read: fail()
        if any(os.path.lexists(phase_path(self.issuer.root, self.reference['operationId'], name, self.issuer.host))
               for name in ('reset-intent', 'reset', 'abort', 'rollback')):
            # An interrupted destructive reset is rollback-only. Never infer
            # whether SQL committed, or run it again from account counts.
            fail()
        hold = self._hold(record)
        _, cutover = self._read_phase('cutover', hashlib.sha256(self._body).hexdigest())
        held, _ = self._read_phase('hold', cutover)
        reviewed = held['fresh']
        self._staged(record)
        # Do not re-run account removal on a lost reply. reset_result() verifies
        # and returns the committed Root receipt without executing reset again.
        def before_rotation(temporary, jwt_hash):
            self._hold(record); self._staged(record)
            fresh, root = self._runtime().r.FRESH, self.issuer.root
            if (temporary.parent != root or not temporary.name.startswith('.orbis-fresh-env-')
                    or not L.K.valid_hash(jwt_hash) or jwt_hash == reviewed['jwtHash']
                    or self._runtime().r.candidate(record, self.issuer.reader) is not None
                    or fresh.accounts(self.issuer.reader, self._runtime().r.role(record['review'], 'database')) != reviewed['accounts']):
                fail()
            with ExitStack() as resources:
                pin = self.issuer.pin_data(temporary, resources)
                text, _, match, original = fresh.environment(root)
                body = pin.body.decode('utf-8')
                prefix, suffix = text[:match.start()] + 'JWT_SECRET=', text[match.end():]
                key = body[len(prefix):len(body) - len(suffix) if suffix else None]
                if (not re.fullmatch('[a-f0-9]{128}', key) or body != prefix + key + suffix
                        or fresh.key_hash(key) != jwt_hash
                        or [pin.identity[index] for index in (2, 3, 4)] != [original.st_uid, original.st_gid, original.st_mode]):
                    fail()
                # Rename changes ctime. Every other identity field and the
                # full file digest must still match this prepared inode.
                planned = {'path': str(root / '.env'), 'sha256': hashlib.sha256(pin.body).hexdigest(),
                           'identity': list(pin.identity[:-1])}
                self._publish_phase(record, 'reset-intent', hold,
                                    {'resetReviewSha256': fresh.review_digest(reviewed), 'environment': planned, 'jwtHash': jwt_hash})
                pin.verify()
        result, snapshot = self._runtime().reset(record, reviewed, before_rotation)
        intent, intent_sha, environment = self._reset_intent(record)
        if environment != snapshot['environment'] or intent['jwtHash'] != result['jwtHash']: fail()
        self._staged(record, environment=snapshot['environment'], reset=result, reset_review=reviewed)
        self._publish_phase(record, 'reset', intent_sha, {'result': result, 'snapshot': snapshot, 'resetReview': reviewed})
        return copy.deepcopy(result)

    def _reset_plan(self, record):
        self._frame(record)
        _, cutover = self._read_phase('cutover', hashlib.sha256(self._body).hexdigest())
        held, hold = self._read_phase('hold', cutover)
        intent, digest = self._read_phase('reset-intent', hold)
        expected = intent['environment']
        fresh, root = self._runtime().r.FRESH, self.issuer.root
        if (intent['resetReviewSha256'] != fresh.review_digest(held['fresh'])
                or not L.K.valid_hash(intent['jwtHash']) or intent['jwtHash'] == held['fresh']['jwtHash']
                or type(expected) is not dict or set(expected) != {'path', 'sha256', 'identity'}
                or expected['path'] != str(root / '.env') or not L.K.valid_hash(expected['sha256'])
                or type(expected['identity']) is not list or len(expected['identity']) != 8
                or any(type(item) is not int for item in expected['identity'])):
            fail()
        return intent, digest

    def _reset_intent(self, record):
        intent, digest = self._reset_plan(record)
        expected = intent['environment']
        fresh, root = self._runtime().r.FRESH, self.issuer.root
        with ExitStack() as resources:
            pin = self.issuer.pin_data(root / '.env', resources)
            current = file_reference(pin)
            legacy = L.K.decoded(self._value)['legacy']
            original = {'path': str(root / '.env'), 'sha256': legacy['files']['.env'],
                        'identity': legacy['fileIdentities']['.env']}
            if current != original:
                stable = {**current, 'identity': current['identity'][:-1]}
                if stable != expected or fresh.key_hash(fresh.secret(root)) != intent['jwtHash']: fail()
            pin.verify()
        self._hold(record, environment=current)
        return intent, digest, current

    def _reset(self, record, *, birth=None):
        # Read the immutable chain first to obtain the Root-recorded replacement
        # inode; independently verify that reset before allowing its resource.
        _, cutover = self._read_phase('cutover', hashlib.sha256(self._body).hexdigest())
        held, hold = self._read_phase('hold', cutover)
        intent, intent_sha, environment = self._reset_intent(record)
        data, digest = self._read_phase('reset', intent_sha)
        if data['resetReview'] != held['fresh'] or self._runtime().reset_snapshot(record, data['result'], data['resetReview']) != data['snapshot']:
            fail()
        if (data['snapshot']['environment'] != environment or data['result']['jwtHash'] != intent['jwtHash']
                or environment['sha256'] != intent['environment']['sha256']): fail()
        if self._hold(record, environment=data['snapshot']['environment']) != hold: fail()
        self._staged(record, environment=data['snapshot']['environment'], birth=birth, reset=data['result'], reset_review=data['resetReview'])
        return data, digest

    def reset_result(self, record):
        birth = self._birth(record) if os.path.lexists(L.B.receipt_path(self.issuer.root, self.issuer.host)) else None
        return copy.deepcopy(self._reset(record, birth=birth)[0]['result'])

    def _birth(self, record):
        value = self._frame(record)
        target, plan = record['review']['target'], value['legacy']
        publication = {**{key: target[key] for key in ('tag', 'commit', 'digest')}, 'manifestSha256': L.K.digest(target)}
        birth = {'schema': L.B.SCHEMA, 'root': str(self.issuer.root), 'context': self.issuer.reader.context,
            'daemonSha256': plan['daemonSha256'], 'rootIdentity': plan['rootIdentity'], 'installationId': plan['installationId'],
            'birthId': L.K.digest({'schema': 'orbis.fresh-birth-id.v1', 'permit': self.reference, 'publication': publication}),
            'initialPublication': publication}
        if 'custody' in plan: birth['custody'] = copy.deepcopy(plan['custody'])
        return L.B.validate(birth)

    def publish_birth(self, record):
        """Publish replacement birth under the still-active transaction fence.

        A complete single-link publication can settle a lost reply. Partial
        files or interrupted two-link publication remain held for local review.
        """
        if self._terminal_read: fail()
        birth = self._birth(record)
        _, reset = self._reset(record, birth=birth)
        if self._runtime().r.candidate(record, self.issuer.reader) is not None:
            fail()
        root, guard = self.issuer.root, self.guard
        body = L.K.canonical(birth) + b'\n'
        if len(body) > L.B.LIMIT or os.path.lexists(L.B.pending_path(root, self.issuer.host)):
            fail()
        if not os.path.lexists(L.B.receipt_path(root, self.issuer.host)):
            self.issuer._publish(guard, L.B.pending_path(root, self.issuer.host), body)
            pin = L.C.PinnedFile(L.B.pending_path(root, self.issuer.host), limit=L.B.LIMIT, private=True)
            try:
                if pin.body != body: fail()
                pin.verify(); self._frame(record)
                os.link(L.B.pending_path(root, self.issuer.host).name, L.B.receipt_path(root, self.issuer.host).name,
                        src_dir_fd=guard._directory.fd, dst_dir_fd=guard._directory.fd, follow_symlinks=False)
                os.fsync(guard._directory.fd)
                # No reader accepts either file while both links exist.
                os.unlink(L.B.pending_path(root, self.issuer.host).name, dir_fd=guard._directory.fd)
                os.fsync(guard._directory.fd)
            finally: pin.close()
        pin = L.C.PinnedFile(L.B.receipt_path(root, self.issuer.host), limit=L.B.LIMIT, private=True)
        try:
            if pin.body != body: fail()
            pin.verify()
            selected = {'schema': L.B.SCHEMA, 'path': str(pin.path), 'sha256': hashlib.sha256(body).hexdigest()}
        finally: pin.close()
        phase = phase_path(root, self.reference['operationId'], 'birth', self.issuer.host)
        if os.path.lexists(phase):
            data, _ = self._read_phase('birth', reset)
            if data != {'reference': selected}: fail()
        else:
            self._publish_phase(record, 'birth', reset, {'reference': selected})
        self._reset(record, birth=birth)
        return selected

    def arm_resume(self, record):
        """Bind controller intent before its first post-reset process starts."""
        if self._terminal_read: fail()
        birth = self.publish_birth(record)
        reset, reset_sha = self._reset(record, birth=self._birth(record))
        issued, birth_sha = self._read_phase('birth', reset_sha)
        if issued != {'reference': birth} or record.get('freshReset') != reset['result']:
            fail()
        runtime = self._runtime()
        if runtime.r.candidate(record, self.issuer.reader) is not None:
            fail()
        data = {'environment': reset['snapshot']['environment'],
                'resumePayloadSha256': L.K.digest(runtime.r._controller_payload(record, self.issuer.reader, 'resume')),
                'normalPayloadSha256': L.K.digest(runtime.r._controller_payload(record, self.issuer.reader, 'normal'))}
        return self._publish_phase(record, 'resume', birth_sha, data)[0]

    def _active(self, record):
        self._frame(record)
        _, cutover = self._read_phase('cutover', hashlib.sha256(self._body).hexdigest())
        held, hold = self._read_phase('hold', cutover)
        intent, intent_sha = self._reset_plan(record)
        reset, reset_sha = self._read_phase('reset', intent_sha)
        if reset['resetReview'] != held['fresh'] or record.get('freshReset') != reset['result']:
            fail()
        environment = reset['snapshot']['environment']
        if ({**environment, 'identity': environment['identity'][:-1]} != intent['environment']
                or reset['result']['jwtHash'] != intent['jwtHash']): fail()
        born, birth_sha = self._read_phase('birth', reset_sha)
        birth = self._birth(record)
        with ExitStack() as resources:
            actual, pin = pinned_json(L.B.receipt_path(self.issuer.root, self.issuer.host), resources)
            selected = {'schema': L.B.SCHEMA, 'path': str(pin.path), 'sha256': hashlib.sha256(pin.body).hexdigest()}
            if actual != birth or born != {'reference': selected} or pin.body != L.K.canonical(birth) + b'\n':
                fail()
            resume, resume_sha = self._read_phase('resume', birth_sha)
            if (resume['environment'] != reset['snapshot']['environment']
                    or any(not L.K.valid_hash(resume[key]) for key in ('resumePayloadSha256', 'normalPayloadSha256'))):
                fail()
            forward = None
            forward_sha = None
            if os.path.lexists(phase_path(self.issuer.root, self.reference['operationId'], 'forward', self.issuer.host)):
                forward, forward_sha = self._read_phase('forward', resume_sha)
                controller_reference(forward['controller'], 'resume', record['id'])
            retained = self._runtime().r.role(record['review'], 'controller') in {row['id'] for row in self.issuer.reader.containers()}
            if not retained:
                if forward is None or not os.path.lexists(phase_path(self.issuer.root, self.reference['operationId'], 'normal', self.issuer.host)):
                    fail()
                normal, _ = self._read_phase('normal', forward_sha)
                controller_reference(normal['controller'], 'normal', None)
                known = record.get('candidate')
                if (record.get('candidatePhase') != 'normal' or type(known) is not dict or known.get('validated') is not True
                        or known.get('id') != normal['controller']['id'] or known.get('definition') != normal['controller']['definitionSha256']
                        or type(record.get('networks')) is not dict):
                    fail()
                raw = self._runtime().r.candidate(record, self.issuer.reader)
                if raw is None or self._runtime().controller_snapshot(record, raw, 'normal', require_healthy=False) != normal['controller']:
                    fail()
            if self._cutover(record, environment=resume['environment'], forward=forward is not None, retained=retained) != cutover:
                fail()
            self._staged(record, environment=resume['environment'], birth=birth, forward=forward is not None, retained=retained)
            pin.verify()
        return resume, resume_sha, forward

    def authorize_controller(self, record):
        """Read-only gate used by the exact bound Root replacement module.

        Once resume was armed, legitimate target cache/account writes are not
        mistaken for a failed reset, and no reset operation is repeated.
        """
        if self._terminal_read: fail()
        resume, _, forward = self._active(record)
        if forward is None and record.get('candidatePhase') not in ('hold', 'resume'):
            fail()
        return copy.deepcopy(resume)

    def authorize_originals(self, record):
        if self._terminal_read: fail()
        root, identifier = self.issuer.root, self.reference['operationId']
        if any(os.path.lexists(phase_path(root, identifier, name, self.issuer.host)) for name in ('abort', 'rollback')):
            fail()
        if os.path.lexists(phase_path(root, identifier, 'resume', self.issuer.host)):
            return self.authorize_controller(record)
        environment = None
        birth = self._birth(record) if os.path.lexists(L.B.receipt_path(root, self.issuer.host)) else None
        if os.path.lexists(phase_path(root, identifier, 'reset', self.issuer.host)):
            reset, _ = self._reset(record, birth=birth)
            environment = reset['snapshot']['environment']
        self._cutover(record, environment=environment)
        if os.path.lexists(root / 'orbis-compose.yml'):
            self._staged(record, environment=environment, birth=birth)
        else:
            self.check(record['review'], record['id'], original_state='stopped')

    def record_forward(self, record):
        """Irreversibly record forward recovery before app ports can open."""
        if self._terminal_read: fail()
        resume, previous, forward = self._active(record)
        if forward is not None:
            return forward
        snapshot = self._runtime().controller(record, 'resume', resume['resumePayloadSha256'])
        self._active(record)
        return self._publish_phase(record, 'forward', previous, {'controller': snapshot})[0]

    def record_normal(self, record):
        """Retain an independently checked normal target before old removal."""
        if self._terminal_read: fail()
        resume, previous, forward = self._active(record)
        if forward is None: fail()
        _, forward_sha = self._read_phase('forward', previous)
        if os.path.lexists(phase_path(self.issuer.root, self.reference['operationId'], 'normal', self.issuer.host)):
            data, _ = self._read_phase('normal', forward_sha)
            known = record.get('candidate')
            if record.get('candidatePhase') != 'normal' or type(known) is not dict or known.get('validated') is not True:
                fail()
            raw = self._runtime().r.candidate(record, self.issuer.reader)
            if raw is None or data != {'controller': self._runtime().controller_snapshot(record, raw, 'normal')}: fail()
            return data
        snapshot = self._runtime().controller(record, 'normal', resume['normalPayloadSha256'])
        self._active(record)
        return self._publish_phase(record, 'normal', forward_sha, {'controller': snapshot})[0]

    def _completion(self, record):
        _, previous, forward = self._active(record)
        if forward is None: fail()
        _, forward_sha = self._read_phase('forward', previous)
        normal, normal_sha = self._read_phase('normal', forward_sha)
        controller_reference(normal['controller'], 'normal', None)
        return self._runtime().completed(record, normal['controller']), normal_sha

    def completed(self, record):
        current, previous = self._completion(record)
        issued, _ = self._read_phase('complete', previous)
        if issued != current: fail()
        return copy.deepcopy(issued)

    def complete(self, record):
        """Retire exactly this selector after fixed live terminal verification."""
        current, previous = self._completion(record)
        if os.path.lexists(phase_path(self.issuer.root, self.reference['operationId'], 'complete', self.issuer.host)):
            self.completed(record)
        else:
            self._publish_phase(record, 'complete', previous, current)
        selected = self.reference
        def verified():
            self.completed(record)
            return True
        self.guard.finish(selected['operationId'], selected['admissionBinding'], verify_completed=verified)
        return copy.deepcopy(current)

    def _rollback_manifest(self, record, intent, *, payload=False):
        runtime = self._runtime()
        storage = record['review']['checkpoint']['storage']
        with ExitStack() as resources:
            manifest, pin = pinned_json(Path(storage['bundle']) / 'storage.json', resources)
            if (file_reference(pin) != intent['checkpoint']['manifest'] or manifest.get('plan') != storage
                    or manifest.get('stage') != 'complete' or L.K.digest(manifest) != intent['checkpoint']['backupFingerprint']):
                fail()
            roots = [item for item in storage['resources'] if item['source'] == str(self.issuer.root)]
            if len(roots) != 1 or roots[0]['kind'] != 'directory': fail()
            protected = ('.env', 'docker-compose.yml', 'VERSION', 'state', 'cache')
            if any(Path(name).is_relative_to(excluded) or Path(excluded).is_relative_to(name)
                   for excluded in roots[0].get('excludedPaths', []) for name in protected):
                fail()
            if any(runtime.r.TX.STORAGE.resource_identity(item) != item for item in storage['resources']):
                fail()
            if payload and runtime.r.TX.STORAGE.verified_manifest(Path(storage['bundle'])) != manifest:
                fail()
            tx = runtime.r.TX.read_record(Path(record['review']['checkpoint']['journal']), self.issuer.root, self.issuer.reader)
            if (type(intent.get('checkpointId')) is not str or not _UUID.fullmatch(intent['checkpointId'])
                    or tx.get('id') != intent['checkpointId'] or tx['review'] != record['review']['checkpoint']
                    or tx.get('backupFingerprint') != intent['checkpoint']['backupFingerprint']):
                fail()
            pin.verify()
        return manifest, tx

    def _rollback_guard(self, record, intent):
        value = self._frame(record)
        root, reader = self.issuer.root, self.issuer.reader
        if any(os.path.lexists(phase_path(root, self.reference['operationId'], name, self.issuer.host)) for name in ('forward', 'normal', 'complete')):
            fail()
        if (L.B.root_identity(root) != value['legacy']['rootIdentity']
                or hashlib.sha256(reader.daemon().encode()).hexdigest() != value['legacy']['daemonSha256']
                or os.path.lexists(L.authorization_path(root, self.issuer.host, self.issuer.reader))):
            fail()
        allowed = {root / 'orbis-compose.yml'}
        if intent['birth'] is not None: allowed.update((L.B.receipt_path(root, self.issuer.host), L.B.retired_path(root, self.issuer.host)))
        if any(os.path.lexists(path) for path in self._transition_vetoes() if path not in allowed):
            fail()
        self._rollback_manifest(record, intent)
        raw = reader._object(['container', 'inspect', '--format', '{{json .}}', value['legacy']['controller']['id']])
        configuration = L.K.digest({key: raw[key] for key in ('Config', 'HostConfig', 'Mounts')})
        restored = os.path.lexists(phase_path(root, self.reference['operationId'], 'restored', self.issuer.host))
        accepted = [value['quiescentConfigurationSha256']]
        if restored: accepted.append(value['legacy']['controller']['configurationSha256'])
        if (raw.get('Id') != value['legacy']['controller']['id'] or raw.get('Image') != value['legacy']['controller']['imageId']
                or raw.get('Name') not in ('/' + record['review']['controllerName'], '/' + record['retainedName'])
                or configuration not in accepted):
            fail()
        if not restored:
            state = raw.get('State', {})
            if (state.get('Status') not in ('exited', 'created') or state.get('Running') is not False
                    or type(state.get('Pid')) is not int or state['Pid'] != 0
                    or any(state.get(key) is not False for key in ('Paused', 'Restarting', 'Dead'))):
                fail()
            for identifier, role in record['review']['checkpoint']['roles'].items():
                current = reader.app(identifier)
                if (current.get('restartPolicy') != NO_RESTART
                        or role not in ('database', 'queue') and current.get('state') not in ('exited', 'created')):
                    fail()

    def _retire_birth(self, record, intent):
        root = self.issuer.root
        original, retired = L.B.receipt_path(root, self.issuer.host), L.B.retired_path(root, self.issuer.host)
        if intent['birth'] is None:
            if os.path.lexists(original) or os.path.lexists(retired): fail()
            return None
        body = L.K.canonical(self._birth(record)) + b'\n'
        path = original if os.path.lexists(original) else retired
        with ExitStack() as resources:
            value, pin = pinned_json(path, resources)
            if pin.body != body or hashlib.sha256(body).hexdigest() != intent['birth']['sha256']:
                fail()
            pin.verify()
            if path == original:
                parent = self.guard._directory.fd
                os.link(original.name, retired.name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
                os.fsync(parent)
                if os.stat(retired.name, dir_fd=parent, follow_symlinks=False).st_ino != os.fstat(pin.file).st_ino:
                    fail()
                os.unlink(original.name, dir_fd=parent); os.fsync(parent)
        with ExitStack() as resources:
            value, pin = pinned_json(retired, resources)
            if pin.body != body or os.path.lexists(original): fail()
            pin.verify()
            return {'path': str(retired), 'sha256': hashlib.sha256(body).hexdigest()}

    def _restored(self, record, intent, previous):
        self._rollback_guard(record, intent)
        manifest, tx = self._rollback_manifest(record, intent, payload=True)
        runtime = self._runtime()
        if tx['stage'] != 'starting' or tx.get('restoreReview', {}).get('backupFingerprint') != intent['checkpoint']['backupFingerprint']:
            fail()
        runtime.r.TX.RESTORE.writers(self.issuer.root, self.issuer.reader, manifest)
        for item, copied in zip(manifest['plan']['resources'], manifest['copies']):
            runtime.r.TX.RESTORE.verify_destination(Path(item['source']), item, copied)
        with ExitStack() as resources:
            restored, pin = pinned_json(Path(tx['restoreJournal']), resources)
            if (restored.get('schema') != runtime.r.TX.RESTORE.SCHEMA or restored.get('stage') != 'complete'
                    or restored.get('review') != tx['restoreReview']):
                fail()
            birth = self._retire_birth(record, intent)
            data = {'restore': file_reference(pin), 'backupFingerprint': intent['checkpoint']['backupFingerprint'], 'birth': birth}
            pin.verify()
        self._publish_phase(record, 'restored', previous, data)

    def _verify_restored(self, record, intent, previous):
        self._rollback_guard(record, intent)
        data, digest = self._read_phase('restored', previous)
        manifest, tx = self._rollback_manifest(record, intent)
        with ExitStack() as resources:
            restored, pin = pinned_json(Path(data['restore']['path']), resources)
            if (file_reference(pin) != data['restore'] or restored.get('stage') != 'complete'
                    or restored.get('review', {}).get('backupFingerprint') != intent['checkpoint']['backupFingerprint']
                    or data['backupFingerprint'] != intent['checkpoint']['backupFingerprint']):
                fail()
            pin.verify()
        original, retired = L.B.receipt_path(self.issuer.root, self.issuer.host), L.B.retired_path(self.issuer.root, self.issuer.host)
        if os.path.lexists(original): fail()
        if intent['birth'] is None:
            if data['birth'] is not None or os.path.lexists(retired): fail()
        else:
            with ExitStack() as resources:
                value, pin = pinned_json(retired, resources)
                expected = {'path': str(retired), 'sha256': hashlib.sha256(pin.body).hexdigest()}
                if (pin.body != L.K.canonical(self._birth(record)) + b'\n'
                        or expected != data['birth'] or expected['sha256'] != intent['birth']['sha256']):
                    fail()
                pin.verify()
        return data, digest, tx

    def _rollback_outcome(self, record, intent, previous):
        restored, digest, tx = self._verify_restored(record, intent, previous)
        runtime, reader = self._runtime(), self.issuer.reader
        if tx['stage'] != 'recovered' or tx.get('storageRestored') is not True or record.get('stage') != 'rolled-back': fail()
        if runtime.r.candidate(record, reader) is not None: fail()
        expected = {item['id']: item for item in record['review']['checkpoint']['storage']['containerStates']}
        if runtime.r.TX.identities(self.issuer.root, reader, record['review']['checkpoint']) != expected:
            fail()
        legacy = L._controller(self.issuer.root, reader)
        original = L.K.decoded(self._value)['legacy']['controller']
        if any(legacy[key] != original[key] for key in ('id', 'imageId', 'configurationSha256')):
            fail()
        # A healthy restart of this same restored definition is not another
        # ownership decision. Retrying retirement must never recopy its writes.
        controller = {key: legacy[key] for key in ('id', 'imageId', 'configurationSha256')}
        for name, expected_hash in L.K.decoded(self._value)['legacy']['files'].items():
            path = self.issuer.root / name
            if expected_hash is None:
                if os.path.lexists(path): fail()
            elif runtime.r.HOST.file_digest(path) != expected_hash: fail()
        with ExitStack() as resources:
            main = runtime.record(record, resources)
            tx_value, pin = pinned_json(Path(record['review']['checkpoint']['journal']), resources)
            if tx_value != tx: fail()
            data = {'controller': controller, 'checkpoint': file_reference(pin), 'journal': file_reference(main), 'birth': restored['birth']}
            main.verify(); pin.verify()
        return data, digest

    def rollback(self, record):
        """Restore only the positively bound checkpoint before forward intent."""
        if self._completed_read or self._aborted_read: fail()
        if self._rollback_read:
            data = self.rolled_back(record)
            def terminal_verified():
                self.rolled_back(record)
                return True
            self.guard.finish(self.reference['operationId'], self.reference['admissionBinding'], verify_completed=terminal_verified)
            return data
        phase = phase_path(self.issuer.root, self.reference['operationId'], 'rollback', self.issuer.host)
        previous = hashlib.sha256(self._body).hexdigest()
        if os.path.lexists(phase):
            intent, rollback_sha = self._read_phase('rollback', previous)
        else:
            if any(os.path.lexists(phase_path(self.issuer.root, self.reference['operationId'], name, self.issuer.host)) for name in ('forward', 'normal', 'complete')):
                fail()
            environment = None
            if os.path.lexists(phase_path(self.issuer.root, self.reference['operationId'], 'resume', self.issuer.host)):
                resume, _, _ = self._active(record); environment = resume['environment']
            elif os.path.lexists(phase_path(self.issuer.root, self.reference['operationId'], 'reset', self.issuer.host)):
                birth = self._birth(record) if os.path.lexists(L.B.receipt_path(self.issuer.root, self.issuer.host)) else None
                reset, _ = self._reset(record, birth=birth); environment = reset['snapshot']['environment']
            elif os.path.lexists(phase_path(self.issuer.root, self.reference['operationId'], 'reset-intent', self.issuer.host)):
                if (os.path.lexists(L.B.receipt_path(self.issuer.root, self.issuer.host))
                        or self._runtime().r.candidate(record, self.issuer.reader) is not None): fail()
                _, _, environment = self._reset_intent(record)
            self._cutover(record, environment=environment)
            staged = os.path.lexists(self.issuer.root / 'orbis-compose.yml')
            if staged:
                self._staged(record, environment=environment, birth=self._birth(record) if os.path.lexists(L.B.receipt_path(self.issuer.root, self.issuer.host)) else None)
            else:
                self.check(record['review'], record['id'], original_state='stopped')
            birth = None
            if os.path.lexists(L.B.receipt_path(self.issuer.root, self.issuer.host)):
                with ExitStack() as resources:
                    value, pin = pinned_json(L.B.receipt_path(self.issuer.root, self.issuer.host), resources)
                    if value != self._birth(record): fail()
                    birth = {'schema': L.B.SCHEMA, 'path': str(pin.path), 'sha256': hashlib.sha256(pin.body).hexdigest()}
            checkpoint, _ = self._read_phase('cutover', previous)
            tx = self._runtime().r.TX.read_record(Path(record['review']['checkpoint']['journal']), self.issuer.root, self.issuer.reader)
            intent = {'checkpoint': checkpoint, 'checkpointId': tx['id'], 'environment': environment, 'birth': birth, 'staged': staged}
            self._rollback_manifest(record, intent, payload=True)
            runtime = self._runtime()
            raw = runtime.r.candidate(record, self.issuer.reader)
            if raw is not None:
                if record.get('candidatePhase') not in ('hold', 'resume'): fail()
                runtime.r._matches_body(record, raw, runtime.r._controller_payload(record, self.issuer.reader, record['candidatePhase']))
            intent, rollback_sha = self._publish_phase(record, 'rollback', previous, intent)
        self._rollback_guard(record, intent)
        runtime, reader = self._runtime(), self.issuer.reader
        if not os.path.lexists(phase_path(self.issuer.root, self.reference['operationId'], 'restored', self.issuer.host)):
            record['stage'] = 'rolling-back'; runtime.r.save(record)
            runtime.r.remove_candidate(record, reader)
            raw = runtime.r.original(record, reader)
            if raw['Name'] != '/' + record['review']['controllerName']:
                reader.change(['rename', raw['Id'], record['review']['controllerName']])
            runtime.r.TX.recover(self.issuer.root, reader, Path(record['review']['checkpoint']['journal']), host_writers_stopped=True,
                                 before_originals_start=lambda: self._restored(record, intent, rollback_sha))
        else:
            _, _, tx = self._verify_restored(record, intent, rollback_sha)
            if tx['stage'] == 'starting':
                runtime.r.TX.finish_recovery(self.issuer.root, reader, Path(record['review']['checkpoint']['journal']))
            elif tx['stage'] != 'recovered': fail()
        if record.get('stage') != 'rolled-back':
            record['stage'] = 'rolled-back'; runtime.r.save(record)
        data, restored_sha = self._rollback_outcome(record, intent, rollback_sha)
        if os.path.lexists(phase_path(self.issuer.root, self.reference['operationId'], 'rolled-back', self.issuer.host)):
            old, _ = self._read_phase('rolled-back', restored_sha)
            if old != data: fail()
        else:
            self._publish_phase(record, 'rolled-back', restored_sha, data)
        def verified():
            current, current_sha = self._rollback_outcome(record, intent, rollback_sha)
            old, _ = self._read_phase('rolled-back', current_sha)
            if current != old: fail()
            return True
        self.guard.finish(self.reference['operationId'], self.reference['admissionBinding'], verify_completed=verified)
        return copy.deepcopy(data)

    def rolled_back(self, record):
        intent, previous = self._read_phase('rollback', hashlib.sha256(self._body).hexdigest())
        data, restored_sha = self._rollback_outcome(record, intent, previous)
        issued, _ = self._read_phase('rolled-back', restored_sha)
        if issued != data: fail()
        return copy.deepcopy(data)

    def _abort_guard(self, record):
        value = self._frame(record)
        root, reader = self.issuer.root, self.issuer.reader
        if any(os.path.lexists(phase_path(root, self.reference['operationId'], name, self.issuer.host))
               for name in ('cutover', 'hold', 'reset-intent', 'reset', 'birth', 'resume', 'forward', 'normal', 'complete', 'rollback', 'restored', 'rolled-back')):
            fail()
        daemon = reader.daemon()
        if (L.B.root_identity(root) != value['legacy']['rootIdentity'] or type(daemon) is not str
                or hashlib.sha256(daemon.encode()).hexdigest() != value['legacy']['daemonSha256']
                or any(os.path.lexists(path) for path in self._transition_vetoes())
                or os.path.lexists(L.authorization_path(root, self.issuer.host, self.issuer.reader))):
            fail()
        with ExitStack() as resources:
            if self.issuer.storage(resources) != value['legacy']['storage']: fail()
            for name, expected in value['legacy']['files'].items():
                path = root / name
                if expected is None:
                    if os.path.lexists(path): fail()
                    continue
                pin = self.issuer.pin_data(path, resources)
                if (hashlib.sha256(pin.body).hexdigest() != expected
                        or list(pin.identity) != value['legacy']['fileIdentities'][name]):
                    fail()
                pin.verify()
        raw = reader._object(['container', 'inspect', '--format', '{{json .}}', value['legacy']['controller']['id']])
        configuration = L.K.digest({key: raw[key] for key in ('Config', 'HostConfig', 'Mounts')})
        if (raw.get('Id') != value['legacy']['controller']['id'] or raw.get('Image') != value['legacy']['controller']['imageId']
                or raw.get('Name') != '/' + record['review']['controllerName']
                or configuration not in (value['legacy']['controller']['configurationSha256'], value['quiescentConfigurationSha256'])):
            fail()
        self._runtime().r.TX.identities(root, reader, record['review']['checkpoint'])
        path = Path(record['review']['checkpoint']['journal'])
        tx = None
        if os.path.lexists(path):
            tx = self._runtime().r.TX.read_record(path, root, reader)
            if (tx['review'] != record['review']['checkpoint'] or tx['stage'] not in ('prepared', 'quiescing', 'snapshotting', 'ready')
                    or 'restoreReview' in tx or 'recoveryStartedFrom' in tx):
                fail()
        return tx

    def _abort_outcome(self, record, intent):
        tx = self._abort_guard(record)
        runtime, reader = self._runtime(), self.issuer.reader
        if (tx['id'] if tx else None) != intent['checkpointId'] or record.get('stage') != 'rolled-back': fail()
        expected = {item['id']: item for item in record['review']['checkpoint']['storage']['containerStates']}
        if runtime.r.TX.identities(self.issuer.root, reader, record['review']['checkpoint']) != expected: fail()
        current = L._controller(self.issuer.root, reader)
        original = L.K.decoded(self._value)['legacy']['controller']
        if any(current[key] != original[key] for key in ('id', 'imageId', 'configurationSha256')): fail()
        with ExitStack() as resources:
            main = runtime.record(record, resources)
            data = {'controller': {key: current[key] for key in ('id', 'imageId', 'configurationSha256')},
                    'checkpointId': intent['checkpointId'], 'journal': file_reference(main)}
            main.verify()
        return data

    def aborted(self, record):
        intent, previous = self._read_phase('abort', hashlib.sha256(self._body).hexdigest())
        current = self._abort_outcome(record, intent)
        issued, _ = self._read_phase('aborted', previous)
        if current != issued: fail()
        return copy.deepcopy(issued)

    def abort_pre_cutover(self, record):
        """Return unchanged original writers; never copy or remove account data."""
        if self._terminal_read not in (None, 'aborted'): fail()
        if self._aborted_read:
            data = self.aborted(record)
        else:
            tx = self._abort_guard(record)
            intent = {'checkpointId': tx['id'] if tx else None}
            previous = hashlib.sha256(self._body).hexdigest()
            if os.path.lexists(phase_path(self.issuer.root, self.reference['operationId'], 'abort', self.issuer.host)):
                issued, previous = self._read_phase('abort', previous)
                if intent != issued: fail()
            else:
                intent, previous = self._publish_phase(record, 'abort', previous, intent)
            runtime, reader = self._runtime(), self.issuer.reader
            for item in runtime.r.TX.ordered(record['review']['checkpoint'], starting=True):
                self._abort_guard(record)
                current = reader.app(item['id'])
                if item['state'] == 'running' and current['state'] != 'running':
                    reader.change(['start', item['id']], timeout=180)
                if record['review']['checkpoint']['roles'][item['id']] == 'controller':
                    runtime.r.TX.require_healthy(reader, item['id'], timeout=180)
            for item in runtime.r.TX.ordered(record['review']['checkpoint'], starting=True):
                self._abort_guard(record)
                policy = item['restartPolicy']
                flag = policy['Name'] + (':' + str(policy['MaximumRetryCount']) if policy['Name'] == 'on-failure' else '')
                reader.change(['update', '--restart', flag, item['id']])
            if record.get('stage') != 'rolled-back':
                record['stage'] = 'rolled-back'; runtime.r.save(record)
            data = self._abort_outcome(record, intent)
            if os.path.lexists(phase_path(self.issuer.root, self.reference['operationId'], 'aborted', self.issuer.host)):
                old, _ = self._read_phase('aborted', previous)
                if old != data: fail()
            else:
                self._publish_phase(record, 'aborted', previous, data)
        def verified():
            self.aborted(record)
            return True
        self.guard.finish(self.reference['operationId'], self.reference['admissionBinding'], verify_completed=verified)
        return copy.deepcopy(data)
