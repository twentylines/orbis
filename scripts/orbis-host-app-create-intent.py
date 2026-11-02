#!/usr/bin/env python3
"""Pure same-host Docker requests from an already admitted protected v6 row.

This module grants no authority and performs no Docker/filesystem operations.
The caller must admit the complete descriptor, independently verify image and
network inspections, and recheck bind device/inode identity before any write.
Saved Compose and env files are deliberately not inputs.
"""
import copy
import ipaddress
import json
import posixpath
import re


HEX = re.compile(r'[a-f0-9]{64}')
IMAGE = re.compile(r'sha256:[a-f0-9]{64}')
POLICY = 'orbis.app-runtime-transform.same-host.v1'
PROPAGATION = {'rprivate', 'private', 'rshared', 'shared', 'rslave', 'slave'}
ENDPOINT_CREATE = {'IPAMConfig', 'Links', 'Aliases', 'DriverOpts', 'MacAddress', 'GwPriority'}
ENDPOINT_VOLATILE = {'NetworkID', 'EndpointID', 'Gateway', 'IPAddress', 'IPPrefixLen',
                     'IPv6Gateway', 'GlobalIPv6Address', 'GlobalIPv6PrefixLen', 'DNSNames'}
NETWORK_VOLATILE = {'Id', 'Created', 'Containers'}


def fail():
    return ValueError('Historical Docker creation intent could not be verified')


def _bounded(value):
    nodes = 0
    def visit(item, depth):
        nonlocal nodes
        nodes += 1
        if nodes > 262144 or depth > 32:
            raise fail()
        if item is None or type(item) is bool:
            return
        if type(item) is int:
            if abs(item) > 9007199254740991: raise fail()
        elif isinstance(item, str):
            if len(item.encode('utf8', 'strict')) > 2 * 1024 * 1024: raise fail()
        elif isinstance(item, list):
            for child in item: visit(child, depth + 1)
        elif isinstance(item, dict):
            for key, child in item.items():
                if not isinstance(key, str): raise fail()
                visit(key, depth + 1); visit(child, depth + 1)
        else:
            raise fail()
    visit(value, 0)
    if len(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()) > 16 * 1024 * 1024:
        raise fail()


def _path(value):
    return (isinstance(value, str) and value.startswith('/') and not value.startswith('//')
            and len(value.encode()) <= 4096 and posixpath.normpath(value) == value
            and not any(ord(char) < 32 or ord(char) == 127 for char in value))


def _mounts(raw, bind_sources):
    host = raw['HostConfig']
    if (not isinstance(bind_sources, dict) or host.get('VolumesFrom') or host.get('VolumeDriver')
            or host.get('Tmpfs') or len(raw['Mounts']) > 256): raise fail()
    observed, intended, sources = {}, {}, set()
    def add(target, source, destination, writable, propagation):
        if (not _path(source) or not _path(destination) or type(writable) is not bool
                or propagation not in PROPAGATION or destination in target): raise fail()
        target[destination] = (source, writable, propagation)
    for mount in raw['Mounts']:
        if not isinstance(mount, dict) or mount.get('Type') != 'bind': raise fail()
        add(observed, mount.get('Source'), mount.get('Destination'), mount.get('RW'), mount.get('Propagation'))
        sources.add(mount['Source'])
    if set(bind_sources) != sources or any(source != bind_sources[source] for source in sources): raise fail()
    structured, binds = host.get('Mounts'), host.get('Binds')
    structured = [] if structured is None else structured
    binds = [] if binds is None else binds
    if not isinstance(structured, list) or not isinstance(binds, list) or len(structured) + len(binds) > 256: raise fail()
    for mount in structured:
        if not isinstance(mount, dict) or mount.get('Type') != 'bind': raise fail()
        options = mount.get('BindOptions')
        options = {} if options is None else options
        if (not isinstance(options, dict) or 'CreateMountpoint' in options and type(options['CreateMountpoint']) is not bool
                or options.get('CreateMountpoint') is True): raise fail()
        mode = options.get('Propagation') or 'rprivate'
        readonly = mount.get('ReadOnly', False)
        if type(readonly) is not bool: raise fail()
        add(intended, mount.get('Source'), mount.get('Target'), not readonly, mode)
    for bind in binds:
        if not isinstance(bind, str): raise fail()
        parts = bind.split(':')
        if len(parts) not in (2, 3): raise fail()
        options = parts[2].split(',') if len(parts) == 3 else []
        choices = set(options)
        if (len(choices) != len(options) or choices - PROPAGATION - {'ro', 'rw', 'z', 'Z'}
                or len(choices & {'ro', 'rw'}) > 1 or len(choices & PROPAGATION) > 1
                or len(choices & {'z', 'Z'}) > 1): raise fail()
        add(intended, parts[0], parts[1], 'ro' not in choices, next(iter(choices & PROPAGATION), 'rprivate'))
    if intended != observed: raise fail()
    volumes = raw['Config'].get('Volumes')
    volumes = {} if volumes is None else volumes
    if not isinstance(volumes, dict) or any(destination not in observed for destination in volumes): raise fail()


