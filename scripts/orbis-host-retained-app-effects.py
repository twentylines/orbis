#!/usr/bin/env python3
"""Durable app effects for independently admitted root restore plans.

No daemon transport, plan admission, data restore, health policy or authority is
provided here. The required authorizer must re-read root origin/frame/decision
and enforce its own nonrenewable lease for every supplied scope/action.
"""
import copy
import fcntl
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import stat
import time
import uuid
from contextlib import contextmanager
from types import SimpleNamespace


def _load(filename, name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


COMPILER = _load('orbis-host-app-create-intent.py', 'retained_app_effects_compiler')
HEX = re.compile(r'[a-f0-9]{64}')
NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,254}')
DEFINITION_LIMIT = 16 * 1024 * 1024
PROGRESS_LIMIT = 1024 * 1024
MAX_CONTAINERS = 1024
MAX_RECOVERY_GRANTS = 64


def fail():
    return ValueError('Protected retained app effects could not be verified')


def canonical(value):
    COMPILER._bounded(value)
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf8')


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def _uuid(value):
    if not isinstance(value, str): raise fail()
    parsed = uuid.UUID(value)
    if str(parsed) != value or parsed.version != 4: raise fail()
    return value


def default_storage():
    authority = _load('orbis-host-retained-authority.py', 'retained_app_effects_authority')
    capture = _load('orbis-host-capture-authority.py', 'retained_app_effects_capture')
    return SimpleNamespace(protected_directory=authority.protected_directory,
                           protected_file=authority.protected_file,
                           atomic=authority.atomic, immutable=capture.immutable, owner=0)


