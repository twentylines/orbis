#!/usr/bin/env python3
"""Protected controller replacement that never recreates the running proxy.

The source is the already-running Docker definition, not writable Compose input.
Database and queue keep their reviewed IDs; their checkpoint still stops writers.
"""
import copy
import hashlib
import importlib.util
import io
import os
import re
import secrets
import stat
import tarfile
import time
import uuid
from pathlib import Path
from types import SimpleNamespace


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


D = load('orbis-host-retained-restore-runtime.py', 'orbis_controller_update_runtime')
BOOTSTRAP = load('orbis-controller-bootstrap-profile.py', 'orbis_controller_bootstrap_profile')
POLICY = 'orbis.controller-update-preserve-live-proxy.v1'
NO_BACKUP_POLICY = 'orbis.controller-update-no-backup.v1'
SCOPE = 'controller-live-proxy.v1'
RESET = D.RESET
RESET_POLICY = 'orbis.controller-update-reset-mount.v1'
RESET_POLICY_V2 = 'orbis.controller-update-reset-mount.v2'
SOURCE_RETIREMENT = 'orbis.controller-source-retirement.v1'
SOURCE_ENABLEMENT = 'orbis.controller-source-bootstrap-enablement.v1'
PRESERVE_ENV = 'ORBIS_CONTROLLER_PRESERVE_NETWORK_ACCESS'
PROBE_RETIREMENT = 'orbis.controller-probe-retirement.v2'
TOOLS = load('orbis-install-transaction.py', 'orbis_controller_reconstruction_transaction')
CAPABILITY = {'schema': 'orbis.controller-overlay-startup.v1', 'version': 1, 'preserveNetworkAccess': True,
              'preserveRunningApps': True, 'environment': 'ORBIS_CONTROLLER_PRESERVE_NETWORK_ACCESS=1'}
NO_BACKUP_CAPABILITY = {**CAPABILITY, 'schema': 'orbis.controller-overlay-startup.v2', 'version': 2,
                        'updateBackupPolicy': 'none'}
CLI_CAPABILITY = {**NO_BACKUP_CAPABILITY, 'schema': 'orbis.controller-overlay-startup.v3', 'version': 3,
                  'cliIdentity': {'path': '/data/.secrets/cli-secret', 'encoding': 'hex32', 'creator': 'backend'}}
CLI_STORAGE = 'orbis.controller-cli-storage.v1'
CLI_OWNER = 0
CLI_TARGET = '/data/.secrets'


def cli_file_identity(value):
    return tuple(getattr(value, key) for key in ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink',
                                                'st_size', 'st_mtime_ns', 'st_ctime_ns'))


