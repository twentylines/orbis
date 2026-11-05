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
import secrets
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
SCOPE = 'controller-live-proxy.v1'
RESET = D.RESET
RESET_POLICY = 'orbis.controller-update-reset-mount.v1'
RESET_POLICY_V2 = 'orbis.controller-update-reset-mount.v2'
SOURCE_RETIREMENT = 'orbis.controller-source-retirement.v1'
PROBE_RETIREMENT = 'orbis.controller-probe-retirement.v2'
TOOLS = load('orbis-install-transaction.py', 'orbis_controller_reconstruction_transaction')
CAPABILITY = {'schema': 'orbis.controller-overlay-startup.v1', 'version': 1, 'preserveNetworkAccess': True,
              'preserveRunningApps': True, 'environment': 'ORBIS_CONTROLLER_PRESERVE_NETWORK_ACCESS=1'}


class CapabilityError(ValueError):
    code = 'controller-preservation-unsupported'


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
        if (record.get('schema') != POLICY or record.get('root') != str(self.root) or record.get('context') != self.context
                or record.get('current') != self.current or record.get('target') != self.target or record.get('snapshot') != str(self.snapshot)):
            raise ValueError('Controller recovery authority does not match this operation')
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
        if binding.get('schema') != RESET.SCHEMA_V4:
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
        record['sourceRetirement'] = {'schema': SOURCE_RETIREMENT, 'phase': 'held', 'body': body,
            'bodySha256': hashlib.sha256(self.P.canonical(body)).hexdigest(), 'imageId': source['Image'],
            'anchorName': 'orbis-controller-source-image-' + self.key,
            'reconstructionName': 'orbis-controller-reconstructed-' + self.key}

    def validate_retirement(self, record):
        retirement = record.get('sourceRetirement')
        if (not isinstance(retirement, dict) or retirement.get('schema') != SOURCE_RETIREMENT
                or retirement.get('bodySha256') != hashlib.sha256(self.P.canonical(retirement.get('body'))).hexdigest()
                or retirement.get('imageId') != record['source']['Image']
                or retirement.get('phase') not in {'held', 'retiring', 'retired', 'reconstructing', 'reconstructed', 'restored'}):
            raise ValueError('The protected source reconstruction intent changed')
        return retirement

    def retain_source_image(self, record):
        retirement = self.validate_retirement(record)
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

    def checkpoint_manifest(self, record):
        retirement = self.validate_retirement(record)
        checkpoint = record['checkpoint']
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
        retirement = self.validate_retirement(record)
        original = self.optional_container(record['source']['Id'])
        if original is not None:
            if retirement.get('reconstructionId'):
                raise ValueError('Both original and reconstructed source exist')
            return self.verify_source(record)
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
            record = {'schema': POLICY, 'root': str(self.root), 'context': self.context, 'snapshot': str(self.snapshot),
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
        if record['checkpoint'] != checkpoint:
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
        if self.P.metadata(body, byte_limit=4096) != CAPABILITY:
            raise CapabilityError('The target does not support preserving live network access during controller updates')
        self.runtime.change(['rm', probe['Id']])
        record.pop('probeId', None)
        record['sourceBootstrapProfile'] = BOOTSTRAP.probe(self, record, 'review')
        if record['sourceBootstrapProfile']['profile'] == BOOTSTRAP.LEGACY:
            record['sourceBootstrapNetworks'] = BOOTSTRAP.preserved_networks(self, record)
        if record.get('sourceRetirement'):
            self.retain_source_image(record)
        record['phase'] = 'prepared'
        self.save(record)
        return record

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
        self.runtime.verify_networks({'source': {'container': record['source']}}, candidate)
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
            if candidate['Image'] != record['targetImageId'] or candidate['State'].get('Running'):
                raise ValueError('Controller candidate differs from its protected intent')
            record['candidateId'] = candidate['Id']
            record['candidateDefinition'] = self.runtime.definition(candidate)
            self.save(record)
        candidate = self.runtime.inspect(record['candidateId'])
        self.runtime.check_intent(candidate, record['body'])
        self.check_candidate_networks(record, candidate)
        self.require_reset_mount(record, candidate=candidate)
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
                return
            if time.monotonic() >= deadline or raw['State'].get('Status') in {'exited', 'dead'}:
                raise RuntimeError('The reviewed controller did not become healthy')
            time.sleep(1)

    def stop_for_rollback(self):
        record = self.read()
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
        return record

    def verify_source_bootstrap(self):
        record = self.read()
        self.preserved(record)
        if record.get('sourceRetirement', {}).get('reconstructionId'):
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
        original = self.verify_source(record)
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