class RetainedAppEffects:
    """Synchronous, resumable exact-ID effects; all callbacks are mandatory.

    engine: inspect(id), find_name(name), create(name, body), start(id), remove(id).
    inspect/find_name return a complete snapshot or None ONLY for authoritative
    daemon 404 / exact successful empty lookup, never transport errors/timeouts.
    create returns a full 64-hex ID, never a prefix. remove must mean non-force,
    no volume deletion. Adapter exceptions propagate with durable intent intact.

    authorize(scope, action) returns exactly {decision, deadline}; deadline is
    integer epoch seconds fixed by root, at most 15 minutes from first use.
    verify_destination(original, current) and verify_ports(plans, destinations)
    must return True after independent root checks. comparator is the shared
    DockerRestoreRuntime.check_intent bound to the independently trusted runtime.
    storage is root-owned helper injection, never caller JSON or HTTP content.
    Optional probe_plans must be the same full plans with ONLY bind Source paths
    transformed into root-verified incoming sibling roots. Their separate digest
    is in scope. The authorizer must validate that mapping, existing source inode
    identities and filesystem safety before every probe boundary; this module
    never creates bind sources or infers their safety from inert Docker create.
    """
    def __init__(self, directory, *, restore_id, point_id, operation_sha256,
                 authority_sha256, plans, destinations, engine, comparator,
                 verify_destination, verify_ports, authorize, storage=None, probe_plans=None):
        if not all(callable(item) for item in (comparator, verify_destination, verify_ports, authorize)):
            raise fail()
        for method in ('inspect', 'find_name', 'create', 'start', 'remove'):
            if not callable(getattr(engine, method, None)): raise fail()
        self.path = Path(directory)
        self.store = default_storage() if storage is None else storage
        self.engine, self.comparator = engine, comparator
        self.verify_destination, self.verify_ports, self.authorize = verify_destination, verify_ports, authorize
        self.plans, self.destinations = copy.deepcopy(plans), copy.deepcopy(destinations)
        self.probe_plans = copy.deepcopy(plans if probe_plans is None else probe_plans)
        self._validate_definitions()
        self._validate_probe_plans()
        if any(not isinstance(value, str) or HEX.fullmatch(value) is None for value in (operation_sha256, authority_sha256)):
            raise fail()
        self.scope = {'version': 1, 'restoreId': _uuid(restore_id), 'pointId': _uuid(point_id),
                      'operationSha256': operation_sha256, 'authoritySha256': authority_sha256,
                      'plansSha256': digest(self.plans), 'destinationsSha256': digest(self.destinations),
                      'probePlansSha256': digest(self.probe_plans)}
        self.scope_hash = digest(self.scope)
        self.definition = {'scope': self.scope, 'plans': self.plans, 'destinations': self.destinations, 'probePlans': self.probe_plans}
        if len(canonical(self.definition)) > DEFINITION_LIMIT: raise fail()
        self.progress = None

    def _validate_definitions(self):
        if (not isinstance(self.plans, list) or not isinstance(self.destinations, list)
                or len(self.plans) > MAX_CONTAINERS or len(self.destinations) > MAX_CONTAINERS): raise fail()
        names, ids, keys = set(), set(), []
        for plan in self.plans:
            if (not isinstance(plan, dict) or set(plan) != {'appUrn', 'service', 'ordinal', 'sourceId', 'wasRunning', 'compiled'}
                    or not isinstance(plan['appUrn'], str) or not plan['appUrn'] or not isinstance(plan['service'], str) or not plan['service']
                    or type(plan['ordinal']) is not int or not 1 <= plan['ordinal'] <= 1024
                    or type(plan['wasRunning']) is not bool or not isinstance(plan['sourceId'], str)
                    or HEX.fullmatch(plan['sourceId']) is None): raise fail()
            compiled = plan['compiled']
            if (not isinstance(compiled, dict) or set(compiled) != {'name', 'body', 'networkIds'}
                    or not isinstance(compiled['name'], str) or NAME.fullmatch(compiled['name']) is None
                    or compiled['name'].startswith('orbis-retained-')
                    or not isinstance(compiled['body'], dict) or not isinstance(compiled['networkIds'], dict)
                    or not isinstance(compiled['body'].get('Image'), str) or COMPILER.IMAGE.fullmatch(compiled['body']['Image']) is None
                    or any(not isinstance(value, str) or HEX.fullmatch(value) is None for value in compiled['networkIds'].values())
                    or compiled['body'].get('HostConfig', {}).get('AutoRemove') is not False
                    or compiled['body'].get('HostConfig', {}).get('ContainerIDFile') not in (None, '')): raise fail()
            if compiled['name'] in names or plan['sourceId'] in ids: raise fail()
            names.add(compiled['name']); ids.add(plan['sourceId'])
            keys.append((plan['appUrn'], plan['service'], plan['ordinal'], plan['sourceId']))
        if keys != sorted(keys) or len(set(key[:3] for key in keys)) != len(keys): raise fail()
        ids, names = set(), set()
        for raw in self.destinations:
            if (not isinstance(raw, dict) or not isinstance(raw.get('Id'), str) or HEX.fullmatch(raw['Id']) is None
                    or not isinstance(raw.get('Name'), str) or not raw['Name'].startswith('/')
                    or NAME.fullmatch(raw['Name'][1:]) is None or raw['Id'] in ids or raw['Name'] in names): raise fail()
            ids.add(raw['Id']); names.add(raw['Name'])
        if [raw['Id'] for raw in self.destinations] != sorted(ids): raise fail()
        canonical({'plans': self.plans, 'destinations': self.destinations})

    def _validate_probe_plans(self):
        if not isinstance(self.probe_plans, list) or len(self.probe_plans) != len(self.plans): raise fail()
        for plan, probe in zip(self.plans, self.probe_plans):
            desired, actual = copy.deepcopy(plan), copy.deepcopy(probe)
            try:
                for candidate in (desired, actual):
                    host = candidate['compiled']['body']['HostConfig']
                    for mount in host.get('Mounts') or []:
                        if mount.get('Type') != 'bind' or not COMPILER._path(mount['Source']): raise fail()
                        mount['Source'] = '/protected-bind-source'
                    binds = host.get('Binds')
                    if binds is not None:
                        for index, bind in enumerate(binds):
                            parts = bind.split(':')
                            if len(parts) not in (2, 3) or not COMPILER._path(parts[0]): raise fail()
                            binds[index] = ':'.join(['/protected-bind-source'] + parts[1:])
            except (KeyError, TypeError, AttributeError) as error:
                raise fail() from error
            if actual != desired: raise fail()
        canonical(self.probe_plans)

    def _guard(self, action, decisions):
        result = self.authorize(copy.deepcopy(self.scope), action)
        if (not isinstance(result, dict) or set(result) != {'decision', 'deadline'}
                or result['decision'] not in decisions or type(result['deadline']) is not int
                or not math.isfinite(result['deadline']) or result['deadline'] <= time.time()): raise fail()
        if self.progress is not None:
            if result['deadline'] != self.progress['deadline']: raise fail()
        elif result['deadline'] > time.time() + 900: raise fail()
        return result

    def _read(self, name, maximum):
        with self.store.protected_directory(self.path) as parent:
            with self.store.protected_file(parent, name, maximum) as body:
                value = json.loads(body)
                if canonical(value) != body: raise fail()
                return value

    def _save(self, decisions):
        self._guard('journal-write', decisions)
        self._validate_progress()
        body = canonical(self.progress)
        if len(body) > PROGRESS_LIMIT: raise fail()
        # Validate any old inode before replacing it; the helper fsyncs both file
        # and parent. Parent/ancestor ownership is independently checked again.
        try: self._read('progress.json', PROGRESS_LIMIT)
        except FileNotFoundError: pass
        with self.store.protected_directory(self.path): pass
        self.store.atomic(self.path / 'progress.json', body)
        with self.store.protected_directory(self.path): pass
        self._guard('journal-written', decisions)

    @contextmanager
    def _locked(self, decisions):
        self.progress = None
        permit = self._guard('open', decisions)
        with self.store.protected_directory(self.path): pass
        lock_path = self.path / 'effects.lock'
        descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        try:
            details = os.fstat(descriptor)
            if (not stat.S_ISREG(details.st_mode) or details.st_uid != self.store.owner or details.st_nlink != 1
                    or stat.S_IMODE(details.st_mode) & 0o077 or details.st_size != 0): raise fail()
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self._guard('locked', decisions)
            with self.store.protected_directory(self.path): pass
            self.store.immutable(self.path / 'definition.json', canonical(self.definition))
            if self._read('definition.json', DEFINITION_LIMIT) != self.definition: raise fail()
            try: self.progress = self._read('progress.json', PROGRESS_LIMIT)
            except FileNotFoundError:
                self.progress = {'version': 1, 'scopeSha256': self.scope_hash, 'deadline': permit['deadline'],
                                 'probes': [self._object_state() for _ in self.plans],
                                 'destinations': [{'removeIntent': False, 'removed': False} for _ in self.destinations],
                                 'desired': [self._object_state() for _ in self.plans]}
                self._save(decisions)
            self._validate_progress()
            self._guard('loaded', decisions)
            yield
        finally:
            os.close(descriptor)

    @staticmethod
    def _object_state():
        return {'createIntent': False, 'id': None, 'removeIntent': False, 'removed': False,
                'startIntent': False, 'started': False}

    def _validate_progress(self):
        value = self.progress
        fields = {'version', 'scopeSha256', 'deadline', 'probes', 'destinations', 'desired'}
        if not isinstance(value, dict) or type(value.get('version')) is not int or value['version'] not in (1, 2): raise fail()
        if value['version'] == 2: fields |= {'initialDeadline', 'leaseHistory'}
        if (set(value) != fields or value['scopeSha256'] != self.scope_hash
                or type(value['deadline']) is not int or not 0 < value['deadline'] <= 9007199254740991): raise fail()
        if value['version'] == 2:
            history = value['leaseHistory']
            if (type(value['initialDeadline']) is not int or not 0 < value['initialDeadline'] <= 9007199254740991
                    or not isinstance(history, list) or not 1 <= len(history) <= MAX_RECOVERY_GRANTS): raise fail()
            predecessor, grants, decision = value['initialDeadline'], set(), 'NONE'
            for entry in history:
                if (not isinstance(entry, dict) or set(entry) != {'grantId', 'predecessorDeadline', 'deadline', 'decision'}
                        or not isinstance(entry['grantId'], str) or entry['grantId'] in grants or type(entry['predecessorDeadline']) is not int
                        or entry['predecessorDeadline'] != predecessor or type(entry['deadline']) is not int
                        or not predecessor < entry['deadline'] <= 9007199254740991
                        or entry['decision'] not in {'NONE', 'COMMIT', 'ROLLBACK'}
                        or decision != 'NONE' and entry['decision'] != decision): raise fail()
                _uuid(entry['grantId'])
                grants.add(entry['grantId']); predecessor = entry['deadline']; decision = entry['decision']
            if value['deadline'] != predecessor: raise fail()
        all_ids = set()
        for kind in ('probes', 'destinations', 'desired'):
            rows = value[kind]
            if not isinstance(rows, list) or len(rows) != len(self.destinations if kind == 'destinations' else self.plans): raise fail()
            for row in rows:
                expected = {'removeIntent', 'removed'} if kind == 'destinations' else set(self._object_state())
                if not isinstance(row, dict) or set(row) != expected: raise fail()
                if any(type(row[key]) is not bool for key in expected - {'id'}): raise fail()
                if row['removed'] and not row['removeIntent']: raise fail()
                if kind != 'destinations':
                    identity = row['id']
                    if identity is not None:
                        if (not isinstance(identity, str) or HEX.fullmatch(identity) is None or not row['createIntent']
                                or identity in all_ids or identity in {raw['Id'] for raw in self.destinations}): raise fail()
                        all_ids.add(identity)
                    if ((row['startIntent'] or row['removeIntent']) and identity is None
                            or row['started'] and not row['startIntent']
                            or kind == 'probes' and (row['startIntent'] or row['started'])
                            or kind == 'desired' and (row['removeIntent'] or row['removed'])): raise fail()

    def _recovery_permit(self, grant_id, predecessor_deadline):
        scope = copy.deepcopy(self.scope)
        scope['recoveryLease'] = {'grantId': grant_id, 'predecessorDeadline': predecessor_deadline}
        result = self.authorize(scope, 'recover-lease')
        now = time.time()
        if (not isinstance(result, dict) or set(result) != {'decision', 'deadline'}
                or result['decision'] not in {'NONE', 'COMMIT', 'ROLLBACK'} or type(result['deadline']) is not int
                or not now < result['deadline'] <= now + 900 or result['deadline'] <= predecessor_deadline): raise fail()
        return result

    def recover_lease(self, grant_id, *, predecessor_deadline):
        """Admit an explicit root recovery grant after an expired predecessor.

        Root must FIRST prove the previous operation quiesced and durably issue
        the exact fresh grant. Only action 'recover-lease' extends the scope with
        recoveryLease:{grantId,predecessorDeadline}; the required authorizer must
        independently verify that grant, original scope and current decision.
        Ordinary calls never renew. Existing journals only; no Engine calls.
        Latest exact grant retries are idempotent; old/stale grants fail closed.
        """
        _uuid(grant_id)
        if type(predecessor_deadline) is not int or not 0 < predecessor_deadline <= time.time(): raise fail()
        permit = self._recovery_permit(grant_id, predecessor_deadline)
        with self.store.protected_directory(self.path): pass
        descriptor = os.open(self.path / 'effects.lock', os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            details = os.fstat(descriptor)
            if (not stat.S_ISREG(details.st_mode) or details.st_uid != self.store.owner or details.st_nlink != 1
                    or stat.S_IMODE(details.st_mode) & 0o077 or details.st_size != 0): raise fail()
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if self._recovery_permit(grant_id, predecessor_deadline) != permit: raise fail()
            if self._read('definition.json', DEFINITION_LIMIT) != self.definition: raise fail()
            self.progress = self._read('progress.json', PROGRESS_LIMIT)
            self._validate_progress()
            history = self.progress.get('leaseHistory', [])
            if history and history[-1]['grantId'] == grant_id:
                if (history[-1]['predecessorDeadline'] != predecessor_deadline
                        or history[-1]['deadline'] != permit['deadline']): raise fail()
                if self._recovery_permit(grant_id, predecessor_deadline) != permit: raise fail()
                self._guard('recovery-lease-reconciled', {permit['decision']})
                return self._summary()
            if (self.progress['deadline'] != predecessor_deadline or any(entry['grantId'] == grant_id for entry in history)
                    or len(history) >= MAX_RECOVERY_GRANTS): raise fail()
            if self._recovery_permit(grant_id, predecessor_deadline) != permit: raise fail()
            initial = self.progress.get('initialDeadline', self.progress['deadline'])
            self.progress.update(version=2, initialDeadline=initial, deadline=permit['deadline'],
                                 leaseHistory=history + [{'grantId': grant_id, 'predecessorDeadline': predecessor_deadline,
                                                         'deadline': permit['deadline'], 'decision': permit['decision']}])
            self._save({permit['decision']})
            if self._recovery_permit(grant_id, predecessor_deadline) != permit: raise fail()
            return self._summary()
        finally:
            os.close(descriptor)

    def _call(self, method, *args, decisions):
        self._guard('before-' + method, decisions)
        result = getattr(self.engine, method)(*copy.deepcopy(args))
        self._guard('after-' + method, decisions)
        return copy.deepcopy(result)

    def _inspect(self, identity, decisions):
        raw = self._call('inspect', identity, decisions=decisions)
        if raw is not None and (not isinstance(raw, dict) or raw.get('Id') != identity): raise fail()
        return raw

    def _find(self, name, decisions):
        raw = self._call('find_name', name, decisions=decisions)
        if raw is not None and (not isinstance(raw, dict) or raw.get('Name') != '/' + name
                                or not isinstance(raw.get('Id'), str) or HEX.fullmatch(raw['Id']) is None): raise fail()
        return raw

    @staticmethod
    def _stopped(raw, never_started=False):
        state = raw.get('State')
        if (not isinstance(state, dict) or state.get('Running') is not False or state.get('Paused') is not False
                or state.get('Restarting') is not False): raise fail()
        if never_started and (state.get('Status') != 'created' or state.get('StartedAt') != '0001-01-01T00:00:00Z'
                              or state.get('FinishedAt') != '0001-01-01T00:00:00Z'): raise fail()

    def _checked(self, raw, compiled, *, running=None, never_started=False):
        if raw is None: raise fail()
        COMPILER.verify_created(raw, copy.deepcopy(compiled), self.comparator)
        state = raw['State']
        if state.get('Paused') is not False or state.get('Restarting') is not False: raise fail()
        if running is not None and state['Running'] is not running: raise fail()
        for name, endpoint in raw['NetworkSettings']['Networks'].items():
            endpoint_id = endpoint.get('EndpointID')
            if state['Running']:
                if (endpoint.get('NetworkID') != compiled['networkIds'][name]
                        or not isinstance(endpoint_id, str) or HEX.fullmatch(endpoint_id) is None): raise fail()
            elif endpoint_id not in (None, '') and (not isinstance(endpoint_id, str) or HEX.fullmatch(endpoint_id) is None):
                raise fail()
        if never_started: self._stopped(raw, True)
        return raw

    def _destination(self, index, decisions, absent=False):
        original = self.destinations[index]
        raw = self._inspect(original['Id'], decisions)
        if raw is None:
            if not absent or not self.progress['destinations'][index]['removeIntent']: raise fail()
            return None
        self._guard('before-verify-destination', decisions)
        if self.verify_destination(copy.deepcopy(original), copy.deepcopy(raw)) is not True: raise fail()
        self._guard('after-verify-destination', decisions)
        self._stopped(raw)
        return raw

    def _ports(self):
        self._guard('before-verify-ports', {'NONE'})
        if self.verify_ports(copy.deepcopy(self.plans), copy.deepcopy(self.destinations)) is not True: raise fail()
        self._guard('after-verify-ports', {'NONE'})

    def _preflight(self):
        self._ports()
        allowed = {raw['Name'][1:]: raw['Id'] for raw in self.destinations}
        for index in range(len(self.destinations)): self._destination(index, {'NONE'})
        for plan in self.plans:
            raw = self._find(plan['compiled']['name'], {'NONE'})
            if raw is not None and allowed.get(plan['compiled']['name']) != raw['Id']: raise fail()

    def preflight(self):
        """Root must call immediately before its durable commit decision too."""
        with self._locked({'NONE'}):
            self._preflight()
            return self._summary()

    def _compiled(self, index, probe):
        compiled = copy.deepcopy((self.probe_plans if probe else self.plans)[index]['compiled'])
        if probe: compiled['name'] = 'orbis-retained-' + self.scope['restoreId'] + '-app-probe-' + str(index)
        return compiled

    def _create(self, index, probe, decisions):
        row = self.progress['probes' if probe else 'desired'][index]
        compiled = self._compiled(index, probe)
        if row['removed']:
            if self._find(compiled['name'], decisions) is not None: raise fail()
            return None
        if row['id'] is not None:
            raw = self._inspect(row['id'], decisions)
            named = self._find(compiled['name'], decisions)
            if raw is None or named is None or named['Id'] != row['id']: raise fail()
            if probe: return self._checked(raw, compiled, running=False, never_started=True)
            if row['started']: return self._checked(raw, compiled, running=True)
            if raw.get('State', {}).get('Running') is True:
                if not row['startIntent']: raise fail()
                return self._checked(raw, compiled, running=True)
            return self._checked(raw, compiled, running=False, never_started=True)
        named = self._find(compiled['name'], decisions)
        if row['createIntent']:
            # Absence after an ambiguous create is not proof that the daemon will
            # never complete it. Fail closed; reconcile the same fixed name later.
            raw = self._checked(named, compiled, running=False, never_started=True)
            row['id'] = raw['Id']; self._save(decisions)
            return raw
        if named is not None: raise fail()
        row['createIntent'] = True; self._save(decisions)
        identity = self._call('create', compiled['name'], compiled['body'], decisions=decisions)
        if not isinstance(identity, str) or HEX.fullmatch(identity) is None: raise fail()
        row['id'] = identity; self._save(decisions)
        raw = self._inspect(identity, decisions)
        named = self._find(compiled['name'], decisions)
        if named is None or named['Id'] != identity: raise fail()
        return self._checked(raw, compiled, running=False, never_started=True)

    def _remove_probe(self, index, decisions):
        row = self.progress['probes'][index]
        if not row['createIntent']:
            if self._find(self._compiled(index, True)['name'], decisions) is not None: raise fail()
            return
        if row['id'] is None: self._create(index, True, decisions)
        raw = self._inspect(row['id'], decisions)
        if raw is None:
            if not row['removeIntent']: raise fail()
        else:
            self._checked(raw, self._compiled(index, True), running=False, never_started=True)
            named = self._find(self._compiled(index, True)['name'], decisions)
            if named is None or named['Id'] != row['id']: raise fail()
            if row['removed']: raise fail()
            row['removeIntent'] = True; self._save(decisions)
            self._call('remove', row['id'], decisions=decisions)
            if self._inspect(row['id'], decisions) is not None: raise fail()
        if self._find(self._compiled(index, True)['name'], decisions) is not None: raise fail()
        row['removed'] = True; self._save(decisions)

    def probe(self):
        with self._locked({'NONE'}):
            self._preflight()
            for index in range(len(self.plans)):
                if not self.progress['probes'][index]['removeIntent']:
                    self._create(index, True, {'NONE'})
                self._remove_probe(index, {'NONE'})
            self._preflight()
            return self._summary()

    def cleanup_probes(self):
        """Must succeed before Node may roll back precommit data."""
        with self._locked({'NONE', 'ROLLBACK'}):
            for index in range(len(self.plans)): self._remove_probe(index, {'NONE', 'ROLLBACK'})
            return self._summary()

    def activate(self):
        with self._locked({'COMMIT'}):
            for index, row in enumerate(self.progress['probes']):
                if not row['removed']: raise fail()
                self._remove_probe(index, {'COMMIT'})
            for index, row in enumerate(self.progress['destinations']):
                raw = self._destination(index, {'COMMIT'}, absent=True)
                if raw is not None:
                    if row['removed']: raise fail()
                    row['removeIntent'] = True; self._save({'COMMIT'})
                    self._call('remove', raw['Id'], decisions={'COMMIT'})
                    if self._inspect(raw['Id'], {'COMMIT'}) is not None: raise fail()
                row['removed'] = True; self._save({'COMMIT'})
            # Every historical object exists and compares before the first start.
            for index in range(len(self.plans)): self._create(index, False, {'COMMIT'})
            for index, plan in enumerate(self.plans):
                row = self.progress['desired'][index]
                raw = self._checked(self._inspect(row['id'], {'COMMIT'}), self._compiled(index, False))
                if not plan['wasRunning']:
                    if row['startIntent']: raise fail()
                    self._checked(raw, self._compiled(index, False), running=False, never_started=True)
                elif raw['State']['Running']:
                    if not row['startIntent']: raise fail()
                    row['started'] = True; self._save({'COMMIT'})
                else:
                    self._stopped(raw, not row['startIntent'])
                    row['startIntent'] = True; self._save({'COMMIT'})
                    self._call('start', row['id'], decisions={'COMMIT'})
                    self._checked(self._inspect(row['id'], {'COMMIT'}), self._compiled(index, False), running=True)
                    row['started'] = True; self._save({'COMMIT'})
            self._verify()
            return self._summary()

    def _verify(self):
        for index, row in enumerate(self.progress['probes']):
            if not row['removed'] or self._find(self._compiled(index, True)['name'], {'COMMIT'}) is not None: raise fail()
        for index, row in enumerate(self.progress['destinations']):
            if not row['removed'] or not row['removeIntent'] or self._inspect(self.destinations[index]['Id'], {'COMMIT'}) is not None: raise fail()
        for index, plan in enumerate(self.plans):
            row = self.progress['desired'][index]
            if row['id'] is None: raise fail()
            raw = self._inspect(row['id'], {'COMMIT'})
            named = self._find(self._compiled(index, False)['name'], {'COMMIT'})
            if named is None or named['Id'] != row['id']: raise fail()
            self._checked(raw, self._compiled(index, False), running=plan['wasRunning'], never_started=not plan['wasRunning'])
            if plan['wasRunning'] and (not row['started'] or not row['startIntent']): raise fail()
        self._guard('verified', {'COMMIT'})

    def verify(self):
        with self._locked({'COMMIT'}):
            self._verify()
            return self._summary()

    def status(self):
        """Read progress under fresh authority; this is not an acceptance proof."""
        with self._locked({'NONE', 'COMMIT', 'ROLLBACK'}): return self._summary()

    def _summary(self):
        return {'version': 1, 'scopeSha256': self.scope_hash,
                'probesRemoved': sum(row['removed'] for row in self.progress['probes']),
                'destinationsRemoved': sum(row['removed'] for row in self.progress['destinations']),
                'desiredCreated': sum(row['id'] is not None for row in self.progress['desired']),
                'desiredStarted': sum(row['started'] for row in self.progress['desired'])}