def _endpoint(endpoint):
    if not isinstance(endpoint, dict) or set(endpoint) - ENDPOINT_CREATE - ENDPOINT_VOLATILE: raise fail()
    if endpoint.get('Links') not in (None, []): raise fail()
    result = {key: copy.deepcopy(value) for key, value in endpoint.items() if key in ENDPOINT_CREATE}
    if result.get('Aliases') is not None:
        if not isinstance(result['Aliases'], list) or any(not isinstance(value, str) or not value for value in result['Aliases']): raise fail()
    for key in ('DriverOpts', 'IPAMConfig'):
        if result.get(key) is not None and not isinstance(result[key], dict): raise fail()
    if any(not isinstance(value, str) for value in (result.get('DriverOpts') or {}).values()): raise fail()
    ipam = result.get('IPAMConfig') or {}
    if set(ipam) - {'IPv4Address', 'IPv6Address', 'LinkLocalIPs'}: raise fail()
    for key, version in (('IPv4Address', 4), ('IPv6Address', 6)):
        if key in ipam and not isinstance(ipam[key], str): raise fail()
        if ipam.get(key) and ('%' in ipam[key] or ipaddress.ip_address(ipam[key]).version != version): raise fail()
    if 'LinkLocalIPs' in ipam:
        if not isinstance(ipam['LinkLocalIPs'], list): raise fail()
        for address in ipam['LinkLocalIPs']:
            if not isinstance(address, str) or '%' in address: raise fail()
            ipaddress.ip_address(address)
    if 'GwPriority' in result and (type(result['GwPriority']) is not int or not -2147483648 <= result['GwPriority'] <= 2147483647): raise fail()
    if 'MacAddress' in result and (not isinstance(result['MacAddress'], str) or result['MacAddress'] and re.fullmatch(r'[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5}', result['MacAddress']) is None): raise fail()
    return result


def _ports(value, *, assigned):
    if value is None: return {}
    if not isinstance(value, dict) or len(value) > 1024: raise fail()
    result, total = {}, 0
    for port, bindings in value.items():
        if not isinstance(port, str) or re.fullmatch(r'[1-9][0-9]{0,4}/(?:tcp|udp|sctp)', port) is None or int(port.split('/')[0]) > 65535: raise fail()
        if bindings is None:
            result[port] = None; continue
        if not isinstance(bindings, list) or len(bindings) > 64: raise fail()
        total += len(bindings)
        if total > 4096: raise fail()
        rows = []
        for binding in bindings:
            if not isinstance(binding, dict) or set(binding) != {'HostIp', 'HostPort'}: raise fail()
            address, number = binding['HostIp'], binding['HostPort']
            if not isinstance(address, str) or not isinstance(number, str): raise fail()
            if '%' in address or '[' in address or ']' in address: raise fail()
            if address: ipaddress.ip_address(address)
            elif assigned: raise fail()
            if number not in ('', '0') and (not number.isascii() or not number.isdecimal() or str(int(number)) != number or not 1 <= int(number) <= 65535): raise fail()
            if assigned and number in ('', '0'): raise fail()
            rows.append((address, number))
        if len(set(rows)) != len(rows): raise fail()
        result[port] = sorted(rows)
    return result


def _creation_ports(raw, was_running):
    host = raw['HostConfig']
    if host.get('PublishAllPorts'): raise fail()
    intended = _ports(host.get('PortBindings'), assigned=False)
    observed = _ports(raw['NetworkSettings']['Ports'], assigned=True)
    bound = {key: value for key, value in observed.items() if value}
    if not was_running:
        if bound or any(not bindings or any(number in ('', '0') for _, number in bindings) for bindings in intended.values()): raise fail()
        return copy.deepcopy(host.get('PortBindings') or {})
    if set(intended) != set(bound) or any(value is None for value in intended.values()): raise fail()
    result = {}
    for port, bindings in intended.items():
        remaining = list(bound[port]); selected = []
        for address, number in bindings:
            matches = [row for row in remaining if (row[0] == address or not address and row[0] in {'0.0.0.0', '::'})
                       and (number in ('', '0') or row[1] == number)]
            if not matches or address and len(matches) != 1 or len({row[0] for row in matches}) != len(matches): raise fail()
            for row in matches:
                remaining.remove(row)
                selected.append({'HostIp': row[0], 'HostPort': row[1]})
        if remaining: raise fail()
        result[port] = selected
    return result


