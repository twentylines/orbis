"""Exercise the installed CLI through a disposable, two-revision app store."""

import json
from pathlib import Path
import re
import secrets
import time
from urllib.parse import quote
import uuid


APP = 'orbis-cli-probe'
STORE = 'orbis-qa'
URN = f'{APP}:{STORE}'
GIT_SERVER = 'orbis-qa-git'
STORE_URL = f'http://{GIT_SERVER}:9418/{STORE}.git'
APP_ROUTE = '/api/apps/' + quote(URN, safe='')
BACKUPS_ROUTE = '/api/backups/' + quote(URN, safe='')
TASK_PHASES = {'preparing', 'pulling_images', 'stopping', 'backing_up', 'copying', 'archiving', 'saving',
               'migrating', 'publishing', 'starting', 'verifying', 'committing', 'recovering'}
TASK_STATUSES = {'queued', 'running', 'cancelling', 'cancelled', 'succeeded', 'failed', 'interrupted', 'unconfirmed'}


def write_package(worktree, version, image, token):
    package = worktree / 'apps' / APP
    package.mkdir(parents=True, exist_ok=True)
    info = {'id': APP, 'name': 'CLI update probe', 'version': f'{version}.0.0', 'tipi_version': version,
            'available': True, 'port': 3000, 'author': 'Orbis', 'source': 'https://app-fixture.invalid',
            'short_desc': 'Disposable app update fixture', 'categories': ['utilities'], 'form_fields': []}
    # Only revision one can create the marker. Revision two must read the
    # original bytes and fail if the update discarded their data directory.
    marker = '/ota-data/marker'
    program = "const f=require('node:fs');"
    if version == 1:
        program += f"if(!f.existsSync('{marker}'))f.writeFileSync('{marker}','{token}',{{flag:'wx'}});"
    program += f"if(f.readFileSync('{marker}','utf8')!=='{token}')process.exit(1);setInterval(()=>{{}},1000);"
    compose = {'x-runtipi': {'schema_version': 2}, 'services': {'web': {
        'image': image, 'entrypoint': ['node', '-e'], 'command': [program], 'network_mode': 'none',
        'restart': 'no', 'healthcheck': {'disable': True}, 'volumes': ['${APP_DATA_DIR}/data:/ota-data'],
        'labels': {'io.orbis.cli-update-revision': str(version)},
        'x-runtipi': {'is_main': True, 'internal_port': 3000},
    }}}
    for name, value in (('config.json', info), ('docker-compose.yml', compose)):
        (package / name).write_text(json.dumps(value, sort_keys=True) + '\n', encoding='utf-8')


def git_commit(run, worktree, version, image, token):
    write_package(worktree, version, image, token)
    git = ['/usr/bin/git', '-C', str(worktree), '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false']
    run(git + ['add', '--', f'apps/{APP}'])
    run(git + ['-c', 'user.name=Orbis fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', f'App revision {version}'])
    return run(git + ['rev-parse', 'HEAD'])


def fixture_catalogue(run, directory, source_image, target_image, token):
    directory.mkdir(mode=0o700)
    worktree = directory / 'catalogue-work'
    repositories = directory / 'served'
    repositories.mkdir(mode=0o700)
    bare = repositories / f'{STORE}.git'
    git = ['/usr/bin/git', '-c', 'init.templateDir=']
    run(git + ['init', '--initial-branch=main', str(worktree)])
    run(git + ['init', '--initial-branch=main', '--bare', str(bare)])
    revisions = [git_commit(run, worktree, version, image, token)
                 for version, image in ((1, source_image), (2, target_image))]
    return worktree, bare, revisions


def publish_revision(run, worktree, bare, revision):
    run(['/usr/bin/git', '-C', str(worktree), '-c', 'core.hooksPath=/dev/null', 'push', str(bare), f'{revision}:refs/heads/main'])


def task_evidence(runtime, row, action):
    status, phase = row.get('status'), row.get('phase')
    details = runtime.fixture_app_failure(status, started_at=row.get('startedAt') or row.get('createdAt')).evidence
    return {'cliAppAction': action,
            'cliAppTaskStatus': status if isinstance(status, str) and status in TASK_STATUSES else 'unrecognized',
            'cliAppTaskPhase': phase if isinstance(phase, str) and phase in TASK_PHASES else None, **details}


