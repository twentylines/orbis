#!/usr/bin/env python3
"""Pure fail-closed conflict check over independently trusted root observations.

No observations, socket ownership or plan authority are collected here. This is
only a snapshot check, never an atomic port reservation. Root must recheck just
before durable commit and before start, and handle late conflicts forward-only.
"""
import copy
import importlib.util
import ipaddress
from pathlib import Path
import re


SPEC = importlib.util.spec_from_file_location('orbis_app_port_compiler', Path(__file__).with_name('orbis-host-app-create-intent.py'))
COMPILER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(COMPILER)
HEX = re.compile(r'[a-f0-9]{64}')
MAX_CONTAINERS = 4096
MAX_CLAIMS = 65536
MAX_SOCKETS = 65536
MAX_COMPARISONS = 262144


def fail(reason):
    return ValueError('Historical app port policy refused: ' + reason)


def _address(value, *, blank=False):
    if not isinstance(value, str) or '%' in value or '[' in value or ']' in value:
        raise fail('invalid address')
    if value == '' and blank: return ''
    address = ipaddress.ip_address(value)
    # Mapped IPv4 must not bypass IPv4 overlap checks through IPv6 spelling.
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        address = address.ipv4_mapped
    return str(address)


def _exposed(value):
    if value is None: return set()
    if not isinstance(value, dict) or any(item != {} for item in value.values()):
        raise fail('incomplete exposed-port observation')
    COMPILER._ports({key: None for key in value}, assigned=True)
    return set(value)


def _claims(value, owner, *, desired=False):
    parsed = COMPILER._ports(value, assigned=not desired)
    result = []
    for exposed, bindings in parsed.items():
        if desired and not bindings: raise fail('unresolved desired port binding')
        for address, number in bindings or []:
            if number in ('', '0'): raise fail('unresolved desired port allocation')
            protocol = exposed.split('/')[1]
            if protocol == 'sctp': raise fail('SCTP kernel coverage unsupported')
            result.append({'containerId': owner, 'containerPort': exposed, 'protocol': protocol,
                           'address': _address(address, blank=desired), 'port': int(number)})
    return result


def _overlaps(left, right):
    if left['protocol'] != right['protocol'] or left['port'] != right['port']: return False
    a, b = left['address'], right['address']
    if not a or not b: return True
    a, b = ipaddress.ip_address(a), ipaddress.ip_address(b)
    if a.version == b.version: return a == b or a.is_unspecified or b.is_unspecified
    ipv6, record = (a, left) if a.version == 6 else (b, right)
    return ipv6.is_unspecified and record.get('v6only') is not True


def _dual_expansion(left, right):
    return (left['containerId'] == right['containerId'] and left['containerPort'] == right['containerPort']
            and left['address'] and right['address']
            and ipaddress.ip_address(left['address']).version != ipaddress.ip_address(right['address']).version)


def _desired(plans):
    if not isinstance(plans, list) or len(plans) > MAX_CONTAINERS: raise fail('invalid protected plans')
    result, sources, names, identities = [], set(), set(), set()
    for plan in plans:
        if (not isinstance(plan, dict) or set(plan) != {'appUrn', 'service', 'ordinal', 'sourceId', 'wasRunning', 'compiled'}
                or not isinstance(plan['sourceId'], str) or HEX.fullmatch(plan['sourceId']) is None
                or not isinstance(plan['appUrn'], str) or not plan['appUrn']
                or not isinstance(plan['service'], str) or not plan['service']
                or type(plan['ordinal']) is not int or not 1 <= plan['ordinal'] <= 1024
                or type(plan['wasRunning']) is not bool): raise fail('invalid protected plan identity')
        identity = (plan['appUrn'], plan['service'], plan['ordinal'])
        compiled = plan['compiled']
        if (not isinstance(compiled, dict) or set(compiled) != {'name', 'body', 'networkIds'}
                or not isinstance(compiled['name'], str)
                or re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,254}', compiled['name']) is None
                or not isinstance(compiled['networkIds'], dict)
                or any(not isinstance(item, str) or HEX.fullmatch(item) is None for item in compiled['networkIds'].values())
                or plan['sourceId'] in sources or compiled['name'] in names or identity in identities):
            raise fail('duplicate or invalid protected plan identity')
        sources.add(plan['sourceId']); names.add(compiled['name']); identities.add(identity)
        body = compiled['body']
        if (not isinstance(body, dict) or not isinstance(body.get('HostConfig'), dict)
                or not isinstance(body.get('Image'), str) or COMPILER.IMAGE.fullmatch(body['Image']) is None):
            raise fail('incomplete compiled create request')
        host = body['HostConfig']
        if host.get('PublishAllPorts') not in (None, False) or type(host.get('PublishAllPorts', False)) not in (bool, type(None)):
            raise fail('publish-all desired ports unsupported')
        if host.get('NetworkMode') in {'host', 'none'} and host.get('PortBindings'):
            raise fail('desired network mode cannot prove published ports')
        claims = _claims(host.get('PortBindings'), plan['sourceId'], desired=True)
        exposed = _exposed(body.get('ExposedPorts'))
        if any(row['containerPort'] not in exposed for row in claims): raise fail('desired port missing exposed declaration')
        if plan['wasRunning']: result.extend(claims)
        if len(result) > MAX_CLAIMS: raise fail('too many desired bindings')
    return result


