#!/usr/bin/env python3
"""Bounded historical Docker create definitions; private capture data only."""
import hashlib
import ipaddress
import json
import re
from pathlib import PurePosixPath

SCHEMA = 'orbis.app-runtime-capture.v1'
POLICY = 'orbis.app-runtime-transform.same-host.v1'
MAX_BYTES, MAX_NODES, MAX_DEPTH = 16 * 1024 * 1024, 262144, 32
SAFE_INTEGER = 2 ** 53 - 1
HEX = re.compile(r'[a-f0-9]{64}')
IMAGE = re.compile(r'sha256:[a-f0-9]{64}')
UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}')
PART = re.compile(r'[a-z0-9][a-z0-9_-]{0,127}')
SERVICE = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}')


def fail():
    return ValueError('Historical app runtime could not be independently verified')


def exact(value, keys):
    return isinstance(value, dict) and set(value) == set(keys)


def digest(body):
    return hashlib.sha256(body).hexdigest()


def bounded(value):
    pending, count = [(value, 0)], 0
    while pending:
        item, depth = pending.pop(); count += 1
        if count > MAX_NODES or depth > MAX_DEPTH:
            raise fail()
        if isinstance(item, dict):
            if any(not isinstance(key, str) for key in item):
                raise fail()
            pending.extend((key, depth + 1) for key in item)
            pending.extend((child, depth + 1) for child in item.values())
        elif isinstance(item, list):
            pending.extend((child, depth + 1) for child in item)
        elif isinstance(item, str):
            if len(item.encode('utf8')) > 2 * 1024 * 1024 or any(0xD800 <= ord(char) <= 0xDFFF for char in item):
                raise fail()
        elif item is None or type(item) is bool:
            pass
        elif type(item) is not int or abs(item) > SAFE_INTEGER:
            raise fail()


def canonical(value):
    bounded(value)
    def ordered(item):
        if isinstance(item, dict):
            return {key: ordered(item[key]) for key in sorted(item, key=lambda key: key.encode('utf-16-be'))}
        if isinstance(item, list):
            return [ordered(child) for child in item]
        return item
    return json.dumps(ordered(value), ensure_ascii=False, separators=(',', ':')).encode('utf8')


def parse(body):
    if not isinstance(body, bytes) or not 0 < len(body) <= MAX_BYTES:
        raise fail()
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result: raise fail()
            result[key] = value
        return result
    def no_float(_): raise fail()
    try:
        value = json.loads(body.decode('utf8', 'strict'), object_pairs_hook=pairs, parse_float=no_float, parse_constant=no_float)
        bounded(value)
        return value
    except (ValueError, UnicodeError, RecursionError, OverflowError) as error:
        raise fail() from error


def integer(value, low, high):
    return type(value) is int and low <= value <= high


def hash_value(value):
    return isinstance(value, str) and HEX.fullmatch(value) is not None


def app_parts(urn):
    if not isinstance(urn, str): raise fail()
    parts = urn.split(':')
    if (len(parts) != 2 or PART.fullmatch(parts[0]) is None
            or parts[1] != '_user' and PART.fullmatch(parts[1]) is None): raise fail()
    return parts


def ports(value):
    if value is None: return
    if not isinstance(value, dict) or len(value) > 1024: raise fail()
    total = 0
    for name, bindings in value.items():
        match = re.fullmatch(r'([1-9][0-9]{0,4})/(tcp|udp|sctp)', name)
        if match is None or int(match[1]) > 65535: raise fail()
        if bindings is None: continue
        if not isinstance(bindings, list) or len(bindings) > 64: raise fail()
        unique = set()
        for binding in bindings:
            if (not exact(binding, {'HostIp', 'HostPort'}) or not isinstance(binding['HostIp'], str)
                    or not binding['HostIp'] or len(binding['HostIp']) > 64 or '%' in binding['HostIp']
                    or not isinstance(binding['HostPort'], str) or re.fullmatch(r'[1-9][0-9]{0,4}', binding['HostPort']) is None
                    or int(binding['HostPort']) > 65535): raise fail()
            try: ipaddress.ip_address(binding['HostIp'])
            except ValueError as error: raise fail() from error
            pair = (binding['HostIp'], binding['HostPort'])
            if pair in unique: raise fail()
            unique.add(pair); total += 1
            if total > 4096: raise fail()


