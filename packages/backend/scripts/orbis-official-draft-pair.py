"""Acquire and authenticate the two draft candidates for a disposable rehearsal."""

import json
import os
from pathlib import Path
import re
import subprocess


INPUT = Path('/run/orbis-official-draft-input')
COMMIT = 'afea7dda40663f92c7c261efe9f5a0a558d19ac1'
REPO = 'twentylines/orbis'
DRAFTS = (
    ('v0.9.2-beta.12', '4.10.1', 46132914399),
    ('v0.9.2-beta.13', '4.12.0', 46132917585),
)


def acquire(runtime, environment):
    require = runtime.require
    require(os.getuid() == os.geteuid() == 0
            and environment.get('GITHUB_ACTIONS') == 'true'
            and environment.get('RUNNER_ENVIRONMENT') == 'github-hosted'
            and environment.get('GITHUB_REPOSITORY') == REPO
            and environment.get('GITHUB_REF') == 'refs/heads/main'
            and environment.get('GH_TOKEN')
            and not os.path.lexists(runtime.WORK) and not os.path.lexists(runtime.HOST), 'draft-acquisition-scope-refused')
    reader = runtime.load('orbis-release-check')
    boot = runtime.load('install-orbis')
    launcher = runtime.load('orbis-host-upgrade-launcher')

    def gh(*args):
        result = subprocess.run(['gh', *args, '--repo', REPO], check=False, capture_output=True, timeout=90)
        require(result.returncode == 0 and len(result.stdout) < 1024 * 1024, 'draft-acquisition-request-refused')
        return result.stdout

    os.umask(0o077)
    INPUT.mkdir(mode=0o700)
    pins = []
    for tag, base, run in DRAFTS:
        run_info = json.loads(gh('run', 'view', str(run), '--json', 'headSha,conclusion,event,workflowName'))
        require((run_info['headSha'], run_info['conclusion'], run_info['event'], run_info['workflowName'])
                == (COMMIT, 'success', 'workflow_dispatch', 'Orbis release'), 'draft-publisher-proof-refused')
        require(reader.git_tag_commit(tag) == COMMIT, 'draft-tag-commit-refused')
        release = json.loads(gh('release', 'view', tag, '--json', 'tagName,isDraft,isPrerelease,assets'))
        assets = release['assets']
        require((release['tagName'], release['isDraft'], release['isPrerelease']) == (tag, True, True)
                and len(assets) == len(runtime.ASSETS)
                and {item['name'] for item in assets} == set(runtime.ASSETS), 'draft-asset-metadata-refused')
        for item in assets:
            name = item['name']
            require(type(item['size']) is int and 0 < item['size'] <= runtime.ASSETS[name]
                    and runtime.DIGEST.fullmatch(item['digest']), 'draft-asset-size-refused')
        directory = INPUT / tag
        directory.mkdir()
        gh('release', 'download', tag, '--dir', str(directory),
           *(argument for name in sorted(runtime.ASSETS) for argument in ('--pattern', name)))
        files = {}
        for item in assets:
            name = item['name']
            path = directory / name
            path.chmod(0o600)
            body = path.read_bytes()
            require(len(body) == item['size'] and 'sha256:' + runtime.sha(body) == item['digest'],
                    'draft-asset-hash-refused')
            files[name] = body
        manifest = reader.PLAN.validate_manifest(json.loads(files['release-manifest.json']))
        require((manifest['image'], manifest['tag'], manifest['commit'], manifest['runtipiCompatibility'],
                 manifest['installationProtocol'])
                == (runtime.IMAGE, tag, COMMIT, base, 'orbis.installation-state.v1'), 'draft-core-identity-refused')
        identity = launcher.literal(files['install-orbis.py'], 'EXPECTED_RELEASE')
        require(identity == {'tag': tag, 'commit': COMMIT, 'manifestSha256': runtime.sha(files[boot.MANIFEST])},
                'draft-installer-selection-refused')
        custody, closure = boot.verify_source_package(files[boot.MANIFEST], identity, files[boot.ARCHIVE])
        launcher.authenticate_embedded_tree(custody[launcher.GIT_PROOF_FIELD], COMMIT, closure)
        require(custody['releaseManifestSha256'] == runtime.sha(files['release-manifest.json'])
                and boot._render_installer('release', identity, closure['scripts/install-orbis.py']) == files['install-orbis.py'],
                'draft-source-custody-refused')
        digest = manifest['digest']
        token = reader.read_json(f'{reader.GHCR}/token?scope=repository:{REPO}:pull&service=ghcr.io', 16384)['token']
        body, headers = reader.read_url(f'{reader.GHCR}/v2/{REPO}/manifests/{digest}', 1024 * 1024,
            {'Accept': ', '.join(sorted(reader.INDEX_TYPES)), 'Authorization': 'Bearer ' + token})
        indexed = next((value for name, value in headers.items() if name.lower() == 'docker-content-digest'), None)
        require(reader.verify_index(body, indexed, digest) == ['linux/amd64', 'linux/arm64'],
                'draft-registry-index-refused')
        # The public API response is a deliberately synthetic fixture. The
        # registry, commit lookup, all asset bodies and installer stay authentic.
        (directory / 'metadata.json').write_text(json.dumps({'tag_name': tag, 'draft': False, 'prerelease': True,
            'assets': [{'name': item['name'], 'size': item['size'], 'digest': item['digest'],
                'browser_download_url': f'https://github.com/{REPO}/releases/download/{tag}/{item["name"]}'}
                for item in assets]}))
        pins.append((tag, COMMIT, digest, base, run))
    (INPUT / 'tags.json').write_text(json.dumps([item[0] for item in pins]))
    (INPUT / 'pins.json').write_text(json.dumps(pins))


def pins(transport):
    directory = transport.private_directory(INPUT)
    pins = json.loads(transport.read(directory / 'pins.json', 4096))
    transport.require(type(pins) is list and len(pins) == len(DRAFTS))
    for item, (tag, base, run) in zip(pins, DRAFTS, strict=True):
        transport.require(type(item) is list and len(item) == 5 and item[:2] == [tag, COMMIT]
                          and item[3:] == [base, run] and type(item[2]) is str
                          and re.fullmatch(r'sha256:[a-f0-9]{64}', item[2]))
    return tuple(tuple(item) for item in pins)
