#!/usr/bin/env python3
"""Read-only source-image proof for bounded cold-bootstrap preservation."""
import copy
import hashlib
import re
import time
from pathlib import Path


SCHEMA = 'orbis.controller-bootstrap-profile.v1'
# Reviewed published-source profiles are an explicit allowlist, never a tag range.
# Each tuple binds publication commit, publication digest and source image ID.
LEGACY_SOURCES = {
    ('b9299ddd36f234d086fd353368b7f7bccfa54255',
     'sha256:96dc73e58522e2d2bbaf73668228ae2bbaeb0a3e51b93a27ea4b174a5aa7a1ee',
     'sha256:96dc73e58522e2d2bbaf73668228ae2bbaeb0a3e51b93a27ea4b174a5aa7a1ee'):
        'a05ff7b95f3689acb036339ec71199df0463ccac643faa27ae131f12633500ee',
}
CAPABLE = 'controller-preservation.v1'
LEGACY = 'legacy-idempotent.v1'
DIGEST_FIELDS = {'codeSha256', 'cacheBusterSha256', 'staticSha256', 'dynamicSha256', 'localDomainSha256',
                 'tlsMarkerSha256', 'certificateSha256', 'privateKeySha256', 'envSha256', 'settingsSha256', 'staticAssetSha256', 'dynamicAssetSha256'}


class SourceBootstrapError(ValueError):
    code = 'source-bootstrap-preservation-unsupported'


def fail():
    return SourceBootstrapError('The source controller cannot yet prove a network-preserving cold restart')


def validate(proof, publication, image, *, now=None):
    if not isinstance(proof, dict) or proof.get('schema') != SCHEMA:
        raise fail()
    now = int(time.time() * 1000) if now is None else now
    if type(proof.get('observedAt')) is not int or not 0 <= now - proof['observedAt'] <= 30000:
        raise fail()
    if proof.get('profile') == CAPABLE:
        if set(proof) != {'schema', 'profile', 'codeSha256', 'observedAt'} or not digest(proof['codeSha256']):
            raise fail()
        return proof
    approved = LEGACY_SOURCES.get((publication.get('commit'), publication.get('digest'), image))
    if not approved or proof.get('profile') != LEGACY:
        raise fail()
    fields = {'schema', 'profile', 'baseVersion', 'persistTraefikConfig', 'cacheBusterExpiresAt', 'certificateNotAfter', 'observedAt', *DIGEST_FIELDS}
    if (set(proof) != fields or proof.get('codeSha256') != approved or proof.get('baseVersion') != 'v4.10.1'
            or proof.get('persistTraefikConfig') is not False
            or any(not digest(proof.get(key)) for key in DIGEST_FIELDS)
            or type(proof.get('cacheBusterExpiresAt')) is not int or proof['cacheBusterExpiresAt'] <= now + 300000
            or type(proof.get('certificateNotAfter')) is not int or proof['certificateNotAfter'] <= now + 86400000 + 300000):
        raise fail()
    return proof


def digest(value):
    return isinstance(value, str) and len(value) == 64 and all(char in '0123456789abcdef' for char in value)


def mapped_source(source, destination):
    covering = [item for item in source['Mounts'] if destination == item.get('Destination')
                or destination.startswith(str(item.get('Destination')) + '/')]
    if not covering:
        raise fail()
    selected = max(covering, key=lambda item: len(item['Destination']))
    if selected.get('Type') != 'bind':
        raise fail()
    path = Path(selected['Source']) / destination.removeprefix(selected['Destination']).lstrip('/')
    if not path.is_absolute() or path.resolve(strict=True) != path:
        raise fail()
    return str(path)


