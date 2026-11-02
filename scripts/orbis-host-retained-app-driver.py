#!/usr/bin/env python3
"""Root transaction adapter for protected historical app Engine effects."""
import copy
import hashlib
import importlib.util
import ipaddress
import json
from pathlib import Path
import re
import time
from types import SimpleNamespace
from urllib.parse import quote
import uuid


def load(filename, name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


EFFECTS = load('orbis-host-retained-app-effects.py', 'root_app_effects')
COMPILER = EFFECTS.COMPILER
PORTS = load('orbis-host-app-port-policy.py', 'root_app_ports')


def fail():
    return ValueError('Historical app activation requires protected root recovery')


def sha(body):
    return hashlib.sha256(body).hexdigest()


class Engine:
    def __init__(self, driver):
        self.driver, self.runtime = driver, driver.runtime

    def inspect(self, identifier):
        if not isinstance(identifier, str) or re.fullmatch(r'[a-f0-9]{64}', identifier) is None: raise fail()
        body = self.runtime.engine('GET', '/containers/' + identifier + '/json', allow_missing=True)
        return None if body is None else self.runtime.manager.CAPTURE.APP.parse(body)

    def find_name(self, name):
        if not isinstance(name, str) or re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,254}', name) is None: raise fail()
        body = self.runtime.engine('GET', '/containers/' + quote(name, safe='') + '/json', allow_missing=True)
        raw = None if body is None else self.runtime.manager.CAPTURE.APP.parse(body)
        if raw is not None and raw.get('Name') != '/' + name: raise fail()
        return raw

    def create(self, name, body):
        self.driver.verify_inventory()
        self.driver.verify_network_definitions()
        result = self.runtime.P.metadata(self.runtime.engine('POST', '/containers/create?name=' + quote(name, safe=''), body))
        if (set(result) - {'Id', 'Warnings'} or not isinstance(result.get('Id'), str)
                or re.fullmatch(r'[a-f0-9]{64}', result['Id']) is None or result.get('Warnings') not in (None, [])): raise fail()
        return result['Id']

    def start(self, identifier):
        self.driver.verify_inventory()
        self.driver.verify_network_definitions()
        self.driver.verify_ports(self.driver.plan['plans'], self.driver.plan['destinations'], include_created=True)
        self.runtime.engine('POST', '/containers/' + identifier + '/start')

    def remove(self, identifier):
        self.driver.verify_inventory()
        self.runtime.engine('DELETE', '/containers/' + identifier + '?force=0&v=0&link=0')


