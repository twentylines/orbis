"""Read one component target set from held, verified installer execution custody.

This resolves bytes and identities only. It does not grant publication, Root or
recovery authority, execute target Python, activate services or change a host.
The caller supplies the trusted installed setup module, never a request module.
"""
import ast
from contextlib import contextmanager
import copy
import hashlib
import json
from pathlib import Path
import re

DRIVERS = ('orbis-host-service-setup.py', 'orbis-host-service-enable.py', 'orbis-host-service-upgrade.py')
TOOLKIT = {'activate_release.py', 'verify_release.py', 'stage_release.py', 'bootstrap_verifier.py', 'LICENSE'}
HASH = re.compile(r'[a-f0-9]{64}\Z')
COMMIT = re.compile(r'[a-f0-9]{40}\Z')
SCRIPT = re.compile(r'(?:orbis-[a-z-]+|migration-preflight|install-orbis)\.py|orbis-(?:host-maintenance-responder|controller-bootstrap-profile)\.mjs')


class TargetSetError(ValueError):
    def __init__(self):
        super().__init__('The complete publisher-selected component set could not be verified.')


def require(value):
    if not value:
        raise TargetSetError()


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False) + '\n').encode('ascii')


def sha(body):
    return hashlib.sha256(body).hexdigest()


def literal(body, name):
    declarations = []
    for node in ast.parse(body).body:
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == name for target in node.targets):
            require(len(node.targets) == 1)
            declarations.append(node.value)
        elif isinstance(node, (ast.AugAssign, ast.AnnAssign)) and isinstance(node.target, ast.Name) and node.target.id == name:
            raise TargetSetError()
    require(len(declarations) == 1)
    for node in ast.walk(declarations[0]):
        if isinstance(node, ast.Dict):
            keys = [ast.literal_eval(key) for key in node.keys]
            require(len(set(keys)) == len(keys))
    return ast.literal_eval(declarations[0])


def target_scripts(body):
    scripts = literal(body, 'SCRIPTS')
    require(type(scripts) is tuple and 1 <= len(scripts) <= 128
            and all(type(name) is str and SCRIPT.fullmatch(name) for name in scripts)
            and len(set(scripts)) == len(scripts)
            and {'orbis-host-service.py', 'orbis-sentinel-install.py'} <= set(scripts))
    return scripts


def sentinel_identity(body):
    release = literal(body, 'RELEASE')
    commit = literal(body, 'TOOLKIT_COMMIT')
    toolkit = literal(body, 'TOOLKIT')
    require(type(release) is dict and set(release) == {'version', 'sha256', 'sourceCommit'})
    require(type(release['version']) is str and len(release['version']) <= 128
            and re.fullmatch(r'(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?', release['version']))
    require(type(release['sha256']) is str and HASH.fullmatch(release['sha256'])
            and type(release['sourceCommit']) is str and COMMIT.fullmatch(release['sourceCommit'])
            and type(commit) is str and COMMIT.fullmatch(commit)
            and type(toolkit) is dict and set(toolkit) == TOOLKIT)
    for record in toolkit.values():
        require(type(record) is tuple and len(record) == 2 and type(record[0]) is int and 0 < record[0] <= 64 * 1024 * 1024
                and type(record[1]) is str and HASH.fullmatch(record[1]))
    return {'release': release, 'toolkitCommit': commit,
            'toolkit': {name: {'bytes': size, 'sha256': digest} for name, (size, digest) in toolkit.items()}}


class TargetSet:
    def __init__(self, manifest, verify):
        self._bytes = canonical(manifest)
        self._verify = verify
        self._active = True

    @property
    def sha256(self):
        self.verify()
        return sha(self._bytes)

    def manifest(self):
        self.verify()
        return json.loads(self._bytes)

    def verify(self):
        require(self._active)
        self._verify()


@contextmanager
def hold_target_set(setup, source, selection_sha256, core):
    source = Path(source)
    require(type(selection_sha256) is str and HASH.fullmatch(selection_sha256))
    # The installed reader establishes the actual retained execution proofs.
    # A bare directory, downloaded archive or caller-provided hash is not enough.
    with setup.hold_source_selection(source, selection_sha256) as selection:
        require(type(selection) is dict and selection.get('mode') == 'release'
                and selection.get('selectionSha256') == selection_sha256)
        with setup.HOST.AUTHORITY.protected_directory(source.parent) as parent:
            with setup.HOST.AUTHORITY.protected_file(parent, 'release-manifest.json', 16384) as body:
                require(sha(body) == selection['coreSha256'])
                selected_core = setup.PLAN.validate_manifest(json.loads(body))
                require(selected_core == core and selection['installer']['tag'] == core['tag']
                        and selection['installer']['commit'] == core['commit'])
        # Discover the target list without importing or running target setup.
        with setup.HOST.AUTHORITY.protected_directory(source) as parent:
            with setup.HOST.AUTHORITY.protected_file(parent, DRIVERS[0], 1024 * 1024) as setup_body:
                scripts = target_scripts(setup_body)
                files = [source / name for name in scripts]
                drivers = [source / name for name in DRIVERS]
                unit = source.parent / 'packaging/systemd/orbis-host.service'
                with setup._SetupSources(files, unit, drivers=drivers) as pins:
                    setup.require_selection_files(source, selection, pins, [*dict.fromkeys([*files, *drivers]), unit])
                    require(pins.body(source / DRIVERS[0]) == setup_body)
                    sentinel = sentinel_identity(pins.body(source / 'orbis-sentinel-install.py'))
                    observer = literal(pins.body(source / 'orbis-host-service.py'), 'SENTINEL_OBSERVER_ACTIVATION')
                    require(observer == 'orbis-observer-v1')
                    inventory = {name: sha(pins.body(source / name)) for name in scripts}
                    value = {'schema': 'orbis.component-upgrade-target.v1', 'core': copy.deepcopy(core),
                             'selectionDirectory': str(source.parent),
                             'sourceSelectionSha256': selection_sha256, 'sourceExecutionSha256': selection['executionSha256'],
                             'host': {'sourceCommit': core['commit'], 'inventory': inventory,
                                      'inventorySha256': sha(canonical(inventory)), 'unitSha256': sha(pins.body(unit)),
                                      'observerActivation': observer}, 'sentinel': sentinel}
                    def verify():
                        pins.verify()
                        with setup.hold_source_selection(source, selection_sha256) as current_selection:
                            require(current_selection == selection)
                        pins.verify()
                    target = TargetSet(value, verify)
                    try:
                        target.verify()
                        yield target
                        target.verify()
                    finally:
                        target._active = False