def probe(updater, record, phase):
    if phase not in {'review', 'rollback'}:
        raise fail()
    source = record['source']
    environment = dict(item.split('=', 1) for item in source['Config'].get('Env', []) if '=' in item)
    capable = environment.get('ORBIS_CONTROLLER_PRESERVE_NETWORK_ACCESS') == '1'
    if not capable and (record['current'].get('commit'), record['current'].get('digest'), source['Image']) not in LEGACY_SOURCES:
        raise fail()
    runtime, P = updater.runtime, updater.P
    require_image_startup(updater, record)
    frozen = updater.path / 'bootstrap-profile.mjs'
    if 'bootstrapProbeCodeSha256' not in record:
        path = Path(__file__).with_suffix('.mjs')
        with updater.a.protected_directory(path.parent, private=False) as directory:
            with updater.a.protected_file(directory, path.name, 512 * 1024, private=False) as code:
                updater.a.atomic(frozen, code)
                record['bootstrapProbeCodeSha256'] = hashlib.sha256(code).hexdigest()
        updater.save(record)
    with updater.a.protected_directory(updater.path) as directory:
        with updater.a.protected_file(directory, frozen.name, 512 * 1024) as code:
            if hashlib.sha256(code).hexdigest() != record['bootstrapProbeCodeSha256']:
                raise fail()
    mounts = [{'Type': 'bind', 'Source': str(frozen), 'Target': '/orbis-probe/profile.mjs', 'ReadOnly': True,
               'BindOptions': {'Propagation': 'rprivate'}}]
    if not capable:
        mounts += [{'Type': 'bind', 'Source': mapped_source(source, target), 'Target': target,
            'ReadOnly': True, 'BindOptions': {'Propagation': 'rprivate'}}
            for target in ('/data/.env', '/data/state/settings.json', '/data/traefik', '/cache')]
    body = {'Image': source['Image'], 'Entrypoint': ['node'], 'Cmd': ['/orbis-probe/profile.mjs'], 'User': '0',
            'Env': [key + '=' + value for key, value in environment.items() if key in {
                'TIPI_VERSION', 'PERSIST_TRAEFIK_CONFIG', 'LOCAL_DOMAIN', 'RUNTIPI_TRUSTED_PROXY_IPS',
                'ORBIS_CONTROLLER_PRESERVE_NETWORK_ACCESS'}],
            'Labels': {'io.orbis.bootstrap-probe': record['nonce'], 'io.orbis.bootstrap-phase': phase},
            'Healthcheck': {'Test': ['NONE']},
            'HostConfig': {'NetworkMode': 'none', 'ReadonlyRootfs': True, 'Privileged': False, 'AutoRemove': False,
                'RestartPolicy': {'Name': 'no', 'MaximumRetryCount': 0}, 'Mounts': mounts, 'CapDrop': ['ALL'],
                'CapAdd': [], 'SecurityOpt': ['no-new-privileges:true'], 'PidsLimit': 32, 'Memory': 128 * 1024 * 1024},
            'NetworkingConfig': {'EndpointsConfig': {'none': {}}}}
    entry = record.setdefault('bootstrapProbes', {}).get(phase)
    if entry is not None and entry.get('phase') in {'observed', 'retired', 'starting'}:
        if entry['phase'] == 'retired':
            old = None
        else:
            existing = runtime.engine('GET', '/containers/' + entry['id'] + '/json', allow_missing=True)
            if existing is None:
                if entry['phase'] != 'observed':
                    raise fail()
                old = None
            else:
                old = P.metadata(existing, byte_limit=8 * 1024 * 1024)
                if runtime.definition(old) != entry['definition']:
                    raise fail()
        # Never replay a completed probe's cached output on recovery. A stopped
        # starting probe may have finished before a lost reply; run a fresh one.
        retire = entry['phase'] in {'observed', 'retired'} or old['State'].get('Status') in {'exited', 'dead'}
        if retire:
            if old is not None:
                if old['State'].get('Running'):
                    raise fail()
                runtime.change(['rm', old['Id']])
            if 'id' in entry:
                entry['retiredId'] = entry.pop('id')
            entry['phase'] = 'retired'
            record.setdefault('bootstrapProbeHistory', []).append({key: value for key, value in entry.items() if key != 'body'})
            if len(record['bootstrapProbeHistory']) > 64:
                raise fail()
            entry = None
    if entry is None:
        entry = {'name': 'orbis-bootstrap-' + phase + '-' + updater.key + '-' + str(len(record.get('bootstrapProbeHistory', []))),
                 'body': body, 'bodySha256': hashlib.sha256(P.canonical(body)).hexdigest(), 'phase': 'allocating'}
        record['bootstrapProbes'][phase] = entry
        updater.save(record)
    if entry.get('body') != body or entry.get('bodySha256') != hashlib.sha256(P.canonical(body)).hexdigest():
        raise fail()
    if not entry.get('id'):
        try:
            raw = updater.lookup(entry['name'])
        except (ValueError, RuntimeError):
            response = P.metadata(runtime.engine('POST', '/containers/create?name=' + entry['name'], body))
            raw = runtime.inspect(response['Id'])
        runtime.check_intent(raw, body)
        if raw['Image'] != source['Image'] or raw['State'].get('Running'):
            raise fail()
        entry.update(id=raw['Id'], definition=runtime.definition(raw), phase='created')
        updater.save(record)
    raw = runtime.inspect(entry['id'])
    runtime.check_intent(raw, body)
    if raw['Image'] != source['Image'] or runtime.definition(raw) != entry['definition']:
        raise fail()
    if entry['phase'] == 'created' and raw['State'].get('Running'):
        raise fail()
    if entry['phase'] == 'created' or entry['phase'] == 'starting' and raw['State'].get('Status') == 'created':
        entry['phase'] = 'starting'
        updater.save(record)
        runtime.change(['start', raw['Id']])
    status = runtime.bounded_output(['docker', '--context', updater.context, 'container', 'wait', raw['Id']], 128, 25)
    if status.strip() != b'0':
        raise fail()
    output = runtime.bounded_output(['docker', '--context', updater.context, 'container', 'logs', raw['Id']], 16384, 10)
    proof = validate(P.metadata(output, byte_limit=16384), record['current'], source['Image'])
    if capable != (proof['profile'] == CAPABLE):
        raise fail()
    if phase == 'rollback' and comparable(proof) != comparable(record.get('sourceBootstrapProfile', {})):
        raise fail()
    entry.update(phase='observed', proofSha256=hashlib.sha256(P.canonical(proof)).hexdigest())
    updater.save(record)
    stopped = runtime.inspect(raw['Id'])
    if stopped['State'].get('Running') or runtime.definition(stopped) != entry['definition']:
        raise fail()
    runtime.change(['rm', raw['Id']])
    entry['retiredId'] = entry.pop('id')
    entry['phase'] = 'retired'
    updater.save(record)
    return copy.deepcopy(proof)


