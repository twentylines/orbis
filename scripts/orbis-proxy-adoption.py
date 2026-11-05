#!/usr/bin/env python3
"""Root-reviewed, resumable proxy-only identity cutover. Never executes Compose."""
import argparse
import copy
import hashlib
import importlib.util
import json
import os
import re
import stat
import sys
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import quote


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HOST = load('orbis-host.py', 'orbis_host_for_proxy_adoption')
D = load('orbis-host-retained-restore-runtime.py', 'orbis_runtime_for_proxy_adoption')
A, L, P = HOST.AUTHORITY, HOST.AUTHORITY.LAYOUT, HOST.IDENTITY.PUBLICATION
SCHEMA = 'orbis.proxy-adoption.v2'
PLAN_SCHEMA = 'orbis.proxy-adoption-plan.v2'
NAME = 'runtipi-reverse-proxy'
LIMIT = 16 * 1024 * 1024


def fail(reason='review changed'):
    return ValueError('Proxy adoption stopped: ' + reason + '. Preserve the original container, identity and private journal for reconciliation.')


def digest(value):
    return hashlib.sha256(P.canonical(value)).hexdigest()


def paths(root):
    base = L.namespace(root)
    return base / 'proxy-config', base / 'proxy-identity'


def execution_path(root):
    return paths(root)[0] / 'execution'


def identity_baseline(record):
    return record.get('quiescentIdentity', record['plan']['identity'])


def require_quiescent(raw):
    state = raw.get('State', {})
    if (state.get('Running') is not False or state.get('Paused') or state.get('Restarting')
            or state.get('Status') not in {'exited', 'created'}
            or raw['HostConfig'].get('RestartPolicy', {}).get('Name') != 'no'):
        raise fail('proxy is not verifiably stopped with restart disabled')


def metadata(info):
    return {key: getattr(info, 'st_' + key) for key in
            ('dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtime_ns', 'ctime_ns')}