class HistoricalAppDriver:
    def __init__(self, runtime, record):
        self.runtime, self.manager, self.record = runtime, runtime.manager, record
        self.capture, self.app = self.manager.CAPTURE, self.manager.CAPTURE.APP
        self.path = self.manager.directory(record['id'])
        self.effects = None
        self.plan = self.load_plan()

    def original(self):
        origin = self.manager.origin(self.record)
        authority = self.runtime.P.metadata(origin.authority_bytes)
        prepared = self.capture.load_preparation(self.manager.state, self.record['pointId'])
        receipt = self.capture.load_app_preparation(self.manager.state, self.record['pointId'], prepared)
        body = self.capture.read(self.capture.directory(self.manager.state, self.record['pointId']), 'app-runtime.json', self.app.MAX_BYTES)
        if (authority.get('schema') != 'orbis.controller-capture-authority.v4' or authority.get('appRuntimeSha256') != sha(body)
                or receipt['appRuntimeSha256'] != sha(body) or self.record['stage']['metadata'].get('appRuntimeSha256') != sha(body)
                or sha(origin.authority_bytes) != self.record['originSha256']): raise fail()
        descriptor = self.app.validate(self.app.parse(body), self.capture.app_expectations(prepared, authority['appRuntimeDaemonSha256']))
        bindings_body = self.capture.read(self.capture.directory(self.manager.state, self.record['pointId']), 'app-host-bindings.json', self.app.MAX_BYTES)
        if sha(bindings_body) != receipt['hostBindingsSha256']: raise fail()
        return descriptor, self.app.parse(bindings_body)

    def destination(self):
        body = self.runtime.read_file(self.path / 'destination-app-runtime.json', self.app.MAX_BYTES)
        bindings_body = self.runtime.read_file(self.path / 'destination-app-bindings.json', self.app.MAX_BYTES)
        if sha(body) != self.record['destinationAppRuntimeSha256'] or sha(bindings_body) != self.record['destinationAppBindingsSha256']: raise fail()
        descriptor, bindings = self.app.parse(body), self.app.parse(bindings_body)
        expected = {key: descriptor[key] for key in ('pointId', 'rootSha256', 'dockerContextSha256', 'daemonSha256',
                                                    'configurationSetSha256', 'preparationSha256')}
        self.app.validate(descriptor, expected)
        if (descriptor['pointId'] != self.record['pointId'] or descriptor['rootSha256'] != sha(str(self.runtime.root).encode())
                or descriptor['dockerContextSha256'] != sha(self.runtime.context.encode())
                or descriptor['daemonSha256'] != sha(self.record['source']['daemonId'].encode())
                or self.runtime.destination_app_digest(descriptor, bindings) != self.record['stage']['destinationAppRuntimeSha256']): raise fail()
        return descriptor

    def managed_roots(self):
        roots = {}
        for name in self.record['stage']['journal']['roots']:
            destination = '/app-data' if name == 'app-data' else '/data/' + name
            roots[name] = str(self.runtime.map_path(self.record['source']['container'], destination))
        values = list(roots.values())
        if any(a == b or a.startswith(b + '/') or b.startswith(a + '/') for index, a in enumerate(values) for b in values[index + 1:]): raise fail()
        return roots

    def load_plan(self):
        filename = self.path / 'historical-app-plan.json'
        try:
            body = self.runtime.read_file(filename, 32 * 1024 * 1024)
        except FileNotFoundError:
            if self.record['decision'] is not None: raise fail()
            return self.prepare_plan(filename)
        if sha(body) != self.record.get('appPlanSha256'): raise fail()
        plan = self.app.parse(body)
        if (plan.get('version') != 1 or plan.get('transactionId') != self.record['id'] or plan.get('pointId') != self.record['pointId']
                or plan.get('operationSha256') != self.record['preparedOperationSha256'] or plan.get('originSha256') != self.record['originSha256']
                or plan.get('managedRoots') != self.managed_roots()): raise fail()
        return plan

    def prepare_plan(self, filename):
        original, source_bindings = self.original()
        destination = self.destination()
        roots = self.managed_roots()
        networks = {}
        for item in original['networkDefinitions']:
            current = self.app.parse(self.runtime.bounded_output(['docker', '--context', self.runtime.context, 'network', 'inspect',
                                     '--format', '{{json .}}', item['name']], self.app.MAX_BYTES, 20))
            networks[item['name']] = {'captured': item, 'current': current}
        plans, probes, transformed = [], [], copy.deepcopy(original)
        external = set()
        for container, probe in zip(original['containers'], transformed['containers'], strict=True):
            raw = container['inspect']
            host = raw['HostConfig']
            if (host.get('NetworkMode') == 'host' or host.get('Devices') or host.get('DeviceRequests')
                    or host.get('DeviceCgroupRules')): raise fail()
            sources = {mount['Source']: mount['Source'] for mount in raw['Mounts']}
            image = self.runtime.image(container['image']['creationReference'])
            selected = {name: networks[name] for name in raw['NetworkSettings']['Networks']}
            compiled = COMPILER.compile_container(container, image=image, bind_sources=sources, networks=selected)
            plan = {key: container[key] for key in ('appUrn', 'service', 'ordinal', 'wasRunning')}
            plan.update(sourceId=raw['Id'], compiled=compiled)
            plans.append(plan)
            probe_plan = copy.deepcopy(plan)
            substitutions = {}
            for source in sources:
                covering = [(name, root) for name, root in roots.items() if source == root or source.startswith(root + '/')]
                if len(covering) > 1: raise fail()
                if not covering:
                    external.add(source); substitutions[source] = source; continue
                name, root = covering[0]
                swap = self.runtime.json(Path(self.record['stage']['journalPath']) / 'roots' / name / 'swap.json')
                expected_root = '/app-data' if name == 'app-data' else '/data/' + name
                details = Path(root).stat()
                if (swap.get('id') != self.record['id'] or swap.get('root') != expected_root or swap.get('phase') != 'prepared'
                        or swap.get('device') != str(details.st_dev) or swap.get('inode') != str(details.st_ino)):
                    raise fail()
                substitutions[source] = str(Path(root) / ('.orbis-restore-' + self.record['id'] + '.incoming') / Path(source).relative_to(root))
            for mount in probe['inspect']['Mounts']: mount['Source'] = substitutions[mount['Source']]
            phost = probe_plan['compiled']['body']['HostConfig']
            for mount in phost.get('Mounts') or []: mount['Source'] = substitutions[mount['Source']]
            if phost.get('Binds') is not None:
                phost['Binds'] = [':'.join([substitutions[parts[0]], *parts[1:]]) for value in phost['Binds'] for parts in [value.split(':')]]
            probes.append(probe_plan)
        original_bindings = {item['source']: item for item in source_bindings}
        probe_bindings = self.app.observe_bindings(transformed)
        if any(item != original_bindings.get(item['source']) for item in probe_bindings if item['source'] in external): raise fail()
        plan = {'version': 1, 'transactionId': self.record['id'], 'pointId': self.record['pointId'],
                'operationSha256': self.record['preparedOperationSha256'], 'originSha256': self.record['originSha256'],
                'appRuntimeSha256': self.record['stage']['metadata']['appRuntimeSha256'], 'managedRoots': roots,
                'plans': plans, 'probePlans': probes, 'destinations': sorted([item['inspect'] for item in destination['containers']], key=lambda item: item['Id']),
                'probeBindings': probe_bindings, 'externalBindings': [original_bindings[source] for source in sorted(external)]}
        body = self.app.canonical(plan)
        if self.record.get('appPlanSha256') not in (None, sha(body)): raise fail()
        self.record['appPlanSha256'] = sha(body)
        self.manager.save(self.record)
        self.capture.immutable(filename, body)
        return plan

    def verify_network_definitions(self):
        original, _ = self.original()
        definitions = {item['name']: item for item in original['networkDefinitions']}
        current = {}
        for name in definitions:
            current[name] = self.app.parse(self.runtime.bounded_output(['docker', '--context', self.runtime.context, 'network', 'inspect',
                                       '--format', '{{json .}}', name], self.app.MAX_BYTES, 20))
        allowed = {item['Id'] for item in self.plan['destinations']} | {identifier for identifier, _ in self.created()}
        claims = {}
        for plan in self.plan['plans']:
            if not plan['wasRunning']: continue
            for name, endpoint in plan['compiled']['body']['NetworkingConfig']['EndpointsConfig'].items():
                ipam = endpoint.get('IPAMConfig') or {}
                requested = [('IPv4Address', ipam.get('IPv4Address')), ('IPv6Address', ipam.get('IPv6Address')), ('MacAddress', endpoint.get('MacAddress'))]
                for kind, value in requested:
                    if not value: continue
                    value = value.lower() if kind == 'MacAddress' else str(ipaddress.ip_address(value))
                    key = (name, kind, value)
                    if key in claims and claims[key] != plan['sourceId']: raise fail()
                    claims[key] = plan['sourceId']
                    occupants = current[name].get('Containers')
                    if not isinstance(occupants, dict): raise fail()
                    for identifier, actual in occupants.items():
                        if identifier in allowed: continue
                        if (not isinstance(identifier, str) or re.fullmatch(r'[a-f0-9]{64}', identifier) is None
                                or not isinstance(actual, dict) or not isinstance(actual.get(kind, ''), str)): raise fail()
                        assigned = actual.get(kind)
                        if not assigned: continue
                        assigned = assigned.lower() if kind == 'MacAddress' else str(ipaddress.ip_interface(assigned).ip)
                        if assigned == value: raise fail()
        for row in original['containers']:
            raw = row['inspect']
            compiled = COMPILER.compile_container(row, image=self.runtime.image(row['image']['creationReference']),
                bind_sources={item['Source']: item['Source'] for item in raw['Mounts']},
                networks={name: {'captured': definitions[name], 'current': current[name]} for name in raw['NetworkSettings']['Networks']})
            pinned = next((plan['compiled'] for plan in self.plan['plans'] if plan['sourceId'] == raw['Id']), None)
            if compiled != pinned: raise fail()

    def verify_destination(self, expected, actual):
        if actual.get('State', {}).get('Running') or actual.get('State', {}).get('Restarting') or actual.get('State', {}).get('Paused'): raise fail()
        if (actual.get('Id') != expected['Id'] or self.runtime.node_fingerprint(actual) != self.runtime.node_fingerprint(expected)
                or actual['HostConfig'].get('RestartPolicy') not in (expected['HostConfig'].get('RestartPolicy'), {'Name': 'no', 'MaximumRetryCount': 0})): raise fail()
        for name, endpoint in expected['NetworkSettings']['Networks'].items():
            current = actual['NetworkSettings']['Networks'].get(name)
            if not isinstance(current, dict) or current.get('NetworkID') not in ('', None, endpoint.get('NetworkID')): raise fail()
        return True

    def containers(self):
        body = self.runtime.bounded_output(['docker', '--context', self.runtime.context, 'container', 'ls', '--all', '--no-trunc', '--format', '{{.ID}}'], 512 * 1024, 20)
        ids = body.decode('ascii', 'strict').splitlines()
        if len(ids) > 4096 or len(ids) != len(set(ids)) or any(re.fullmatch(r'[a-f0-9]{64}', item) is None for item in ids): raise fail()
        return [self.runtime.inspect(identifier) for identifier in sorted(ids)]

    def created(self):
        if self.effects is None or self.effects.progress is None: return []
        result = []
        for kind in ('probes', 'desired'):
            for index, row in enumerate(self.effects.progress[kind]):
                if row['id'] is not None and not row['removed']:
                    result.append((row['id'], self.effects._compiled(index, kind == 'probes')))
        return result

    def verify_inventory(self):
        snapshots = self.containers()
        owned = {raw['Id'] for raw in self.plan['destinations']}
        compiled = dict(self.created())
        known = owned | set(compiled) | {self.record['source']['controllerId']}
        known.update(self.record.get(name) for name in ('workerId', 'candidateId', 'verifierId', 'responderId'))
        for raw in snapshots:
            if raw['Id'] in compiled:
                expected = compiled[raw['Id']]
                COMPILER.verify_created(raw, expected, self.runtime.check_intent)
                if raw['State']['Running']:
                    for name, endpoint in expected['body']['NetworkingConfig']['EndpointsConfig'].items():
                        actual = raw['NetworkSettings']['Networks'][name]
                        for requested, observed in (('IPv4Address', 'IPAddress'), ('IPv6Address', 'GlobalIPv6Address')):
                            value = (endpoint.get('IPAMConfig') or {}).get(requested)
                            if value and ipaddress.ip_address(actual.get(observed, '')) != ipaddress.ip_address(value): raise fail()
            if raw['Id'] in known: continue
            labels = raw.get('Config', {}).get('Labels') or {}
            if labels.get('runtipi.appurn') is not None or str(labels.get('runtipi.managed')).lower() == 'true' and labels.get('com.docker.compose.project') != 'runtipi': raise fail()
            for mount in raw.get('Mounts') or []:
                source = mount.get('Source', '')
                if (mount.get('RW') is True and mount.get('Type') == 'bind'
                        and any(source == root or source.startswith(root + '/') or root.startswith(source + '/') for root in self.plan['managedRoots'].values())): raise fail()
        return snapshots

    def verify_ports(self, plans, destinations, *, include_created=False):
        snapshots = self.verify_inventory()
        known = {item['Id'] for item in snapshots}
        retiring = {item['Id'] for item in destinations} & known
        if include_created: retiring.update(identifier for identifier, _ in self.created() if identifier in known)
        observer_module = load('orbis-host-app-port-observer.py', 'root_app_port_observer')
        deadline = int(time.time()) + 25
        observer = observer_module.ProcPortObserver(deadline=deadline)
        envelope = observer.observe([raw for raw in snapshots if raw['Id'] in retiring])
        sockets = envelope['observation']
        if any(plan['wasRunning'] and plan['compiled']['body']['HostConfig'].get('PortBindings') for plan in plans):
            diag_module = load('orbis-host-app-inet-diag.py', 'root_app_inet_diag')
            diag = diag_module.InetDiagTcpObserver(deadline=deadline).observe()
            sockets = observer_module.combine_port_observations(envelope, diag)
        result = PORTS.verify_port_claims(plans, snapshots, sorted(retiring), sockets,
                                          prove_host_socket_owner=observer.prove_host_socket_owner)
        observer._check()
        return result

    def authorize(self, scope, action):
        current = self.manager.read(self.record['id'])
        if (sha(self.manager.origin(current).authority_bytes) != self.plan['originSha256']
                or current.get('appPlanSha256') != self.record.get('appPlanSha256')
                or current.get('preparedOperationSha256') != self.plan['operationSha256']
                or current.get('root') != str(self.runtime.root) or current.get('context') != self.runtime.context): raise fail()
        base = self.effects.scope if self.effects is not None else self.expected_scope
        recovery = scope.pop('recoveryLease', None)
        if scope != base: raise fail()
        lease = current.get('appEffectsLease')
        if not isinstance(lease, dict): raise fail()
        if action == 'recover-lease':
            if recovery != {'grantId': lease['id'], 'predecessorDeadline': lease.get('predecessorDeadline')}: raise fail()
        elif recovery is not None: raise fail()
        if sha(self.runtime.read_file(self.path / 'node-runtime.json', 1024 * 1024)) != self.plan['operationSha256']: raise fail()
        if action == 'before-create':
            rows = self.plan['probeBindings'] if current['decision'] is None else self.plan['externalBindings']
            transformed = {'containers': [{'inspect': {'Mounts': [{'Type': 'bind', 'Source': item['source']} for item in rows]}}]}
            if self.app.observe_bindings(transformed) != rows: raise fail()
            if current['decision'] == 'commit':
                sources = sorted({mount['Source'] for plan in self.plan['plans'] for mount in plan['compiled']['body']['HostConfig'].get('Mounts') or []}
                                 | {bind.split(':')[0] for plan in self.plan['plans'] for bind in plan['compiled']['body']['HostConfig'].get('Binds') or []})
                self.app.observe_bindings({'containers': [{'inspect': {'Mounts': [{'Type': 'bind', 'Source': source} for source in sources]}}]})
        return {'decision': 'NONE' if current['decision'] is None else current['decision'].upper(), 'deadline': lease['deadline']}

    def open_effects(self, *, recovery=False):
        directory = self.path / 'historical-app-effects'
        directory.mkdir(mode=0o700, exist_ok=True)
        with self.runtime.a.protected_directory(directory): pass
        lease = self.record.get('appEffectsLease')
        if lease is None:
            if self.record['decision'] is not None: raise fail()
            lease = {'id': str(uuid.uuid4()), 'deadline': int(time.time()) + 900}
            self.record['appEffectsLease'] = lease
            self.manager.save(self.record)
        predecessor = lease.get('predecessorDeadline') if recovery else None
        if recovery and lease['deadline'] <= time.time():
            predecessor = lease['deadline']
            lease = {'id': str(uuid.uuid4()), 'deadline': int(time.time()) + 900, 'predecessorDeadline': predecessor}
            self.record['appEffectsLease'] = lease
            self.manager.save(self.record)
        self.effects = EFFECTS.RetainedAppEffects(directory, restore_id=self.record['id'], point_id=self.record['pointId'],
            operation_sha256=self.plan['operationSha256'], authority_sha256=self.plan['originSha256'],
            plans=self.plan['plans'], destinations=self.plan['destinations'], probe_plans=self.plan['probePlans'], engine=Engine(self),
            comparator=self.runtime.check_intent, verify_destination=self.verify_destination, verify_ports=self.verify_ports,
            authorize=self.authorize, storage=SimpleNamespace(protected_directory=self.runtime.a.protected_directory,
                protected_file=self.runtime.a.protected_file, atomic=self.runtime.a.atomic, immutable=self.capture.immutable, owner=self.runtime.a.OWNER))
        self.expected_scope = self.effects.scope
        if predecessor is not None: self.effects.recover_lease(lease['id'], predecessor_deadline=predecessor)
        return self.effects

    def probe(self):
        return self.open_effects().probe()

    def precommit(self):
        self.verify_network_definitions()
        return self.open_effects().preflight()

    def rollback(self):
        if not (self.path / 'historical-app-effects' / 'progress.json').exists(): return
        return self.open_effects(recovery=True).cleanup_probes()

    def healthy(self):
        lease = self.record['appEffectsLease']
        while time.time() < lease['deadline']:
            ready = True
            self.effects.verify()
            for index, plan in enumerate(self.plan['plans']):
                row = self.effects.progress['desired'][index]
                raw = Engine(self).inspect(row['id'])
                if plan['wasRunning']:
                    healthcheck = raw['Config'].get('Healthcheck') or {}
                    if healthcheck.get('Test') and healthcheck['Test'] != ['NONE']:
                        if (raw.get('State', {}).get('Health') or {}).get('Status') != 'healthy': ready = False
            if ready: return
            time.sleep(min(0.2, max(0, lease['deadline'] - time.time())))
        raise fail()

    def result(self):
        self.effects.verify()
        self.verify_inventory()
        containers = []
        for index, plan in enumerate(self.plan['plans']):
            row = self.effects.progress['desired'][index]
            containers.append({key: plan[key] for key in ('appUrn', 'service', 'ordinal', 'wasRunning')})
            containers[-1].update(id=row['id'], imageId=plan['compiled']['body']['Image'])
        result = {'version': 1, 'transactionId': self.record['id'], 'pointId': self.record['pointId'],
                  'operationSha256': self.plan['operationSha256'], 'appRuntimeSha256': self.plan['appRuntimeSha256'],
                  'scopeSha256': self.effects.scope_hash, 'containers': containers}
        body = self.app.canonical(result)
        if self.record.get('appEffectsSha256') not in (None, sha(body)): raise fail()
        self.capture.immutable(self.path / 'historical-app-result.json', body)
        self.record['appEffectsSha256'] = sha(body)
        self.manager.save(self.record)
        return {**result, 'appEffectsSha256': sha(body)}

    def activate(self, *, recovery=False):
        self.open_effects(recovery=recovery).activate()
        self.healthy()
        self.runtime.restore_app_statuses(self.record)
        return self.result()

    def verify(self):
        self.open_effects().verify()
        self.healthy()
        result = self.result()
        if result['appEffectsSha256'] != self.record.get('appEffectsSha256'): raise fail()
        return result