def cli_storage(root, *, create=False):
    """Observe private target identity without copying a key into update state."""
    root = Path(root)
    if not root.is_absolute() or os.path.normpath(str(root)) != str(root):
        raise ValueError('CLI authentication root is invalid')
    descriptors = [os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)]
    bindings = []
    try:
        for part in root.parts[1:]:
            parent = descriptors[-1]
            current = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            descriptors.append(current)
            bindings.append((parent, part, current))
        parent = descriptors[-1]
        if stat.S_IMODE(os.fstat(parent).st_mode) & 0o022:
            raise ValueError('CLI authentication root is writable by other users')
        if create:
            try:
                os.mkdir('.secrets', 0o700, dir_fd=parent)
            except FileExistsError:
                pass
        directory = os.open('.secrets', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        descriptors.append(directory)
        bindings.append((parent, '.secrets', directory))
        details = os.fstat(directory)
        if details.st_uid != CLI_OWNER or stat.S_IMODE(details.st_mode) != 0o700:
            raise ValueError('CLI authentication directory is not private')
        digest = None
        try:
            key = os.open('cli-secret', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        except FileNotFoundError:
            pass
        else:
            try:
                before = os.fstat(key)
                if (not stat.S_ISREG(before.st_mode) or before.st_uid != CLI_OWNER
                        or stat.S_IMODE(before.st_mode) != 0o600 or before.st_nlink != 1 or before.st_size != 64):
                    raise ValueError('CLI authentication key is invalid or not private')
                data = os.read(key, 65)
                if (not re.fullmatch(rb'[a-f0-9]{64}', data) or cli_file_identity(before) != cli_file_identity(os.fstat(key))
                        or cli_file_identity(before) != cli_file_identity(os.stat('cli-secret', dir_fd=directory, follow_symlinks=False))):
                    raise ValueError('CLI authentication key changed or is invalid')
                digest = hashlib.sha256(data).hexdigest()
            finally:
                os.close(key)
        for parent_fd, part, descriptor in bindings:
            before = os.fstat(descriptor)
            after = os.stat(part, dir_fd=parent_fd, follow_symlinks=False)
            if (before.st_dev, before.st_ino, before.st_uid, before.st_mode) != (after.st_dev, after.st_ino, after.st_uid, after.st_mode):
                raise ValueError('CLI authentication directory changed')
        if create:
            os.fsync(directory)
            os.fsync(parent)
        return {'schema': CLI_STORAGE, 'source': str(root / '.secrets'), 'destination': CLI_TARGET,
                'device': details.st_dev, 'inode': details.st_ino, 'owner': details.st_uid, 'keySha256': digest}
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def cli_mounts(body):
    host = body.get('HostConfig') or {}
    if any(value is not None and not isinstance(value, list) for value in (host.get('Binds'), host.get('Mounts'))):
        raise ValueError('CLI authentication mount intent is invalid')
    result = []
    for mount in host.get('Mounts') or []:
        if not isinstance(mount, dict):
            raise ValueError('CLI authentication mount intent is invalid')
        result.append({'Type': mount.get('Type'), 'Source': mount.get('Source'),
                       'Destination': mount.get('Target'), 'RW': not mount.get('ReadOnly', False)})
    for mount in host.get('Binds') or []:
        parts = mount.split(':') if isinstance(mount, str) else []
        if len(parts) not in (2, 3):
            raise ValueError('CLI authentication bind intent is invalid')
        result.append({'Type': 'bind', 'Source': parts[0], 'Destination': parts[1],
                       'RW': 'ro' not in parts[2].split(',') if len(parts) == 3 else True})
    return result


def require_cli_mounts(root, mounts, *, required):
    if not isinstance(mounts, list) or any(not isinstance(mount, dict) for mount in mounts):
        raise ValueError('CLI authentication mount information is invalid')
    source = str(root / '.secrets')
    selected = []
    for mount in mounts:
        target, origin = mount.get('Destination'), mount.get('Source')
        if not isinstance(target, str) or os.path.normpath(target) != target:
            raise ValueError('CLI authentication mount target is invalid')
        if target == CLI_TARGET:
            if mount.get('Type') != 'bind' or origin != source or mount.get('RW') is not True:
                raise ValueError('CLI authentication requires its private target bind')
            selected.append(mount)
        elif target.startswith(CLI_TARGET + '/') or CLI_TARGET.startswith(target.rstrip('/') + '/'):
            if not (target == '/data' and mount.get('Type') == 'bind' and origin == str(root)):
                raise ValueError('A mount shadows CLI authentication storage')
        if mount.get('Type') == 'bind' and origin != str(root):
            if not isinstance(origin, str) or not Path(origin).is_absolute() or os.path.normpath(origin) != origin:
                raise ValueError('CLI authentication mount source is invalid')
            if (Path(origin) == Path(source) or Path(origin).is_relative_to(source) or Path(source).is_relative_to(origin)) and target != CLI_TARGET:
                raise ValueError('Another mount exposes CLI authentication storage')
        elif mount.get('Type') == 'bind' and origin == str(root) and target != '/data':
            raise ValueError('Another mount exposes CLI authentication storage')
    if (required and len(selected) != 1) or len(selected) > 1:
        raise ValueError('The CLI authentication bind is missing or duplicated')
    return bool(selected)


CORE_NETWORK = 'runtipi_tipi_core_network'
NETWORK_CAPABILITY = {**CLI_CAPABILITY, 'schema': 'orbis.controller-overlay-startup.v4', 'version': 4,
                      'coreNetwork': {'name': CORE_NETWORK, 'internal': True, 'peers': ['runtipi-db', 'runtipi-queue']}}


class CoreNetwork:
    """Journal endpoint changes separately from immutable peer definitions."""
    def __init__(self, updater):
        self.u = updater
        self.r = updater.runtime

    def network(self, identifier, *, optional=False):
        body = self.r.engine('GET', '/networks/' + identifier, allow_missing=optional)
        return None if body is None else self.u.P.metadata(body, byte_limit=8 * 1024 * 1024)

    def definition(self, network):
        if (network.get('Name') != CORE_NETWORK or network.get('Driver') != 'bridge' or network.get('Scope') != 'local'
                or network.get('Internal') is not True or network.get('Ingress') is True or network.get('Options')
                or not re.fullmatch(r'[a-f0-9]{64}', network.get('Id', ''))):
            raise ValueError('The private controller network changed or is not isolated')
        fields = ('Id', 'Name', 'Driver', 'Scope', 'Internal', 'Attachable', 'Ingress', 'EnableIPv6', 'IPAM', 'Options', 'Labels')
        return hashlib.sha256(self.u.P.canonical({key: network.get(key) for key in fields})).hexdigest()

    def prepare(self, record):
        plan = record.get('coreNetwork')
        if plan is not None and plan.get('id') is not None:
            if plan.get('retirement') is not None:
                raise ValueError('A rolled-back controller network cannot be reused for forward activation')
            self.verify(record)
            return
        if plan is None:
            source_networks = record['source']['NetworkSettings']['Networks']
            common = set(source_networks) & set(record['proxy']['NetworkSettings']['Networks'])
            if len(common) != 1:
                raise CapabilityError('The controller network migration requires one reviewed public network')
            main = next(iter(common))
            if main == CORE_NETWORK or set(source_networks) - {main, CORE_NETWORK}:
                raise CapabilityError('The source controller has an unsupported network topology')
            identities = {name: endpoint.get('NetworkID') for name, endpoint in source_networks.items()}
            if any(not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{64}', value) for value in identities.values()):
                raise ValueError('The source network identity is invalid')
            initial = CORE_NETWORK if CORE_NETWORK in source_networks else main
            for peer in record['peers'].values():
                networks = peer['NetworkSettings']['Networks']
                if (set(networks) != {initial} or networks[initial].get('NetworkID') != identities[initial]
                        or peer['HostConfig'].get('NetworkMode') not in {initial, identities[initial]}):
                    raise CapabilityError('The database or queue has an unsupported network topology')
            plan = {'schema': 'orbis.controller-core-network.v1', 'main': main, 'sourceIds': identities,
                    'rootSha256': hashlib.sha256(str(self.u.root).encode()).hexdigest(), 'id': None,
                    'definition': None, 'goal': 'source', 'active': None, 'retirement': None,
                    'peers': {name: sorted(peer['NetworkSettings']['Networks']) for name, peer in record['peers'].items()}}
            record['coreNetwork'] = plan
            self.u.save(record)
        network = self.network(CORE_NETWORK, optional=True)
        if network is None:
            self.u.preserved(record)
            self.r.engine('POST', '/networks/create', {'Name': CORE_NETWORK, 'CheckDuplicate': True, 'Driver': 'bridge',
                'Internal': True, 'Labels': {'orbis.managed': 'true', 'io.orbis.root.sha256': plan['rootSha256'],
                                             'io.orbis.controller-update': record['nonce']}})
            network = self.network(CORE_NETWORK)
        labels = network.get('Labels') or {}
        if (CORE_NETWORK not in plan['sourceIds'] and
                (labels.get('orbis.managed') != 'true' or labels.get('io.orbis.root.sha256') != plan['rootSha256']
                 or labels.get('io.orbis.controller-update') != record['nonce'])):
            raise ValueError('An unreviewed private controller network already exists')
        if CORE_NETWORK in plan['sourceIds'] and network.get('Id') != plan['sourceIds'][CORE_NETWORK]:
            raise ValueError('The source private network identity changed')
        plan.update(id=network['Id'], definition=self.definition(network))
        endpoints = record['body']['NetworkingConfig']['EndpointsConfig']
        endpoints.setdefault(CORE_NETWORK, {'Aliases': ['runtipi']})
        self.u.save(record)
        self.verify(record)

    def active_transition(self, record, plan):
        active = plan['active']
        if active is None:
            return None
        name = active.get('peer')
        if name not in record['peers'] or set(active) != {'peer', 'from', 'to', 'network', 'method'}:
            raise ValueError('The protected network transition is invalid')
        before, after = set(active['from']), set(active['to'])
        desired = self.desired(record, plan, name)
        if (active['from'] != plan['peers'][name] or active['to'] != sorted(after)
                or not before or not after or before - {plan['main'], CORE_NETWORK} or after - {plan['main'], CORE_NETWORK}):
            raise ValueError('The protected network transition is invalid')
        if active['method'] == 'connect':
            valid = after == before | {active['network']} and active['network'] in desired - before
        else:
            valid = (active['method'] == 'disconnect' and after == before - {active['network']}
                     and active['network'] in before - desired and desired <= before)
        if not valid:
            raise ValueError('The protected network transition changed')
        return active

    def desired(self, record, plan, name):
        return {CORE_NETWORK} if plan['goal'] == 'target' else set(record['peers'][name]['NetworkSettings']['Networks'])

    def verify(self, record):
        plan = record.get('coreNetwork')
        if plan is None:
            return
        if (set(plan) != {'schema', 'main', 'sourceIds', 'rootSha256', 'id', 'definition', 'goal', 'active', 'peers', 'retirement'}
                or plan['schema'] != 'orbis.controller-core-network.v1' or plan['goal'] not in {'source', 'target'}
                or plan['retirement'] not in {None, 'intent', 'complete'}
                or set(plan['peers']) != set(record['peers'])
                or plan['rootSha256'] != hashlib.sha256(str(self.u.root).encode()).hexdigest()
                or plan['sourceIds'] != {name: item.get('NetworkID') for name, item in record['source']['NetworkSettings']['Networks'].items()}):
            raise ValueError('The protected controller network plan changed')
        if plan['id'] is None:
            if plan['definition'] is not None or plan['active'] is not None or plan['goal'] != 'source' or plan['retirement'] is not None:
                raise ValueError('The controller network preparation is incomplete')
            for name, peer in record['peers'].items():
                if self.r.definition(self.r.inspect(peer['Id'])) != record['peerDefinitions'][name]:
                    raise ValueError('A controller peer changed before private network preparation')
            return
        if plan['retirement'] is not None:
            if (plan['goal'] != 'source' or plan['active'] is not None or CORE_NETWORK in plan['sourceIds']
                    or record.get('sourceBootstrapProfile', {}).get('profile') != BOOTSTRAP.LEGACY
                    or any(set(plan['peers'][name]) != self.desired(record, plan, name) for name in record['peers'])):
                raise ValueError('The controller rollback network retirement is invalid')
            network = self.network(plan['id'], optional=True)
            if network is not None and (plan['retirement'] == 'complete' or self.definition(network) != plan['definition']):
                raise ValueError('The retired private controller network changed')
        elif self.definition(self.network(plan['id'])) != plan['definition']:
            raise ValueError('The private controller network definition changed')
        active = self.active_transition(record, plan)
        identities = {**plan['sourceIds'], CORE_NETWORK: plan['id']}
        for name, prior in record['peers'].items():
            raw = self.r.inspect(prior['Id'])
            networks = raw['NetworkSettings']['Networks']
            allowed = [plan['peers'][name]]
            if active is not None and active['peer'] == name:
                allowed.append(active['to'])
                if raw['State'].get('Running'):
                    raise ValueError('A controller peer started during its network transition')
            if sorted(networks) not in allowed:
                raise ValueError('A controller peer network set changed')
            for net, endpoint in networks.items():
                if net not in identities or endpoint.get('NetworkID') not in ({identities[net]} if raw['State'].get('Running') else {identities[net], '', None}):
                    raise ValueError('A controller peer network identity changed')
                expected = self.endpoint(record, name, net)
                aliases = endpoint.get('Aliases') or []
                generated = {name, prior['Id'], prior['Id'][:12]}
                if (not isinstance(aliases, list) or not set(expected.get('Aliases') or []) <= set(aliases)
                        or set(aliases) - set(expected.get('Aliases') or []) - generated
                        or endpoint.get('IPAMConfig') != expected.get('IPAMConfig')
                        or (endpoint.get('Links') or []) != (expected.get('Links') or [])
                        or (endpoint.get('DriverOpts') or {}) != (expected.get('DriverOpts') or {})):
                    raise ValueError('A controller peer network address or aliases changed')
                dns = endpoint.get('DNSNames')
                if dns is not None and (not isinstance(dns, list) or set(dns) - set(aliases) - generated):
                    raise ValueError('A controller peer network DNS identity changed')
            normalized = copy.deepcopy(raw)
            normalized['NetworkSettings']['Networks'] = copy.deepcopy(prior['NetworkSettings']['Networks'])
            if raw['Name'] != '/' + name or self.r.definition(normalized) != record['peerDefinitions'][name]:
                raise ValueError('A controller peer changed outside its reviewed network transition')
        body = self.r.engine('GET', '/containers/json?all=true')
        inventory = self.u.P.metadata(b'{"containers":' + body + b'}', byte_limit=8 * 1024 * 1024 + 16)['containers']
        if not isinstance(inventory, list) or len(inventory) > 2048:
            raise ValueError('The private network membership inventory is invalid')
        allowed = {record['source']['Id'], *(peer['Id'] for peer in record['peers'].values())}
        if record.get('candidateId'):
            allowed.add(record['candidateId'])
        for row in inventory:
            if not isinstance(row, dict):
                raise ValueError('The private network membership inventory is invalid')
            if CORE_NETWORK not in (row.get('NetworkSettings') or {}).get('Networks', {}):
                continue
            if plan['retirement'] is not None:
                raise ValueError('The rollback network retirement still has attached containers')
            identifier = row.get('Id')
            if identifier in allowed:
                continue
            candidate = self.r.inspect(identifier)
            if (candidate['Name'] != '/' + record['candidateName'] or candidate['Image'] != record['targetImageId']
                    or candidate['State'].get('Running') or candidate['Config'].get('Labels', {}).get('io.orbis.controller-update') != self.u.key):
                raise ValueError('An unrelated container joined the private controller network')
            self.r.check_intent(candidate, record['body'])

    def endpoint(self, record, name, network):
        prior = record['peers'][name]['NetworkSettings']['Networks']
        if network in prior:
            return {key: copy.deepcopy(prior[network].get(key)) for key in ('Aliases', 'IPAMConfig', 'Links', 'DriverOpts')
                    if prior[network].get(key) is not None}
        aliases = {name}
        for endpoint in prior.values():
            aliases.update(endpoint.get('Aliases') or [])
        return {'Aliases': sorted(aliases)}

    def move(self, record, goal):
        plan = record.get('coreNetwork')
        if plan is None:
            return
        if goal not in {'source', 'target'} or plan.get('id') is None:
            raise ValueError('The controller network destination is invalid')
        if plan['retirement'] is not None and goal != 'source':
            raise ValueError('A retired rollback network cannot be used for forward activation')
        self.u.preserved(record)
        desired = {name: ({CORE_NETWORK} if goal == 'target' else set(peer['NetworkSettings']['Networks']))
                   for name, peer in record['peers'].items()}
        if plan['active'] is None and all(set(plan['peers'][name]) == networks for name, networks in desired.items()):
            if plan['goal'] != goal:
                plan['goal'] = goal
                self.u.save(record)
            return
        controllers = [record['source']['Id']]
        if record.get('sourceRetirement', {}).get('reconstructionId'):
            controllers = [record['sourceRetirement']['reconstructionId']]
        if record.get('candidateId'):
            controllers.append(record['candidateId'])
        for identifier in controllers:
            raw = self.u.optional_container(identifier)
            if raw is not None and raw['State'].get('Running'):
                raise ValueError('Controllers must be stopped before moving private network endpoints')
        for peer in record['peers'].values():
            raw = self.r.inspect(peer['Id'])
            if raw['State'].get('Running') or raw['HostConfig'].get('RestartPolicy', {}).get('Name') != 'no':
                raise ValueError('Controller peers must be stopped and restart-disabled before changing networks')
        active = plan['active']
        if active is not None:
            actual = sorted(self.r.inspect(record['peers'][active['peer']]['Id'])['NetworkSettings']['Networks'])
            if actual == active['to']:
                plan['peers'][active['peer']] = actual
            plan['active'] = None
        plan['goal'] = goal
        self.u.save(record)
        for name, peer in record['peers'].items():
            desired = self.desired(record, plan, name)
            while set(plan['peers'][name]) != desired:
                before = set(plan['peers'][name])
                adding = desired - before
                net = sorted(adding or before - desired)[0]
                method = 'connect' if adding else 'disconnect'
                after = before | {net} if adding else before - {net}
                plan['active'] = {'peer': name, 'from': sorted(before), 'to': sorted(after), 'network': net, 'method': method}
                self.u.save(record)
                self.u.preserved(record)
                identifier = plan['id'] if net == CORE_NETWORK else plan['sourceIds'][net]
                body = {'Container': peer['Id'], 'EndpointConfig': self.endpoint(record, name, net)} if adding else {'Container': peer['Id'], 'Force': False}
                try:
                    self.r.engine('POST', '/networks/' + identifier + '/' + method, body)
                except (ValueError, RuntimeError):
                    self.u.preserved(record)
                    if sorted(self.r.inspect(peer['Id'])['NetworkSettings']['Networks']) != sorted(after):
                        raise
                self.u.preserved(record)
                if sorted(self.r.inspect(peer['Id'])['NetworkSettings']['Networks']) != sorted(after):
                    raise ValueError('The controller network transition was not observed')
                plan['peers'][name] = sorted(after)
                plan['active'] = None
                self.u.save(record)
        self.u.preserved(record)

    def retire_for_legacy_rollback(self, record):
        plan = record.get('coreNetwork')
        if (plan is None or CORE_NETWORK in plan['sourceIds']
                or record.get('sourceBootstrapProfile', {}).get('profile') != BOOTSTRAP.LEGACY):
            return
        self.u.preserved(record)
        if plan['goal'] != 'source' or plan['active'] is not None:
            raise ValueError('The source topology must be restored before private network retirement')
        if plan['retirement'] == 'complete':
            return
        if plan['retirement'] is None:
            plan['retirement'] = 'intent'
            self.u.save(record)
        # The intent above permits absence only after every original endpoint
        # is restored and an all-container inventory proves this network empty.
        self.u.preserved(record)
        if self.network(plan['id'], optional=True) is not None:
            try:
                self.r.engine('DELETE', '/networks/' + plan['id'])
            except (ValueError, RuntimeError):
                if self.network(plan['id'], optional=True) is not None:
                    raise
        if self.network(plan['id'], optional=True) is not None:
            raise ValueError('The private rollback network has not retired')
        plan['retirement'] = 'complete'
        self.u.save(record)
        self.u.preserved(record)


class CapabilityError(ValueError):
    code = 'controller-preservation-unsupported'


class NoBackupRecoveryRequired(RuntimeError):
    code = 'recovery-required'


def unbacked(record):
    selected = record.get('schema') == NO_BACKUP_POLICY
    review = record.get('checkpoint') or {}
    if selected != (review.get('backupPolicy') == 'none'):
        raise ValueError('The controller update backup policy changed')
    if 'unbackedWritesPossible' in record and (not selected or type(record['unbackedWritesPossible']) is not bool):
        raise ValueError('The unbacked write boundary is invalid')
    return selected


class ControllerUpdate:
    def __init__(self, host, root, context, snapshot, current, target, state_dir):
        self.host, self.root, self.context = host, root, context
        self.current, self.target, self.snapshot = current, target, snapshot
        self.a, self.P = host.AUTHORITY, host.IDENTITY.PUBLICATION
        with self.a.protected_directory(state_dir):
            pass
        base = state_dir / 'controller-updates'
        base.mkdir(mode=0o700, exist_ok=True)
        with self.a.protected_directory(base):
            pass
        self.key = hashlib.sha256(str(snapshot).encode()).hexdigest()
        self.path = base / self.key
        self.path.mkdir(mode=0o700, exist_ok=True)
        with self.a.protected_directory(self.path):
            pass
        manager = SimpleNamespace(host=host, authority=self.a, root=root, context=context)
        self.runtime = D.DockerRestoreRuntime(manager)
        self.runtime.reader.lock_fd = host.LOCK_DESCRIPTOR.get()

    def save(self, record):
        self.a.atomic(self.path / 'runtime.json', self.P.canonical(record))

    def read(self):
        with self.a.protected_directory(self.path) as directory:
            with self.a.protected_file(directory, 'runtime.json', 16 * 1024 * 1024) as body:
                record = self.P.metadata(body, byte_limit=16 * 1024 * 1024, string_limit=2 * 1024 * 1024)
        if (record.get('schema') not in {POLICY, NO_BACKUP_POLICY} or record.get('root') != str(self.root) or record.get('context') != self.context
                or record.get('current') != self.current or record.get('target') != self.target or record.get('snapshot') != str(self.snapshot)):
            raise ValueError('Controller recovery authority does not match this operation')
        unbacked(record)
        return record

    def lookup(self, name):
        return self.runtime.reader._object(['container', 'inspect', '--format', '{{json .}}', name])

    def optional_reset_enrollment(self, source):
        mounts = source.get('Mounts')
        if not isinstance(mounts, list) or any(not isinstance(item, dict) for item in mounts):
            raise ValueError('Controller reset mount information is invalid')
        dedicated = any(item.get('Destination') == RESET.TARGET or str(item.get('Destination', '')).startswith(RESET.TARGET + '/') for item in mounts)
        namespace = RESET.external_directory(self.root).parent
        # Absence is checked beneath the helper's protected canonical control
        # tree. An existing partial or invalid namespace is never legacy absence.
        try:
            with RESET._control_descriptor(namespace.parent) as directory:
                try:
                    os.stat(namespace.name, dir_fd=directory, follow_symlinks=False)
                except FileNotFoundError:
                    if dedicated:
                        raise ValueError('The source reset mount has no protected enrollment')
                    return None
        except RESET.ResetAuthorityError as error:
            if isinstance(error.__cause__, FileNotFoundError):
                if dedicated:
                    raise ValueError('The source reset mount has no protected enrollment')
                return None
            raise
        daemon = D.APPS.digest_daemon(self.runtime.reader)
        binding = RESET.read_external_enrollment(self.root, daemon, self.context)
        # Existing verified mounts retain their enrollment contract. Only adding
        # a mount requires the newer operator-reviewed enrollment.
        if not dedicated and binding.get('schema') != RESET.SCHEMA_V4:
            raise ValueError('A new controller reset mount requires reviewed v4 external enrollment')
        RESET.verify(self.root, binding, daemon=daemon, context=self.context)
        if dedicated:
            RESET.require_runtime(self.root, mounts, binding)
        else:
            RESET.require_no_enrollment_aliases(self.root, mounts, binding)
        return binding

    def proxy_candidate_body(self, body, *, transform):
        identity = D.load('orbis-proxy-identity.py', 'orbis_controller_candidate_proxy_identity')
        if not identity.adoption_selected(self.root):
            return body
        adoption = identity.adoption_module()
        execution = str(adoption.execution_path(self.root))
        original = str(self.root / 'traefik')
        host = body['HostConfig']
        if host.get('VolumesFrom') or host.get('Privileged'):
            raise ValueError('Adopted proxy configuration requires isolated controller mounts')
        if any(value is not None and not isinstance(value, list) for value in (host.get('Mounts'), host.get('Binds'))):
            raise ValueError('Controller mount intent is invalid')
        mounts = []
        selected = []
        for item in host.get('Mounts') or []:
            if not isinstance(item, dict) or item.get('Type') != 'bind' or type(item.get('ReadOnly', False)) is not bool:
                raise ValueError('Controller mount intent is invalid')
            source, target, writable = item.get('Source'), item.get('Target'), not item.get('ReadOnly', False)
            if target == '/data/traefik':
                selected.append((item, None, source))
                if transform and source in {original, execution}:
                    source = execution
                    writable = False
            mounts.append({'Type': 'bind', 'Source': source, 'Destination': target, 'RW': writable})
        for index, item in enumerate(host.get('Binds') or []):
            parts = item.split(':') if isinstance(item, str) else []
            if len(parts) not in (2, 3):
                raise ValueError('Controller bind intent is invalid')
            options = parts[2].split(',') if len(parts) == 3 else []
            if (len(set(options)) != len(options) or set(options) - {'ro', 'rw', 'z', 'Z', 'private', 'rprivate', 'shared', 'rshared', 'slave', 'rslave'}
                    or len(set(options) & {'ro', 'rw'}) > 1 or len(set(options) & {'z', 'Z'}) > 1
                    or len(set(options) & {'private', 'rprivate', 'shared', 'rshared', 'slave', 'rslave'}) > 1):
                raise ValueError('Controller bind options are invalid')
            writable = 'ro' not in options
            if parts[1] == '/data/traefik':
                selected.append((parts, index, parts[0]))
                writable = False if transform else writable
            source = execution if transform and parts[1] == '/data/traefik' and parts[0] in {original, execution} else parts[0]
            mounts.append({'Type': 'bind', 'Source': source, 'Destination': parts[1], 'RW': writable})
        if len(selected) != 1 or selected[0][2] not in ({original, execution} if transform else {execution}):
            raise ValueError('Controller proxy configuration bind is missing or changed')
        if len({mount['Destination'] for mount in mounts if isinstance(mount['Destination'], str)}) != len(mounts):
            raise ValueError('Controller mount destinations are invalid')
        for mount in mounts:
            target = mount['Destination']
            if (not isinstance(target, str) or not target.startswith('/') or os.path.normpath(target) != target
                    or (target != '/data/traefik' and mount['RW'] and adoption.overlap(target, '/data/traefik'))):
                raise ValueError('Controller mount overlaps proxy configuration')
        if next(m for m in mounts if m['Destination'] == '/data/traefik')['RW']:
            raise ValueError('Controller proxy configuration bind must be read-only')
        adoption.require_aliases(self.root, [{'Id': 'candidate', 'Mounts': mounts}], source_id='not-candidate')
        if transform:
            item, index, _ = selected[0]
            if index is None:
                item['Source'] = execution
                item['ReadOnly'] = True
            else:
                options = item[2].split(',') if len(item) == 3 else []
                options = [option for option in options if option != 'rw']
                if 'ro' not in options:
                    options.append('ro')
                host['Binds'][index] = ':'.join([execution, item[1], ','.join(options)])
        return body

    def reset_candidate_body(self, record, body):
        binding = self.optional_reset_enrollment(record['source'])
        present = any(item.get('Destination') == RESET.TARGET for item in record['source']['Mounts'])
        record['controllerResetMount'] = {'schema': RESET_POLICY_V2, 'binding': binding, 'sourceMount': 'present' if present else 'absent',
                                        'journal': self.reset_journal(binding) if binding is not None else None}
        if present:
            self.plan_source_reconstruction(record)
        if binding is None:
            return body
        host = body['HostConfig']
        if present:
            return body
        for item in host.get('Mounts') or []:
            if item.get('Target') == RESET.TARGET or str(item.get('Target', '')).startswith(RESET.TARGET + '/'):
                raise ValueError('The candidate reset mount already has an unverified definition')
        for item in host.get('Binds') or []:
            parts = item.split(':') if isinstance(item, str) else []
            if len(parts) < 2 or parts[1] == RESET.TARGET or parts[1].startswith(RESET.TARGET + '/'):
                raise ValueError('The candidate reset bind is unverified')
        if host.get('Mounts') is None:
            host['Mounts'] = []
        if not isinstance(host['Mounts'], list):
            raise ValueError('The candidate mount union is invalid')
        host['Mounts'].append({'Type': 'bind', 'Source': str(RESET.binding_path(self.root, binding)),
            'Target': RESET.TARGET, 'ReadOnly': False, 'BindOptions': {'Propagation': 'rprivate'}})
        return body

    def reset_journal(self, binding):
        with self.a.protected_directory(RESET.binding_path(self.root, binding)) as directory:
            names = os.listdir(directory)
            if not names:
                return {'state': 'empty'}
            if names != ['active.json']:
                raise ValueError('Reset intent or unknown reset storage requires protected recovery')
            with self.a.protected_file(directory, 'active.json', 16384) as body:
                value = self.P.metadata(body, byte_limit=16384)
        fields = {'version', 'id', 'controller', 'accounts', 'users', 'phase', 'createdAt'}
        try:
            identifier = uuid.UUID(value.get('id', ''))
        except (ValueError, TypeError, AttributeError):
            raise ValueError('The completed reset journal is invalid') from None
        users = value.get('users')
        if (set(value) != fields or type(value.get('version')) is not int or value['version'] != 1
                or str(identifier) != value['id'].lower() or identifier.version not in range(1, 9)
                or not isinstance(value.get('controller'), str) or not 1 <= len(value['controller'].encode('utf-16-le', 'surrogatepass')) // 2 <= 253
                or value.get('accounts') not in {'keep', 'remove'} or value.get('phase') != 'complete'
                or not isinstance(users, list) or len(users) > 256
                or any(type(user) is not int or not 0 < user <= 2**53 - 1 for user in users) or len(set(users)) != len(users)
                or type(value.get('createdAt')) is not int or not 0 < value['createdAt'] <= 2**53 - 1):
            raise ValueError('The completed reset journal is invalid or unfinished')
        return {'state': 'complete', 'sha256': hashlib.sha256(body).hexdigest(), 'bytes': len(body)}

    def optional_container(self, identifier):
        body = self.runtime.engine('GET', '/containers/' + identifier + '/json', allow_missing=True)
        return None if body is None else self.P.metadata(body, byte_limit=8 * 1024 * 1024)

    def require_reset_mount(self, record, candidate=None):
        if 'controllerResetMount' not in record:
            return
        policy = record['controllerResetMount']
        if not isinstance(policy, dict):
            raise ValueError('The protected controller reset policy is invalid')
        expected_fields = {'schema', 'binding', 'sourceMount'} if policy.get('schema') == RESET_POLICY else {'schema', 'binding', 'sourceMount', 'journal'}
        if (not isinstance(policy, dict) or set(policy) != expected_fields
                or policy.get('schema') not in {RESET_POLICY, RESET_POLICY_V2}
                or policy.get('sourceMount') not in ({'absent'} if policy['schema'] == RESET_POLICY else {'absent', 'present'})):
            raise ValueError('The protected controller reset policy changed')
        binding = self.optional_reset_enrollment(record['source'])
        if binding != policy['binding']:
            raise ValueError('The controller reset enrollment changed during replacement')
        if binding is None:
            return
        controllers = []
        pending_candidate = False
        if candidate is None and not record.get('candidateId') and not record.get('candidateRetirementIntent'):
            try:
                candidate = self.lookup(record['candidateName'])
            except (ValueError, RuntimeError):
                candidate = None
            if candidate is not None:
                self.runtime.check_intent(candidate, record['body'])
                self.check_candidate_networks(record, candidate)
                if (candidate['Image'] != record['targetImageId'] or candidate['State'].get('Running')
                        or candidate['State'].get('Status') != 'created'):
                    raise ValueError('The pending reset-enabled candidate changed before adoption')
                pending_candidate = True
        if candidate is None and record.get('candidateId'):
            candidate = self.optional_container(record['candidateId'])
            if candidate is None and record.get('candidateRetirementIntent') is not True:
                raise ValueError('The reset-enabled candidate disappeared without retirement intent')
        if candidate is not None:
            controllers.append(candidate)
        if policy['sourceMount'] == 'present':
            retirement = record.get('sourceRetirement')
            retirement = self.validate_retirement(record)
            if retirement.get('phase') == 'reconstructing' and not retirement.get('reconstructionId'):
                try:
                    pending = self.lookup(retirement['reconstructionName'])
                except (ValueError, RuntimeError):
                    pending = None
                if pending is not None:
                    self.runtime.check_intent(pending, retirement['body'])
                    if pending['Image'] != retirement['imageId'] or pending['State'].get('Running'):
                        raise ValueError('The pending reconstructed source changed')
                    retirement.update(reconstructionId=pending['Id'], reconstructionDefinition=self.runtime.definition(pending), phase='reconstructed')
                    self.save(record)
            for identifier in [record['source']['Id'], retirement.get('reconstructionId')]:
                if identifier:
                    source = self.optional_container(identifier)
                    if source is not None:
                        controllers.append(source)
                    elif identifier == record['source']['Id'] and retirement.get('phase') == 'held':
                        raise ValueError('The dedicated source disappeared before retirement intent')
        if len(controllers) > 1:
            raise ValueError('More than one controller can write protected reset storage')
        controller = controllers[0] if controllers else None
        if controller is not None:
            RESET.require_runtime(self.root, controller.get('Mounts'), binding)
        RESET.require_docker_isolation(self.root, self.runtime.reader, binding, controller_id=controller['Id'] if controller else None)
        if record.get('phase') != 'committed':
            journal = self.reset_journal(binding)
            expected = {'state': 'empty'} if policy['schema'] == RESET_POLICY else policy['journal']
            if journal != expected:
                raise ValueError('External reset intent changed during controller replacement')
        if pending_candidate:
            record['candidateId'] = candidate['Id']
            record['candidateDefinition'] = self.runtime.definition(candidate)
            self.save(record)

    def plan_source_reconstruction(self, record):
        body = self.source_reconstruction_body(record)
        record['sourceRetirement'] = {'schema': SOURCE_RETIREMENT, 'phase': 'held', 'body': body,
            'bodySha256': hashlib.sha256(self.P.canonical(body)).hexdigest(), 'imageId': record['source']['Image'],
            'anchorName': 'orbis-controller-source-image-' + self.key,
            'reconstructionName': 'orbis-controller-reconstructed-' + self.key}

    def source_reconstruction_body(self, record):
        source = record['source']
        if source['HostConfig'].get('Links') or source['HostConfig'].get('VolumesFrom') or any(item.get('Type') != 'bind' for item in source['Mounts']):
            raise ValueError('Source dependencies require explicit reconstruction review')
        body = copy.deepcopy(source['Config'])
        body.pop('Hostname', None)
        body['Env'] = [item for item in body.get('Env', []) if item not in
                       {'HOSTNAME=' + source['Id'], 'HOSTNAME=' + source['Id'][:12]}]
        body.setdefault('Labels', {})['io.orbis.source-reconstruction'] = record['nonce']
        body['HostConfig'] = D.normalized(source['HostConfig'])
        body['HostConfig']['RestartPolicy'] = {'Name': 'no', 'MaximumRetryCount': 0}
        body['NetworkingConfig'] = {'EndpointsConfig': {name: {'Aliases': sorted({alias for alias in endpoint.get('Aliases') or []
            if alias not in {source['Id'], source['Id'][:12]}})} for name, endpoint in source['NetworkSettings']['Networks'].items()}}
        return body

    def bootstrap_enablement_intent(self, record):
        body = self.source_reconstruction_body(record)
        environment = body.get('Env', [])
        if (not isinstance(environment, list) or any(not isinstance(item, str) or '=' not in item for item in environment)
                or len({item.split('=', 1)[0] for item in environment}) != len(environment)):
            raise BOOTSTRAP.fail()
        body['Env'] = [item for item in environment if not item.startswith(PRESERVE_ENV + '=')] + [PRESERVE_ENV + '=1']
        policy = {'schema': SOURCE_ENABLEMENT, 'sourceDefinition': record['sourceDefinition'],
                  'publication': copy.deepcopy(record['current']), 'imageId': record['source']['Image'],
                  'sourceEnvSha256': hashlib.sha256(self.P.canonical(record['source']['Config'].get('Env', []))).hexdigest(),
                  'startupEnvSha256': hashlib.sha256(self.P.canonical(body['Env'])).hexdigest(),
                  'bodySha256': hashlib.sha256(self.P.canonical(body)).hexdigest()}
        return body, policy

    def validate_bootstrap_enablement(self, record, retirement, *, require_proof=False):
        policy = record.get('sourceBootstrapEnablement')
        environment = dict(item.split('=', 1) for item in record['source']['Config'].get('Env', []) if '=' in item)
        if policy is None:
            if environment.get(PRESERVE_ENV) != '1' and record.get('sourceBootstrapProfile', {}).get('profile') == BOOTSTRAP.CAPABLE:
                raise BOOTSTRAP.fail()
            return
        if (not isinstance(policy, dict) or environment.get(PRESERVE_ENV) == '1'
                or record.get('controllerResetMount', {}).get('sourceMount') != 'present'
                or not isinstance(record.get('controllerResetMount', {}).get('binding'), dict)
                or not any(item.get('Destination') == RESET.TARGET for item in record['source']['Mounts'])):
            raise BOOTSTRAP.fail()
        body, expected = self.bootstrap_enablement_intent(record)
        if retirement['body'] != body or {key: value for key, value in policy.items() if key != 'profileSha256'} != expected:
            raise BOOTSTRAP.fail()
        proof = record.get('sourceBootstrapProfile')
        if proof is not None or require_proof or 'profileSha256' in policy:
            if (not isinstance(proof, dict) or proof.get('profile') != BOOTSTRAP.CAPABLE
                    or policy.get('profileSha256') != hashlib.sha256(self.P.canonical(BOOTSTRAP.comparable(proof))).hexdigest()):
                raise BOOTSTRAP.fail()

    def bootstrap_source(self, record, phase):
        retirement = self.validate_retirement(record)
        self.validate_bootstrap_enablement(record, retirement, require_proof=phase == 'rollback')
        source = self.verify_source(record)
        if phase == 'review':
            if retirement['phase'] != 'held' or retirement.get('reconstructionId'):
                raise BOOTSTRAP.fail()
            # Only the isolated probe sees the future startup environment. The
            # running original and its protected definition remain unchanged.
            source['Config']['Env'] = copy.deepcopy(retirement['body']['Env'])
        elif phase == 'rollback':
            if not retirement.get('reconstructionId'):
                raise BOOTSTRAP.fail()
            self.runtime.check_intent(source, retirement['body'])
        else:
            raise BOOTSTRAP.fail()
        if source['Image'] != retirement['imageId'] or source['Config'].get('Env') != retirement['body']['Env']:
            raise BOOTSTRAP.fail()
        return source

    def review_source_bootstrap(self, record):
        source = record['source']
        environment = dict(item.split('=', 1) for item in source['Config'].get('Env', []) if '=' in item)
        if (environment.get(PRESERVE_ENV) != '1' and record.get('sourceRetirement')
                and (record['current'].get('commit'), record['current'].get('digest'), source['Image']) not in BOOTSTRAP.LEGACY_SOURCES):
            retirement = self.validate_retirement(record)
            if record.get('sourceBootstrapEnablement') is None:
                if retirement['phase'] != 'held' or retirement.get('anchorId') or retirement.get('checkpointManifestSha256'):
                    raise BOOTSTRAP.fail()
                body, policy = self.bootstrap_enablement_intent(record)
                retirement.update(body=body, bodySha256=policy['bodySha256'])
                record['sourceBootstrapEnablement'] = policy
                self.validate_bootstrap_enablement(record, retirement)
                self.save(record)
        proof = BOOTSTRAP.probe(self, record, 'review')
        record['sourceBootstrapProfile'] = proof
        if record.get('sourceBootstrapEnablement') is not None:
            record['sourceBootstrapEnablement']['profileSha256'] = hashlib.sha256(self.P.canonical(BOOTSTRAP.comparable(proof))).hexdigest()
            self.validate_bootstrap_enablement(record, self.validate_retirement(record), require_proof=True)
        return proof

    def validate_retirement(self, record):
        retirement = record.get('sourceRetirement')
        if (not isinstance(retirement, dict) or retirement.get('schema') != SOURCE_RETIREMENT
                or retirement.get('bodySha256') != hashlib.sha256(self.P.canonical(retirement.get('body'))).hexdigest()
                or retirement.get('imageId') != record['source']['Image']
                or retirement.get('phase') not in {'held', 'retiring', 'retired', 'reconstructing', 'reconstructed', 'restored'}):
            raise ValueError('The protected source reconstruction intent changed')
        self.validate_bootstrap_enablement(record, retirement)
        return retirement

    def retain_source_image(self, record):
        retirement = self.validate_retirement(record)
        self.validate_bootstrap_enablement(record, retirement, require_proof=record.get('sourceBootstrapEnablement') is not None)
        if not retirement.get('anchorId'):
            body = {'Image': retirement['imageId'], 'Labels': {'io.orbis.source-image-anchor': record['nonce']},
                    'HostConfig': {'NetworkMode': 'none', 'RestartPolicy': {'Name': 'no', 'MaximumRetryCount': 0}}}
            retirement['anchorBody'] = body
            self.save(record)
            try:
                anchor = self.lookup(retirement['anchorName'])
            except (ValueError, RuntimeError):
                response = self.P.metadata(self.runtime.engine('POST', '/containers/create?name=' + retirement['anchorName'], body))
                anchor = self.runtime.inspect(response['Id'])
            retirement['anchorId'] = anchor['Id']
            self.save(record)
        anchor = self.runtime.inspect(retirement['anchorId'])
        if (anchor['Image'] != retirement['imageId'] or anchor['State'].get('Running') or anchor.get('Mounts')
                or anchor['State'].get('Status') != 'created' or anchor['HostConfig'].get('NetworkMode') != 'none'
                or anchor['HostConfig'].get('RestartPolicy') != {'Name': 'no', 'MaximumRetryCount': 0}
                or anchor['Config'].get('Labels', {}).get('io.orbis.source-image-anchor') != record['nonce']):
            raise ValueError('The retained source image anchor changed')
        definition = self.runtime.definition(anchor)
        if retirement.get('anchorDefinition') not in {None, definition}:
            raise ValueError('The source image anchor definition changed')
        retirement['anchorDefinition'] = definition
        self.save(record)

    def no_backup_handoff(self, record):
        if not unbacked(record):
            raise ValueError('This controller operation requires a no-backup policy')
        checkpoint = record['checkpoint']
        saved = TOOLS.read_no_backup_handoff(Path(checkpoint['journal']), self.root, self.runtime.reader, verify_runtime=False)
        if saved['review'] != checkpoint:
            raise ValueError('The controller handoff review changed')
        digest = hashlib.sha256(self.P.canonical(saved)).hexdigest()
        if record.get('noBackupHandoffSha256') not in {None, digest}:
            raise ValueError('The protected controller handoff changed')
        if not record.get('unbackedWritesPossible', False):
            retirement = record.get('sourceRetirement') or {}
            if retirement.get('phase') not in {'retiring', 'retired'}:
                source = self.verify_source(record)
                if source['State'].get('Running') or source['HostConfig'].get('RestartPolicy') != {'Name': 'no', 'MaximumRetryCount': 0}:
                    raise ValueError('The no-backup source must be stopped and restart-disabled')
            for original in record['peers'].values():
                peer = self.runtime.inspect(original['Id'])
                if peer['State'].get('Running') or peer['HostConfig'].get('RestartPolicy') != {'Name': 'no', 'MaximumRetryCount': 0}:
                    raise ValueError('The no-backup controller peers must be stopped and restart-disabled')
        record['noBackupHandoffSha256'] = digest
        self.save(record)
        return saved

    def checkpoint_manifest(self, record):
        retirement = self.validate_retirement(record)
        checkpoint = record['checkpoint']
        if unbacked(record):
            saved = self.no_backup_handoff(record)
            if saved['review'] != checkpoint or retirement.get('checkpointManifestSha256'):
                raise ValueError('Source retirement requires its exact no-backup handoff')
            self.require_reset_excluded(record, checkpoint['storage'])
            digest = hashlib.sha256(self.P.canonical(saved)).hexdigest()
            if retirement.get('handoffSha256') not in {None, digest}:
                raise ValueError('The protected no-backup handoff changed')
            retirement['handoffSha256'] = digest
            self.save(record)
            return saved
        saved = TOOLS.read_record(Path(checkpoint['journal']), self.root, self.runtime.reader)
        manifest = TOOLS.STORAGE.verified_manifest(self.snapshot)
        if (saved.get('stage') != 'ready' or saved.get('review') != checkpoint
                or manifest.get('plan') != checkpoint['storage'] or saved.get('backupFingerprint') != TOOLS.APPS.digest(manifest)):
            raise ValueError('Source retirement requires the exact durable checkpoint')
        self.require_reset_excluded(record, manifest['plan'])
        digest = hashlib.sha256(self.P.canonical(manifest)).hexdigest()
        if retirement.get('checkpointManifestSha256') not in {None, digest}:
            raise ValueError('The protected controller checkpoint changed')
        retirement['checkpointManifestSha256'] = digest
        self.save(record)
        return manifest

    def require_reset_excluded(self, record, storage):
        binding = record['controllerResetMount']['binding']
        protected = RESET.binding_path(self.root, binding).parent.resolve(strict=True)
        for item in storage['resources']:
            source = Path(item['source']).resolve(strict=True)
            if source == protected or source.is_relative_to(protected) or protected.is_relative_to(source):
                raise ValueError('Controller checkpoint overlaps protected reset authority')

    def retire_dedicated_source(self, record):
        retirement = self.validate_retirement(record)
        self.retain_source_image(record)
        self.checkpoint_manifest(record)
        original = self.optional_container(record['source']['Id'])
        if original is None:
            if retirement['phase'] not in {'retiring', 'retired'}:
                raise ValueError('The source disappeared before protected retirement')
        else:
            if (self.runtime.definition(original) != record['sourceDefinition'] or original['Name'] != '/runtipi'
                    or original['State'].get('Running') or original['HostConfig'].get('RestartPolicy') != {'Name': 'no', 'MaximumRetryCount': 0}):
                raise ValueError('Source retirement requires its exact stopped restart-disabled definition')
            for peer in record['peers'].values():
                raw = self.runtime.inspect(peer['Id'])
                if raw['State'].get('Running') or raw['HostConfig'].get('RestartPolicy') != {'Name': 'no', 'MaximumRetryCount': 0}:
                    raise ValueError('Source retirement requires stopped checkpoint writers')
            retirement['phase'] = 'retiring'
            self.save(record)
            self.runtime.change(['rm', original['Id']])
        if self.optional_container(record['source']['Id']) is not None:
            raise ValueError('The source has not retired; no replacement may be created')
        retirement['phase'] = 'retired'
        self.save(record)
        self.require_reset_mount(record)

    def ensure_rollback_source(self, record):
        if unbacked(record):
            raise NoBackupRecoveryRequired('This update has no data backup; preserve its state for recovery review')
        retirement = self.validate_retirement(record)
        original = self.optional_container(record['source']['Id'])
        if original is not None:
            if retirement.get('reconstructionId'):
                raise ValueError('Both original and reconstructed source exist')
            if record.get('sourceBootstrapEnablement') is None:
                return self.verify_source(record)
            # A reviewed Env=1 proof never authorizes restarting the Env=0
            # original, even if the cutover failed before source retirement.
            self.retire_dedicated_source(record)
        if retirement['phase'] == 'held' or not retirement.get('checkpointManifestSha256'):
            raise ValueError('Source reconstruction lacks a durable retirement intent')
        if not retirement.get('reconstructionId'):
            if self.optional_container(record.get('candidateId', '0' * 64)) is not None:
                raise ValueError('The candidate must retire before source reconstruction')
            self.require_reset_mount(record)
            image = self.runtime.reader._object(['image', 'inspect', '--format', '{{json .}}', retirement['body']['Image']])
            if image.get('Id') != retirement['imageId']:
                raise ValueError('The exact source image is unavailable for reconstruction')
            retirement['phase'] = 'reconstructing'
            self.save(record)
            try:
                source = self.lookup(retirement['reconstructionName'])
            except (ValueError, RuntimeError):
                response = self.P.metadata(self.runtime.engine('POST', '/containers/create?name=' + retirement['reconstructionName'], retirement['body']))
                source = self.runtime.inspect(response['Id'])
            self.runtime.check_intent(source, retirement['body'])
            if source['Image'] != retirement['imageId'] or source['State'].get('Running'):
                raise ValueError('The reconstructed source does not match its stopped intent')
            retirement.update(reconstructionId=source['Id'], reconstructionDefinition=self.runtime.definition(source), phase='reconstructed')
            self.save(record)
        source = self.verify_source(record)
        self.runtime.check_intent(source, retirement['body'])
        if source['Name'] == '/' + retirement['reconstructionName']:
            self.runtime.change(['rename', source['Id'], 'runtipi'])
            source = self.verify_source(record)
        elif source['Name'] != '/runtipi':
            raise ValueError('Reconstructed source recovery name changed')
        if source['State'].get('Running'):
            raise ValueError('The reconstructed source started before storage recovery')
        self.require_reset_mount(record)
        return source

    def restore_reconstructed_checkpoint(self):
        record = self.read()
        if unbacked(record):
            raise NoBackupRecoveryRequired('This update has no data backup; preserve its state for recovery review')
        if not record.get('sourceRetirement') or self.validate_retirement(record)['phase'] == 'held':
            return False
        source = self.ensure_rollback_source(record)
        self.preserved(record)
        retirement = self.validate_retirement(record)
        manifest = TOOLS.STORAGE.verified_manifest(self.snapshot)
        if (manifest.get('plan') != record['checkpoint']['storage']
                or hashlib.sha256(self.P.canonical(manifest)).hexdigest() != retirement['checkpointManifestSha256']):
            raise ValueError('The reconstructed source checkpoint changed')
        self.require_reset_excluded(record, manifest['plan'])
        path = self.path / 'reconstructed-source-restore.json'
        exists = path.exists() or path.is_symlink()
        saved = TOOLS.RESTORE.private_json(path) if exists else None
        if saved is not None and saved.get('stage') == 'complete':
            if (set(saved) != {'schema', 'stage', 'review', 'completed', 'active'}
                    or saved.get('schema') != TOOLS.RESTORE.SCHEMA
                    or retirement.get('restoreJournal') != str(path)
                    or saved.get('review') != retirement.get('restoreReview')
                    or not isinstance(saved.get('review'), dict)
                    or saved.get('completed') != list(range(len(manifest['plan']['resources'])))
                    or saved.get('active') is not None):
                raise ValueError('The completed reconstructed-source restore receipt changed')
            # The source may already have restarted before the outer journal was
            # saved. A completed restore is never replayed over its newer data.
            retirement['phase'] = 'restored'
            self.save(record)
            self.preserved(record)
            return True
        if retirement['phase'] == 'restored' or record.get('phase') == 'rolled-back':
            raise ValueError('The completed reconstructed-source restore receipt is missing or invalid')
        review = TOOLS.RESTORE.review(self.root, self.runtime.reader, self.snapshot)
        if retirement.get('restoreJournal') == str(path):
            if retirement.get('restoreReview') != review:
                raise ValueError('Reconstructed source storage writers changed during recovery')
        retirement.update(restoreJournal=str(path), restoreReview=review)
        self.save(record)
        TOOLS.RESTORE.restore(self.root, self.runtime.reader, review, path, host_writers_stopped=True, recover=path.exists())
        retirement['phase'] = 'restored'
        self.save(record)
        self.preserved(record)
        return True

    def preserved(self, record):
        self.require_reset_mount(record)
        self.require_cli_storage(record)
        CoreNetwork(self).verify(record)
        if self.runtime.reader._object(['info', '--format', '{{json .}}']).get('ID') != record['daemonId']:
            raise ValueError('Controller update Docker daemon changed')
        proxy = self.runtime.inspect(record['proxy']['Id'])
        self.runtime.verify_networks({'source': {'container': record['proxy']}}, proxy)
        if (self.runtime.definition(proxy) != record['proxyDefinition']
                or self.runtime.controller_proxy_policy(proxy) != record['proxyPolicy']):
            raise ValueError('The preserved live proxy changed')
        self.proxy_candidate_body(record['body'], transform=False)
        for identifier, prior in record.get('appIdentities', {}).items():
            raw = self.runtime.inspect(identifier)
            if (self.runtime.definition(raw) != prior['definition']
                    or raw['State'].get('Running') != prior['running'] or raw['State'].get('StartedAt') != prior['startedAt']):
                raise ValueError('A preserved application container changed')
        for name, prior in record['peers'].items():
            if record.get('coreNetwork') is not None:
                continue
            raw = self.runtime.inspect(prior['Id'])
            self.runtime.verify_networks({'source': {'container': prior}}, raw)
            if raw['Name'] != '/' + name or self.runtime.definition(raw) != record['peerDefinitions'][name]:
                raise ValueError('A controller database or queue definition changed')

    def retire_rejected_probe(self):
        record = self.read()
        with self.a.protected_directory(self.path) as directory:
            with self.a.protected_file(directory, 'runtime.json', 16 * 1024 * 1024) as body:
                if self.P.metadata(body, byte_limit=16 * 1024 * 1024, string_limit=2 * 1024 * 1024) != record:
                    raise ValueError('Probe authority changed during abort settlement')
                runtime_sha = hashlib.sha256(body).hexdigest()
        journal_path = self.snapshot.with_name(self.snapshot.name + '.orbis-update.json')
        with self.a.protected_directory(journal_path.parent) as directory:
            with self.a.protected_file(directory, journal_path.name, 16 * 1024 * 1024) as body:
                journal = self.P.metadata(body, byte_limit=16 * 1024 * 1024, string_limit=2 * 1024 * 1024)
                journal_sha = hashlib.sha256(body).hexdigest()
        retirement = record.get('sourceRetirement') or {}
        checkpoint_path = Path(record.get('checkpoint', {}).get('journal', str(self.snapshot) + '.checkpoint.json'))
        if (journal.get('schema') != 'orbis.update.v1' or journal.get('stage') != 'aborted'
                or journal.get('failureStage') != 'pulled' or journal.get('failureCode') != CapabilityError.code
                or journal.get('root') != str(self.root) or journal.get('dockerContext') != self.context
                or journal.get('snapshot') != str(self.snapshot) or journal.get('previousDigest') != self.current['digest']
                or journal.get('targetDigest') != self.target['digest'] or record.get('phase') != 'preparing'
                or record.get('candidateId') or record.get('bootstrapProbes')
                or retirement and (retirement.get('phase') != 'held' or retirement.get('anchorId')
                    or retirement.get('reconstructionId') or retirement.get('checkpointManifestSha256'))
                or checkpoint_path.exists() or checkpoint_path.is_symlink() or self.snapshot.exists() or self.snapshot.is_symlink()):
            raise ValueError('Probe retirement requires its durable abort before downtime')
        identifier = record.get('probeId')
        if not isinstance(identifier, str) or not self.host.IDENTITY.HEX.fullmatch(identifier):
            raise ValueError('The aborted operation has no exact probe identity')
        expected = record.get('probeBody') or {}
        if (set(expected) != {'Image', 'Labels', 'HostConfig'}
                or expected.get('Image') != self.target['image'] + '@' + self.target['digest']
                or expected.get('Labels') != {'io.orbis.controller-probe': record.get('nonce')}
                or expected.get('HostConfig') != {'NetworkMode': 'none', 'RestartPolicy': {'Name': 'no', 'MaximumRetryCount': 0}}):
            raise ValueError('The aborted probe creation intent changed')
        name = 'orbis-controller-probe-' + self.key
        binding = {'schema': PROBE_RETIREMENT, 'id': identifier, 'name': name,
                   'runtimeSha256': runtime_sha, 'updateJournalSha256': journal_sha,
                   'imageId': record.get('targetImageId'), 'reason': 'controller-preservation-unsupported'}
        receipt_path = self.path / 'capability-probe-retirement.json'
        receipt = None
        try:
            with self.a.protected_directory(self.path) as directory:
                with self.a.protected_file(directory, receipt_path.name, 16384) as body:
                    receipt = self.P.metadata(body, byte_limit=16384)
        except FileNotFoundError:
            pass
        if receipt is not None and (set(receipt) != {*binding, 'phase', 'definitionSha256'}
                or any(receipt.get(key) != value for key, value in binding.items())
                or receipt.get('phase') not in {'approved', 'complete'}
                or not isinstance(receipt.get('definitionSha256'), str)
                or not self.host.IDENTITY.HEX.fullmatch(receipt['definitionSha256'])):
            raise ValueError('The protected probe retirement receipt changed')
        if self.runtime.reader._object(['info', '--format', '{{json .}}']).get('ID') != record['daemonId']:
            raise ValueError('The probe Docker daemon changed')
        probe = self.optional_container(identifier)
        if probe is None:
            if receipt is None:
                raise ValueError('The probe disappeared before protected retirement intent')
        else:
            labels = probe.get('Config', {}).get('Labels') or {}
            if (probe['Id'] != identifier or probe.get('Name') != '/' + name
                    or probe.get('Image') != binding['imageId'] or probe['Config'].get('Image') != expected.get('Image')
                    or not isinstance(expected.get('Labels'), dict) or not expected['Labels']
                    or any(labels.get(key) != value for key, value in expected['Labels'].items())
                    or probe.get('State', {}).get('Status') != 'created' or probe['State'].get('Running') is not False
                    or probe['State'].get('StartedAt') != '0001-01-01T00:00:00Z' or probe.get('Mounts') != []
                    or probe['Config'].get('Volumes') or probe['HostConfig'].get('Binds')
                    or probe['HostConfig'].get('Mounts') or probe['HostConfig'].get('VolumesFrom')
                    or probe['HostConfig'].get('NetworkMode') != 'none' or probe['HostConfig'].get('Privileged')
                    or probe['HostConfig'].get('AutoRemove')
                    or set(probe.get('NetworkSettings', {}).get('Networks', {})) - {'none'}
                    or probe['HostConfig'].get('RestartPolicy') != {'Name': 'no', 'MaximumRetryCount': 0}):
                raise ValueError('The rejected probe no longer matches its exact never-started intent')
            definition = self.runtime.definition(probe)
            if receipt is not None and (receipt['phase'] == 'complete' or receipt['definitionSha256'] != definition):
                raise ValueError('The rejected probe changed after retirement approval')
            receipt = {**binding, 'phase': 'approved', 'definitionSha256': definition}
            self.a.atomic(receipt_path, self.P.canonical(receipt))
            try:
                self.runtime.change(['rm', identifier])
            except RuntimeError:
                if self.optional_container(identifier) is not None:
                    raise
            if self.optional_container(identifier) is not None:
                raise ValueError('Rejected probe retirement remains incomplete')
        receipt['phase'] = 'complete'
        self.a.atomic(receipt_path, self.P.canonical(receipt))
        return True

    def prepare(self, checkpoint):
        without_backup = checkpoint.get('backupPolicy') == 'none'
        if without_backup:
            TOOLS.validate_review(checkpoint)
        if checkpoint['storage'].get('backupScope') != SCOPE:
            raise ValueError('This controller replacement requires a live-proxy checkpoint')
        try:
            record = self.read()
        except FileNotFoundError:
            source = self.runtime.inspect('runtipi')
            labels = source['Config'].get('Labels') or {}
            expected = self.host.controller_reference(self.root, self.current, self.context)
            if (source['Config'].get('Image') != expected or source['State'].get('Running') is not True
                    or (source['State'].get('Health') or {}).get('Status') != 'healthy'
                    or labels.get('com.docker.compose.project.working_dir') != str(self.root)
                    or labels.get('com.docker.compose.service') != 'runtipi'
                    or source['HostConfig'].get('Privileged') or source['HostConfig'].get('AutoRemove')):
                raise ValueError('The reviewed running controller changed')
            # Runtime configuration comes from the reviewed running controller.
            # Only protected reviewed reset enrollment can add a dedicated bind.
            proxy = self.runtime.inspect('runtipi-reverse-proxy')
            overlay = self.runtime.overlay_preflight(source, policy='controller-overlay.v1')
            peers = {name: self.runtime.inspect(name) for name in ('runtipi-db', 'runtipi-queue')}
            record = {'schema': NO_BACKUP_POLICY if without_backup else POLICY, 'root': str(self.root), 'context': self.context, 'snapshot': str(self.snapshot),
                      'current': self.current, 'target': self.target, 'phase': 'preparing', 'nonce': secrets.token_hex(32),
                      'checkpoint': checkpoint, 'source': source, 'sourceDefinition': self.runtime.definition(source),
                      'proxy': proxy, 'proxyDefinition': self.runtime.definition(proxy), 'proxyPolicy': overlay['controllerProxyPolicy'],
                      'peers': peers, 'peerDefinitions': {name: self.runtime.definition(raw) for name, raw in peers.items()},
                      'daemonId': self.runtime.reader._object(['info', '--format', '{{json .}}'])['ID'],
                      'originalName': 'orbis-controller-original-' + self.key,
                      'candidateName': 'orbis-controller-candidate-' + self.key,
                      'failedName': 'orbis-controller-failed-' + self.key}
            target_ref = self.target['image'] + '@' + self.target['digest']
            target_image = self.runtime.reader._object(['image', 'inspect', '--format', '{{json .}}', target_ref])
            source_image = self.runtime.image(source['Image'])
            body_record = {'id': self.key, 'nonce': record['nonce'],
                           'source': {'container': source, 'imageConfiguration': source_image.get('Config') or {}},
                           'target': {'creationReference': target_ref, 'publication': self.target}}
            body = self.runtime.base_body(body_record, 'candidate', target_image.get('Config') or {})
            body['Env'] = [item for item in body['Env'] if not item.startswith('ORBIS_CONTROLLER_PRESERVE_NETWORK_ACCESS=')]
            body['Env'].append('ORBIS_CONTROLLER_PRESERVE_NETWORK_ACCESS=1')
            for key in ('io.orbis.restore', 'io.orbis.restore.nonce', 'io.orbis.restore.role'):
                body['Labels'].pop(key, None)
            body['Labels']['io.orbis.controller-update'] = self.key
            # Preserve name-based network aliases used by the controller's peers.
            body['NetworkingConfig'] = {'EndpointsConfig': {name: {'Aliases': sorted({alias for alias in (endpoint.get('Aliases') or [])
                if alias not in {source['Id'], source['Id'][:12]}})} for name, endpoint in source['NetworkSettings']['Networks'].items()}}
            app_identities = {}
            for identifier in checkpoint['storage'].get('preservedAppContainers', []):
                raw = self.runtime.inspect(identifier)
                app_identities[identifier] = {'definition': self.runtime.definition(raw), 'running': raw['State'].get('Running'),
                                              'startedAt': raw['State'].get('StartedAt')}
            body = self.reset_candidate_body(record, body)
            body = self.proxy_candidate_body(body, transform=True)
            record.update(body=body, targetImageId=target_image['Id'], appIdentities=app_identities)
            self.save(record)
        if unbacked(record) != without_backup or record['checkpoint'] != checkpoint:
            raise ValueError('The protected controller checkpoint changed')
        self.preserved(record)
        if not record.get('probeId'):
            probe_body = {'Image': self.target['image'] + '@' + self.target['digest'],
                          'Labels': {'io.orbis.controller-probe': record['nonce']},
                          'HostConfig': {'NetworkMode': 'none', 'RestartPolicy': {'Name': 'no', 'MaximumRetryCount': 0}}}
            record['probeBody'] = probe_body
            self.save(record)
            try:
                probe = self.lookup('orbis-controller-probe-' + self.key)
            except (ValueError, RuntimeError):
                response = self.P.metadata(self.runtime.engine('POST', '/containers/create?name=orbis-controller-probe-' + self.key, probe_body))
                probe = self.runtime.inspect(response['Id'])
            record['probeId'] = probe['Id']
            self.save(record)
        probe = self.runtime.inspect(record['probeId'])
        if (probe['Image'] != record['targetImageId'] or probe['State'].get('Running')
                or probe['Config'].get('Labels', {}).get('io.orbis.controller-probe') != record['nonce']
                or probe.get('Mounts') or probe['HostConfig'].get('NetworkMode') != 'none'):
            raise ValueError('Target capability probe changed')
        try:
            output = self.runtime.bounded_output(['docker', '--context', self.context, 'container', 'cp',
                probe['Id'] + ':/app/controller-overlay-capability.json', '-'], 16384, 20)
        except (ValueError, RuntimeError) as error:
            raise CapabilityError('The target does not support preserving live network access during controller updates') from error
        with tarfile.open(fileobj=io.BytesIO(output), mode='r:') as archive:
            entries = list(archive)
            if (len(entries) != 1 or entries[0].name != 'controller-overlay-capability.json'
                    or not entries[0].isfile() or not 0 < entries[0].size <= 4096):
                raise CapabilityError('The target does not support preserving live network access during controller updates')
            body = archive.extractfile(entries[0]).read(4097)
        capability = self.P.metadata(body, byte_limit=4096)
        if capability not in (CAPABILITY, CLI_CAPABILITY, NETWORK_CAPABILITY) and not (without_backup and capability == NO_BACKUP_CAPABILITY):
            raise CapabilityError('The target does not support preserving live network access during controller updates')
        if capability in (CLI_CAPABILITY, NETWORK_CAPABILITY):
            self.prepare_cli_storage(record)
            self.save(record)
        self.runtime.change(['rm', probe['Id']])
        record.pop('probeId', None)
        self.review_source_bootstrap(record)
        if record['sourceBootstrapProfile']['profile'] == BOOTSTRAP.LEGACY:
            if record.get('coreNetwork') is None:
                record['sourceBootstrapNetworks'] = BOOTSTRAP.preserved_networks(self, record)
            elif 'sourceBootstrapNetworks' not in record:
                raise ValueError('The original legacy bootstrap network review is missing')
        if capability == NETWORK_CAPABILITY:
            CoreNetwork(self).prepare(record)
        if record.get('sourceRetirement'):
            self.retain_source_image(record)
        record['phase'] = 'prepared'
        self.save(record)
        return record

    def prepare_cli_storage(self, record):
        if record.get('cliStorage') is not None:
            self.require_cli_storage(record)
            return
        body = record['body']
        user = body.get('User') or ''
        host = body['HostConfig']
        daemon = self.runtime.reader._object(['info', '--format', '{{json .}}'])
        security = daemon.get('SecurityOptions')
        if (user not in {'', '0', 'root', '0:0', 'root:root'} or host.get('UsernsMode') not in (None, '', 'host')
                or not isinstance(security, list) or any(not isinstance(value, str) for value in security)
                or any('rootless' in value or ('userns' in value and host.get('UsernsMode') != 'host') for value in security)):
            raise CapabilityError('The target CLI authentication requires a verified root-owned private bind')
        observed = require_cli_mounts(self.root, record['source'].get('Mounts'), required=False)
        intended = require_cli_mounts(self.root, cli_mounts(body), required=False)
        if observed != intended:
            raise ValueError('The source CLI authentication bind intent changed')
        storage = cli_storage(self.root, create=True)
        if not intended:
            if host.get('Mounts') is None:
                host['Mounts'] = []
            host['Mounts'].append({'Type': 'bind', 'Source': storage['source'], 'Target': CLI_TARGET,
                                   'ReadOnly': False, 'BindOptions': {'Propagation': 'rprivate'}})
        record['cliStorage'] = storage
        self.require_cli_storage(record)

    def require_cli_storage(self, record, *, candidate=None, require_key=False):
        storage = record.get('cliStorage')
        if storage is None:
            return
        current = cli_storage(self.root)
        if (set(storage) != set(current) or any(storage[key] != current[key] for key in current if key != 'keySha256')
                or storage['keySha256'] is not None and storage['keySha256'] != current['keySha256']):
            raise ValueError('The private target CLI authentication storage changed')
        require_cli_mounts(self.root, cli_mounts(record['body']), required=True)
        if candidate is not None:
            require_cli_mounts(self.root, candidate.get('Mounts'), required=True)
        if require_key:
            if current['keySha256'] is None:
                raise ValueError('The healthy controller did not establish its private CLI authentication key')
            storage['keySha256'] = current['keySha256']

    def verify_source(self, record):
        retirement = record.get('sourceRetirement') or {}
        identifier = retirement.get('reconstructionId') or record['source']['Id']
        raw = self.runtime.inspect(identifier)
        expected = retirement.get('reconstructionDefinition') if retirement.get('reconstructionId') else record['sourceDefinition']
        if self.runtime.definition(raw) != expected:
            raise ValueError('The original controller definition changed')
        return raw

    def start_peers(self, record):
        self.preserved(record)
        for name in ('runtipi-db', 'runtipi-queue'):
            raw = self.runtime.inspect(record['peers'][name]['Id'])
            if not raw['State'].get('Running'):
                self.runtime.change(['start', raw['Id']])

    def check_candidate_networks(self, record, candidate):
        source = record['source']
        if record.get('coreNetwork') is not None:
            source = copy.deepcopy(source)
            source['NetworkSettings']['Networks'][CORE_NETWORK] = {'NetworkID': record['coreNetwork']['id']}
        self.runtime.verify_networks({'source': {'container': source}}, candidate)
        intended = record['body']['NetworkingConfig']['EndpointsConfig']
        actual = candidate['NetworkSettings']['Networks']
        if set(actual) != set(intended):
            raise ValueError('The controller candidate network set changed')
        generated = {record['candidateName'], 'runtipi', candidate['Id'], candidate['Id'][:12]}
        for name, endpoint in intended.items():
            requested = endpoint.get('Aliases') or []
            observed = actual[name].get('Aliases') or []
            if (not isinstance(requested, list) or not isinstance(observed, list)
                    or any(not isinstance(alias, str) or not alias or len(alias) > 253 for alias in [*requested, *observed])
                    or not set(requested) <= set(observed) or set(observed) - set(requested) - generated):
                raise ValueError('The controller candidate configured network aliases changed')
            dns = actual[name].get('DNSNames')
            if dns is not None:
                if (not isinstance(dns, list) or any(not isinstance(alias, str) or not alias or len(alias) > 253 for alias in dns)
                        or set(dns) - set(requested) - generated
                        or candidate['State'].get('Running') and not set(requested) <= set(dns)):
                    raise ValueError('The controller candidate Docker DNS names changed')

    def start_target(self, progress=None):
        record = self.read()
        self.preserved(record)
        if unbacked(record):
            self.no_backup_handoff(record)
        if record.get('sourceRetirement'):
            self.retire_dedicated_source(record)
            original = None
        else:
            original = self.verify_source(record)
        if not record.get('candidateId'):
            try:
                candidate = self.lookup(record['candidateName'])
            except (ValueError, RuntimeError):
                response = self.P.metadata(self.runtime.engine('POST', '/containers/create?name=' + record['candidateName'], record['body']))
                candidate = self.runtime.inspect(response['Id'])
            self.runtime.check_intent(candidate, record['body'])
            self.check_candidate_networks(record, candidate)
            self.require_reset_mount(record, candidate=candidate)
            self.require_cli_storage(record, candidate=candidate)
            if candidate['Image'] != record['targetImageId'] or candidate['State'].get('Running'):
                raise ValueError('Controller candidate differs from its protected intent')
            record['candidateId'] = candidate['Id']
            record['candidateDefinition'] = self.runtime.definition(candidate)
            self.save(record)
        candidate = self.runtime.inspect(record['candidateId'])
        self.runtime.check_intent(candidate, record['body'])
        self.check_candidate_networks(record, candidate)
        self.require_reset_mount(record, candidate=candidate)
        self.require_cli_storage(record, candidate=candidate)
        if ((original is not None and original['State'].get('Running')) or self.runtime.definition(candidate) != record['candidateDefinition']
                or candidate['Image'] != record['targetImageId']):
            raise ValueError('The stopped controller or candidate changed')
        record['phase'] = 'replacing'
        self.save(record)
        if original is not None:
            if original['Name'] == '/runtipi':
                self.runtime.change(['rename', original['Id'], record['originalName']])
            elif original['Name'] != '/' + record['originalName']:
                raise ValueError('Original controller recovery name changed')
        if candidate['Name'] != '/runtipi':
            if candidate['Name'] != '/' + record['candidateName']:
                raise ValueError('Candidate controller name changed')
            self.runtime.change(['rename', candidate['Id'], 'runtipi'])
        if unbacked(record):
            record['unbackedWritesPossible'] = True
            self.save(record)
        CoreNetwork(self).move(record, 'target')
        self.start_peers(record)
        if progress is not None:
            progress('restarting')
        self.runtime.change(['start', candidate['Id']])
        if progress is not None:
            progress('verifying')
        self.healthy(record, candidate['Id'], record['targetImageId'])
        record['phase'] = 'active'
        self.save(record)

    def healthy(self, record, identifier, image):
        deadline = time.monotonic() + 180
        while True:
            self.preserved(record)
            raw = self.runtime.inspect(identifier)
            if identifier == record.get('candidateId'):
                self.check_candidate_networks(record, raw)
            elif identifier == record.get('sourceRetirement', {}).get('reconstructionId'):
                source_record = {**record, 'body': record['sourceRetirement']['body'],
                                 'candidateName': record['sourceRetirement']['reconstructionName']}
                self.check_candidate_networks(source_record, raw)
            else:
                self.runtime.verify_networks({'source': {'container': record['source']}}, raw)
            if raw['Image'] != image or raw['Name'] != '/runtipi':
                raise ValueError('Controller identity changed during startup')
            if raw['State'].get('Running') and (raw['State'].get('Health') or {}).get('Status') == 'healthy':
                if identifier == record.get('candidateId'):
                    self.require_cli_storage(record, candidate=raw, require_key=True)
                return
            if time.monotonic() >= deadline or raw['State'].get('Status') in {'exited', 'dead'}:
                raise RuntimeError('The reviewed controller did not become healthy')
            time.sleep(1)

    def stop_for_rollback(self):
        record = self.read()
        if unbacked(record):
            raise NoBackupRecoveryRequired('This update has no data backup; preserve its state for recovery review')
        self.preserved(record)
        retirement = record.get('sourceRetirement')
        if retirement:
            self.validate_retirement(record)
            identifier = retirement.get('reconstructionId') or record['source']['Id']
            source = self.optional_container(identifier)
            if source is None and retirement['phase'] == 'held':
                raise ValueError('The dedicated source disappeared before retirement')
            if source is not None:
                self.verify_source(record)
        else:
            source = self.verify_source(record)
        identifiers = ([source['Id']] if source is not None else []) + [raw['Id'] for raw in record['peers'].values()]
        if not record.get('candidateId'):
            try:
                pending = self.lookup(record['candidateName'])
            except (ValueError, RuntimeError):
                pending = None
            if pending is not None:
                self.runtime.check_intent(pending, record['body'])
                if pending['Image'] != record['targetImageId'] or pending['State'].get('Running'):
                    raise ValueError('An unrecorded controller candidate changed')
                record['candidateId'] = pending['Id']
                record['candidateDefinition'] = self.runtime.definition(pending)
                self.save(record)
        candidate = None
        if record.get('candidateId'):
            try:
                candidate = self.runtime.inspect(record['candidateId'])
            except (ValueError, RuntimeError):
                missing = self.runtime.engine('GET', '/containers/' + record['candidateId'] + '/json', allow_missing=True)
                if missing is not None or record.get('candidateRetirementIntent') is not True:
                    raise ValueError('The candidate disappeared without a protected retirement intent')
            if candidate is not None:
                intent = copy.deepcopy(record['body'])
                policy = candidate['HostConfig'].get('RestartPolicy')
                if policy not in [intent['HostConfig']['RestartPolicy'], record['source']['HostConfig']['RestartPolicy']]:
                    raise ValueError('The candidate restart policy changed before recovery')
                intent['HostConfig']['RestartPolicy'] = policy
                self.runtime.check_intent(candidate, intent)
                if self.runtime.definition(candidate) != record['candidateDefinition']:
                    raise ValueError('The candidate changed before recovery')
                identifiers.insert(0, candidate['Id'])
        for identifier in identifiers:
            self.runtime.change(['update', '--restart', 'no', identifier])
            if self.runtime.inspect(identifier)['State'].get('Running'):
                self.runtime.change(['stop', identifier])
        if candidate is not None:
            raw = self.runtime.inspect(candidate['Id'])
            record.update(phase='rolling-back', candidateRetirementIntent=True)
            self.save(record)
            # Retain its exact intent and definition in protected recovery state;
            # remove only this verified stopped generated candidate so discovery
            # and the original checkpoint see the original controller alone.
            self.runtime.change(['rm', raw['Id']])
        original = self.ensure_rollback_source(record) if retirement else self.verify_source(record)
        if original['Name'] == '/' + record['originalName']:
            self.runtime.change(['rename', original['Id'], 'runtipi'])
        elif original['Name'] != '/runtipi':
            raise ValueError('The original controller recovery name changed')
        CoreNetwork(self).move(record, 'source')
        CoreNetwork(self).retire_for_legacy_rollback(record)
        return record

    def verify_source_bootstrap(self):
        record = self.read()
        self.preserved(record)
        if record.get('sourceBootstrapEnablement') is not None:
            proof = BOOTSTRAP.probe(self, record, 'rollback')
        elif record.get('sourceRetirement', {}).get('reconstructionId'):
            original_source = copy.deepcopy(record['source'])
            record['source'] = self.verify_source(record)
            def save_probe(value):
                stored = copy.deepcopy(value)
                stored['source'] = original_source
                self.save(stored)
            proxy = SimpleNamespace(**vars(self))
            proxy.save = save_probe
            proxy.lookup = self.lookup
            proof = BOOTSTRAP.probe(proxy, record, 'rollback')
        else:
            proof = BOOTSTRAP.probe(self, record, 'rollback')
        if proof['profile'] == BOOTSTRAP.LEGACY:
            if BOOTSTRAP.preserved_networks(self, record) != record.get('sourceBootstrapNetworks'):
                raise BOOTSTRAP.fail()
        return proof

    def start_original(self):
        record = self.read()
        if unbacked(record):
            raise NoBackupRecoveryRequired('This update has no data backup; preserve its state for recovery review')
        if record.get('sourceBootstrapEnablement') is not None:
            self.bootstrap_source(record, 'rollback')
        original = self.verify_source(record)
        CoreNetwork(self).move(record, 'source')
        CoreNetwork(self).retire_for_legacy_rollback(record)
        self.start_peers(record)
        if not original['State'].get('Running'):
            self.verify_source_bootstrap()
            self.runtime.change(['start', original['Id']])
        self.healthy(record, original['Id'], original['Image'])
        record = self.read()
        record['phase'] = 'rolled-back'
        self.save(record)
        self.cleanup_source_anchor(record)

    def restore_policies(self, *, target):
        record = self.read()
        self.preserved(record)
        records = list(record['peers'].values()) + [record['source']]
        for raw in records:
            identifier = raw['Id']
            if raw['Id'] == record['source']['Id']:
                identifier = record['candidateId'] if target else record.get('sourceRetirement', {}).get('reconstructionId') or identifier
            policy = raw['HostConfig']['RestartPolicy']
            flag = policy['Name'] + (':' + str(policy['MaximumRetryCount']) if policy['Name'] == 'on-failure' else '')
            self.runtime.change(['update', '--restart', flag, identifier])

    def cleanup_source_anchor(self, record):
        retirement = record.get('sourceRetirement')
        if not retirement or not retirement.get('anchorId'):
            return False
        try:
            anchor = self.optional_container(retirement['anchorId'])
            if anchor is not None:
                if (self.runtime.definition(anchor) != retirement.get('anchorDefinition') or anchor.get('Mounts')
                        or anchor['State'].get('Running') or anchor['State'].get('Status') != 'created'
                        or anchor['Image'] != retirement['imageId']):
                    raise ValueError('Source image anchor retirement needs protected review')
                self.runtime.change(['rm', anchor['Id']])
            if self.optional_container(retirement['anchorId']) is not None:
                raise ValueError('The source image anchor has not retired')
            retirement['anchorRetiredId'] = retirement.pop('anchorId')
            retirement['anchorCleanupRequired'] = False
        except (ValueError, RuntimeError, OSError):
            retirement['anchorCleanupRequired'] = True
        self.save(record)
        return retirement['anchorCleanupRequired']

    def commit(self):
        record = self.read()
        self.healthy(record, record['candidateId'], record['targetImageId'])
        candidate = self.runtime.inspect(record['candidateId'])
        intent = copy.deepcopy(record['body'])
        intent['HostConfig']['RestartPolicy'] = record['source']['HostConfig']['RestartPolicy']
        self.runtime.check_intent(candidate, intent)
        if self.runtime.definition(candidate) != record['candidateDefinition']:
            raise ValueError('The controller definition changed before commit')
        record.update(phase='committed', cleanupRequired=True)
        self.save(record)
        # The commit is durable before retiring the stopped source. A failed or
        # lost cleanup reply cannot reverse the healthy committed publication.
        try:
            body = self.runtime.engine('GET', '/containers/' + record['source']['Id'] + '/json', allow_missing=True)
            if body is not None:
                original = self.P.metadata(body, byte_limit=8 * 1024 * 1024)
                if (self.runtime.definition(original) != record['sourceDefinition']
                        or original['Name'] != '/' + record['originalName'] or original['State'].get('Running')
                        or original['HostConfig'].get('RestartPolicy') != {'Name': 'no', 'MaximumRetryCount': 0}):
                    raise ValueError('Original controller retirement needs protected review')
                self.runtime.change(['rm', original['Id']])
            if self.runtime.engine('GET', '/containers/' + record['source']['Id'] + '/json', allow_missing=True) is not None:
                raise ValueError('Original controller retirement is incomplete')
            record['cleanupRequired'] = False
        except (ValueError, RuntimeError, OSError):
            record['cleanupRequired'] = True
        if self.cleanup_source_anchor(record):
            record['cleanupRequired'] = True
        self.save(record)
        return record['cleanupRequired']
