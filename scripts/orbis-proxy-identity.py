#!/usr/bin/env python3
"""Verify the live proxy's host-local mutable identity outside backup roots."""
import argparse
import hashlib
import importlib.util
import json
import os
import stat
import sys
from pathlib import Path


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HOST = load('orbis-host.py', 'orbis_host_for_proxy_identity')
A, P = HOST.AUTHORITY, HOST.IDENTITY.PUBLICATION
SCHEMA = 'orbis.proxy-host-identity.v1'
POLICY = 'preserve-live-proxy-identity.v1'


def fail():
    return ValueError('Proxy mutable identity overlaps backup data or lacks protected ownership. Existing proxy data was preserved. An explicit proxy layout migration is required before coherent Time Machine capture.')


def adoption_module():
    return load('orbis-proxy-adoption.py', 'orbis_adoption_for_proxy_identity')


def adoption_selected(root):
    layout = A.LAYOUT
    try:
        layout.STATE_ROOT.lstat()
    except FileNotFoundError:
        return False
    return layout.read(root) is not None and (layout.namespace(root) / 'proxy-config').exists()


def configuration_path(root):
    if adoption_selected(root):
        return adoption_module().execution_path(root)
    return Path(root) / 'traefik'


def shared_path(root):
    if adoption_selected(root):
        return A.LAYOUT.namespace(root) / 'proxy-identity'
    return root.parent / ('.' + root.name + '.orbis-proxy-identity')


def receipt_path(root):
    return root.parent / ('.' + root.name + '.orbis-proxy-identity.json')


def declaration(root):
    return {'schema': SCHEMA, 'policy': POLICY, 'configuration': {'source': str(configuration_path(root)), 'destination': '/etc/traefik', 'readOnly': True,
            'capture': 'encrypted-review-only', 'restore': 'preserve-live'},
            'mutableIdentity': {'source': str(shared_path(root)), 'destination': '/shared', 'capture': 'excluded', 'restore': 'preserve-live'}}


def initialize(root):
    root = Path(root)
    with A.protected_directory(root.parent, private=False):
        pass
    store, receipt = shared_path(root), receipt_path(root)
    if receipt.exists() or receipt.is_symlink():
        with A.protected_directory(root.parent, private=False) as directory:
            with A.protected_file(directory, receipt.name, 4096) as body:
                intent = P.metadata(body)
        if intent.get('phase') == 'owned':
            return owned(root)
        expected = {'schema': SCHEMA, 'policy': POLICY, 'phase': 'allocating',
                    'rootSha256': hashlib.sha256(str(root).encode()).hexdigest(), 'directorySha256': hashlib.sha256(str(store).encode()).hexdigest()}
        if intent != expected:
            raise fail()
    else:
        if store.exists() or store.is_symlink():
            raise fail()
        intent = {'schema': SCHEMA, 'policy': POLICY, 'phase': 'allocating',
                  'rootSha256': hashlib.sha256(str(root).encode()).hexdigest(), 'directorySha256': hashlib.sha256(str(store).encode()).hexdigest()}
        A.atomic(receipt, P.canonical(intent))
    if not store.exists() and not store.is_symlink():
        store.mkdir(mode=0o700)
    with A.protected_directory(store) as directory:
        if os.listdir(directory):
            raise fail()
        details = os.fstat(directory)
        value = {'schema': SCHEMA, 'policy': POLICY, 'phase': 'owned', 'rootSha256': hashlib.sha256(str(root).encode()).hexdigest(),
                 'directorySha256': hashlib.sha256(str(store).encode()).hexdigest(), 'device': str(details.st_dev), 'inode': str(details.st_ino),
                 'uid': details.st_uid, 'gid': details.st_gid, 'mode': stat.S_IMODE(details.st_mode)}
    # Receipt is outside every container mount, including writable /shared.
    A.atomic(receipt, P.canonical(value))
    return value


def owned(root, context=None, proxy=None):
    if adoption_selected(root):
        if context is None or proxy is None:
            raise fail()
        return adoption_module().verified_authority(root, context, proxy)
    store, receipt = shared_path(root), receipt_path(root)
    with A.protected_directory(root.parent, private=False) as parent:
        with A.protected_file(parent, receipt.name, 4096) as body:
            value = P.metadata(body)
    with A.protected_directory(store) as directory:
        details = os.fstat(directory)
        expected = {'schema': SCHEMA, 'policy': POLICY, 'phase': 'owned', 'rootSha256': hashlib.sha256(str(root).encode()).hexdigest(),
                    'directorySha256': hashlib.sha256(str(store).encode()).hexdigest(), 'device': str(details.st_dev), 'inode': str(details.st_ino),
                    'uid': details.st_uid, 'gid': details.st_gid, 'mode': stat.S_IMODE(details.st_mode)}
        if value != expected:
            raise fail()
    return value


