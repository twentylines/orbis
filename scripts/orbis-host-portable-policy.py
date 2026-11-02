#!/usr/bin/env python3
"""Strict, observed storage and socket policy for a future portable capture."""
import hashlib
import ipaddress
import json
import os
import re
import stat
from pathlib import Path

SCHEMA = 'orbis.portable-mount-policy.v1'
LIMIT = 1024 * 1024
HEX = re.compile(r'[a-f0-9]{64}')
DIGEST = re.compile(r'sha256:[a-f0-9]{64}')
UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}')
URN = re.compile(r'[a-z0-9][a-z0-9_-]{0,127}:[a-z0-9][a-z0-9_-]{0,127}')
NAME = re.compile(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}')


def fail():
    return ValueError('Portable mount policy requires an explicit protected storage review')


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()


def sha(value):
    return hashlib.sha256(value).hexdigest()


def path(value):
    if (not isinstance(value, str) or not value.startswith('/') or value.startswith('//') or value == '/'
            or len(value.encode()) > 4096 or any(ord(char) < 32 or ord(char) == 127 for char in value)
            or str(Path(value)) != value or any(part in {'.', '..'} for part in value.split('/')[1:])):
        raise fail()
    return value


def below(parent, child):
    return parent == child or child.startswith(parent.rstrip('/') + '/')


def matches(pattern, value):
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def exact(value, keys):
    return isinstance(value, dict) and set(value) == set(keys)


def table(body):
    if not isinstance(body, str) or len(body.encode()) > 4 * 1024 * 1024:
        raise fail()
    result = []
    def unescape(value):
        return re.sub(r'\\(040|011|012|134)', lambda match: chr(int(match[1], 8)), value)
    for row in body.splitlines():
        fields = row.split(' ')
        try:
            split = fields.index('-')
            if split < 6 or len(fields) < split + 4 or not re.fullmatch(r'[0-9]+:[0-9]+', fields[2]):
                raise fail()
            mountpoint, root = unescape(fields[4]), unescape(fields[3])
            for item in (mountpoint, root):
                if item != '/': path(item)
            if not re.fullmatch(r'[a-zA-Z0-9_.-]{1,64}', fields[split + 1]): raise fail()
            result.append({'mountId': str(int(fields[0])), 'majorMinor': fields[2], 'mountPoint': mountpoint,
                           'root': root, 'filesystem': fields[split + 1], 'source': unescape(fields[split + 2])})
        except (ValueError, IndexError, TypeError):
            raise fail()
    if not 1 <= len(result) <= 16384 or len({item['mountId'] for item in result}) != len(result): raise fail()
    return result


def observe_path(value, mounts):
    value = path(value)
    parts = Path(value).parts
    root_descriptor = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    directory = root_descriptor
    opened = []
    try:
        for index, part in enumerate(parts[1:]):
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
            if index < len(parts) - 2: flags |= os.O_DIRECTORY
            child = os.open(part, flags, dir_fd=directory)
            opened.append(child)
            details = os.fstat(child)
            if not (stat.S_ISDIR(details.st_mode) or stat.S_ISREG(details.st_mode)) or (stat.S_ISREG(details.st_mode) and details.st_nlink != 1):
                raise fail()
            directory = child
        details = os.fstat(directory)
        current = os.stat(value, follow_symlinks=False)
        seal = lambda item: (item.st_dev, item.st_ino, item.st_mode, item.st_uid, item.st_gid)
        if seal(details) != seal(current): raise fail()
        matching = [item for item in mounts if below(item['mountPoint'], value)]
        if not matching: raise fail()
        filesystem = max(matching, key=lambda item: len(item['mountPoint']))
        if filesystem['majorMinor'] != f'{os.major(details.st_dev)}:{os.minor(details.st_dev)}': raise fail()
        return {'path': value, 'device': str(details.st_dev), 'inode': str(details.st_ino), 'uid': details.st_uid,
                'gid': details.st_gid, 'mode': stat.S_IMODE(details.st_mode), 'kind': 'directory' if stat.S_ISDIR(details.st_mode) else 'file',
                'filesystem': dict(filesystem)}
    finally:
        for descriptor in reversed(opened): os.close(descriptor)
        os.close(root_descriptor)