def sequence(value, maximum, key):
    if not isinstance(value, list) or len(value) > maximum:
        raise fail()
    keys = [key(item) for item in value]
    # UTF16 ordering is the JS canonical ordering used by the encrypted reader.
    def order(item):
        if isinstance(item, tuple): return tuple(order(part) for part in item)
        if isinstance(item, str): return item.encode('utf-16-be')
        return item
    if any(order(left) >= order(right) for left, right in zip(keys, keys[1:])):
        raise fail()
    return value


def platform(value):
    if (not isinstance(value, dict) or set(value) not in ({'os', 'architecture'}, {'os', 'architecture', 'variant'})
            or value['os'] != 'linux' or value['architecture'] not in {'amd64', 'arm64'}
            or 'variant' in value and (not isinstance(value['variant'], str) or re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,31}', value['variant']) is None)):
        raise fail()


def saved_names(urn):
    name, store = app_parts(urn)
    root = 'data/apps/' + store + '/' + name + '/'
    return {root + name for name in ('config.json', 'docker-compose.yml', 'docker-compose.json', 'docker-compose.generated.yml')} | {
        'data/user-config/' + store + '/' + name + '/docker-compose.yml', 'app-data/' + store + '/' + name + '/app.env'}


def _validate(value, expected):
    bounded(value)
    keys = {'schema', 'version', 'pointId', 'rootSha256', 'dockerContextSha256', 'daemonSha256', 'configurationSetSha256',
            'preparationSha256', 'capturedAt', 'apps', 'containers', 'networkDefinitions', 'sha256'}
    if (not exact(value, keys) or value['schema'] != SCHEMA or type(value['version']) is not int or value['version'] != 1
            or not isinstance(value['pointId'], str) or UUID.fullmatch(value['pointId']) is None
            or not integer(value['capturedAt'], 0, SAFE_INTEGER)):
        raise fail()
    for key in ('rootSha256', 'dockerContextSha256', 'daemonSha256', 'configurationSetSha256', 'preparationSha256'):
        if not hash_value(value[key]) or expected.get(key) != value[key]: raise fail()
    if expected.get('pointId') != value['pointId']: raise fail()
    apps = {}
    for item in sequence(value['apps'], 1024, lambda item: item.get('urn', '') if isinstance(item, dict) else ''):
        if (not exact(item, {'id', 'urn', 'project', 'status', 'pendingRestart', 'userConfigEnabled', 'sourceSha256',
                             'configurationSha256', 'savedFiles', 'services'}) or not integer(item['id'], 1, 2147483647)
                or not isinstance(item['urn'], str)
                or item['project'] != item['urn'].replace(':', '_') or item['status'] not in {'running', 'stopped', 'missing'}
                or type(item['pendingRestart']) is not bool or type(item['userConfigEnabled']) is not bool
                or not hash_value(item['sourceSha256']) or not hash_value(item['configurationSha256'])):
            raise fail()
        app_parts(item['urn'])
        for file in sequence(item['savedFiles'], 2048, lambda file: file.get('name', '') if isinstance(file, dict) else ''):
            if (not exact(file, {'name', 'bytes', 'sha256'}) or file['name'] not in saved_names(item['urn'])
                    or str(PurePosixPath(file['name'])) != file['name'] or not integer(file['bytes'], 0, SAFE_INTEGER)
                    or not hash_value(file['sha256'])): raise fail()
        if item['sourceSha256'] != digest(b'orbis.app-runtime-saved-source.v1\n' + canonical(item['savedFiles'])): raise fail()
        for service in sequence(item['services'], 256, lambda service: service.get('name', '') if isinstance(service, dict) else ''):
            if (not exact(service, {'name', 'replicas'}) or not isinstance(service['name'], str) or SERVICE.fullmatch(service['name']) is None
                    or not integer(service['replicas'], 0, 1024)): raise fail()
        apps[item['urn']] = item
    if len({item['id'] for item in apps.values()}) != len(apps): raise fail()
    counts, ids, names, network_names = {}, set(), set(), set()
    for item in sequence(value['containers'], 1024, lambda item: (item.get('appUrn', ''), item.get('service', ''), item.get('ordinal', 0)) if isinstance(item, dict) else ('', '', 0)):
        if (not exact(item, {'appUrn', 'service', 'ordinal', 'wasRunning', 'inspect', 'image', 'transformPolicy'})
                or item['appUrn'] not in apps or not isinstance(item['service'], str) or SERVICE.fullmatch(item['service']) is None
                or not integer(item['ordinal'], 1, 1024) or type(item['wasRunning']) is not bool or item['transformPolicy'] != POLICY): raise fail()
        raw, image = item['inspect'], item['image']
        if (not exact(raw, {'Id', 'Name', 'Image', 'Config', 'HostConfig', 'Mounts', 'NetworkSettings'})
                or not isinstance(raw['Id'], str) or HEX.fullmatch(raw['Id']) is None or raw['Id'] in ids
                or not isinstance(raw['Name'], str) or re.fullmatch(r'/[A-Za-z0-9][A-Za-z0-9_.-]{0,254}', raw['Name']) is None or raw['Name'] in names
                or not isinstance(raw['Image'], str) or IMAGE.fullmatch(raw['Image']) is None
                or not isinstance(raw['Config'], dict) or not isinstance(raw['HostConfig'], dict)
                or not isinstance(raw['Mounts'], list) or not exact(raw['NetworkSettings'], {'Networks', 'Ports'}) or not isinstance(raw['NetworkSettings']['Networks'], dict)
                or not exact(image, {'sourceImageId', 'creationReference', 'platform', 'selection'}) or image['sourceImageId'] != raw['Image']
                or not isinstance(image['creationReference'], str) or IMAGE.fullmatch(image['creationReference']) is None
                or image['selection'] not in {'docker29-platform-manifest.v1', 'docker-config.v1'}): raise fail()
        platform(image['platform'])
        ports(raw['NetworkSettings']['Ports'])
        if image['selection'] == 'docker-config.v1' and image['creationReference'] != image['sourceImageId']: raise fail()
        labels = raw['Config'].get('Labels') or {}
        if (labels.get('com.docker.compose.project') != apps[item['appUrn']]['project']
                or labels.get('com.docker.compose.service') != item['service']
                or labels.get('com.docker.compose.container-number') != str(item['ordinal'])
                or labels.get('runtipi.appurn') != item['appUrn'] or str(labels.get('runtipi.managed')).lower() != 'true'
                or str(labels.get('com.docker.compose.oneoff')).lower() != 'false'): raise fail()
        destinations = []
        for mount in raw['Mounts']:
            if not isinstance(mount, dict) or not isinstance(mount.get('Destination'), str) or not mount['Destination'].startswith('/') or type(mount.get('RW')) is not bool: raise fail()
            destinations.append(mount['Destination'])
        if len(destinations) != len(set(destinations)): raise fail()
        ids.add(raw['Id']); names.add(raw['Name']); network_names.update(raw['NetworkSettings']['Networks'])
        counts.setdefault((item['appUrn'], item['service']), []).append(item['ordinal'])
    for urn, app in apps.items():
        if set(service['name'] for service in app['services']) != {service for app_urn, service in counts if app_urn == urn} | {service['name'] for service in app['services'] if service['replicas'] == 0}: raise fail()
        for service in app['services']:
            if counts.get((urn, service['name']), []) != list(range(1, service['replicas'] + 1)): raise fail()
        config_name = 'data/apps/' + urn.split(':')[1] + '/' + urn.split(':')[0] + '/config.json'
        file = next((file for file in app['savedFiles'] if file['name'] == config_name), None)
        if file is None:
            if app['status'] != 'missing' or any(key[0] == urn for key in counts) or app['configurationSha256'] != digest(b''): raise fail()
        elif app['configurationSha256'] != file['sha256']: raise fail()
    definitions = {}
    for item in sequence(value['networkDefinitions'], 1024, lambda item: item.get('name', '') if isinstance(item, dict) else ''):
        if (not exact(item, {'name', 'sourceNetworkId', 'inspect'}) or not isinstance(item['name'], str) or not item['name']
                or not hash_value(item['sourceNetworkId']) or not isinstance(item['inspect'], dict)
                or item['inspect'].get('Name') != item['name'] or item['inspect'].get('Id') != item['sourceNetworkId']): raise fail()
        definitions[item['name']] = item
    if set(definitions) != network_names: raise fail()
    for item in value['containers']:
        for name, endpoint in item['inspect']['NetworkSettings']['Networks'].items():
            if not isinstance(endpoint, dict) or endpoint.get('NetworkID') not in {'', None, definitions[name]['sourceNetworkId']}: raise fail()
    descriptor = {key: child for key, child in value.items() if key != 'sha256'}
    if value['sha256'] != digest((SCHEMA + '\n').encode() + canonical(descriptor)): raise fail()
    if len(canonical(value)) > MAX_BYTES: raise fail()
    return value


def validate(value, expected):
    try:
        if not isinstance(expected, dict): raise fail()
        return _validate(value, expected)
    except (KeyError, TypeError, AttributeError, UnicodeError, RecursionError, OverflowError) as error:
        raise fail() from error


def seal(value, expected):
    value = {**value, 'sha256': digest((SCHEMA + '\n').encode() + canonical(value))}
    return validate(value, expected)


def _runtime(service, host):
    import importlib.util
    from pathlib import Path
    from types import SimpleNamespace
    spec = importlib.util.spec_from_file_location('root_app_capture_driver', Path(__file__).with_name('orbis-host-retained-restore-runtime.py'))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module.DockerRestoreRuntime(SimpleNamespace(host=host, authority=host.AUTHORITY, root=service.root,
                                                      context=service.context, service=service))


def _read_saved(driver, controller, name):
    import os
    from pathlib import PurePosixPath
    internal = '/' + name
    candidates = [item for item in controller['Mounts'] if item.get('Type') == 'bind'
                  and (internal == item.get('Destination') or internal.startswith(str(item.get('Destination')) + '/'))]
    if not candidates: raise fail()
    mount = max(candidates, key=lambda item: len(item['Destination']))
    relative = PurePosixPath(internal).relative_to(mount['Destination']).parts
    if not relative or any(part in {'', '.', '..'} for part in relative): raise fail()
    with driver.a.protected_directory(mount['Source'], private=False) as directory:
        opened, current = [], directory
        try:
            for part in relative[:-1]:
                try: fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
                except FileNotFoundError: return None
                opened.append(fd); current = fd
                info = os.fstat(fd)
                if info.st_uid != driver.a.OWNER or info.st_mode & 0o022: raise fail()
            try:
                with driver.a.protected_file(current, relative[-1], 2 * 1024 * 1024, private=False) as body:
                    return {'name': name, 'bytes': len(body), 'sha256': digest(body)}
            except FileNotFoundError: return None
        finally:
            for fd in reversed(opened): os.close(fd)


def observe(service, prepared, host, point, *, driver=None, seconds=60):
    """Read actual managed runtime; no request supplies Docker definitions or IDs."""
    import base64
    import copy
    import shlex
    import time
    driver = driver or _runtime(service, host)
    deadline = time.monotonic() + seconds
    def read(arguments, maximum=MAX_BYTES):
        remaining = deadline - time.monotonic()
        if remaining <= 0: raise fail()
        body = driver.bounded_output(['docker', '--context', service.context, *arguments], maximum, min(30, remaining))
        return parse(body)
    daemon = read(['info', '--format', '{{json .}}'])
    if not isinstance(daemon.get('ID'), str) or not daemon['ID']: raise fail()
    controller_id = prepared['configuration']['controller']['id']
    controller = read(['container', 'inspect', '--format', '{{json .}}', controller_id])
    if controller.get('Id') != controller_id or controller.get('Image') != prepared['configuration']['controller']['imageId']: raise fail()
    if controller.get('State', {}).get('Running') is not True: raise fail()
    environment = dict(entry.split('=', 1) for entry in controller['Config'].get('Env', []) if isinstance(entry, str) and '=' in entry)
    entry = next((item for item in prepared['configuration']['files'] if item['path'] == '.env' and item.get('present') is True), None)
    if entry is None: raise fail()
    body = base64.b64decode(entry['data'], validate=True)
    if len(body) != entry['bytes'] or digest(body) != entry['sha256']: raise fail()
    for key in ('POSTGRES_HOST', 'POSTGRES_USERNAME', 'POSTGRES_DBNAME'):
        rows = re.findall(r'(?m)^(?:export\s+)?' + key + r'\s*=\s*([^\r\n]*)$', body.decode('utf8'))
        if len(rows) > 1: raise fail()
        if rows:
            parts = shlex.split(rows[0], comments=True, posix=True)
            if len(parts) != 1: raise fail()
            environment[key] = parts[0]
    database = read(['container', 'inspect', '--format', '{{json .}}', 'runtipi-db'])
    labels = database['Config'].get('Labels') or {}
    if (database.get('Name') != '/runtipi-db' or database.get('State', {}).get('Running') is not True
            or labels.get('com.docker.compose.project') != 'runtipi' or labels.get('com.docker.compose.service') != 'runtipi-db'
            or labels.get('com.docker.compose.project.working_dir') != str(service.root)): raise fail()
    addresses = {'runtipi-db'}
    for name, endpoint in database['NetworkSettings']['Networks'].items():
        if name in controller['NetworkSettings']['Networks'] and endpoint.get('NetworkID') == controller['NetworkSettings']['Networks'][name].get('NetworkID'):
            addresses.update(value for value in [endpoint.get('IPAddress'), *(endpoint.get('Aliases') or [])] if isinstance(value, str))
    if environment.get('POSTGRES_HOST', 'runtipi-db') not in addresses: raise fail()
    user, db = environment.get('POSTGRES_USERNAME', 'tipi'), environment.get('POSTGRES_DBNAME', 'tipi')
    if any(re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,62}', value or '') is None for value in (user, db)): raise fail()
    query = ("SELECT json_build_object('apps',COALESCE(json_agg(json_build_object('id',id,'urn',app_name||':'||app_store_slug,"
             "'status',status::text,'pendingRestart',pending_restart,'userConfigEnabled',COALESCE(user_config_enabled,true)) "
             "ORDER BY app_name,app_store_slug),'[]'::json)) FROM public.app")
    rows = read(['exec', database['Id'], 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', db, '-Atqc', query], 2 * 1024 * 1024)
    if not exact(rows, {'apps'}) or not isinstance(rows['apps'], list) or len(rows['apps']) > 1024: raise fail()
    apps = {}
    for row in rows['apps']:
        if time.monotonic() >= deadline: raise fail()
        if not exact(row, {'id', 'urn', 'status', 'pendingRestart', 'userConfigEnabled'}) or not isinstance(row['urn'], str): raise fail()
        parts = app_parts(row['urn'])
        if row['urn'] in apps: raise fail()
        files = []
        for name in sorted(saved_names(row['urn'])):
            if time.monotonic() >= deadline: raise fail()
            file = _read_saved(driver, controller, name)
            if file is not None: files.append(file)
        config_name = 'data/apps/' + parts[1] + '/' + parts[0] + '/config.json'
        config = next((file for file in files if file['name'] == config_name), None)
        apps[row['urn']] = {**row, 'project': row['urn'].replace(':', '_'), 'sourceSha256': digest(b'orbis.app-runtime-saved-source.v1\n' + canonical(files)),
                            'configurationSha256': config['sha256'] if config else digest(b''), 'savedFiles': files, 'services': []}
    remaining = deadline - time.monotonic()
    if remaining <= 0: raise fail()
    ids_body = driver.bounded_output(['docker', '--context', service.context, 'container', 'ls', '--all', '--no-trunc', '--format', '{{.ID}}'], 512 * 1024, min(30, remaining))
    ids = ids_body.decode('ascii').splitlines()
    if len(ids) > 4096 or len(ids) != len(set(ids)) or any(HEX.fullmatch(value) is None for value in ids): raise fail()
    by_project = {app['project']: app for app in apps.values()}; containers, networks = [], {}
    core = {controller_id, database['Id']}
    readable = [item['Source'] for item in controller['Mounts'] if item.get('Type') == 'bind' and item.get('RW') is True
                and item.get('Destination') in {'/data/apps', '/data/state', '/data/repos', '/data/media', '/data/user-config', '/data/traefik', '/app-data'}]
    def overlaps(left, right): return left == right or left.startswith(right + '/') or right.startswith(left + '/')
    wanted_platform = prepared['publicationReceipt']['proof']['platform']
    for identifier in sorted(ids):
        raw = read(['container', 'inspect', '--format', '{{json .}}', identifier])
        config_labels = raw['Config'].get('Labels') or {}
        project = config_labels.get('com.docker.compose.project'); app = by_project.get(project)
        if app is None:
            if identifier not in core and (config_labels.get('runtipi.appurn') is not None
                    or str(config_labels.get('runtipi.managed')).lower() == 'true' and project != 'runtipi'):
                raise fail()
            if identifier not in core and raw['State'].get('Running') and any(mount.get('RW') is True and mount.get('Type') == 'bind'
                    and any(overlaps(mount['Source'], source) for source in readable) for mount in raw['Mounts']): raise fail()
            continue
        state = raw['State']
        if (state.get('Paused') or state.get('Restarting') or state.get('Status') not in {'created', 'running', 'exited'}
                or raw['HostConfig'].get('AutoRemove') is not False or config_labels.get('runtipi.appurn') != app['urn']): raise fail()
        ordinal = config_labels.get('com.docker.compose.container-number')
        if not isinstance(ordinal, str) or re.fullmatch(r'[1-9][0-9]{0,3}', ordinal) is None: raise fail()
        source_image = read(['image', 'inspect', '--format', '{{json .}}', raw['Image']])
        if source_image.get('Id') != raw['Image']: raise fail()
        selected = []
        for item in source_image.get('Manifests') or []:
            observed_platform = (item.get('Descriptor') or {}).get('platform') or (item.get('ImageData') or {}).get('Platform')
            if not isinstance(observed_platform, dict): continue
            if (item.get('Kind') == 'image' and item.get('Available') is True and observed_platform.get('os') == wanted_platform.get('os')
                    and observed_platform.get('architecture') == wanted_platform.get('architecture')
                    and (observed_platform.get('variant') == wanted_platform.get('variant')
                         or wanted_platform.get('architecture') == 'arm64' and {observed_platform.get('variant'), wanted_platform.get('variant')} <= {None, 'v8'})):
                selected.append((item['Descriptor']['digest'], observed_platform))
        if len(selected) == 1:
            creation, observed_platform = selected[0]; selection = 'docker29-platform-manifest.v1'
        elif source_image.get('Manifests'):
            raise fail()
        else:
            if any('containerd' in str(value) for value in daemon.get('DriverStatus') or []): raise fail()
            creation = raw['Image']; observed_platform = {'os': source_image.get('Os'), 'architecture': source_image.get('Architecture')}
            if source_image.get('Variant'): observed_platform['variant'] = source_image['Variant']
            selection = 'docker-config.v1'
            if (observed_platform.get('os') != wanted_platform.get('os') or observed_platform.get('architecture') != wanted_platform.get('architecture')
                    or not (observed_platform.get('variant') == wanted_platform.get('variant')
                            or wanted_platform.get('architecture') == 'arm64'
                            and {observed_platform.get('variant'), wanted_platform.get('variant')} <= {None, 'v8'})):
                raise fail()
        captured = {key: copy.deepcopy(raw[key]) for key in ('Id', 'Name', 'Image', 'Config', 'HostConfig', 'Mounts')}
        captured['Mounts'].sort(key=lambda mount: mount['Destination'])
        if 'Ports' not in raw['NetworkSettings']:
            raise fail()
        captured['NetworkSettings'] = {'Networks': copy.deepcopy(raw['NetworkSettings']['Networks']),
                                       'Ports': copy.deepcopy(raw['NetworkSettings']['Ports'])}
        containers.append({'appUrn': app['urn'], 'service': config_labels.get('com.docker.compose.service'), 'ordinal': int(ordinal),
                           'wasRunning': state.get('Running'), 'inspect': captured,
                           'image': {'sourceImageId': raw['Image'], 'creationReference': creation, 'platform': observed_platform, 'selection': selection},
                           'transformPolicy': POLICY})
        for name in raw['NetworkSettings']['Networks']:
            if name not in networks:
                value = read(['network', 'inspect', '--format', '{{json .}}', name])
                networks[name] = {'name': name, 'sourceNetworkId': value.get('Id'), 'inspect': value}
    for app in apps.values():
        grouped = {}
        for item in containers:
            if item['appUrn'] == app['urn']: grouped.setdefault(item['service'], []).append(item['ordinal'])
        app['services'] = [{'name': name, 'replicas': len(values)} for name, values in sorted(grouped.items())]
    expected = {'pointId': point, 'rootSha256': digest(str(service.root).encode()), 'dockerContextSha256': digest(service.context.encode()),
                'daemonSha256': digest(daemon['ID'].encode()), 'configurationSetSha256': prepared['configuration']['configurationSetSha256'],
                'preparationSha256': prepared['publicationReceipt']['preparationSha256']}
    value = seal({'schema': SCHEMA, 'version': 1, **expected, 'capturedAt': int(time.time() * 1000),
                  'apps': sorted(apps.values(), key=lambda app: app['urn']),
                  'containers': sorted(containers, key=lambda item: (item['appUrn'], item['service'], item['ordinal'])),
                  'networkDefinitions': [networks[name] for name in sorted(networks)]}, expected)
    return value


def observe_bindings(value):
    import os
    import stat
    paths = sorted({mount['Source'] for item in value['containers'] for mount in item['inspect']['Mounts']
                    if mount.get('Type') == 'bind'})
    result = []
    for path in paths:
        if (not isinstance(path, str) or len(path.encode()) > 4096 or not path.startswith('/')
                or str(PurePosixPath(path)) != path or '..' in PurePosixPath(path).parts):
            raise fail()
        descriptor = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            parts = PurePosixPath(path).parts[1:]
            for part in parts[:-1]:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
                os.close(descriptor); descriptor = child
            details = os.stat(parts[-1], dir_fd=descriptor, follow_symlinks=False) if parts else os.fstat(descriptor)
            if stat.S_ISLNK(details.st_mode) or not (stat.S_ISREG(details.st_mode) or stat.S_ISDIR(details.st_mode)
                    or stat.S_ISSOCK(details.st_mode) or stat.S_ISCHR(details.st_mode) or stat.S_ISBLK(details.st_mode)):
                raise fail()
            result.append({'source': path, 'device': details.st_dev, 'inode': details.st_ino,
                           'type': stat.S_IFMT(details.st_mode), 'specialDevice': details.st_rdev})
        finally:
            os.close(descriptor)
    return result


def verify_quiesced(original, observed):
    import copy
    expected, current = copy.deepcopy(original), copy.deepcopy(observed)
    for value in (expected, current):
        value.pop('sha256'); value.pop('capturedAt')
    transient = {'EndpointID', 'Gateway', 'IPAddress', 'IPPrefixLen', 'IPv6Gateway', 'GlobalIPv6Address',
                 'GlobalIPv6PrefixLen', 'MacAddress', 'DNSNames'}
    managed = {item['inspect']['Id'] for item in original['containers']}
    for left, right in zip(expected['containers'], current['containers'], strict=True):
        if right['wasRunning'] is not False:
            raise fail()
        left['wasRunning'] = False
        observed_ports, original_ports = right['inspect']['NetworkSettings']['Ports'], left['inspect']['NetworkSettings']['Ports']
        exposed = set(left['inspect']['Config'].get('ExposedPorts') or {}) | set(original_ports or {})
        if observed_ports != original_ports:
            if observed_ports is not None and (set(observed_ports) - exposed or any(bindings for bindings in observed_ports.values())):
                raise fail()
            right['inspect']['NetworkSettings']['Ports'] = copy.deepcopy(original_ports)
        for item in (left, right):
            for endpoint in item['inspect']['NetworkSettings']['Networks'].values():
                for key in transient:
                    endpoint.pop(key, None)
                # A stopped endpoint can lose its network ID; the separate full
                # network inspection still pins the exact named network ID.
                endpoint['NetworkID'] = ''
    for value in (expected, current):
        for network in value['networkDefinitions']:
            peers = network['inspect'].get('Containers')
            if peers is not None:
                if not isinstance(peers, dict): raise fail()
                network['inspect']['Containers'] = {key: item for key, item in peers.items() if key not in managed}
    if current != expected:
        raise fail()