def observe(root, context, proxy):
    root = Path(root)
    HOST.IDENTITY.binding(str(root), context)
    labels = proxy.get('Config', {}).get('Labels') or {}
    if (labels.get('com.docker.compose.project') != 'runtipi' or labels.get('com.docker.compose.service') != 'runtipi-reverse-proxy'
            or labels.get('com.docker.compose.project.working_dir') != str(root) or not proxy.get('State', {}).get('Running')
            or proxy['State'].get('Paused') or proxy['State'].get('Restarting')):
        raise fail()
    ownership = owned(root, context, proxy)
    mounts = proxy.get('Mounts')
    if not isinstance(mounts, list):
        raise fail()
    config = [item for item in mounts if item.get('Destination') == '/etc/traefik']
    shared = [item for item in mounts if item.get('Destination') == '/shared']
    if (len(config) != 1 or config[0].get('Type') != 'bind' or config[0].get('Source') != str(configuration_path(root)) or config[0].get('RW') is not False
            or len(shared) != 1 or shared[0].get('Type') != 'bind' or shared[0].get('Source') != str(shared_path(root)) or shared[0].get('RW') is not True):
        raise fail()
    for item in mounts:
        source = item.get('Source')
        if item.get('RW') is True and (item.get('Type') != 'bind' or source != str(shared_path(root))):
            raise fail()
    if adoption_selected(root):
        static_sha = ownership['static']['sha256']
        root_sha = hashlib.sha256(str(root).encode()).hexdigest()
    else:
        with A.protected_directory(root / 'traefik', private=False) as directory:
            with A.protected_file(directory, 'traefik.yml', 1024 * 1024, private=False) as body:
                static_sha = hashlib.sha256(body).hexdigest()
        root_sha = ownership['rootSha256']
    image = proxy.get('Image')
    identifier = proxy.get('Id')
    if not HOST.IDENTITY.hashed(image) or not isinstance(identifier, str) or not HOST.IDENTITY.HEX.fullmatch(identifier):
        raise fail()
    descriptor = {'schema': 'orbis.proxy-host-identity-policy.v1', 'policy': POLICY,
                  'rootSha256': root_sha, 'dockerContextSha256': hashlib.sha256(context.encode()).hexdigest(),
                  'configuration': {'destination': '/etc/traefik', 'readOnly': True, 'staticSha256': static_sha,
                                    'capture': 'encrypted-review-only', 'restore': 'preserve-live'},
                  'mutableIdentity': {'destination': '/shared', 'capture': 'excluded', 'restore': 'preserve-live',
                                      'ownershipSha256': hashlib.sha256(P.canonical(ownership)).hexdigest()},
                  'proxy': {'containerId': identifier, 'imageId': image}}
    descriptor['sha256'] = hashlib.sha256(b'orbis.proxy-host-identity-policy.v1\n' + P.canonical(descriptor)).hexdigest()
    return descriptor


def observe_current(root, context):
    endpoint = HOST.docker(context, ['context', 'inspect', context, '--format', '{"host":{{json .Endpoints.docker.Host}}}'], root)
    if endpoint.returncode:
        raise fail()
    address = P.metadata(endpoint.stdout.encode()).get('host')
    if not isinstance(address, str) or not address.startswith('unix:///'):
        raise fail()
    result = HOST.docker(context, ['container', 'inspect', '--format', '{{json .}}', 'runtipi-reverse-proxy'], root)
    if result.returncode:
        raise fail()
    return observe(root, context, P.metadata(result.stdout.encode(), byte_limit=8 * 1024 * 1024))


def migration_plan(root, context, proxy):
    # A read-only plan deliberately does not copy a still-writing ACME store or
    # restart the proxy. A reviewed, separately authorized cutover is required.
    labels = proxy.get('Config', {}).get('Labels') or {}
    expected = str(root / 'traefik/shared')
    stores = [item for item in proxy.get('Mounts', []) if item.get('Destination') == '/shared']
    if (labels.get('com.docker.compose.project.working_dir') != str(root) or labels.get('com.docker.compose.service') != 'runtipi-reverse-proxy'
            or len(stores) != 1 or stores[0].get('Type') != 'bind' or stores[0].get('Source') != expected):
        raise fail()
    return {'schema': 'orbis.proxy-host-identity-migration-plan.v1', 'available': False, 'migrationRequired': True,
            'reason': 'The active proxy can write inside captured backup data. A reviewed cutover must copy and verify existing host identity, switch only these proxy mounts, and verify HTTPS before capture is enabled.',
            'source': expected, 'destination': str(shared_path(root)), 'configurationReadOnlyRequired': True,
            'preserveOriginal': True, 'automaticApplySupported': False, 'policy': POLICY}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['inspect', 'migration-plan'])
    parser.add_argument('root', type=Path)
    parser.add_argument('--docker-context', required=True)
    args = parser.parse_args()
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise ValueError('Run proxy identity review as root on the selected Linux Docker host')
    root = args.root.resolve(strict=True)
    with HOST.host_lock(root):
        raw = HOST.docker(args.docker_context, ['container', 'inspect', '--format', '{{json .}}', 'runtipi-reverse-proxy'], root)
        if raw.returncode:
            raise fail()
        proxy = P.metadata(raw.stdout.encode(), byte_limit=8 * 1024 * 1024)
        value = observe(root, args.docker_context, proxy) if args.action == 'inspect' else migration_plan(root, args.docker_context, proxy)
        print(json.dumps(value, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)