def source_files(root, urn):
    app, store = urn.split(':')
    result = {}
    for relative in (f'apps/{store}/{app}/docker-compose.yml', f'apps/{store}/{app}/docker-compose.json',
                     f'apps/{store}/{app}/docker-compose.generated.yml', f'user-config/{store}/{app}/docker-compose.yml'):
        file = Path(root) / relative
        if not file.exists() and not file.is_symlink(): continue
        if file.parent.resolve(strict=True) != file.parent: raise fail()
        descriptor = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            before = os.fstat(descriptor)
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > 2 * 1024 * 1024: raise fail()
            body = bytearray()
            while len(body) <= 2 * 1024 * 1024:
                block = os.read(descriptor, 65536)
                if not block: break
                body.extend(block)
            after = os.fstat(descriptor)
            current = file.lstat()
            seal = lambda value: (value.st_dev, value.st_ino, value.st_mode, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
            if len(body) != before.st_size or seal(before) != seal(after) or seal(before) != seal(current): raise fail()
            result[relative] = {'bytes': len(body), 'sha256': sha(body)}
        finally: os.close(descriptor)
    if not any(name.endswith('/docker-compose.generated.yml') for name in result) or not any(name.endswith(('/docker-compose.yml', '/docker-compose.json')) and '/apps/' in '/'+name for name in result):
        raise fail()
    return result


def ports(inspect):
    bindings = inspect.get('HostConfig', {}).get('PortBindings') or {}
    if not isinstance(bindings, dict) or len(bindings) > 256: raise fail()
    result = []
    for container, values in sorted(bindings.items()):
        match = re.fullmatch(r'([0-9]{1,5})/(tcp|udp)', container)
        if not match or not 1 <= int(match[1]) <= 65535 or not isinstance(values, list) or not 1 <= len(values) <= 16: raise fail()
        for value in values:
            if not exact(value, {'HostIp', 'HostPort'}) or not isinstance(value['HostPort'], str) or not value['HostPort'].isdecimal() or not 1 <= int(value['HostPort']) <= 65535: raise fail()
            address = value['HostIp']
            if address != '': ipaddress.ip_address(address)
            result.append({'containerPort': int(match[1]), 'protocol': match[2], 'hostIP': address, 'hostPort': int(value['HostPort'])})
    if len({canonical(item) for item in result}) != len(result): raise fail()
    return sorted(result, key=canonical)


def container_observation(container):
    return {'Id':container['Id'],'Image':container['Image'],'Config':container['Config'],'HostConfig':container['HostConfig'],
            'Mounts':sorted(container['Mounts'],key=lambda item:item['Destination']),
            'Networks':{name:value.get('NetworkID') for name,value in sorted(container['NetworkSettings']['Networks'].items())}}


def build(point_id, configuration_sha256, root, app_containers, included_roots, media_approvals, mounts, network_inspects, *, context_sha256, daemon_sha256):
    """Inputs are daemon/root-policy observations, never an incoming policy JSON."""
    if not matches(UUID, point_id) or any(not matches(HEX, value) for value in (configuration_sha256,context_sha256,daemon_sha256)) or not 0 <= len(app_containers) <= 512: raise fail()
    root = Path(path(str(root)))
    included_roots = [path(str(value)) for value in included_roots]
    if len(set(included_roots)) != len(included_roots): raise fail()
    apps, observed_sources, used_media = [], {}, set()
    for container in sorted(app_containers, key=lambda item: item.get('Id', '')):
        labels = container.get('Config', {}).get('Labels') or {}
        urn, project, service = (labels.get(key) for key in ('runtipi.appurn', 'com.docker.compose.project', 'com.docker.compose.service'))
        if (labels.get('runtipi.managed') != 'true' or not matches(URN, urn) or not matches(NAME, project) or not matches(NAME, service)
                or not matches(HEX, container.get('Id')) or not matches(DIGEST, container.get('Image'))):
            raise fail()
        files = source_files(root, urn)
        observed_sources[urn] = files
        bound = []
        values = container.get('Mounts')
        if not isinstance(values, list) or len(values) > 256 or len({item.get('Destination') for item in values if isinstance(item, dict)}) != len(values): raise fail()
        for item in sorted(values, key=lambda item: item.get('Destination', '')):
            if item.get('Type') != 'bind' or type(item.get('RW')) is not bool: raise fail()
            destination, source = path(item.get('Destination')), path(item.get('Source'))
            key = urn + '\n' + service + '\n' + destination
            approved_media = media_approvals.get(key)
            if approved_media is not None:
                if approved_media != source or any(below(inside, source) or below(source, inside) for inside in included_roots): raise fail()
                used_media.add(key)
                role, byte_policy = 'excluded-media', 'excluded'
            elif any(below(inside, source) for inside in included_roots): role, byte_policy = 'application-data', 'included'
            else: raise fail()
            bound.append({'key': sha((urn+'\n'+service+'\n'+destination).encode()), 'destination': destination, 'readOnly': not item['RW'],
                          'role': role, 'bytesPolicy': byte_policy, 'source': observe_path(source, mounts)})
        networks = []
        for name, endpoint in sorted(container.get('NetworkSettings', {}).get('Networks', {}).items()):
            network = network_inspects.get(name)
            if (not matches(NAME, name) or not isinstance(network, dict) or network.get('Name') != name
                    or not matches(HEX, network.get('Id')) or (endpoint.get('NetworkID') != network['Id']
                        and (endpoint.get('NetworkID') not in {'',None} or container.get('State',{}).get('Running') or container.get('State',{}).get('Restarting')))
                    or network.get('Driver') != 'bridge' or network.get('Scope') != 'local' or type(network.get('Internal')) is not bool): raise fail()
            aliases = endpoint.get('Aliases') or []
            if not isinstance(aliases, list) or len(aliases) > 64 or any(not matches(NAME, alias) for alias in aliases): raise fail()
            definition = {key: network.get(key) for key in ('Name', 'Driver', 'Scope', 'Internal', 'Attachable', 'EnableIPv6', 'IPAM', 'Options', 'Labels')}
            networks.append({'name': name, 'sourceNetworkId': network['Id'], 'driver': 'bridge', 'scope': 'local', 'internal': network['Internal'],
                             'configurationSha256': sha(canonical(definition)), 'aliases': sorted(set(aliases))})
        if not networks: raise fail()
        configuration = {key: container.get(key) for key in ('Config', 'HostConfig')}
        apps.append({'containerId': container['Id'], 'appUrn': urn, 'project': project, 'service': service, 'imageId': container['Image'],
                     'containerConfigurationSha256': sha(canonical(configuration)), 'composeFiles': files, 'mounts': bound,
                     'ports': ports(container), 'networks': networks})
    if len({item['containerId'] for item in apps}) != len(apps) or set(media_approvals)-used_media: raise fail()
    for urn, files in observed_sources.items():
        if source_files(root, urn) != files: raise fail()
    value = {'schema': SCHEMA, 'version': 1, 'pointId': point_id, 'configurationSetSha256': configuration_sha256,
             'sourceRootSha256': sha(str(root).encode()), 'sourceContextSha256':context_sha256, 'sourceDaemonSha256':daemon_sha256, 'scope': 'declared-app-data-and-excluded-media.v1', 'apps': apps}
    value['sha256'] = sha((SCHEMA+'\n').encode()+canonical(value))
    if len(canonical(value)) > LIMIT: raise fail()
    return validate(value)


def validate(value):
    if (not exact(value, {'schema','version','pointId','configurationSetSha256','sourceRootSha256','sourceContextSha256','sourceDaemonSha256','scope','apps','sha256'})
            or value['schema'] != SCHEMA or type(value['version']) is not int or value['version'] != 1
            or value['scope'] != 'declared-app-data-and-excluded-media.v1' or not matches(UUID, value['pointId'])
            or any(not matches(HEX, value[key]) for key in ('configurationSetSha256','sourceRootSha256','sourceContextSha256','sourceDaemonSha256','sha256'))
            or not isinstance(value['apps'], list) or len(value['apps']) > 512 or len(canonical(value)) > LIMIT): raise fail()
    descriptor = {key:item for key,item in value.items() if key != 'sha256'}
    if sha((SCHEMA+'\n').encode()+canonical(descriptor)) != value['sha256']: raise fail()
    if any(not isinstance(item,dict) for item in value['apps']): raise fail()
    if [item.get('containerId') for item in value['apps']] != sorted(item.get('containerId','') for item in value['apps']): raise fail()
    ids, keys = set(), set()
    for app in value['apps']:
        if (not exact(app, {'containerId','appUrn','project','service','imageId','containerConfigurationSha256','composeFiles','mounts','ports','networks'})
                or not matches(HEX, app['containerId']) or app['containerId'] in ids or not matches(URN, app['appUrn'])
                or not matches(NAME, app['project']) or not matches(NAME, app['service']) or not matches(DIGEST, app['imageId'])
                or not matches(HEX, app['containerConfigurationSha256']) or not isinstance(app['composeFiles'], dict) or not 1 <= len(app['composeFiles']) <= 4
                or not isinstance(app['mounts'], list) or len(app['mounts']) > 256 or not isinstance(app['ports'], list) or len(app['ports']) > 4096
                or not isinstance(app['networks'], list) or not 1 <= len(app['networks']) <= 64): raise fail()
        ids.add(app['containerId'])
        if any(not isinstance(item,dict) for group in ('mounts','ports','networks') for item in app[group]): raise fail()
        name, store = app['appUrn'].split(':')
        allowed = {f'apps/{store}/{name}/docker-compose.yml',f'apps/{store}/{name}/docker-compose.json',f'apps/{store}/{name}/docker-compose.generated.yml',f'user-config/{store}/{name}/docker-compose.yml'}
        if f'apps/{store}/{name}/docker-compose.generated.yml' not in app['composeFiles'] or not ({f'apps/{store}/{name}/docker-compose.yml',f'apps/{store}/{name}/docker-compose.json'} & set(app['composeFiles'])): raise fail()
        if [item.get('destination') for item in app['mounts']] != sorted(item.get('destination','') for item in app['mounts']): raise fail()
        if len({canonical(item) for item in app['ports']}) != len(app['ports']) or app['ports'] != sorted(app['ports'],key=canonical): raise fail()
        network_names=[item.get('name') for item in app['networks']]
        if network_names != sorted(network_names) or len(set(network_names)) != len(network_names): raise fail()
        for file, info in app['composeFiles'].items():
            if file not in allowed or not exact(info, {'bytes','sha256'}) or type(info['bytes']) is not int or not 0 <= info['bytes'] <= 2*1024*1024 or not matches(HEX, info['sha256']): raise fail()
        destinations = set()
        for item in app['mounts']:
            if (not exact(item, {'key','destination','readOnly','role','bytesPolicy','source'}) or not matches(HEX, item['key']) or item['key'] in keys
                    or type(item['readOnly']) is not bool or item['role'] not in {'application-data','excluded-media'}
                    or item['bytesPolicy'] != ('included' if item['role'] == 'application-data' else 'excluded')): raise fail()
            destination = path(item['destination'])
            if destination in destinations or item['key'] != sha((app['appUrn']+'\n'+app['service']+'\n'+destination).encode()): raise fail()
            destinations.add(destination); keys.add(item['key']); state = item['source']
            if not exact(state, {'path','device','inode','uid','gid','mode','kind','filesystem'}): raise fail()
            path(state['path'])
            if (state['kind'] not in {'file','directory'} or any(not isinstance(state[key], str) or not re.fullmatch(r'[0-9]+',state[key]) for key in ('device','inode'))
                    or any(type(state[key]) is not int or state[key] < 0 for key in ('uid','gid','mode')) or state['mode'] > 0o7777): raise fail()
            fs = state['filesystem']
            if not exact(fs, {'mountId','majorMinor','mountPoint','root','filesystem','source'}) or not isinstance(fs['mountId'],str) or not re.fullmatch(r'[1-9][0-9]*',fs['mountId']) or not re.fullmatch(r'[0-9]+:[0-9]+',str(fs['majorMinor'])): raise fail()
            for key in ('mountPoint','root'):
                if fs[key] != '/': path(fs[key])
            if not below(fs['mountPoint'],state['path']) or not re.fullmatch(r'[a-zA-Z0-9_.-]{1,64}',str(fs['filesystem'])) or not isinstance(fs['source'],str) or not 1 <= len(fs['source'].encode()) <= 4096 or any(ord(char)<32 or ord(char)==127 for char in fs['source']): raise fail()
        for port in app['ports']:
            if (not exact(port, {'containerPort','protocol','hostIP','hostPort'}) or port['protocol'] not in {'tcp','udp'}
                    or any(type(port[key]) is not int or not 1 <= port[key] <= 65535 for key in ('containerPort','hostPort'))): raise fail()
            if port['hostIP'] != '': ipaddress.ip_address(port['hostIP'])
        for network in app['networks']:
            if (not exact(network, {'name','sourceNetworkId','driver','scope','internal','configurationSha256','aliases'})
                    or not matches(NAME, network['name']) or not matches(HEX, network['sourceNetworkId'])
                    or network['driver'] != 'bridge' or network['scope'] != 'local' or type(network['internal']) is not bool
                    or not matches(HEX, network['configurationSha256']) or not isinstance(network['aliases'],list)
                    or len(network['aliases']) > 64 or any(not matches(NAME, alias) for alias in network['aliases']) or network['aliases'] != sorted(set(network['aliases']))): raise fail()
    return json.loads(canonical(value))


def require_no_unknown_writers(inspections, known_ids, included_roots, policy):
    validate(policy)
    guarded = [path(str(value)) for value in included_roots]
    guarded += [item['source']['path'] for app in policy['apps'] for item in app['mounts']]
    for container in inspections:
        if container.get('Id') in known_ids: continue
        for item in container.get('Mounts') or []:
            if item.get('RW') is True and item.get('Type') == 'bind':
                source = path(item.get('Source'))
                if any(below(root,source) or below(source,root) for root in guarded): raise fail()


def addresses_overlap(first, second):
    return first in {'','0.0.0.0','::'} or second in {'','0.0.0.0','::'} or first == second


def destination_plan(policy, *, included_roots, remaps, port_decisions, mounts, occupied_ports, network_inspects):
    policy = validate(policy)
    included_roots = [path(str(value)) for value in included_roots]
    allowed_keys = {item['key'] for app in policy['apps'] for item in app['mounts']}
    if not isinstance(remaps,dict) or set(remaps)-allowed_keys or not isinstance(port_decisions,dict): raise fail()
    for root in included_roots: observe_path(root,mounts)
    entries, blockers, requested_ports, networks, seen_ports = [], [], [], {}, set()
    for app in policy['apps']:
        for item in app['mounts']:
            target = path(remaps.get(item['key'],item['source']['path']))
            if any(below(root,target) or below(target,root) for root in ('/etc','/proc','/sys','/dev','/run','/var/run','/var/lib/docker')):
                raise fail()
            if item['bytesPolicy'] == 'included' and not any(below(root,target) for root in included_roots):
                blockers.append({'code':'included-data-remap-required','key':item['key']});continue
            create, observed = False, None
            try: observed = observe_path(target,mounts)
            except FileNotFoundError:
                if item['bytesPolicy'] == 'excluded':
                    blockers.append({'code':'required-media-mount-missing','key':item['key']});continue
                parent = Path(target).parent
                while not parent.exists() and not parent.is_symlink(): parent=parent.parent
                if not any(below(root,str(parent)) for root in included_roots): raise fail()
                observed = observe_path(str(parent),mounts)
                create = True
            if (create and observed['kind'] != 'directory') or (not create and observed['kind'] != item['source']['kind']):
                blockers.append({'code':'required-path-kind-mismatch','key':item['key']});continue
            if (item['bytesPolicy']=='excluded' and item['source']['filesystem']['mountPoint'] != '/'
                    and observed['filesystem']['mountPoint']=='/'):
                blockers.append({'code':'required-media-disk-not-mounted','key':item['key']});continue
            if item['key'] not in remaps and observed != item['source']:
                blockers.append({'code':'explicit-mount-remap-required','key':item['key']})
            entries.append({'key':item['key'],'targetPath':target,'role':item['role'],'readOnly':item['readOnly'],
                            'bytesPolicy':item['bytesPolicy'],'sourceKind':item['source']['kind'],'createFromRetainedData':create,'observed':observed})
        for port in app['ports']:
            key=sha(canonical({'appUrn':app['appUrn'],'service':app['service'],**port})); seen_ports.add(key)
            chosen=port_decisions.get(key,{'hostIP':port['hostIP'],'hostPort':port['hostPort']})
            if not exact(chosen,{'hostIP','hostPort'}) or type(chosen['hostPort']) is not int or not 1<=chosen['hostPort']<=65535: raise fail()
            if chosen['hostIP']!='': ipaddress.ip_address(chosen['hostIP'])
            request={'key':key,'containerPort':port['containerPort'],'protocol':port['protocol'],**chosen}
            if any(other['protocol']==request['protocol'] and other['hostPort']==request['hostPort'] and addresses_overlap(other['hostIP'],request['hostIP']) for other in occupied_ports+requested_ports):
                blockers.append({'code':'host-port-collision','key':key})
            requested_ports.append(request)
        for network in app['networks']:
            current=network_inspects.get(network['name'])
            if current is None:
                blockers.append({'code':'network-review-required','key':network['name']});continue
            definition={key:current.get(key) for key in ('Name','Driver','Scope','Internal','Attachable','EnableIPv6','IPAM','Options','Labels')}
            if (current.get('Driver')!='bridge' or current.get('Scope')!='local' or sha(canonical(definition))!=network['configurationSha256']):
                blockers.append({'code':'network-definition-conflict','key':network['name']})
            networks[network['name']]={'id':current.get('Id'),'configurationSha256':sha(canonical(definition))}
    if set(port_decisions)-seen_ports: raise fail()
    paths=[item['targetPath'] for item in entries]
    if len(paths)!=len(set(paths)): raise fail()
    value={'schema':'orbis.portable-destination-plan.v1','pointId':policy['pointId'],'mountPolicySha256':sha(canonical(policy)),
           'mounts':sorted(entries,key=lambda item:item['key']),'ports':sorted(requested_ports,key=lambda item:item['key']),
           'networks':networks,'blockers':sorted(blockers,key=canonical)}
    value['sha256']=sha(b'orbis.portable-destination-plan.v1\n'+canonical(value))
    return value