def _current(containers, retirement_ids):
    if not isinstance(containers, list) or len(containers) > MAX_CONTAINERS: raise fail('incomplete daemon enumeration')
    if not isinstance(retirement_ids, (list, tuple, set, frozenset)) or len(retirement_ids) > MAX_CONTAINERS:
        raise fail('invalid protected retirement set')
    if any(not isinstance(identity, str) or HEX.fullmatch(identity) is None for identity in retirement_ids):
        raise fail('invalid protected retirement ID')
    retirement = set(retirement_ids)
    if len(retirement) != len(retirement_ids): raise fail('duplicate retirement ID')
    result, observed = [], {}
    for raw in containers:
        if (not isinstance(raw, dict) or not isinstance(raw.get('Id'), str) or HEX.fullmatch(raw['Id']) is None
                or raw['Id'] in observed or not isinstance(raw.get('State'), dict)
                or not isinstance(raw.get('Config'), dict) or 'ExposedPorts' not in raw['Config']
                or not isinstance(raw.get('HostConfig'), dict)
                or not {'PortBindings', 'PublishAllPorts'} <= set(raw['HostConfig'])
                or not isinstance(raw.get('NetworkSettings'), dict)
                or not {'Networks', 'Ports'} <= set(raw['NetworkSettings'])
                or not isinstance(raw['NetworkSettings']['Networks'], dict)):
            raise fail('incomplete current container observation')
        observed[raw['Id']] = raw
        state, host = raw['State'], raw['HostConfig']
        if (any(type(state.get(key)) is not bool for key in ('Running', 'Paused', 'Restarting'))
                or state['Paused'] and not state['Running'] or type(host['PublishAllPorts']) is not bool):
            raise fail('incomplete current state observation')
        exposed = _exposed(raw['Config']['ExposedPorts'])
        intended = COMPILER._ports(host['PortBindings'], assigned=False)
        assigned = COMPILER._ports(raw['NetworkSettings']['Ports'], assigned=True)
        claims = _claims(raw['NetworkSettings']['Ports'], raw['Id'])
        if any(port not in exposed for port in assigned): raise fail('assigned port missing exposed declaration')
        active = any(state[key] for key in ('Running', 'Paused', 'Restarting'))
        if active:
            if host['PublishAllPorts']:
                if set(assigned) != exposed or any(not assigned[key] for key in exposed):
                    raise fail('partial publish-all observation')
            else:
                if (any(not rows for rows in intended.values())
                        or set(intended) != {key for key, rows in assigned.items() if rows}):
                    raise fail('partial active port observation')
                COMPILER._creation_ports(raw, True)
            result.extend(claims)
        elif claims:
            raise fail('stopped container has stale published assignments')
        if len(result) > MAX_CLAIMS: raise fail('too many current bindings')
    if not retirement <= set(observed): raise fail('retirement ID absent from current enumeration')
    return result, observed, retirement