def _compile(container, image, bind_sources, networks):
    _bounded({'container': container, 'image': image, 'bindSources': bind_sources, 'networks': networks})
    if (not isinstance(container, dict) or set(container) != {'appUrn', 'service', 'ordinal', 'wasRunning', 'inspect', 'image', 'transformPolicy'}
            or container['transformPolicy'] != POLICY or type(container['wasRunning']) is not bool
            or type(container['ordinal']) is not int or not 1 <= container['ordinal'] <= 1024): raise fail()
    raw, captured_image = container['inspect'], container['image']
    if (not isinstance(raw, dict) or set(raw) != {'Id', 'Name', 'Image', 'Config', 'HostConfig', 'Mounts', 'NetworkSettings'}
            or not isinstance(raw['Id'], str) or HEX.fullmatch(raw['Id']) is None
            or not isinstance(raw['Name'], str) or re.fullmatch(r'/[A-Za-z0-9][A-Za-z0-9_.-]{0,254}', raw['Name']) is None
            or not isinstance(raw['Config'], dict) or not isinstance(raw['HostConfig'], dict) or not isinstance(raw['Mounts'], list)
            or not isinstance(raw['NetworkSettings'], dict) or set(raw['NetworkSettings']) != {'Networks', 'Ports'}
            or not isinstance(raw['NetworkSettings']['Networks'], dict) or not isinstance(networks, dict)
            or set(raw['Config']) & {'HostConfig', 'NetworkingConfig'}): raise fail()
    if (not isinstance(captured_image, dict) or set(captured_image) != {'sourceImageId', 'creationReference', 'platform', 'selection'}
            or captured_image['sourceImageId'] != raw['Image'] or IMAGE.fullmatch(raw['Image']) is None
            or captured_image['selection'] not in {'docker29-platform-manifest.v1', 'docker-config.v1'}
            or captured_image['selection'] == 'docker-config.v1' and captured_image['creationReference'] != raw['Image']
            or IMAGE.fullmatch(captured_image['creationReference']) is None
            or not isinstance(image, dict) or image.get('Id') != captured_image['creationReference']): raise fail()
    platform = captured_image['platform']
    if (not isinstance(platform, dict) or set(platform) - {'os', 'architecture', 'variant'}
            or platform.get('os') != 'linux' or platform.get('architecture') not in {'arm64', 'amd64'}
            or image.get('Os') != platform['os'] or image.get('Architecture') != platform['architecture']): raise fail()
    if image.get('Variant') != platform.get('variant') and not (platform['architecture'] == 'arm64' and {image.get('Variant'), platform.get('variant')} <= {None, '', 'v8'}): raise fail()
    _mounts(raw, bind_sources)
    labels = raw['Config'].get('Labels')
    if (not isinstance(container['appUrn'], str) or not isinstance(container['service'], str)
            or not isinstance(labels, dict) or labels.get('runtipi.appurn') != container['appUrn']
            or str(labels.get('runtipi.managed')).lower() != 'true'
            or labels.get('com.docker.compose.project') != container['appUrn'].replace(':', '_')
            or labels.get('com.docker.compose.service') != container['service']
            or labels.get('com.docker.compose.container-number') != str(container['ordinal'])
            or str(labels.get('com.docker.compose.oneoff')).lower() != 'false'): raise fail()
    host = copy.deepcopy(raw['HostConfig'])
    if host.get('AutoRemove') is not False or host.get('Links'): raise fail()
    for key in ('NetworkMode', 'PidMode', 'IpcMode', 'UTSMode', 'UsernsMode', 'CgroupnsMode'):
        if isinstance(host.get(key), str) and host[key].startswith('container:'): raise fail()
    endpoints, network_ids = {}, {}
    if set(networks) != set(raw['NetworkSettings']['Networks']): raise fail()
    source_ids = {}
    for name, endpoint in raw['NetworkSettings']['Networks'].items():
        approved = networks[name]
        if not isinstance(approved, dict) or set(approved) != {'captured', 'current'}: raise fail()
        captured, current = approved['captured'], approved['current']
        if (not isinstance(captured, dict) or set(captured) != {'name', 'sourceNetworkId', 'inspect'}
                or captured['name'] != name or not isinstance(current, dict) or not isinstance(captured['inspect'], dict)
                or current.get('Name') != name or captured['inspect'].get('Name') != name
                or captured['inspect'].get('Id') != captured['sourceNetworkId']
                or not isinstance(current.get('Id'), str) or HEX.fullmatch(current['Id']) is None
                or not isinstance(captured['sourceNetworkId'], str) or HEX.fullmatch(captured['sourceNetworkId']) is None
                or endpoint.get('NetworkID') not in (None, '', captured['sourceNetworkId'])): raise fail()
        desired = {key: value for key, value in captured['inspect'].items() if key not in NETWORK_VOLATILE}
        actual = {key: value for key, value in current.items() if key not in NETWORK_VOLATILE}
        if actual != desired: raise fail()
        endpoints[name] = _endpoint(endpoint)
        endpoints[name]['NetworkID'] = current['Id']
        network_ids[name] = current['Id']; source_ids[captured['sourceNetworkId']] = current['Id']
    if host.get('NetworkMode') in source_ids: host['NetworkMode'] = source_ids[host['NetworkMode']]
    elif host.get('NetworkMode') not in set(networks) | {'host', 'none', 'default', 'bridge'}: raise fail()
    ports = _creation_ports(raw, container['wasRunning'])
    if host.get('PortBindings') is not None or ports: host['PortBindings'] = ports
    body = copy.deepcopy(raw['Config'])
    body['Image'] = captured_image['creationReference']
    body['HostConfig'] = host
    body['NetworkingConfig'] = {'EndpointsConfig': endpoints}
    return {'name': raw['Name'][1:], 'body': body, 'networkIds': network_ids}