@contextmanager
def sealed_tree(path, *, private=False, maximum=LIMIT, exclude=()):
    """Retain every FD and seal named entries, contents, ownership and metadata."""
    path = Path(path)
    descriptors, seals, bodies, entries = [], [], {}, {}
    total = 0
    try:
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        descriptors.append(fd)
        def walk(directory, relative):
            nonlocal total
            before = os.fstat(directory)
            if private and (before.st_uid != os.geteuid() or stat.S_IMODE(before.st_mode) != 0o700):
                raise fail('identity directory is not root-private')
            names = sorted(os.listdir(directory))
            if len(entries) + len(names) > 4096:
                raise fail('identity tree exceeds its bound')
            entries[relative] = {'metadata': metadata(before), 'children': [name for name in names if relative or name not in exclude]}
            seals.append((None, None, directory, metadata(before), names))
            for name in names:
                if not relative and name in exclude:
                    continue
                child_name = relative + '/' + name if relative else name
                info = os.stat(name, dir_fd=directory, follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                    descriptors.append(child)
                    seals.append((directory, name, child, metadata(info), None))
                    walk(child, child_name)
                elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and 0 <= info.st_size <= maximum:
                    child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
                    descriptors.append(child)
                    if private and (info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600):
                        raise fail('identity file is not root-private')
                    body = b''
                    while len(body) <= info.st_size:
                        block = os.read(child, min(1024 * 1024, info.st_size + 1 - len(body)))
                        if not block:
                            break
                        body += block
                    total += len(body)
                    if len(body) != info.st_size or total > maximum:
                        raise fail('identity tree exceeds its bound or changed')
                    bodies[child_name] = body
                    entries[child_name] = {'metadata': metadata(info), 'sha256': hashlib.sha256(body).hexdigest()}
                    seals.append((directory, name, child, metadata(info), None))
                else:
                    raise fail('identity contains a link or unsupported entry')
        walk(fd, '')
        initial = metadata(os.fstat(fd))
        def seal():
            if metadata(path.lstat()) != initial:
                raise fail('identity root was replaced')
            for parent, name, descriptor, expected, names in seals:
                if metadata(os.fstat(descriptor)) != expected:
                    raise fail('identity metadata changed')
                if parent is not None and metadata(os.stat(name, dir_fd=parent, follow_symlinks=False)) != expected:
                    raise fail('identity entry was replaced')
                if names is not None and sorted(os.listdir(descriptor)) != names:
                    raise fail('identity entries changed')
        seal()
        yield {'entries': entries, 'bytes': total}, bodies, seal
        seal()
    finally:
        for fd in reversed(descriptors):
            os.close(fd)


def content_fingerprint(tree):
    return digest({name: value.get('sha256', {'directory': True}) for name, value in tree['entries'].items()})


@contextmanager
def sealed_static(root):
    with L.R._reviewed_ancestry(root) as (_, ancestry_seal):
        directory = os.open(root / 'traefik', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        descriptor = None
        try:
            directory_info = metadata(os.fstat(directory))
            descriptor = os.open('traefik.yml', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            info = os.fstat(descriptor)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1
                    or not 0 < info.st_size <= 1024 * 1024):
                raise fail('static configuration lacks reviewed root ownership')
            body = os.read(descriptor, 1024 * 1024 + 1)
            if len(body) != info.st_size:
                raise fail('static configuration changed')
            value = {'sha256': hashlib.sha256(body).hexdigest(), 'metadata': metadata(info), 'directory': directory_info}
            def seal():
                ancestry_seal()
                if (metadata(os.fstat(descriptor)) != value['metadata']
                        or metadata(os.stat('traefik.yml', dir_fd=directory, follow_symlinks=False)) != value['metadata']
                        or metadata(os.fstat(directory)) != directory_info
                        or metadata((root / 'traefik').lstat()) != directory_info):
                    raise fail('static configuration changed')
            seal()
            yield value, body, seal
            seal()
        finally:
            if descriptor is not None:
                os.close(descriptor)
            os.close(directory)


def started_ns(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z', value):
        raise fail('proxy start time is invalid')
    base, _, fraction = value[:-1].partition('.')
    return int(datetime.fromisoformat(base + '+00:00').timestamp()) * 10**9 + int(fraction.ljust(9, '0') or '0')


def overlap(left, right):
    a, b = Path(left), Path(right)
    return a == b or a.is_relative_to(b) or b.is_relative_to(a)


def mount_coordinates(path, mounts):
    path = Path(path)
    if mounts is None:
        return [('lexical', path)]
    candidates = [entry for entry in mounts if path == Path(entry['path']) or path.is_relative_to(entry['path'])]
    if not candidates:
        raise fail('host mount topology is unavailable')
    selected = max(candidates, key=lambda item: len(item['path']))
    def coordinate(entry, suffix):
        fields = entry['identity'].split(' ')
        return fields[2], Path(L.R._unescape(fields[3])) / suffix
    result = [coordinate(selected, path.relative_to(selected['path']))]
    # Recursive bind mounts also expose submounts below their source.
    result.extend(coordinate(entry, Path('.')) for entry in mounts
                  if Path(entry['path']).is_relative_to(path) and entry['fsType'] != 'nsfs')
    return result


def require_aliases(root, containers, source_id, target_id=None, reviewed_writers=(), mountinfo=None):
    namespace = L.namespace(root)
    identity = paths(root)[1]
    if mountinfo is None and sys.platform == 'linux':
        mountinfo = Path('/proc/self/mountinfo')
    mounts = L.R._mount_entries(mountinfo) if mountinfo is not None else None
    def exposes(source, protected):
        return any(a_dev == b_dev and overlap(a_path, b_path)
                   for a_dev, a_path in mount_coordinates(source, mounts)
                   for b_dev, b_path in mount_coordinates(protected, mounts))
    for raw in containers:
        identifier = raw['Id']
        for mount in raw.get('Mounts', []):
            if mount.get('Type') == 'tmpfs':
                continue
            source = mount.get('Source')
            if not isinstance(source, str) or not source.startswith('/') or type(mount.get('RW')) is not bool:
                raise fail('container mount inventory is invalid')
            original_source = source
            source = os.path.realpath(source)
            if exposes(source, namespace):
                identity_mount = (identifier == target_id and mount.get('Type') == 'bind' and original_source == str(identity)
                                  and mount.get('Destination') == '/shared' and mount.get('RW') is True)
                config_mount = (mount.get('Type') == 'bind' and original_source == str(execution_path(root))
                                and source == original_source and mount.get('RW') is False
                                and (identifier == target_id and mount.get('Destination') == '/etc/traefik'
                                     or mount.get('Destination') == '/data/traefik'))
                if not (identity_mount or config_mount):
                    raise fail('container exposes protected enrollment or identity')
            if mount['RW'] and exposes(source, root / 'traefik'):
                if identifier != source_id and identifier not in reviewed_writers:
                    raise fail('unreviewed container can write proxy configuration')
    if mountinfo is not None and L.R._mount_entries(mountinfo) != mounts:
        raise fail('host mount topology changed during alias review')


@contextmanager
def sealed_execution(root, record):
    with L.R._control_descriptor(execution_path(root)), sealed_tree(execution_path(root), private=True) as (tree, bodies, seal):
        if (content_fingerprint(tree) != record['plan']['configurationSha256']
                or tree != record.get('executionTree')):
            raise fail('private execution configuration differs from approved bytes')
        entry = tree['entries'].get('traefik.yml', {})
        if entry.get('sha256') != record['plan']['static']['sha256']:
            raise fail('private static configuration differs from approved bytes')
        yield {'sha256': entry['sha256'], 'metadata': entry['metadata'], 'directory': tree['entries']['']['metadata']}, bodies, seal


def make_body(source, root):
    if (source.get('Name') != '/' + NAME or source['HostConfig'].get('AutoRemove')
            or source['HostConfig'].get('Privileged') or source['Config'].get('User', '') not in {'', '0', '0:0', 'root'}):
        raise fail('proxy definition cannot be preserved safely')
    mounts = source.get('Mounts', [])
    expected = {'/etc/traefik': str(root / 'traefik'), '/shared': str(root / 'traefik/shared')}
    if len({item.get('Destination') for item in mounts}) != len(mounts):
        raise fail('proxy mounts overlap')
    for target, path in expected.items():
        selected = [m for m in mounts if m.get('Destination') == target]
        if len(selected) != 1 or selected[0].get('Type') != 'bind' or selected[0].get('Source') != path or selected[0].get('RW') is not True:
            raise fail('legacy proxy mount differs')
    for item in mounts:
        if (item.get('Type') != 'bind' or item.get('Propagation') not in {'rprivate', ''}
                or (item['Destination'] not in expected and (item.get('RW') is not False
                    or any(overlap(item['Destination'], target) for target in expected)))):
            raise fail('proxy has unsupported mounts')
    body = copy.deepcopy(source['Config'])
    body['Image'] = source['Image']
    host = copy.deepcopy(source['HostConfig'])
    host['Binds'] = None
    host['Mounts'] = [{'Type': 'bind', 'Source': (str(paths(root)[1]) if m['Destination'] == '/shared' else
                                  str(execution_path(root)) if m['Destination'] == '/etc/traefik' else m['Source']),
                       'Target': m['Destination'], 'ReadOnly': m['Destination'] != '/shared',
                       'BindOptions': {'Propagation': 'rprivate'}} for m in mounts]
    body['HostConfig'] = host
    endpoints = {}
    for name, item in source['NetworkSettings']['Networks'].items():
        if not re.fullmatch(r'[a-f0-9]{64}', item.get('NetworkID', '')):
            raise fail('proxy network identity is invalid')
        endpoints[name] = {key: copy.deepcopy(item[key]) for key in ('IPAMConfig', 'Links', 'Aliases', 'DriverOpts', 'GwPriority') if key in item}
        aliases = endpoints[name].get('Aliases') or []
        endpoints[name]['Aliases'] = [alias for alias in aliases if alias not in {source['Id'], source['Id'][:12]}]
    body['NetworkingConfig'] = {'EndpointsConfig': endpoints}
    return body


class Adoption:
    def __init__(self, root, context, runtime=None):
        self.root, self.context = Path(root), context
        self.runtime = runtime or D.DockerRestoreRuntime(SimpleNamespace(host=HOST, authority=A, root=self.root, context=context))
        self.directory, self.identity = paths(self.root)
        self.journal = self.directory / 'adoption.json'

    def inventory(self):
        before = {r['id'] for r in self.runtime.reader.containers()}
        if len(before) > 4096 or any(not re.fullmatch(r'[a-f0-9]{64}', item) for item in before):
            raise fail('invalid container inventory')
        result = [self.runtime.inspect(item) for item in sorted(before)]
        if {r['id'] for r in self.runtime.reader.containers()} != before:
            raise fail('container inventory changed')
        return result

    def environment(self):
        endpoint = self.runtime.reader.socket()
        daemon = self.runtime.reader.daemon()
        if not endpoint or not endpoint.startswith('/'):
            raise fail('local Docker socket is required')
        layout = L.read(self.root, daemon, self.context)
        if layout is None:
            raise fail('approved installation layout enrollment is required')
        return {'daemon': daemon, 'socket': endpoint, 'context': self.context, 'layoutSha256': digest(layout)}

    def fingerprint(self, raw):
        return {'definition': self.runtime.definition(raw), 'restartPolicy': raw['HostConfig'].get('RestartPolicy'),
                'name': raw['Name'], 'running': raw['State'].get('Running'), 'startedAt': raw['State'].get('StartedAt')}

    def routes(self, proxy, controller, network, expected=None):
        observed = self.runtime.proxy_routers(controller['Id'], proxy, network)
        selected = {name: observed.get(name) for name in ('dashboard@docker', 'dashboard-secure@docker')}
        for name, router in selected.items():
            if (not isinstance(router, dict) or router.get('status') != 'enabled' or router.get('service') != 'dashboard'
                    or router.get('entryPoints') != (['websecure'] if 'secure' in name else ['web'])):
                raise fail('dashboard HTTP/HTTPS routers are not active')
        if expected is not None and selected != expected:
            raise fail('dashboard routers changed')
        # Use the existing controller's Node runtime, the reviewed network IP and
        # router host rule. TLS is checked and no credentials/body are emitted.
        address = proxy['NetworkSettings']['Networks'][network].get('IPAddress')
        D.ipaddress.ip_address(address)
        for secure, router in ((False, selected['dashboard@docker']), (True, selected['dashboard-secure@docker'])):
            match = re.search(r'Host\([`\"]([A-Za-z0-9.-]+)[`\"]\)', router.get('rule', ''))
            hostname = match.group(1) if match else address
            options = {'hostname': address, 'port': 443 if secure else 80, 'path': '/dashboard',
                       'headers': {'host': hostname, 'accept': 'text/html'}, 'servername': hostname}
            code = "import h from 'node:" + ('https' if secure else 'http') + "';const q=h.get(" + json.dumps(options) + ",r=>{r.resume();if(r.statusCode!==200||!(r.headers['content-type']||'').startsWith('text/html'))process.exit(2);r.on('end',()=>process.stdout.write('ok'));});q.setTimeout(3000,()=>q.destroy());q.on('error',()=>process.exit(3));"
            if self.runtime.bounded_output(['docker', '--context', self.context, 'exec', controller['Id'], 'node', '--input-type=module', '-e', code], 1024, 6) != b'ok':
                raise fail('HTTP/HTTPS dashboard verification failed')
        return selected

    def review(self, reviewed_writers=()):
        environment = self.environment()
        if self.directory.exists() or self.identity.exists():
            raise fail('adoption storage already exists; use resume')
        for legacy in (self.root.parent / ('.' + self.root.name + '.orbis-proxy-identity'),
                       self.root.parent / ('.' + self.root.name + '.orbis-proxy-identity.json')):
            if legacy.exists() or legacy.is_symlink():
                raise fail('legacy identity authority requires reconciliation')
        rows = self.inventory()
        proxy = next((r for r in rows if r['Name'] == '/' + NAME), None)
        controller = next((r for r in rows if r['Name'] == '/runtipi'), None)
        if not proxy or not controller or not proxy['State'].get('Running') or proxy['State'].get('Paused') or proxy['State'].get('Restarting'):
            raise fail('healthy proxy and controller are required')
        labels = proxy['Config'].get('Labels') or {}
        if any(labels.get(key) != value for key, value in {'com.docker.compose.project': 'runtipi', 'com.docker.compose.service': NAME,
                                                         'com.docker.compose.project.working_dir': str(self.root)}.items()):
            raise fail('proxy installation labels differ')
        writers = sorted(set(reviewed_writers))
        if any(item not in {r['Id'] for r in rows} or item == proxy['Id'] for item in writers):
            raise fail('reviewed config writer is absent or invalid')
        require_aliases(self.root, rows, proxy['Id'], reviewed_writers=writers)
        common = set(proxy['NetworkSettings']['Networks']) & set(controller['NetworkSettings']['Networks'])
        network = (controller['Config'].get('Labels') or {}).get('traefik.docker.network')
        if network is None and len(common) == 1:
            network = next(iter(common))
        if network not in common:
            raise fail('reviewed dashboard network is required')
        with sealed_static(self.root) as (static, _, seal), sealed_tree(self.root / 'traefik/shared') as (tree, _, tree_seal), \
                sealed_tree(self.root / 'traefik', exclude=('shared',)) as (configuration, _, config_seal):
            plan = {'schema': PLAN_SCHEMA, 'root': str(self.root), 'environment': environment,
                    'proxy': proxy, 'body': make_body(proxy, self.root), 'static': static,
                    'identity': tree, 'identitySha256': content_fingerprint(tree), 'reviewedConfigWriters': writers,
                    'configuration': configuration, 'configurationSha256': content_fingerprint(configuration),
                    'peers': {r['Id']: self.fingerprint(r) for r in rows if r['Id'] != proxy['Id']},
                    'controllerId': controller['Id'], 'network': network, 'routes': self.routes(proxy, controller, network),
                    'preserveOriginal': True, 'rollback': 'only-if-new-identity-content-unchanged; otherwise-explicit-forward-reconciliation'}
            seal(); tree_seal(); config_seal()
        if environment != self.environment():
            raise fail('Docker/layout identity changed')
        P.metadata(P.canonical(plan), byte_limit=8 * 1024 * 1024)
        return plan

    def save(self, record):
        with L.R._control_descriptor(self.directory) as fd:
            L.R._require_private(os.fstat(fd))
            A.atomic(self.journal, P.canonical(record))

    def read(self):
        with A.protected_directory(self.directory) as directory:
            with A.protected_file(directory, 'adoption.json', 8 * 1024 * 1024) as body:
                value = P.metadata(body, byte_limit=8 * 1024 * 1024)
        if (value.get('schema') != SCHEMA or value.get('approvedPlanSha256') != digest(value.get('plan'))
                or value.get('plan', {}).get('root') != str(self.root)):
            raise fail('invalid adoption journal')
        return value

    def guard(self, record, *, target=None):
        plan = record['plan']
        if self.environment() != plan['environment']:
            raise fail('daemon or enrolled layout changed')
        rows = self.inventory()
        expected = set(plan['peers']) | {plan['proxy']['Id']} | ({target['Id']} if target else set())
        if {r['Id'] for r in rows} != expected:
            raise fail('container generation changed')
        for raw in rows:
            if raw['Id'] in plan['peers'] and self.fingerprint(raw) != plan['peers'][raw['Id']]:
                raise fail('another container changed; no peer was restarted')
        require_aliases(self.root, rows, plan['proxy']['Id'], target['Id'] if target else None, plan['reviewedConfigWriters'])
        if record.get('executionTree'):
            with sealed_execution(self.root, record):
                pass
        else:
            with sealed_static(self.root) as (observed, _, _):
                if observed != plan['static']:
                    raise fail('approved source static bytes or metadata changed')
        source = self.runtime.inspect(plan['proxy']['Id'])
        if (self.runtime.definition(source) != self.runtime.definition(plan['proxy'])
                or source['Image'] != plan['proxy']['Image'] or source['Name'] not in {'/' + NAME, '/' + record['retainedName']}
                or source['HostConfig'].get('RestartPolicy') not in [plan['proxy']['HostConfig']['RestartPolicy'], {'Name': 'no', 'MaximumRetryCount': 0}]):
            raise fail('original proxy changed')
        if record.get('copiedIdentity') and not source['State'].get('Running'):
            with sealed_tree(self.root / 'traefik/shared') as (tree, _, _):
                if tree != identity_baseline(record):
                    raise fail('retained original identity changed after quiescent copy; preserve both stores and reconcile explicitly')
        if target:
            body = copy.deepcopy(plan['body'])
            if (record.get('rollbackPhase') or record.get('intent') == 'disable-target-restart') and target['HostConfig']['RestartPolicy']['Name'] == 'no':
                body['HostConfig']['RestartPolicy'] = {'Name': 'no', 'MaximumRetryCount': 0}
            self.runtime.check_intent(target, body)
            self.check_networks(target, plan)
        return source

    def check_networks(self, target, plan):
        for name, endpoint in plan['proxy']['NetworkSettings']['Networks'].items():
            actual = target['NetworkSettings']['Networks'].get(name, {})
            if actual.get('NetworkID') != endpoint['NetworkID']:
                state = target.get('State', {})
                if (actual.get('NetworkID') not in {'', None} or state.get('Running') is not False
                        or state.get('Status') != 'created' or state.get('Paused') or state.get('Restarting')
                        or state.get('StartedAt') != '0001-01-01T00:00:00Z'):
                    raise fail('proxy network generation changed')
                network = P.metadata(self.runtime.engine('GET', '/networks/' + quote(name, safe='')))
                if network.get('Id') != endpoint['NetworkID']:
                    raise fail('intended proxy network generation changed before first start')
            intended = plan['body']['NetworkingConfig']['EndpointsConfig'][name]
            expected = set(intended.get('Aliases') or [])
            aliases = set(actual.get('Aliases') or []) - {target['Id'], target['Id'][:12]}
            if aliases != expected:
                raise fail('proxy network aliases changed')

    def approve(self, plan, approved):
        if approved != digest(plan) or plan != self.review(plan.get('reviewedConfigWriters', [])):
            raise fail('exact fresh operator plan approval is required')
        # The journal is fsynced before the first Docker or identity mutation.
        with L.R._control_descriptor(L.namespace(self.root)) as base:
            os.mkdir(self.directory.name, 0o700, dir_fd=base); os.fsync(base)
        record = {'schema': SCHEMA, 'plan': plan, 'approvedPlanSha256': approved, 'phase': 'approved',
                  'retainedName': 'orbis-proxy-original-' + approved[:24], 'targetId': None, 'intent': None}
        self.save(record)
        return record

    def mutation(self, record, intent, operation, target=None):
        self.guard(record, target=target)
        record['intent'] = intent
        self.save(record)
        self.guard(record, target=target)
        execution = sealed_execution(self.root, record) if record.get('executionTree') else sealed_static(self.root)
        with L.R._control_descriptor(L.namespace(self.root)), execution as (_, _, seal):
            operation()
            seal()

    def copy_execution(self, record):
        self.guard(record)
        with sealed_tree(self.root / 'traefik', exclude=('shared',)) as (tree, bodies, seal):
            if tree != record['plan']['configuration']:
                raise fail('approved source configuration changed before private copy')
            self.copy_tree(record, execution_path(self.root), tree, bodies, seal, 'execution')
        with sealed_tree(execution_path(self.root), private=True) as (tree, _, _):
            if content_fingerprint(tree) != record['plan']['configurationSha256']:
                raise fail('private execution copy differs')
            record['executionTree'] = tree
        record.pop('executionCopyEntry', None)
        record['intent'] = None; self.save(record)

    def copy_tree(self, record, target_path, tree, bodies, seal, purpose):
        """Resume exact intended copies; retain interrupted bytes outside execution."""
        intent = 'copy-' + purpose
        entry_key = purpose + 'CopyEntry'
        exists = target_path.exists() or target_path.is_symlink()
        if exists and record.get('intent') != intent:
            raise fail('unowned private copy exists')
        self.mutation(record, intent, lambda: None)
        if not exists:
            with L.R._control_descriptor(target_path.parent) as parent:
                os.mkdir(target_path.name, 0o700, dir_fd=parent); os.fsync(parent)
        with sealed_tree(target_path, private=True) as (partial, _, _):
            pass
        for name, entry in list(partial['entries'].items()):
            expected = tree['entries'].get(name)
            if expected is None:
                raise fail('interrupted copy contains unexpected data')
            if entry.get('sha256') != expected.get('sha256'):
                if name != record.get(entry_key) or 'sha256' not in entry or 'sha256' not in expected:
                    raise fail('interrupted copy contains unexpected data')
                retained = 'copy-partial-' + purpose + '-' + hashlib.sha256(name.encode()).hexdigest()[:24] + '-' + entry['sha256']
                record['partialCopyIntent'] = {'entry': name, 'retained': retained, 'metadata': entry['metadata']}
                self.save(record); self.guard(record); seal()
                source_path = target_path / name
                with L.R._control_descriptor(source_path.parent) as parent, L.R._control_descriptor(self.directory) as target:
                    if metadata(os.stat(source_path.name, dir_fd=parent, follow_symlinks=False)) != entry['metadata']:
                        raise fail('interrupted copy entry changed')
                    try:
                        os.stat(retained, dir_fd=target, follow_symlinks=False)
                    except FileNotFoundError:
                        pass
                    else:
                        raise fail('interrupted copy evidence already exists; reconcile explicitly')
                    os.rename(source_path.name, retained, src_dir_fd=parent, dst_dir_fd=target)
                    os.fsync(parent); os.fsync(target)
                record.setdefault('partialCopies', []).append(record.pop('partialCopyIntent'))
                self.save(record)
                partial['entries'].pop(name)
        with L.R._control_descriptor(target_path) as base:
            for name, entry in sorted(tree['entries'].items(), key=lambda item: (item[0].count('/'), item[0])):
                if not name or name in partial['entries']:
                    continue
                path = target_path / name
                self.guard(record); seal()
                record[entry_key] = name; self.save(record)
                self.guard(record); seal()
                with L.R._control_descriptor(path.parent) as parent:
                    if 'sha256' not in entry:
                        os.mkdir(path.name, 0o700, dir_fd=parent)
                    else:
                        fd = os.open(path.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
                        with os.fdopen(fd, 'wb') as output:
                            output.write(bodies[name]); output.flush(); os.fsync(output.fileno())
                    os.fsync(parent)
            os.fsync(base)
        seal()

    def copy_identity(self, record):
        source = self.guard(record)
        require_quiescent(source)
        with sealed_tree(self.root / 'traefik/shared') as (tree, bodies, seal):
            if tree != identity_baseline(record):
                raise fail('source identity changed at quiescence; request reconcile-plan and explicitly approve forward')
            self.copy_tree(record, self.identity, tree, bodies, seal, 'identity')
        with sealed_tree(self.identity, private=True) as (copied, _, _):
            if content_fingerprint(copied) != content_fingerprint(identity_baseline(record)):
                raise fail('identity copy differs')
            record['copiedIdentity'] = copied
        record.pop('identityCopyEntry', None)
        record['phase'] = 'copied'; record['intent'] = None; self.save(record)

    def lookup_target(self, record):
        candidates = [raw for raw in self.inventory() if (raw['Name'] == '/' + NAME or raw['Id'] == record.get('targetId')) and raw['Id'] != record['plan']['proxy']['Id']]
        if not candidates:
            if record.get('targetId'):
                raise fail('created target disappeared')
            return None
        target = candidates[0]
        if record.get('targetId') not in {None, target['Id']} or record.get('intent') != 'create-target' and record.get('targetId') is None:
            raise fail('unowned target appeared')
        body = copy.deepcopy(record['plan']['body'])
        if (record.get('rollbackPhase') or record.get('intent') == 'disable-target-restart') and target['HostConfig']['RestartPolicy']['Name'] == 'no':
            body['HostConfig']['RestartPolicy'] = {'Name': 'no', 'MaximumRetryCount': 0}
        self.runtime.check_intent(target, body); self.check_networks(target, record['plan'])
        if record.get('targetId') is None and (target['State'].get('Running') or target['State'].get('Status') != 'created'):
            raise fail('unacknowledged target was started externally')
        return target

    def resume(self, record):
        if record.get('rollbackPhase'):
            raise fail('rollback has begun; resume the explicit rollback action')
        if record['phase'] == 'rolled-back':
            raise fail('rolled-back adoption requires a new review')
        target = self.lookup_target(record)
        source = self.guard(record, target=target)
        if not record.get('executionTree'):
            self.copy_execution(record)
        if record['phase'] == 'approved':
            if source['HostConfig']['RestartPolicy']['Name'] != 'no':
                self.mutation(record, 'disable-original-restart', lambda: self.runtime.change(['update', '--restart=no', source['Id']]))
            source = self.guard(record)
            if source['State'].get('Running'):
                self.mutation(record, 'stop-original', lambda: self.runtime.change(['stop', '--time', '30', source['Id']]))
            source = self.guard(record)
            require_quiescent(source)
            record['phase'] = 'stopped'; record['intent'] = None; self.save(record)
        if record['phase'] == 'stopped':
            self.copy_identity(record)
        source = self.guard(record, target=target)
        if source['State'].get('Running'):
            raise fail('original restarted during cutover')
        if source['Name'] != '/' + record['retainedName']:
            self.mutation(record, 'rename-original', lambda: self.runtime.change(['rename', source['Id'], record['retainedName']]), target)
        if target is None:
            self.mutation(record, 'create-target', lambda: self.runtime.engine('POST', '/containers/create?name=' + NAME, record['plan']['body']))
            target = self.lookup_target(record)
            if target is None:
                raise fail('target creation could not be confirmed')
            record['targetId'] = target['Id']; record['phase'] = 'created'; record['intent'] = None; self.save(record)
        elif record.get('targetId') is None:
            record['targetId'] = target['Id']; record['phase'] = 'created'; record['intent'] = None; self.save(record)
        if not target['State'].get('Running'):
            if record['phase'] in {'started', 'verified'}:
                raise fail('previously started target stopped; explicit reconciliation is required')
            with sealed_tree(self.identity, private=True) as (tree, _, _):
                if tree != record['copiedIdentity']:
                    raise fail('identity changed before first target start')
            self.mutation(record, 'start-target', lambda: self.runtime.change(['start', target['Id']]), target)
        record['phase'] = 'started'; record['intent'] = None; self.save(record)
        return self.verify(record)

    def verify(self, record):
        target = self.lookup_target(record)
        if target is None:
            raise fail('target is missing')
        source = self.guard(record, target=target)
        if source['State'].get('Running') or source['HostConfig']['RestartPolicy']['Name'] != 'no':
            raise fail('retained original is not quiescent')
        if (not target['State'].get('Running') or target['State'].get('Paused') or target['State'].get('Restarting')
                or target['Name'] != '/' + NAME):
            raise fail('target is not running')
        with sealed_execution(self.root, record) as (observed, _, seal):
            if observed['metadata']['ctime_ns'] > started_ns(target['State']['StartedAt']):
                raise fail('static configuration was modified after proxy start')
            if self.runtime.observed_proxy_static_digest(target) != observed['sha256']:
                raise fail('container static bytes differ from approved immutable authority')
            self.routes(target, self.runtime.inspect(record['plan']['controllerId']), record['plan']['network'], record['plan']['routes'])
            seal()
        with sealed_tree(self.identity, private=True) as (tree, _, _):
            ownership = {key: tree['entries']['']['metadata'][key] for key in ('dev', 'ino', 'uid', 'gid', 'mode')}
        receipt = {'schema': SCHEMA, 'approvedPlanSha256': record['approvedPlanSha256'],
                   'environment': record['plan']['environment'], 'root': str(self.root),
                   'static': observed, 'configurationSha256': record['plan']['configurationSha256'], 'ownership': ownership,
                   'proxyId': target['Id'], 'imageId': target['Image'], 'targetBodySha256': digest(record['plan']['body']),
                   'reviewedConfigWriters': record['plan']['reviewedConfigWriters']}
        self.guard(record, target=target)
        receipt_path = self.directory / 'identity.json'
        if receipt_path.exists() or receipt_path.is_symlink():
            with A.protected_directory(self.directory) as directory:
                with A.protected_file(directory, 'identity.json', 65536) as body:
                    if body != P.canonical(receipt):
                        raise fail('immutable proxy identity receipt differs')
        else:
            with L.R._control_descriptor(self.directory) as directory:
                fd = os.open('identity.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
                with os.fdopen(fd, 'wb') as output:
                    output.write(P.canonical(receipt)); output.flush(); os.fsync(output.fileno())
                os.fsync(directory)
        record['phase'] = 'verified'; record['intent'] = None; self.save(record)
        return receipt

    def reconciliation_plan(self, record):
        target = self.lookup_target(record)
        if target is None:
            source = self.guard(record)
            require_quiescent(source)
            if record['phase'] != 'stopped' or self.identity.exists():
                raise fail('quiescent source reconciliation requires an uncopied stopped source')
            with sealed_tree(self.root / 'traefik/shared') as (tree, _, _):
                return {'schema': 'orbis.proxy-adoption-quiescent-plan.v1',
                        'approvedPlanSha256': record['approvedPlanSha256'], 'environment': self.environment(),
                        'sourceId': source['Id'], 'source': self.fingerprint(source),
                        'identity': tree, 'identitySha256': content_fingerprint(tree)}
        source = self.guard(record, target=target)
        if source['State'].get('Running') or source['HostConfig']['RestartPolicy']['Name'] != 'no':
            raise fail('forward reconciliation requires a quiescent original')
        with sealed_tree(self.identity, private=True) as (tree, _, _):
            return {'schema': 'orbis.proxy-adoption-forward-plan.v1', 'approvedPlanSha256': record['approvedPlanSha256'],
                    'environment': self.environment(), 'targetId': target['Id'], 'target': self.fingerprint(target),
                    'identity': tree, 'identitySha256': content_fingerprint(tree)}

    def forward(self, record, approved):
        reconciliation = self.reconciliation_plan(record)
        if approved != digest(reconciliation):
            raise fail('exact fresh forward-reconciliation approval is required')
        if reconciliation['schema'] == 'orbis.proxy-adoption-quiescent-plan.v1':
            record['quiescentReconciliation'] = reconciliation
            record['quiescentIdentity'] = reconciliation['identity']; self.save(record)
            return self.resume(record)
        target = self.lookup_target(record)
        record['reconciliation'] = reconciliation; record['rollbackPhase'] = 'forward-reviewed'; self.save(record)
        if target['Name'] != '/' + NAME:
            self.mutation(record, 'restore-target-name', lambda: self.runtime.change(['rename', target['Id'], NAME]), target)
            target = self.runtime.inspect(target['Id'])
        policy = record['plan']['body']['HostConfig']['RestartPolicy']
        if target['HostConfig']['RestartPolicy'] != policy:
            restart = policy['Name'] + (':' + str(policy['MaximumRetryCount']) if policy['Name'] == 'on-failure' else '')
            self.mutation(record, 'restore-target-policy', lambda: self.runtime.change(['update', '--restart=' + restart, target['Id']]), target)
            target = self.runtime.inspect(target['Id'])
        # All current identity bytes are preserved; this approval never copies
        # stale old shared data over a target that has already written.
        with sealed_tree(self.identity, private=True) as (tree, _, _):
            if tree != reconciliation['identity']:
                raise fail('new identity changed during forward reconciliation; review again')
            record['copiedIdentity'] = tree
        record.pop('rollbackPhase', None)
        record['phase'] = 'created'; record['intent'] = None; self.save(record)
        return self.resume(record)

    def rollback(self, record):
        if record['phase'] == 'rolled-back':
            return {'phase': 'rolled-back', 'originalPreserved': True, 'targetPreserved': bool(record.get('targetId'))}
        target = self.lookup_target(record)
        source = self.guard(record, target=target)
        if source['State'].get('Running') and (record.get('intent') == 'start-original' or record.get('rollbackPhase') == 'original-started'):
            if (source['Name'] != '/' + NAME or source['HostConfig']['RestartPolicy'] != record['plan']['proxy']['HostConfig']['RestartPolicy']
                    or target and (target['State'].get('Running') or target['HostConfig']['RestartPolicy']['Name'] != 'no')):
                raise fail('rollback terminal generation differs')
            # A lost start reply must never replay old identity over writes made
            # by the restarted original. Finish only its terminal receipt.
            self.routes(source, self.runtime.inspect(record['plan']['controllerId']), record['plan']['network'], record['plan']['routes'])
            record['phase'] = 'rolled-back'; record['intent'] = None; self.save(record)
            return {'phase': 'rolled-back', 'originalPreserved': True, 'targetPreserved': bool(target)}
        if target and not record.get('targetId'):
            record['targetId'] = target['Id']; self.save(record)
        def unchanged():
            with sealed_tree(self.root / 'traefik', exclude=('shared',)) as (configuration, _, _):
                if configuration != record['plan']['configuration']:
                    raise fail('original configuration changed; preserve immutable target and reconcile forward')
            with sealed_tree(self.root / 'traefik/shared') as (tree, _, _):
                if tree != identity_baseline(record):
                    raise fail('original identity changed; forward reconciliation required')
            if target:
                with sealed_tree(self.identity, private=True) as (tree, _, _):
                    if content_fingerprint(tree) != content_fingerprint(identity_baseline(record)):
                        raise fail('new identity diverged; NEVER restart the stale original; explicitly reconcile and forward-complete')
        def change(intent, arguments, phase):
            nonlocal source, target
            unchanged()
            self.mutation(record, intent, lambda: self.runtime.change(arguments), target)
            record['rollbackPhase'] = phase; record['intent'] = None; self.save(record)
            source = self.runtime.inspect(record['plan']['proxy']['Id'])
            if target:
                target = self.runtime.inspect(target['Id'])
        unchanged()
        record.setdefault('rollbackPhase', 'reviewed'); self.save(record)
        if target:
            if target['HostConfig']['RestartPolicy']['Name'] != 'no':
                change('disable-target-restart', ['update', '--restart=no', target['Id']], 'target-disabled')
            if target['State'].get('Running'):
                change('stop-target-for-rollback', ['stop', '--time', '30', target['Id']], 'target-stopped')
            # A write during stop is a hard hold, including ACME renewal. No
            # automatic restart of either stale store is permitted after this.
            require_quiescent(target)
            unchanged()
            rejected = 'orbis-proxy-rejected-' + record['approvedPlanSha256'][:24]
            if target['Name'] != '/' + rejected:
                change('retain-target', ['rename', target['Id'], rejected], 'target-retained')
        unchanged()
        if source['Name'] != '/' + NAME:
            change('restore-original-name', ['rename', source['Id'], NAME], 'original-renamed')
        policy = record['plan']['proxy']['HostConfig']['RestartPolicy']
        restart = policy['Name'] + (':' + str(policy['MaximumRetryCount']) if policy['Name'] == 'on-failure' else '')
        if source['HostConfig']['RestartPolicy'] != policy:
            change('restore-original-policy', ['update', '--restart=' + restart, source['Id']], 'original-policy')
        if not source['State'].get('Running'):
            change('start-original', ['start', source['Id']], 'original-started')
        source = self.guard(record, target=target)
        self.routes(source, self.runtime.inspect(record['plan']['controllerId']), record['plan']['network'], record['plan']['routes'])
        record['phase'] = 'rolled-back'; record['intent'] = None; self.save(record)
        return {'phase': 'rolled-back', 'originalPreserved': True, 'targetPreserved': bool(target)}


def verified_authority(root, context, proxy, runtime=None):
    adoption = Adoption(root, context, runtime)
    record = adoption.read()
    if (proxy.get('Name') != '/' + NAME or not proxy.get('State', {}).get('Running') or proxy['State'].get('Paused') or proxy['State'].get('Restarting')
            or record['phase'] != 'verified'):
        raise fail('proxy adoption is not verified')
    with A.protected_directory(adoption.directory) as directory:
        with A.protected_file(directory, 'identity.json', 65536) as body:
            receipt = P.metadata(body)
    if (receipt.get('schema') != SCHEMA or receipt.get('approvedPlanSha256') != record['approvedPlanSha256']
            or receipt.get('environment') != adoption.environment() or receipt.get('proxyId') != proxy['Id']
            or receipt.get('imageId') != proxy['Image'] or receipt.get('configurationSha256') != record['plan']['configurationSha256']
            or receipt.get('targetBodySha256') != digest(record['plan']['body'])):
        raise fail('proxy identity authority differs')
    adoption.runtime.check_intent(proxy, record['plan']['body'])
    adoption.check_networks(proxy, record['plan'])
    source = adoption.runtime.inspect(record['plan']['proxy']['Id'])
    if source['State'].get('Running') or source['HostConfig'].get('RestartPolicy', {}).get('Name') != 'no':
        raise fail('retained original is not quiescent')
    require_aliases(Path(root), adoption.inventory(), source['Id'], proxy['Id'], receipt['reviewedConfigWriters'])
    with sealed_execution(Path(root), record) as (observed, _, _):
        if observed != receipt['static'] or observed['metadata']['ctime_ns'] > started_ns(proxy['State']['StartedAt']):
            raise fail('static bytes changed after reviewed proxy start')
        if adoption.runtime.observed_proxy_static_digest(proxy) != observed['sha256']:
            raise fail('loaded static bytes differ from immutable authority')
    with sealed_tree(adoption.identity, private=True) as (tree, _, _):
        ownership = {key: tree['entries']['']['metadata'][key] for key in ('dev', 'ino', 'uid', 'gid', 'mode')}
        if ownership != receipt.get('ownership'):
            raise fail('proxy identity directory changed')
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['review', 'plan', 'apply', 'verify', 'resume', 'rollback', 'reconcile-plan', 'forward'])
    parser.add_argument('root', type=Path)
    parser.add_argument('--docker-context', required=True)
    parser.add_argument('--approved-plan-sha256')
    parser.add_argument('--approved-reconciliation-sha256')
    parser.add_argument('--reviewed-config-writer', action='append', default=[])
    args = parser.parse_args()
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise fail('run as root on the selected Linux Docker host')
    if str(args.root) != os.path.realpath(args.root):
        raise fail('installation root must be canonical')
    with HOST.host_lock(args.root):
        adoption = Adoption(args.root, args.docker_context)
        if args.action in {'review', 'plan'}:
            plan = adoption.review(args.reviewed_config_writer)
            # Full Engine intent remains private; only fingerprints go to stdout.
            result = {'schema': PLAN_SCHEMA, 'planSha256': digest(plan), 'staticSha256': plan['static']['sha256'],
                      'identitySha256': plan['identitySha256'], 'proxyId': plan['proxy']['Id'],
                      'environment': plan['environment'], 'reviewedConfigWriters': plan['reviewedConfigWriters'],
                      'preserveOriginal': True, 'automaticRollbackAfterIdentityDivergence': False}
        elif args.action == 'apply':
            plan = adoption.review(args.reviewed_config_writer)
            result = adoption.resume(adoption.approve(plan, args.approved_plan_sha256))
        else:
            record = adoption.read()
            if args.approved_plan_sha256 != record['approvedPlanSha256']:
                raise fail('exact operator plan approval is required')
            if args.action == 'reconcile-plan':
                reconciliation = adoption.reconciliation_plan(record)
                result = {'schema': reconciliation['schema'], 'reconciliationSha256': digest(reconciliation),
                          'identitySha256': reconciliation['identitySha256'],
                          **{key: reconciliation[key] for key in ('targetId', 'sourceId') if key in reconciliation}}
            elif args.action == 'forward':
                result = adoption.forward(record, args.approved_reconciliation_sha256)
            else:
                result = getattr(adoption, args.action)(record)
        print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError, KeyError, TypeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)