def one_task(runtime, cookie, request, action):
    runtime.require(type(request) is str and re.fullmatch(r'[0-9a-f-]{36}', request)
                    and str(uuid.UUID(request, version=4)) == request, 'cli-update-task-identity-refused')
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        tasks, _ = runtime.http('GET', '/api/tasks', cookie=cookie)
        rows = [task for task in tasks['tasks'] if task['id'] == request]
        if rows:
            runtime.require(len(rows) == 1 and rows[0]['appUrn'] == URN and rows[0]['action'] == action,
                            'cli-update-task-binding-refused')
            if rows[0]['status'] == 'succeeded':
                return
            if rows[0]['status'] not in ('queued', 'running', 'unconfirmed'):
                raise runtime.Refused('cli-update-task-did-not-succeed', **task_evidence(runtime, rows[0], action))
        time.sleep(0.5)
    raise runtime.Refused('cli-update-task-not-observed', cliAppAction=action)


def deployment(runtime, cookie, version, latest, image, token):
    selected, _ = runtime.http('GET', APP_ROUTE, cookie=cookie)
    runtime.require(selected['app']['version'] == version and selected['app']['status'] == 'running'
                    and selected['info']['version'] == f'{version}.0.0'
                    and selected['metadata']['latestVersion'] == latest, 'cli-update-version-or-state-refused')
    containers = runtime.run(runtime.DOCKER + ['ps', '-q', '--no-trunc', '--filter', f'label=runtipi.appurn={URN}'])
    runtime.require(re.fullmatch(r'[a-f0-9]{64}', containers), 'cli-update-active-container-refused')
    fields = '{{json .Config.Image}} {{json .State.Running}} {{json (index .Config.Labels "io.orbis.cli-update-revision")}}'
    inspected = runtime.run(runtime.DOCKER + ['inspect', '--format', fields, containers])
    runtime.require(inspected == f'"{image}" true "{version}"', 'cli-update-runtime-image-refused')
    marker = runtime.run(runtime.DOCKER + ['exec', containers, 'cat', '/ota-data/marker'])
    runtime.require(marker == token, 'cli-update-original-marker-refused')
    return containers


def cli_update_job(runtime, cookie):
    before, _ = runtime.http('GET', '/api/tasks', cookie=cookie)
    old_ids = {item['id'] for item in before['tasks']}
    try:
        output = runtime.run(runtime.DOCKER + ['exec', 'runtipi', 'orbis-cli', 'app', 'update', URN],
                             timeout=240, code='installed-cli-app-update-refused')
    except runtime.Refused as error:
        details = {'cliAppAction': 'update'}
        try:
            tasks, _ = runtime.http('GET', '/api/tasks', cookie=cookie)
            rows = [item for item in tasks['tasks'] if item['id'] not in old_ids
                    and item['appUrn'] == URN and item['action'] == 'update']
            if len(rows) == 1:
                details = task_evidence(runtime, rows[0], 'update')
        except (runtime.Refused, KeyError, TypeError):
            pass
        raise runtime.Refused(str(error), **details) from None
    jobs = re.findall(r'^App update accepted for ' + re.escape(URN) + r' \(([a-f0-9-]{36})\)\.$', output, re.M)
    runtime.require(len(jobs) == 1 and jobs[0] not in old_ids
                    and output.splitlines()[-1] == f'App update completed for {URN}.', 'cli-update-terminal-output-refused')
    one_task(runtime, cookie, jobs[0], 'update')


def seed_and_update(runtime, cookie, worktree, bare, revisions, source_image, target_image, token):
    store, _ = runtime.http('POST', '/api/marketplace/create', body={'name': STORE, 'url': STORE_URL}, cookie=cookie,
                            expect=(200, 201), timeout=60)
    runtime.require(store.get('slug') == STORE and store.get('url') == STORE_URL and store.get('enabled') is True,
                    'cli-update-catalogue-source-refused')
    installed, _ = runtime.http('POST', '/api/app-lifecycle/' + quote(URN, safe='') + '/install',
                                body={'skipPull': True, 'openPort': False, 'exposed': False, 'exposedLocal': False, 'maxBackups': 2},
                                cookie=cookie, expect=(200, 201, 202))
    one_task(runtime, cookie, installed['requestId'], 'install')
    original = deployment(runtime, cookie, 1, 1, source_image, token)
    publish_revision(runtime.run, worktree, bare, revisions[1])
    updated, _ = runtime.http('POST', '/api/marketplace/pull', cookie=cookie, expect=(200, 201), timeout=90)
    runtime.require(updated.get('success') is True and deployment(runtime, cookie, 1, 2, source_image, token) == original,
                    'cli-update-catalogue-refresh-refused')
    before, _ = runtime.http('GET', BACKUPS_ROUTE, cookie=cookie)
    cli_update_job(runtime, cookie)
    runtime.require(deployment(runtime, cookie, 2, 2, target_image, token) != original, 'cli-update-did-not-replace-container')
    after, _ = runtime.http('GET', BACKUPS_ROUTE, cookie=cookie)
    old_ids = {item['id'] for item in before['data']}
    added = [item for item in after['data'] if item['id'] not in old_ids]
    runtime.require(after['total'] == before['total'] + 1 and len(added) == 1 and added[0]['size'] > 0,
                    'cli-update-default-backup-refused')


