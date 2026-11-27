"""Private fixture builder used by the real Host/Core Linux qualification.

Creates only fresh synthetic installation data. No Docker, enrollment or authority
operation runs implicitly. An optional pre-population callback lets the caller
issue real birth authority while the installation is empty. Credentials stay local.
"""
from pathlib import Path
import hashlib
import importlib.util
import json
import os
import secrets

SOURCE = Path(__file__).resolve().parents[3]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, SOURCE / 'scripts' / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def private_json(file, value):
    with file.open('x') as output:
        os.chmod(file, 0o600)
        json.dump(value, output, indent=2)
        output.write('\n')


def prepare(manifest_path, folder, dependencies, *, before_populate=None, credential_socket=False, host_engine=False):
    """Prepare fresh files; an explicit caller hook may run before population."""
    stage = load('storage_fixture_stage', 'orbis-stage-release.py')
    preflight = load('storage_fixture_preflight', 'migration-preflight.py')
    manifest = stage.PLAN.validate_manifest(json.loads(manifest_path.read_text()))
    root = folder / 'install'
    root.mkdir(mode=0o700)
    if before_populate is not None:
        before_populate(root)
    for suffix in [*preflight.DATA_PATHS, 'data/postgres', 'data/queue', 'auth', 'cache']:
        (root / suffix).mkdir(mode=0o700, parents=True, exist_ok=True)
    for name in ['host-state', 'snapshots', 'socket', 'public-probe']:
        (folder / name).mkdir(mode=0o700)
    for store in ('fixture', '_user'):
        (root / 'app-data' / store / 'probe').mkdir(mode=0o700, parents=True)
        (root / 'app-data' / store / 'probe/marker').write_text('scoped fixture\n')
    if host_engine:
        for name in ('engine-upgrade', 'engine-rollback'):
            directory = root / 'app-data/fixture' / name
            directory.mkdir(mode=0o700)
            (directory / 'marker').write_text('scoped fixture\n')
    (root / 'state/seed').write_text(secrets.token_hex(32))
    os.chmod(root / 'state/seed', 0o600)
    environment = {
        'POSTGRES_HOST': 'runtipi-db', 'POSTGRES_DBNAME': 'tipi',
        'POSTGRES_USERNAME': 'tipi', 'POSTGRES_PASSWORD': secrets.token_hex(32),
        'RABBITMQ_HOST': 'runtipi-queue', 'RABBITMQ_USERNAME': 'tipi',
        'RABBITMQ_PASSWORD': secrets.token_hex(32), 'JWT_SECRET': secrets.token_hex(32),
        'ROOT_FOLDER_HOST': str(root), 'RUNTIPI_APP_DATA_PATH': str(root),
        'TIPI_VERSION': manifest['runtipiCompatibility'], 'ARCHITECTURE': 'amd64',
        'INTERNAL_IP': '127.0.0.1', 'APPS_REPO_ID': 'fixture',
        'APPS_REPO_URL': 'https://github.com/runtipi/runtipi-appstore',
        'DOMAIN': 'fixture.invalid', 'LOCAL_DOMAIN': 'fixture.lan',
        'RUNTIPI_FORWARD_AUTH_URL': 'http://runtipi:3000/api/auth/traefik',
        'DEMO_MODE': 'false', 'GUEST_DASHBOARD': 'false',
        'ALLOW_AUTO_THEMES': 'false',
        'PERSIST_TRAEFIK_CONFIG': 'false', 'ADVANCED_SETTINGS': 'false',
        'THEME_BASE': 'gray', 'THEME_COLOR': 'green', 'TZ': 'UTC',
        'EXPERIMENTAL_INSECURE_COOKIE': 'false', 'LOG_LEVEL': 'info',
    }
    if credential_socket:
        environment['ORBIS_HOST_SOCKET'] = '/run/orbis/host.sock'
    env_file = root / '.env'
    env_file.write_text(''.join(f'{key}={value}\n' for key, value in environment.items()))
    os.chmod(env_file, 0o600)
    (root / 'VERSION').write_text(manifest['runtipiCompatibility'] + '\n')
    (root / 'user-config/tipi-compose.yml').write_text('services: {}\n')
    (root / 'orbis-compose.yml').write_text(stage.staged_content(manifest))
    image = manifest['image'] + '@' + manifest['digest']
    bind = lambda source, target, readonly=False: {
        'type': 'bind', 'source': str(source), 'target': target,
        'read_only': readonly, 'bind': {'propagation': 'rprivate'},
    }
    core_mounts = [bind(root / name, '/data/' + name) for name in preflight.DATA_PATHS if name != 'app-data']
    core_mounts += [bind(root / 'app-data', '/app-data'), bind(root / 'auth', '/data/.secrets'),
                    bind(root / 'cache', '/cache'),
                    bind(env_file, '/data/.env'), bind('/var/run/docker.sock', '/var/run/docker.sock', True),
                    bind(folder / 'socket/host.sock', '/run/orbis/host.sock'),
                    bind(folder / 'public-probe', '/opt/orbis-test-probe', True)]
    common = {'restart': 'no', 'networks': ['tipi_main_network']}
    config = {
        'services': {
            'runtipi': {
                **common, 'container_name': 'runtipi', 'image': image,
                'env_file': [str(env_file)], 'volumes': core_mounts,
                'stop_grace_period': '10s',
                'healthcheck': {'test': ['CMD', 'curl', '-f', 'http://localhost:3000/api/health'],
                                'interval': '1s', 'timeout': '3s', 'retries': 60, 'start_period': '5s'},
                'labels': {'traefik.enable': 'true', 'traefik.http.services.dashboard.loadbalancer.server.port': '3000',
                           'traefik.http.routers.dashboard.rule': 'PathPrefix(`/`)', 'traefik.http.routers.dashboard.entrypoints': 'web'},
                'depends_on': {'runtipi-db': {'condition': 'service_healthy'},
                               'runtipi-queue': {'condition': 'service_started'}},
            },
            'runtipi-db': {
                **common, 'container_name': 'runtipi-db',
                'image': dependencies['library/postgres']['reference'],
                'environment': {'POSTGRES_USER': 'tipi', 'POSTGRES_DB': 'tipi',
                                'POSTGRES_PASSWORD': environment['POSTGRES_PASSWORD']},
                'volumes': [bind(root / 'data/postgres', '/var/lib/postgresql/data')],
                'healthcheck': {'test': ['CMD', 'pg_isready', '-U', 'tipi', '-d', 'tipi'],
                                'interval': '1s', 'timeout': '3s', 'retries': 60},
            },
            'runtipi-queue': {
                **common, 'container_name': 'runtipi-queue',
                'image': dependencies['library/rabbitmq']['reference'],
                'environment': {'RABBITMQ_DEFAULT_USER': 'tipi', 'RABBITMQ_DEFAULT_PASS': environment['RABBITMQ_PASSWORD']},
                'volumes': [bind(root / 'data/queue', '/var/lib/rabbitmq')],
            },
            'runtipi-reverse-proxy': {
                **common, 'container_name': 'runtipi-reverse-proxy',
                'image': dependencies['library/traefik']['reference'],
                'command': ['--providers.docker=true', '--providers.docker.exposedbydefault=false', '--entrypoints.web.address=:80'],
                'volumes': [bind('/var/run/docker.sock', '/var/run/docker.sock', True),
                            bind(root / 'traefik', '/etc/traefik')],
            },
        },
        'networks': {'tipi_main_network': {'name': 'runtipi_tipi_main_network', 'driver': 'bridge'}},
    }
    private_json(root / 'docker-compose.yml', config)
    report = preflight.inspect(root, compose_config=config)
    if report['result'] != 'inventory-only' or report['layout'] != 'orbis-v1':
        raise RuntimeError('The prepared fixture fails the actual source inventory contract')
    return {'root': root, 'manifest': manifest, 'config': config}
