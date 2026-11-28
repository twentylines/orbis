"""Acquire and authenticate the two draft candidates for a disposable rehearsal."""

import json
import os
from pathlib import Path
import re
import subprocess


INPUT = Path('/run/orbis-official-draft-input')
REPO = 'twentylines/orbis'


def selection(environment):
    harness = environment.get('GITHUB_SHA', '')
    commit = environment.get('DRAFT_RELEASE_COMMIT') or harness
    bridge_tag, target_tag = (environment.get(f'DRAFT_{role}_TAG', '') for role in ('BRIDGE', 'TARGET'))
    bridge_run, target_run = (environment.get(f'DRAFT_{role}_RUN', '') for role in ('BRIDGE', 'TARGET'))
    tag_pattern = r'v[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}-beta\.[0-9]{1,8}'
    if not (re.fullmatch(r'[a-f0-9]{40}', harness) and re.fullmatch(r'[a-f0-9]{40}', commit)
            and bridge_tag != target_tag and bridge_run != target_run
            and all(re.fullmatch(tag_pattern, tag) for tag in (bridge_tag, target_tag))
            and all(re.fullmatch(r'[1-9][0-9]{0,19}', run) for run in (bridge_run, target_run))):
        raise ValueError('draft-selection-refused')
    return commit, ((bridge_tag, '4.10.1', int(bridge_run)), (target_tag, '4.12.0', int(target_run)))


def acquire(runtime, environment):
    require = runtime.require
    require(os.getuid() == os.geteuid() == 0
            and environment.get('GITHUB_ACTIONS') == 'true'
            and environment.get('RUNNER_ENVIRONMENT') == 'github-hosted'
            and environment.get('GITHUB_REPOSITORY') == REPO
            and environment.get('GITHUB_REF') == 'refs/heads/main'
            and environment.get('GH_TOKEN')
            and not os.path.lexists(runtime.WORK) and not os.path.lexists(runtime.HOST), 'draft-acquisition-scope-refused')
    commit, drafts = selection(environment)
    if commit != environment['GITHUB_SHA']:
        checkout = Path(__file__).resolve().parents[3]
        history = subprocess.run(['/usr/bin/git', '-c', f'safe.directory={checkout}', 'merge-base',
                                 '--is-ancestor', commit, environment['GITHUB_SHA']],
                                 cwd=checkout, check=False, capture_output=True, timeout=15)
        require(history.returncode == 0, 'draft-source-is-not-harness-ancestor')
    public_target = environment.get('DRAFT_UPGRADE_CASE') == runtime.PUBLIC_DISCOVERY_CASE
    reader = runtime.load('orbis-release-check')
    boot = runtime.load('install-orbis')
    launcher = runtime.load('orbis-host-upgrade-launcher')

    def gh(*args):
        result = subprocess.run(['gh', *args], check=False, capture_output=True, timeout=90)
        require(result.returncode == 0 and len(result.stdout) < 1024 * 1024, 'draft-acquisition-request-refused')
        return result.stdout

    os.umask(0o077)
    INPUT.mkdir(mode=0o700)
    pins = []
    for index, (tag, base, run) in enumerate(drafts):
        is_draft = not (public_target and index == 1)
        run_info = json.loads(gh('api', f'repos/{REPO}/actions/runs/{run}'))
        require((run_info.get('head_sha'), run_info.get('conclusion'), run_info.get('event'),
                 run_info.get('path', '').partition('@')[0])
                == (commit, 'success', 'workflow_dispatch', '.github/workflows/release.yml'), 'draft-publisher-proof-refused')
        require(reader.git_tag_commit(tag) == commit, 'draft-tag-commit-refused')
        release = json.loads(gh('release', 'view', tag, '--repo', REPO, '--json', 'tagName,isDraft,isPrerelease,assets'))
        assets = release['assets']
        require((release['tagName'], release['isDraft'], release['isPrerelease']) == (tag, is_draft, True),
                'draft-asset-metadata-refused')
        limits = runtime.release_asset_limits(assets, base)
        require(is_draft or runtime.QUALIFIED_CORE_MANIFEST in limits, 'public-qualified-manifest-required')
        for item in assets:
            name = item['name']
            require(type(item['size']) is int and 0 < item['size'] <= limits[name]
                    and runtime.DIGEST.fullmatch(item['digest']), 'draft-asset-size-refused')
        directory = INPUT / tag
        directory.mkdir()
        gh('release', 'download', tag, '--repo', REPO, '--dir', str(directory),
           *(argument for name in sorted(limits) for argument in ('--pattern', name)))
        files = {}
        for item in assets:
            name = item['name']
            path = directory / name
            path.chmod(0o600)
            body = path.read_bytes()
            require(len(body) == item['size'] and 'sha256:' + runtime.sha(body) == item['digest'],
                    'draft-asset-hash-refused')
            files[runtime.CORE_MANIFEST if name == runtime.QUALIFIED_CORE_MANIFEST else name] = body
        manifest = reader.PLAN.validate_manifest(json.loads(files['release-manifest.json']))
        require((manifest['image'], manifest['tag'], manifest['commit'], manifest['runtipiCompatibility'],
                 manifest['installationProtocol'])
                == (runtime.IMAGE, tag, commit, base, 'orbis.installation-state.v1'), 'draft-core-identity-refused')
        identity = launcher.literal(files['install-orbis.py'], 'EXPECTED_RELEASE')
        require(identity == {'tag': tag, 'commit': commit, 'manifestSha256': runtime.sha(files[boot.MANIFEST])},
                'draft-installer-selection-refused')
        custody, closure = boot.verify_source_package(files[boot.MANIFEST], identity, files[boot.ARCHIVE])
        launcher.authenticate_embedded_tree(custody[launcher.GIT_PROOF_FIELD], commit, closure)
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
        pins.append((tag, commit, digest, base, run))
    # Keep the target off the replay map so the installed Core and Host must
    # resolve the real public release during the post-publication proof.
    (INPUT / 'tags.json').write_text(json.dumps([item[0] for item in (pins[:1] if public_target else pins)]))
    (INPUT / 'pins.json').write_text(json.dumps(pins))


def pins(transport):
    commit, drafts = selection(os.environ)
    directory = transport.private_directory(INPUT)
    pins = json.loads(transport.read(directory / 'pins.json', 4096))
    transport.require(type(pins) is list and len(pins) == len(drafts))
    for item, (tag, base, run) in zip(pins, drafts, strict=True):
        transport.require(type(item) is list and len(item) == 5 and item[:2] == [tag, commit]
                          and item[3:] == [base, run] and type(item[2]) is str
                          and re.fullmatch(r'sha256:[a-f0-9]{64}', item[2]))
    return tuple(tuple(item) for item in pins)