def git_server_image(runtime, target_image):
    # The Alpine product image only needs Git as a client. Put git-http-backend
    # in a disposable fixture image with an otherwise empty build context.
    context = runtime.WORK / 'catalogue-server-image'
    context.mkdir(mode=0o700)
    (context / 'Dockerfile').write_text(f'FROM {target_image}\nRUN apk add --no-cache git-daemon\n', encoding='ascii')
    image = runtime.run(runtime.DOCKER + ['build', '--quiet', '--pull=false', str(context)], timeout=120,
                        code='cli-update-catalogue-image-refused')
    runtime.require(re.fullmatch(r'sha256:[a-f0-9]{64}', image), 'cli-update-catalogue-image-identity-refused')
    return image


def installed_cli_update(runtime, cookie, source, target):
    runtime.require(runtime.source_pin(target) == source and source[1] == target[1] and source[2] != target[2],
                    'cli-update-release-pair-refused')
    token = secrets.token_hex(12)
    source_image, target_image = (f'{runtime.IMAGE}@{pin[2]}' for pin in (source, target))
    worktree, bare, revisions = fixture_catalogue(runtime.run, runtime.WORK / 'app-update-catalogue', source_image, target_image, token)
    publish_revision(runtime.run, worktree, bare, revisions[0])
    network = 'runtipi_tipi_main_network'
    attached = json.loads(runtime.run(runtime.DOCKER + ['inspect', '--format', '{{json .NetworkSettings.Networks}}', 'runtipi']))
    runtime.require(network in attached, 'cli-update-catalogue-network-refused')
    server = Path(__file__).resolve().parents[3] / 'scripts/store-fixture-server.cjs'
    runtime.require(server.is_file() and not server.is_symlink(), 'cli-update-catalogue-server-refused')
    image = git_server_image(runtime, target_image)
    try:
        identifier = runtime.run(runtime.DOCKER + ['run', '-d', '--pull=never', '--name', GIT_SERVER, '--network', network,
            '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=0:0', '--entrypoint=node',
            '-e', 'ORBIS_ALLOW_STORE_FIXTURE=1', '--mount', f'type=bind,src={bare.parent},dst=/fixtures/repos,readonly',
            '--mount', f'type=bind,src={server},dst=/fixture-server.cjs,readonly', image, '/fixture-server.cjs'])
        runtime.require(re.fullmatch(r'[a-f0-9]{64}', identifier), 'cli-update-catalogue-container-refused')
        try:
            runtime.run(runtime.DOCKER + ['exec', identifier, 'test', '-x', '/usr/libexec/git-core/git-http-backend'],
                        code='cli-update-catalogue-backend-missing')
            wait_for_catalogue(runtime)
            seed_and_update(runtime, cookie, worktree, bare, revisions, source_image, target_image, token)
        finally:
            runtime.run(runtime.DOCKER + ['rm', '-f', identifier], timeout=20, code='cli-update-catalogue-cleanup-refused')
    finally:
        runtime.run(runtime.DOCKER + ['image', 'rm', image], timeout=20, code='cli-update-catalogue-image-cleanup-refused')


def wait_for_catalogue(runtime):
    probe = f"fetch('{STORE_URL}/info/refs?service=git-upload-pack',{{signal:AbortSignal.timeout(3000)}})"
    probe += ".then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            runtime.run(runtime.DOCKER + ['exec', 'runtipi', 'node', '-e', probe], timeout=5)
            return
        except runtime.Refused:
            time.sleep(0.5)
    raise runtime.Refused('cli-update-catalogue-not-ready')