def _sockets(envelope):
    if (not isinstance(envelope, dict) or set(envelope) != {'complete', 'namespace', 'protocols', 'sockets'}
            or envelope['complete'] is not True or envelope['namespace'] != 'host'
            or envelope['protocols'] != ['tcp', 'udp']
            or not isinstance(envelope['sockets'], list) or len(envelope['sockets']) > MAX_SOCKETS):
        raise fail('complete host TCP/UDP socket coverage required')
    result, inodes = [], set()
    for raw in envelope['sockets']:
        if (not isinstance(raw, dict) or set(raw) != {'protocol', 'address', 'port', 'inode', 'v6only'}
                or raw['protocol'] not in {'tcp', 'udp'} or type(raw['port']) is not int or not 1 <= raw['port'] <= 65535
                or type(raw['inode']) is not int or not 0 <= raw['inode'] <= 9007199254740991
                or raw['inode'] > 0 and raw['inode'] in inodes or raw['v6only'] is not None and type(raw['v6only']) is not bool):
            raise fail('invalid or duplicate kernel socket observation')
        address = _address(raw['address'])
        if ipaddress.ip_address(address).version == 4 and raw['v6only'] is not None:
            raise fail('IPv4 socket has invalid v6-only proof')
        if raw['inode'] > 0: inodes.add(raw['inode'])
        record = copy.deepcopy(raw); record['address'] = address
        result.append(record)
    return result


def _groups(records):
    result = {}
    for record in records: result.setdefault((record['protocol'], record['port']), []).append(record)
    return result


def verify_port_claims(plans, current_containers, retirement_ids, host_sockets, *, prove_host_socket_owner=None):
    """Return True or fail closed; this function performs no IO or host effects.

    All inputs must be independently admitted root-owned observations, never bare
    caller JSON. current_containers must come from a SUCCESSFUL COMPLETE daemon
    enumeration with every container inspected; [] from failure is not evidence.
    host_sockets is exactly {complete:True,namespace:'host',protocols:['tcp','udp'],
    sockets:[{protocol,address,port,inode,v6only}]}. Coverage must include both
    address families, TCP listeners and bound UDP. namespace/context proof belongs
    to root. SCTP bindings are explicitly unsupported. Empty socket lists are
    accepted only inside this complete collector envelope.

    prove_host_socket_owner(socket, current_container, current_binding) must return
    True to exempt ANY conflicting kernel socket. Only an exact observed retiring
    binding with matching protocol/address/port is offered. Root must prove that
    inode is the exact retiring Docker allocator/proxy, not infer from tuple or
    labels. Missing, false or uncertain ownership fails conservatively. Callback
    exceptions propagate; no process/path/command inspection occurs here.
    Inode0 records (including TIME_WAIT) are unowned conflicts; they never reach
    the ownership callback. Duplicate zero is permitted; positive duplicates fail.
    """
    if prove_host_socket_owner is not None and not callable(prove_host_socket_owner):
        raise fail('invalid ownership verifier')
    # Full bounded structures protect pure parsing; callbacks are excluded.
    COMPILER._bounded({'plans': plans, 'currentContainers': current_containers, 'hostSockets': host_sockets})
    desired = _desired(plans)
    current, observed, retirement = _current(current_containers, retirement_ids)
    sockets = _sockets(host_sockets)
    desired_groups, current_groups, socket_groups = _groups(desired), _groups(current), _groups(sockets)
    retiring_exact = {}
    for binding in current:
        if binding['containerId'] in retirement:
            retiring_exact.setdefault((binding['protocol'], binding['port'], binding['address']), []).append(binding)
    comparisons = 0
    def compare(left, right):
        nonlocal comparisons
        comparisons += 1
        if comparisons > MAX_COMPARISONS: raise fail('conflict comparison bound exceeded')
        return _overlaps(left, right)
    for key, claims in desired_groups.items():
        for index, claim in enumerate(claims):
            for earlier in claims[:index]:
                if compare(claim, earlier) and not _dual_expansion(claim, earlier):
                    raise fail('conflicting desired bindings')
            for existing in current_groups.get(key, []):
                if compare(claim, existing) and existing['containerId'] not in retirement:
                    raise fail('active non-retiring daemon binding conflicts')
            for socket in socket_groups.get(key, []):
                if not compare(claim, socket): continue
                if socket['inode'] == 0: raise fail('unowned kernel socket conflicts')
                if prove_host_socket_owner is None: raise fail('conflicting host socket lacks ownership proof')
                candidates = retiring_exact.get((socket['protocol'], socket['port'], socket['address']), [])
                if not any(prove_host_socket_owner(copy.deepcopy(socket), copy.deepcopy(observed[binding['containerId']]),
                                                    copy.deepcopy(binding)) is True for binding in candidates):
                    raise fail('conflicting host socket is not proven retiring Docker ownership')
    return True
