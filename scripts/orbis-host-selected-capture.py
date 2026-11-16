"""Selected app components, with authority separate from legacy capture receipts.

Only opaque reviewed mount IDs cross the request boundary. The admitted core
lease owns this transaction; its durable intent remains a hold on any failure.
"""
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tarfile
import time
import uuid
from types import SimpleNamespace


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


STORAGE = load('orbis-install-storage.py', 'selected_capture_storage')
PACK = load('orbis-host-core-checkpoint.py', 'selected_capture_pack')
IO = load('orbis-host-selected-capture-io.py', 'selected_capture_io')
HEX = re.compile(r'[a-f0-9]{64}')
URN = re.compile(r'[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+')
POINT = PACK.POINT
CAPABILITY = {'schema': 'orbis.selected-capture-capability.v1', 'version': 1,
              'pointVersion': 4, 'payloadFormat': 'orbis.time-machine-components.v1',
              'operations': ['review', 'bind', 'receipt', 'artifact', 'status'],
              'lifecycleAuthority': 'parent-core-admission.v1', 'legacyReceipts': 'unchanged'}
LIMIT = 2 ** 36 - 32
METADATA_LIMIT = 16 * 1024 ** 2


SelectedCaptureError = IO.BoundsError
CAPTURE_SECONDS = 1800
RECOVERY_RESERVE = 256 * 1024 ** 2