def compile_container(container, *, image, bind_sources, networks):
    """Compile one protected row; network values are {captured, current} pairs.

    Requires the Ports-bearing descriptor revision. Unsupported authority for
    named/anonymous volumes, namespace sharing, links or publish-all is rejected.
    Image inspection must resolve directly to creationReference; no tag fallback.
    """
    try:
        return _compile(container, image, bind_sources, networks)
    except (KeyError, TypeError, AttributeError, UnicodeError, RecursionError, OverflowError) as error:
        raise fail() from error


def verify_created(raw, compiled, comparator):
    """Use the injected DockerRestoreRuntime.check_intent, then pin identities.

    A successful pure check is not authority to create/start a container. The
    caller retains independent root-owned admission and transaction boundaries.
    """
    try:
        _bounded({'raw': raw, 'compiled': compiled})
        if not callable(comparator) or set(compiled) != {'name', 'body', 'networkIds'}: raise fail()
        body = compiled['body']
        if not isinstance(raw.get('Id'), str) or HEX.fullmatch(raw['Id']) is None: raise fail()
        comparator(raw, body)
        expected_config = {key: value for key, value in body.items() if key not in {'HostConfig', 'NetworkingConfig'}}
        if raw['Name'] != '/' + compiled['name'] or raw['Image'] != body['Image'] or raw['Config'] != expected_config: raise fail()
        expected_host, actual_host = copy.deepcopy(body['HostConfig']), copy.deepcopy(raw['HostConfig'])
        for host in (expected_host, actual_host):
            if host.get('OomKillDisable') is None: host['OomKillDisable'] = False
        if actual_host != expected_host: raise fail()
        actual_networks = raw['NetworkSettings']['Networks']
        if type(raw['State']['Running']) is not bool: raise fail()
        running = raw['State']['Running']
        if set(actual_networks) != set(compiled['networkIds']): raise fail()
        for name, endpoint in actual_networks.items():
            wanted = body['NetworkingConfig']['EndpointsConfig'][name]
            actual_id = endpoint.get('NetworkID')
            if ((actual_id != compiled['networkIds'][name] and (running or actual_id not in ('', None)))
                    or _endpoint(endpoint) != {key: value for key, value in wanted.items() if key != 'NetworkID'}): raise fail()
        actual_ports = _ports(raw['NetworkSettings']['Ports'], assigned=True)
        _creation_ports(raw, running)
        if not running and any(actual_ports.values()): raise fail()
        return True
    except (KeyError, TypeError, AttributeError, UnicodeError, RecursionError, OverflowError) as error:
        raise fail() from error
