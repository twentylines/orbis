#!/usr/bin/env python3
"""Verify the public candidate index and both platform identities before a fixture.

Only anonymous pull access is used. Registry credentials remain in memory, and
only public release metadata is emitted. This cannot publish or change a release.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import urllib.request

BASE = 'https://ghcr.io/v2/twentylines/orbis/'
TYPES = ', '.join(('application/vnd.oci.image.index.v1+json',
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.docker.distribution.manifest.v2+json'))
FIXTURE_PATHS = frozenset({
    '.github/workflows/host-storage-runtime.yml',
    'packages/backend/scripts/orbis-host-storage-candidate.py',
    'packages/backend/scripts/orbis-host-storage-fixture.py',
    'packages/backend/scripts/orbis-host-storage-runtime.py',
    'packages/backend/scripts/test_orbis_host_storage_runtime.py',
    'packages/backend/src/modules/host-updates/__tests__/app-storage-controller.linux.probe.ts',
})


def read(url, headers=None):
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}), timeout=40) as response:
        body = response.read(4 * 1024 * 1024 + 1)
        if len(body) > 4 * 1024 * 1024:
            raise ValueError('Registry metadata exceeds its bound')
        return body, response.headers


def git(source, *arguments):
    return subprocess.check_output(['git', *arguments], cwd=source, stderr=subprocess.DEVNULL)


def validate_source(source, commit):
    # The tested controller image and the Host/witness must have exactly the same
    # production sources. Only these exact test-harness paths may differ.
    if git(source, 'diff', '--name-only', 'HEAD').strip() or git(source, 'diff', '--cached', '--name-only').strip():
        raise ValueError('Tracked source must be clean')
    changes = git(source, 'diff', '--name-status', commit, 'HEAD').decode().splitlines()
    for change in changes:
        fields = change.split('\t')
        if len(fields) != 2 or fields[0] not in ('A', 'M') or fields[1] not in FIXTURE_PATHS:
            raise ValueError('The image and fixture production sources differ')


def verify(source, tag, commit, digest):
    if not re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+', tag):
        raise ValueError('Expected an immutable candidate tag')
    if not re.fullmatch(r'[a-f0-9]{40}', commit) or not re.fullmatch(r'sha256:[a-f0-9]{64}', digest):
        raise ValueError('Invalid candidate identity')
    validate_source(source, commit)
    spec = importlib.util.spec_from_file_location('orbis_candidate_plan', source / 'scripts/orbis-release-plan.py')
    plan = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plan)
    token = json.loads(read('https://ghcr.io/token?service=ghcr.io&scope=repository:twentylines/orbis:pull')[0])['token']
    headers = {'Authorization': 'Bearer ' + token, 'Accept': TYPES}

    def get(relative, expected):
        body, response = read(BASE + relative, headers)
        if 'sha256:' + hashlib.sha256(body).hexdigest() != expected:
            raise ValueError('Registry content digest mismatch')
        if relative.startswith('manifests/') and response.get('Docker-Content-Digest') != expected:
            raise ValueError('Registry response identity mismatch')
        return json.loads(body)

    index = get('manifests/' + tag, digest)
    if get('manifests/' + digest, digest) != index:
        raise ValueError('Candidate tag changed')
    platforms = [item for item in index['manifests'] if item.get('platform', {}).get('os') == 'linux']
    if sorted(item['platform']['architecture'] for item in platforms) != ['amd64', 'arm64']:
        raise ValueError('Both candidate platforms are required')
    bases = set()
    for descriptor in platforms:
        image = get('manifests/' + descriptor['digest'], descriptor['digest'])
        config_descriptor = image['config']
        config = get('blobs/' + config_descriptor['digest'], config_descriptor['digest'])
        labels = config['config']['Labels']
        if (config['os'] != 'linux' or config['architecture'] != descriptor['platform']['architecture']
                or labels.get('org.opencontainers.image.source') != 'https://github.com/twentylines/orbis'
                or labels.get('org.opencontainers.image.revision') != commit
                or labels.get('org.opencontainers.image.version') != tag
                or labels.get('io.orbis.installation-protocol') != 'orbis.installation-state.v1'
                or f'ORBIS_VERSION={tag}' not in config['config']['Env']
                or f'ORBIS_COMMIT={commit}' not in config['config']['Env']):
            raise ValueError('Candidate configuration differs from its publication')
        bases.add(plan.image_compatibility(labels))
    if len(bases) != 1:
        raise ValueError('Candidate platforms declare different Runtipi compatibility bases')
    fingerprint = subprocess.check_output(['python3', '-B', str(source / 'scripts/orbis-migration-fingerprint.py')], cwd=source).decode().strip()
    return {'schema': 'orbis.release.v1', 'image': 'ghcr.io/twentylines/orbis',
            'tag': tag, 'commit': commit, 'digest': digest, 'releaseChannel': 'nightly',
            'updatePriority': 'normal', 'criticalThrough': None, 'criticalFixes': [],
            'platforms': ['linux/amd64', 'linux/arm64'], 'runtipiCompatibility': bases.pop(),
            'installationProtocol': 'orbis.installation-state.v1', 'dataCompatibility': 'orbis.data.v1',
            'accountIdentifierCompatibility': 'orbis.account-identifier.v1', 'migrationFingerprint': fingerprint}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--tag', required=True)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--digest', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        manifest = verify(args.source, args.tag, args.commit, args.digest)
        with args.output.open('x') as output:
            json.dump(manifest, output, sort_keys=True)
            output.write('\n')
        print(json.dumps({'registryVerified': True, 'platforms': 2, 'productionSourcesMatch': True,
                          'tag': args.tag, 'commit': args.commit, 'digest': args.digest}, sort_keys=True))
        return 0
    except Exception:
        # Network exceptions can carry authorization request details; do not echo.
        print(json.dumps({'registryVerified': False, 'error': 'candidate-verification-failed'}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