def comparable(proof):
    return {key: value for key, value in proof.items() if key != 'observedAt'}


def preserved_networks(updater, record):
    # The legacy normal bootstrap prunes this label. Every matching network
    # needs a pinned peer that remains running across the controller restart.
    runtime = updater.runtime
    output = runtime.bounded_output(['docker', '--context', updater.context, 'network', 'ls', '--no-trunc',
        '--filter', 'label=orbis.managed=true', '--format', '{{.ID}}'], 131072, 10)
    identifiers = output.decode('ascii').splitlines()
    if len(identifiers) > 2048 or len(set(identifiers)) != len(identifiers) or any(not re.fullmatch(r'[a-f0-9]{64}', item) for item in identifiers):
        raise fail()
    allowed = {record['proxy']['Id'], *[raw['Id'] for raw in record['peers'].values()]}
    allowed.update(identifier for identifier, raw in record.get('appIdentities', {}).items() if raw['running'])
    result = []
    for identifier in sorted(identifiers):
        raw = runtime.reader._object(['network', 'inspect', '--format', '{{json .}}', identifier])
        labels, endpoints = raw.get('Labels') or {}, raw.get('Containers')
        if raw.get('Id') != identifier or labels.get('orbis.managed') != 'true' or not isinstance(endpoints, dict):
            raise fail()
        running = []
        for candidate in sorted(set(endpoints) & allowed):
            container = runtime.inspect(candidate)
            if container['State'].get('Running') is True:
                running.append(candidate)
        if not running:
            raise fail()
        result.append({'id': identifier, 'preservedEndpoints': running})
    return result


def require_image_startup(updater, record):
    runtime, source = updater.runtime, record['source']
    image = runtime.image(source['Image'])
    defaults = image.get('Config') or {}
    actual = source['Config']
    if image.get('Id') != source['Image'] or any(actual.get(key) != defaults.get(key) for key in ('Entrypoint', 'Cmd', 'WorkingDir')):
        raise fail()
    expected_env = dict(item.split('=', 1) for item in defaults.get('Env', []) if '=' in item)
    actual_env = dict(item.split('=', 1) for item in actual.get('Env', []) if '=' in item)
    if any(actual_env.get(key) != expected_env.get(key) for key in ('NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH')):
        raise fail()
    for mount in source['Mounts']:
        destination = mount.get('Destination', '')
        if destination == '/' or any(destination == base or destination.startswith(base + '/') for base in ('/app', '/usr', '/bin', '/lib', '/lib64', '/etc')):
            raise fail()
    body = runtime.engine('GET', '/containers/' + source['Id'] + '/changes', maximum=1024 * 1024)
    changes = updater.P.metadata(b'{"changes":' + body + b'}', byte_limit=1024 * 1024 + 12).get('changes')
    if not isinstance(changes, list) or len(changes) > 8192:
        raise fail()
    for change in changes:
        path = change.get('Path') if isinstance(change, dict) else None
        if (not isinstance(path, str) or type(change.get('Kind')) is not int or change['Kind'] not in {0, 1, 2}
                or path == '/' or any(path == base or path.startswith(base + '/') for base in ('/app', '/usr', '/bin', '/lib', '/lib64', '/etc'))):
            raise fail()