def fail(message='Selected app storage changed. Review the capture again before continuing.'):
    return SelectedCaptureError(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf8')


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def checked_point(value):
    if not isinstance(value, str) or POINT.fullmatch(value) is None:
        raise fail()
    return value


def physical_overlap(left, right):
    """Resolve bind-mount ancestor aliases using inode identities as well as paths."""
    left, right = Path(left), Path(right)
    if STORAGE.overlaps(left, right) or STORAGE.overlaps(left.resolve(strict=True), right.resolve(strict=True)):
        return True
    def identity(path):
        details = path.stat()
        return details.st_dev, details.st_ino
    left_id, right_id = identity(left), identity(right)
    return (left_id == right_id or left_id in {identity(path) for path in right.parents}
            or right_id in {identity(path) for path in left.parents})


def require_no_nested_mounts(source):
    if sys.platform != 'linux':
        return  # Non-Linux fixtures cannot establish Linux mount-namespace evidence.
    with open('/proc/self/mountinfo', 'r', encoding='utf8') as stream:
        body = stream.read(8 * 1024 * 1024 + 1)
    if len(body) > 8 * 1024 * 1024:
        raise fail()
    for line in body.splitlines():
        fields = line.split()
        if len(fields) < 10:
            raise fail()
        value = re.sub(r'\\([0-7]{3})', lambda match: chr(int(match[1], 8)), fields[4])
        target = Path(value)
        if target != source and target.is_relative_to(source):
            raise fail('Included storage contains another mounted filesystem. Choose separate storage roots before capture.')


def selected(value):
    if (not isinstance(value, list) or not 1 <= len(value) <= 512
            or any(not isinstance(item, dict) or set(item) != {'urn', 'mountIds'}
                   or not isinstance(item['urn'], str) or URN.fullmatch(item['urn']) is None
                   or not isinstance(item['mountIds'], list) or not 1 <= len(item['mountIds']) <= 512
                   or len(set(item['mountIds'])) != len(item['mountIds'])
                   or any(not isinstance(key, str) or HEX.fullmatch(key) is None for key in item['mountIds']) for item in value)
            or len({item['urn'] for item in value}) != len(value)):
        raise fail('Choose at least one storage mount for every included app.')
    return sorted([{'urn': item['urn'], 'mountIds': sorted(item['mountIds'])} for item in value], key=lambda item: item['urn'])


class SelectedCapture:
    def __init__(self, service, core, host):
        self.service, self.core, self.host = service, core, host
        self.root, self.state = Path(service.root), Path(service.state_dir)
        self.authority = core.a
        self.base = self.state / 'selected-captures'
        core.child(self.base)

    def directory(self, point):
        return self.base / checked_point(point)

    def read(self, directory, name, optional=False):
        try:
            with self.authority.protected_directory(directory) as parent:
                with self.authority.protected_file(parent, name, METADATA_LIMIT) as body:
                    value = json.loads(body)
                    if canonical(value) != body:
                        raise fail()
                    return value
        except FileNotFoundError:
            if optional:
                return None
            raise

    def write(self, directory, name, value, replace=False):
        body = canonical(value)
        if len(body) > METADATA_LIMIT:
            raise fail('Selected app metadata exceeds the capture limit.')
        if hasattr(self, 'io'):
            self.io.consume(len(body))
        temporary = '.selected-' + uuid.uuid4().hex
        with self.authority.protected_directory(directory) as checked:
            identity = tuple(getattr(os.fstat(checked), key) for key in ('st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_mode'))
            parent = os.dup(checked)
        try:
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            try:
                with os.fdopen(fd, 'wb', closefd=False) as stream:
                    stream.write(body)
                    stream.flush()
                    os.fsync(fd)
                if replace:
                    os.rename(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
                else:
                    os.link(temporary, name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
                    os.unlink(temporary, dir_fd=parent)
                os.fsync(parent)
            finally:
                os.close(fd)
                try:
                    os.unlink(temporary, dir_fd=parent)
                except FileNotFoundError:
                    pass
            with self.authority.protected_directory(directory) as checked:
                if tuple(getattr(os.fstat(checked), key) for key in ('st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_mode')) != identity:
                    raise fail('The protected selected-capture directory changed.')
        finally:
            os.close(parent)

    def observe(self, reader, urns):
        if (not isinstance(urns, list) or not 1 <= len(urns) <= 512 or len(set(urns)) != len(urns)
                or any(not isinstance(urn, str) or URN.fullmatch(urn) is None for urn in urns)):
            raise fail('Choose installed apps before reviewing their storage.')
        rows = reader.containers()
        STORAGE.DETECT.validate_rows(rows)
        _, installation = STORAGE.APPS.selected_installation(reader, self.root)
        controller = installation['container']['id']
        inventory, apps = {}, {urn: {'urn': urn, 'containers': [], 'mounts': []} for urn in sorted(urns)}
        for row in rows:
            raw = reader._object(['container', 'inspect', '--format', '{{json .}}', row['id']])
            observation = self.core.observation(reader, row['id'])
            labels = raw['Config'].get('Labels') or {}
            urn = labels.get('runtipi.appurn')
            inventory[row['id']] = {'observation': observation, 'mounts': copy.deepcopy(raw['Mounts'])}
            if urn not in apps:
                continue
            name, repository = urn.split(':')
            working = labels.get('com.docker.compose.project.working_dir')
            expected = self.root / 'apps' / repository / name
            if (str(labels.get('runtipi.managed')).lower() != 'true'
                    or labels.get('com.docker.compose.project') != urn.replace(':', '_')
                    or working != str(expected) or expected.resolve(strict=True) != expected
                    or not isinstance(labels.get('com.docker.compose.service'), str)
                    or re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', labels['com.docker.compose.service']) is None
                    or raw['Id'] == controller):
                raise fail('An included app is not owned by this Orbis installation.')
            apps[urn]['containers'].append({'id': row['id'], 'inspect': copy.deepcopy(raw), 'observation': observation})
            for mount in STORAGE.DETECT.validate_mounts(raw['Mounts']):
                source = STORAGE.mount_source(reader, mount)
                if source is None:
                    continue
                identity = STORAGE.source_identity(source)
                if any(physical_overlap(source, path) for path in (self.state, Path(self.service.snapshots))):
                    raise fail('App storage overlaps capture or recovery storage.')
                destination = mount['Destination']
                internal = (source.is_relative_to(self.root / 'app-data' / repository / name)
                            or source.is_relative_to(self.root / 'app-data' / name))
                media = any(part.lower() in {'media', 'movies', 'music', 'photos', 'videos', 'tv', 'downloads'}
                            for part in (*source.parts, *Path(destination).parts))
                kind = 'media' if media else 'app-data' if internal or mount['Type'] == 'volume' else 'external'
                address = {'appUrn': urn, 'containerId': raw['Id'], 'destination': destination,
                           'service': labels['com.docker.compose.service'],
                           'type': mount['Type'], 'volumeName': mount.get('Name'), 'identity': identity}
                apps[urn]['mounts'].append({**address, 'id': digest(address), 'classification': kind,
                                          'requiresExplicitInclusion': True, 'writable': mount['RW']})
        if any(not app['containers'] for app in apps.values()):
            raise fail('An included app has no stable Docker containers. Refresh the app list.')
        return {'schema': 'orbis.selected-capture-observation.v1', 'root': str(self.root),
                'context': self.service.context, 'daemonSha256': STORAGE.APPS.digest_daemon(reader),
                'controllerId': controller, 'inventory': inventory, 'apps': list(apps.values())}

    @staticmethod
    def public(observed):
        return [{'urn': app['urn'], 'mounts': [
            {'id': mount['id'], 'destination': mount['destination'], 'source': mount['identity']['source'],
             'service': mount['service'],
             'classification': mount['classification'], 'requiresExplicitInclusion': True,
             'type': mount['type'], 'writable': mount['writable']} for mount in app['mounts']]} for app in observed['apps']]

    def review(self, reader, urns):
        observed = self.observe(reader, urns)
        point = str(uuid.uuid4())
        directory = self.directory(point)
        self.core.child(directory)
        review = {'schema': 'orbis.selected-capture-review.v1', 'id': point,
                  'createdAt': int(time.time() * 1000), 'observation': observed}
        self.write(directory, 'review.json', review)
        return {'version': 1, 'reviewId': point, 'reviewSha256': digest(review), 'apps': self.public(observed)}

    def plan(self, observed, choices):
        choices = selected(choices)
        wanted = {item['urn']: set(item['mountIds']) for item in choices}
        if set(wanted) != {app['urn'] for app in observed['apps']}:
            raise fail()
        mounts, containers = [], {}
        for app in observed['apps']:
            included = [mount for mount in app['mounts'] if mount['id'] in wanted[app['urn']]]
            if {mount['id'] for mount in included} != wanted[app['urn']]:
                raise fail()
            mounts.extend(included)
            containers.update({item['id']: item for item in app['containers']})
        resources = []
        for mount in mounts:
            identity = mount['identity']
            if identity['kind'] != 'directory':
                raise fail('Selected capture requires directory mounts. No app has been stopped.')
            require_no_nested_mounts(Path(identity['source']))
            existing = next((item for item in resources if item['identity'] == identity), None)
            if existing:
                existing['mountIds'].append(mount['id'])
                continue
            source = Path(identity['source'])
            if any(physical_overlap(source, Path(item['identity']['source']))
                   or (identity['device'], identity['inode']) == (item['identity']['device'], item['identity']['inode'])
                   for item in resources):
                raise fail('Included storage has overlapping paths or aliases. Review one storage root at a time.')
            resources.append({'identity': identity, 'mountIds': [mount['id']]})
        included_ids = {mount['id'] for mount in mounts}
        for app in observed['apps']:
            for mount in app['mounts']:
                if mount['id'] not in included_ids and any(
                        physical_overlap(Path(mount['identity']['source']), Path(item['identity']['source']))
                        for item in resources):
                    raise fail('An excluded mount overlaps included storage. Review the storage choices again.')
        for identifier, item in observed['inventory'].items():
            if identifier in containers:
                continue
            for mount in item['mounts']:
                if mount.get('RW') is not True or mount.get('Type') not in {'bind', 'volume'}:
                    continue
                candidate = mount.get('Source')
                if not isinstance(candidate, str) or not Path(candidate).is_absolute():
                    raise fail()
                path = Path(candidate)
                for resource in resources:
                    source = Path(resource['identity']['source'])
                    overlap = physical_overlap(path, source)
                    if not overlap:
                        try:
                            info = path.stat()
                            overlap = (info.st_dev, info.st_ino) == (resource['identity']['device'], resource['identity']['inode'])
                        except OSError:
                            raise fail()
                    # The enrolled controller is drained by the parent source hold.
                    # It may expose a broad app-data parent, but never an external/media root.
                    controller_data = (identifier == observed['controllerId']
                                       and mount.get('Destination') == '/app-data'
                                       and source.is_relative_to(self.root / 'app-data'))
                    if overlap and not controller_data:
                        raise fail('Included storage has another Docker writer. Omitted apps will not be stopped; choose separate storage.')
        return {'selection': choices, 'mounts': mounts, 'containers': containers, 'resources': resources}

    def bind(self, reader, core_point, request):
        checked_point(core_point)
        if (not isinstance(request, dict) or set(request) != {'pointId', 'reviewId', 'reviewSha256', 'coreReservationSha256', 'apps'}
                or any(not isinstance(request[key], str) or HEX.fullmatch(request[key]) is None
                       for key in ('reviewSha256', 'coreReservationSha256'))):
            raise fail()
        checked_point(request['pointId'])
        review = self.read(self.directory(request['reviewId']), 'review.json')
        if (digest(review) != request['reviewSha256'] or int(time.time() * 1000) - review['createdAt'] > 15 * 60 * 1000):
            raise fail('The storage review expired. Review the included content again.')
        observed = self.observe(reader, [item['urn'] for item in selected(request['apps'])])
        if observed != review['observation']:
            raise fail()
        plan = self.plan(observed, request['apps'])
        directory = self.directory(core_point)
        self.core.child(directory)
        binding = {'schema': 'orbis.selected-capture-admission.v1', 'corePointId': core_point,
                   'pointId': request['pointId'], 'coreReservationSha256': request['coreReservationSha256'],
                   'reviewSha256': request['reviewSha256'], 'observation': observed, 'plan': plan}
        self.write(directory, 'binding.json', binding)
        return {'version': 1, 'pointId': request['pointId'], 'corePointId': core_point,
                'planSha256': digest(binding), 'apps': self.public(observed), 'selection': plan['selection']}

    def prepared(self, reader, point, reservation_sha):
        binding = self.read(self.directory(point), 'binding.json', optional=True)
        if binding is None:
            return None
        if (binding['corePointId'] != point or binding['coreReservationSha256'] != reservation_sha
                or self.observe(reader, [item['urn'] for item in binding['plan']['selection']]) != binding['observation']
                or self.plan(binding['observation'], binding['plan']['selection']) != binding['plan']):
            raise fail()
        return binding

    def execute(self, admission, core_capture):
        binding = self.read(self.directory(admission.point), 'binding.json', optional=True)
        if binding is None:
            return core_capture()
        self.io = IO.Budget(2 * LIMIT, CAPTURE_SECONDS, self.state, RECOVERY_RESERVE)
        reservation = self.read(self.state / 'core-capture-preparations' / admission.point, 'point-reservation.json')
        if (admission.request.get('schema') != 'orbis.core-capture-admission.v2'
                or binding['corePointId'] != admission.point
                or digest(reservation) != binding['coreReservationSha256']):
            raise fail('Selected app capture requires its exact reserved parent admission.')
        directory = self.directory(admission.point)
        reader = STORAGE.APPS.Docker(self.service.context)
        # All discovery subprocesses share the selected I/O deadline.
        def bounded_read(arguments):
            return IO.process(['docker', '--context', reader.context, *arguments], self.io,
                              8 * 1024 ** 2, seconds=20).decode('utf8').strip()
        reader._read = bounded_read
        with self.host.host_lock(self.root) as lock_fd:
            reader.lock_fd = lock_fd
            current = self.observe(reader, [item['urn'] for item in binding['plan']['selection']])
            if (current != binding['observation'] or self.plan(current, binding['plan']['selection']) != binding['plan']):
                raise fail()
            admission.unchanged()
            estimate = self.preflight(reader, binding)
            record = {'schema': 'orbis.selected-capture-operation.v1', 'corePointId': admission.point,
                      'pointId': binding['pointId'], 'planSha256': digest(binding),
                      'parentAdmissionSha256': admission.request_sha256, 'phase': 'stopping',
                      'pendingMutation': None, 'expected': copy.deepcopy(current['inventory']), 'estimate': estimate}
            self.write(directory, 'operation.json', record)
            self._stop(reader, binding, record, directory)
            record['phase'] = 'copying'
            self.write(directory, 'operation.json', record, replace=True)
            self._capture(reader, binding, record, directory)
            self._verify(reader, binding, record)
            record['phase'] = 'core-capture'
            record['coreEntryExpected'] = copy.deepcopy(record['expected'])
            self.write(directory, 'operation.json', record, replace=True)
        # The core checkpoint remains unchanged and preserves the stopped apps.
        result = core_capture()
        with self.host.host_lock(self.root) as lock_fd:
            reader.lock_fd = lock_fd
            core_record = self.core.read(self.core.base / admission.point)
            if core_record['settlement'] != result or core_record['phase'] != 'complete':
                raise fail('The parent Orbis component has not positively settled.')
            self.core.verify(reader, core_record)
            for identifier in core_record['checkpoint']['roles']:
                record['expected'][identifier]['observation'] = self.core.observation(reader, identifier)
            self._verify(reader, binding, record)
            record['phase'] = 'resuming'
            self.write(directory, 'operation.json', record, replace=True)
            for identifier, item in sorted(binding['plan']['containers'].items()):
                if item['observation']['state'] == 'running':
                    self._change(reader, binding, record, directory, ['start', identifier])
                policy = item['observation']['restartPolicy']
                flag = policy['Name'] + (':' + str(policy['MaximumRetryCount']) if policy['Name'] == 'on-failure' else '')
                self._change(reader, binding, record, directory, ['update', '--restart', flag, identifier])
            self._verify(reader, binding, record)
            receipt = {'schema': 'orbis.selected-capture-receipt.v1', 'pointId': binding['pointId'],
                       'corePointId': admission.point, 'planSha256': digest(binding),
                       'parentAdmissionSha256': admission.request_sha256,
                       'coreCheckpointSha256': result['checkpointSha256'],
                       'artifact': record['artifact'], 'manifest': record['manifest'],
                       'resumedContainerIds': sorted(identifier for identifier, item in binding['plan']['containers'].items()
                                                     if item['observation']['state'] == 'running')}
            self.write(directory, 'receipt.json', receipt)
            record['phase'] = 'complete'
            self.write(directory, 'operation.json', record, replace=True)
        del self.io
        return result

    def _verify(self, reader, binding, record):
        if hasattr(self, 'io'):
            self.io.check()
        rows = reader.containers()
        if ({row['id'] for row in rows} != set(record['expected'])
                or STORAGE.APPS.digest_daemon(reader) != binding['observation']['daemonSha256']):
            raise fail()
        for identifier, expected in record['expected'].items():
            if hasattr(self, 'io'):
                self.io.check()
            if self.core.observation(reader, identifier) != expected['observation']:
                raise fail('A selected or omitted container changed during capture. Recovery authority was retained.')
        for resource in binding['plan']['resources']:
            if hasattr(self, 'io'):
                self.io.check()
            if STORAGE.source_identity(Path(resource['identity']['source'])) != resource['identity']:
                raise fail()
            require_no_nested_mounts(Path(resource['identity']['source']))

    def _change(self, reader, binding, record, directory, arguments):
        identifier = arguments[-1]
        if identifier not in binding['plan']['containers'] or record['pendingMutation'] is not None:
            raise fail()
        original = binding['plan']['containers'][identifier]['observation']
        policy = original['restartPolicy']
        flag = policy['Name'] + (':' + str(policy['MaximumRetryCount']) if policy['Name'] == 'on-failure' else '')
        allowed = ([['update', '--restart', 'no', identifier], ['stop', identifier]] if record['phase'] == 'stopping'
                   else [['start', identifier], ['update', '--restart', flag, identifier]] if record['phase'] == 'resuming' else [])
        if arguments not in allowed:
            raise fail()
        self._verify(reader, binding, record)
        record['pendingMutation'] = arguments
        self.write(directory, 'operation.json', record, replace=True)
        reader.change(arguments, timeout=min(180, self.io.remaining()))
        self.io.check()
        after = self.core.observation(reader, identifier)
        expected = copy.deepcopy(record['expected'][identifier]['observation'])
        if arguments[0] == 'update':
            expected['restartPolicy'] = {'Name': 'no', 'MaximumRetryCount': 0} if arguments[2] == 'no' else policy
        else:
            expected['state'] = 'running' if arguments[0] == 'start' else 'exited'
            expected['startedAt'] = after['startedAt']
            if arguments[0] == 'start':
                expected['networks'] = original['networks']
            else:
                if any(value not in {'', original['networks'].get(name)} for name, value in after['networks'].items()):
                    raise fail('An included app changed network identity while stopping.')
                expected['networks'] = after['networks']
        if after != expected:
            raise fail('An included app did not settle after its capture lifecycle action.')
        record['expected'][identifier]['observation'] = after
        record['pendingMutation'] = None
        self._verify(reader, binding, record)
        self.write(directory, 'operation.json', record, replace=True)

    def _stop(self, reader, binding, record, directory):
        for identifier, item in sorted(binding['plan']['containers'].items()):
            self._change(reader, binding, record, directory, ['update', '--restart', 'no', identifier])
            if item['observation']['state'] == 'running':
                self._change(reader, binding, record, directory, ['stop', identifier])

    def preflight(self, reader, binding):
        sources = [Path(item['identity']['source']) for item in binding['plan']['resources']]
        for source in sources:
            self.io.check()
            require_no_nested_mounts(source)
        # Validate every metadata/link type before any selected lifecycle mutation.
        entries = IO.collect(sources, PACK, self.io, hash_files=False)
        total = sum(item['bytes'] for item in entries if item['type'] == 'file')
        exports = self.image_descriptors(reader, binding)
        if len(exports) > 256:
            raise fail('Selected app images exceed the supported inventory. No app was stopped.')
        image_total = 0
        for item in exports:
            self.io.check()
            size = item['inspection'].get('Size')
            if type(size) is not int or size < 0 or size > 16 * 1024 ** 3:
                raise fail('Selected app image storage cannot be estimated safely. No app was stopped.')
            image_total += size
        # Size is an admission estimate, never authority for later Docker output.
        # Every exported byte and final tar byte consumes the same hard budget.
        available = shutil.disk_usage(self.state).free - RECOVERY_RESERVE
        self.io.maximum = min(2 * LIMIT, max(0, available))
        tar_estimate = (sum(512 + ((item.get('bytes', 0) + 511) // 512) * 512
                            + 2048 for item in entries) + METADATA_LIMIT + 10240)
        if total + image_total > LIMIT or tar_estimate + 2 * image_total > self.io.maximum:
            raise fail('Selected app data needs more available capture storage. No app was stopped.')
        self.io.check()
        return {'sourceBytes': total, 'imageBytes': image_total, 'entries': len(entries),
                'maximumBytes': LIMIT, 'aggregateWriteBytes': self.io.maximum,
                'reservedFreeBytes': RECOVERY_RESERVE, 'deadlineSeconds': CAPTURE_SECONDS,
                'imageExports': exports}

    def _capture(self, reader, binding, record, directory):
        resources = binding['plan']['resources']
        sources = [Path(item['identity']['source']) for item in resources]
        self._verify(reader, binding, record)
        before = IO.collect(sources, PACK, self.io)
        exports = record['estimate']['imageExports']
        if self.image_descriptors(reader, binding) != exports:
            raise fail('Selected app image identity changed. Recovery authority was retained.')
        image_files = []
        for item in exports:
            identifier = item['imageId']
            image_file = directory / ('image-' + identifier[7:] + '.tar')
            descriptor = os.open(image_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            try:
                self._save_images(reader, [identifier], descriptor, item['platform'])
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            size = image_file.stat().st_size
            if not 1 <= size <= min(LIMIT, 16 * 1024 ** 3):
                raise fail('Selected app images exceed the capture limit.')
            item = dict(item, archive=image_file.name, bytes=size, sha256=self.file_hash(image_file))
            image_files.append((image_file, item))
            if sum(value['bytes'] for _, value in image_files) + record['estimate']['sourceBytes'] > LIMIT:
                raise fail('Selected app exports exceed the component size. Recovery authority was retained.')
        image_exports = [item for _, item in image_files]
        manifest = {'schema': 'orbis.selected-app-component.v1', 'pointId': binding['pointId'],
                    'corePointId': binding['corePointId'], 'planSha256': digest(binding),
                    'capturedAt': int(time.time() * 1000), 'selection': binding['plan']['selection'],
                    'mounts': binding['plan']['mounts'], 'containers': binding['plan']['containers'],
                    'imageExports': image_exports,
                    'images': {'format': 'orbis.selected-image-exports.v1',
                               'ids': [item['imageId'] for item in image_exports],
                               'bytes': sum(item['bytes'] for item in image_exports),
                               'sha256': digest(image_exports)}}
        artifact = directory / 'apps.tar'
        descriptor = os.open(artifact, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'wb') as stream:
            with tarfile.open(fileobj=IO.Writer(stream, self.io, LIMIT), mode='w|', format=tarfile.PAX_FORMAT) as archive:
                manifest['entries'] = IO.collect(sources, PACK, self.io, archive)
                if manifest['entries'] != before:
                    raise fail('Included app storage changed while streaming. Recovery authority was retained.')
                for image_file, item in image_files:
                    info = tarfile.TarInfo('images/' + item['archive'])
                    info.mode, info.size = 0o600, item['bytes']
                    image_fd = os.open(image_file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                    try:
                        archive.addfile(info, IO.Reader(image_fd, self.io))
                    finally:
                        os.close(image_fd)
                body = canonical(manifest)
                if len(body) > METADATA_LIMIT:
                    raise fail()
                info = tarfile.TarInfo('manifest.json')
                info.mode, info.size = 0o600, len(body)
                archive.addfile(info, io.BytesIO(body))
            stream.flush()
            os.fsync(stream.fileno())
        self._verify(reader, binding, record)
        if (IO.collect(sources, PACK, self.io) != manifest['entries']
                or any(self.file_hash(file) != item['sha256'] for file, item in image_files)
                or self.image_descriptors(reader, binding) != exports or artifact.stat().st_size > LIMIT):
            raise fail('Included app storage changed while being captured. Recovery authority was retained.')
        record['manifest'] = {key: value for key, value in manifest.items() if key not in {'containers', 'mounts', 'entries', 'imageExports'}}
        record['manifest']['includedStorage'] = [
            {key: mount[key] for key in ('id', 'appUrn', 'service', 'destination', 'classification', 'type')}
            for mount in binding['plan']['mounts']]
        record['manifest']['manifestSha256'] = hashlib.sha256(canonical(manifest)).hexdigest()
        record['artifact'] = {'bytes': artifact.stat().st_size, 'sha256': self.file_hash(artifact)}
        self.write(directory, 'operation.json', record, replace=True)

    def image_descriptors(self, reader, binding):
        exports = []
        for identifier in sorted({item['inspect']['Image'] for item in binding['plan']['containers'].values()}):
            if hasattr(self, 'io'):
                self.io.check()
            image = reader._object(['image', 'inspect', '--format', '{{json .}}', identifier])
            platform = {'os': image.get('Os'), 'architecture': image.get('Architecture')}
            if image.get('Variant'):
                platform['variant'] = image['Variant']
            if (image.get('Id') != identifier or platform['os'] != 'linux'
                    or any(not isinstance(value, str) or not re.fullmatch(r'[a-z0-9][a-z0-9._-]{0,63}', value)
                           for value in platform.values())):
                raise fail('Selected app image platform could not be pinned. No app was stopped.')
            selected = reader._object(['image', 'inspect', '--platform', '/'.join(platform.values()),
                                       '--format', '{{json .}}', identifier])
            def curated(value):
                return {key: value[key] for key in ('Id', 'RepoDigests', 'Os', 'Architecture', 'Variant', 'Manifests', 'Size') if key in value}
            exports.append({'imageId': identifier, 'platform': platform,
                            'inspection': curated(image), 'selected': curated(selected)})
        return exports

    def _save_images(self, reader, images, descriptor, platform):
        # The CLI cannot write directly to state storage or bypass the aggregate cap.
        with os.fdopen(os.dup(descriptor), 'wb') as stream:
            writer = IO.Writer(stream, self.io, min(LIMIT, 16 * 1024 ** 3))
            IO.process(['docker', '--context', reader.context, 'image', 'save', '--platform',
                        '/'.join(platform[key] for key in ('os', 'architecture', 'variant') if key in platform), *images],
                       self.io, writer.maximum, writer=writer, pass_fds=(reader.lock_fd,))
            stream.flush()
            self.io.check()

    def file_hash(self, path):
        return IO.file_hash(path, self.io)

    def receipt(self, core_point):
        directory = self.directory(core_point)
        receipt = self.read(directory, 'receipt.json')
        binding = self.read(directory, 'binding.json')
        operation = self.read(directory, 'operation.json')
        if (receipt['corePointId'] != core_point or receipt['planSha256'] != digest(binding)
                or operation['phase'] != 'complete' or operation['artifact'] != receipt['artifact']
                or operation['manifest'] != receipt['manifest']):
            raise fail('The selected app capture has not positively settled.')
        return receipt

    def completion_record(self, admission, reader, core_record):
        """Composite verification view; the immutable core job retains its original meaning."""
        receipt = self.receipt(admission.point)
        directory = self.directory(admission.point)
        binding = self.read(directory, 'binding.json')
        operation = self.read(directory, 'operation.json')
        if (admission.request.get('schema') != 'orbis.core-capture-admission.v2'
                or receipt['parentAdmissionSha256'] != admission.request_sha256
                or receipt['coreCheckpointSha256'] != core_record.get('checkpointSha256')
                or core_record.get('phase') != 'complete' or core_record.get('pendingMutation') is not None
                or operation.get('pendingMutation') is not None
                or set(core_record['original']) != set(operation['expected'])
                or set(operation.get('coreEntryExpected', {})) != set(core_record['original'])):
            raise fail('Selected app completion lacks its exact settled parent checkpoint.')
        selected = set(binding['plan']['containers'])
        roles = set(core_record['checkpoint']['roles'])
        if (not selected or selected & roles or not selected <= set(core_record['original'])
                or set(core_record['expected']) != roles
                or receipt['resumedContainerIds'] != sorted(identifier for identifier, item in binding['plan']['containers'].items()
                                                            if item['observation']['state'] == 'running')):
            raise fail('Selected app completion differs from its exact lifecycle ownership.')
        for identifier, original in core_record['original'].items():
            if original != operation['coreEntryExpected'][identifier]['observation']:
                raise fail('A container changed between selected and Orbis checkpoint admission.')
            expected = operation['expected'][identifier]['observation']
            if identifier in roles:
                if expected != core_record['expected'][identifier]:
                    raise fail('A core container changed outside its original capture authority.')
            elif identifier not in selected and expected != original:
                raise fail('An omitted container changed during selected capture.')
        self._verify(reader, binding, operation)
        view = copy.deepcopy(core_record)
        for identifier in selected:
            view['expected'][identifier] = copy.deepcopy(operation['expected'][identifier]['observation'])
        return view

    def status(self, core_point):
        """Curated observation only. Wrapper publication is a separate authority."""
        checked_point(core_point)
        directory = self.directory(core_point)
        binding = self.read(directory, 'binding.json')
        if binding.get('corePointId') != core_point:
            raise fail()
        operation = self.read(directory, 'operation.json', optional=True)
        phase = operation.get('phase') if operation else None
        failure = self.read(self.state / 'core-capture-admissions' / core_point, 'failure.json', optional=True)
        phases = {None: 'preparing', 'stopping': 'stopping-apps', 'copying': 'saving-apps',
                  'core-capture': 'sealing', 'resuming': 'starting-apps', 'complete': 'sealing'}
        if phase not in phases:
            raise fail()
        verified = False
        if phase == 'complete':
            self.receipt(core_point)
            verified = True
        artifact = operation.get('artifact') if operation else None
        count = artifact.get('bytes') if isinstance(artifact, dict) else None
        if count is not None and (type(count) is not int or not 0 <= count <= LIMIT):
            raise fail()
        return {'version': 1, 'id': core_point,
                'state': 'recovery-required' if failure else 'running' if operation else 'waiting',
                'phase': phases[phase], 'completedBytes': count or 0, 'totalBytes': count,
                'restartVerified': verified}

    def verify_wrapper(self, core_point, controller_id):
        """Read-only catalog verification; caller independently verifies retirement/health."""
        checked_point(core_point)
        if not isinstance(controller_id, str) or HEX.fullmatch(controller_id) is None:
            raise fail()
        receipt = self.receipt(core_point)
        binding = self.read(self.directory(core_point), 'binding.json')
        runtime = load('orbis-host-retained-restore-runtime.py', 'selected_capture_catalog_runtime')
        body = runtime.DockerRestoreRuntime.bounded_output(SimpleNamespace(host=self.host, root=self.root),
            ['docker', '--context', self.service.context, 'exec', controller_id, '/usr/local/bin/node',
             '/app/components-capture-catalog.mjs', '--observe', core_point], 8192, 1.5)
        value = json.loads(body)
        expected = {'schema', 'version', 'pointId', 'corePointId', 'metadataSha256', 'planSha256',
                    'selectedReceiptSha256', 'coreCheckpointSha256', 'complete'}
        if (not isinstance(value, dict) or set(value) != expected
                or value['schema'] != 'orbis.components-capture-catalog.v1' or value['version'] != 1
                or value['complete'] is not True or value['pointId'] != binding['pointId']
                or value['corePointId'] != core_point or value['planSha256'] != digest(binding)
                or value['selectedReceiptSha256'] != digest(receipt)
                or value['coreCheckpointSha256'] != receipt['coreCheckpointSha256']
                or not isinstance(value['metadataSha256'], str) or HEX.fullmatch(value['metadataSha256']) is None):
            raise fail('The selected-components wrapper has not been positively verified.')
        return value

    def artifact(self, core_point, expected):
        receipt = self.receipt(core_point)
        if expected != digest(receipt):
            raise fail()
        file = self.directory(core_point) / 'apps.tar'
        with self.authority.protected_directory(file.parent) as directory:
            descriptor = os.open(file.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        info = os.fstat(descriptor)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != self.authority.OWNER or info.st_nlink != 1
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size != receipt['artifact']['bytes']):
            os.close(descriptor)
            raise fail()
        return descriptor, receipt
