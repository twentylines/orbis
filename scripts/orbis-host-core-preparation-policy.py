"""Installed-generation authority for isolated clean-target migrations only."""
import copy
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import importlib.util
from pathlib import Path
import re
import sys


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    sys.modules[key] = module
    spec.loader.exec_module(module)
    return module


I = load('orbis-host-core-inspection-installation.py', 'orbis_preparation_policy_installation')
B = load('orbis-host-core-clean-target-bootstrap.py', 'orbis_policy_clean_target_bootstrap')
SCHEMA = 'orbis.core-clean-target-migration-policy.v1'
INVENTORY = 'orbis.core-executable-migration-inventory.v1'
SQL = re.compile(r'[0-9]{4}_[A-Za-z0-9_-]+\.sql')
POLICIES = {'scope': 'prepare-isolated-clean-target-only', 'activation': False,
            'sourceWrites': False, 'restoreAuthority': False}


class MigrationPolicyError(ValueError):
    pass


def require(value):
    if not value:
        raise MigrationPolicyError('Restore database preparation is not approved. Saved data was kept.')


@dataclass(frozen=True)
class RootMigrationPolicyApproval:
    """Only independently verified installer/release policy constructs this value."""
    installation: I.InstalledSelection
    source_controller_image_id: str
    release_sha256: str
    inventory: dict
    inventory_sha256: str
    graph: list
    graph_sha256: str


class CleanTargetMigrationPolicies:
    def __init__(self, enrollment):
        self.enrollment, self.P = enrollment, enrollment.P
        self.registry = I.InstalledInspectionRuntime(enrollment)

    def digest(self, value):
        return hashlib.sha256(self.P.canonical(value)).hexdigest()

    def manifest(self, inventory, graph):
        require(self.P.exact(inventory, {'schema', 'files'}) and inventory['schema'] == INVENTORY
                and type(inventory['files']) is dict and 2 <= len(inventory['files']) <= 4097
                and type(graph) is list and 1 <= len(graph) <= 4096)
        files = inventory['files']
        require('meta/_journal.json' in files)
        total = 0
        for name, details in files.items():
            require(isinstance(name, str) and len(name) <= 255 and (name == 'meta/_journal.json' or SQL.fullmatch(name))
                    and self.P.exact(details, {'bytes', 'sha256'})
                    and type(details['bytes']) is int and 0 < details['bytes'] <= 4 * 1024 ** 2
                    and isinstance(details['sha256'], str) and I.C.HEX.fullmatch(details['sha256']))
            total += details['bytes']
        require(total <= 16 * 1024 ** 2)
        names = sorted(name for name in files if name != 'meta/_journal.json')
        require(len(names) == len(graph))
        previous = 0
        for index, (name, entry) in enumerate(zip(names, graph)):
            require(name.startswith(f'{index:04d}_') and self.P.exact(entry, {'hash', 'created_at'})
                    and entry['hash'] == files[name]['sha256']
                    and isinstance(entry['created_at'], str)
                    and re.fullmatch(r'[1-9][0-9]{0,15}', entry['created_at']))
            current = int(entry['created_at'])
            require(previous < current <= 9007199254740991)
            previous = current
        return copy.deepcopy(inventory), copy.deepcopy(graph)

    def source(self, identifier):
        require(isinstance(identifier, str) and I.C.IMAGE.fullmatch(identifier))
        return identifier[7:] + '.json'

    def binding(self, selection):
        require(type(selection) is I.InstalledSelection)
        return {'id': selection.identifier, 'installationSha256': selection.installation_sha256}

    def record(self, selection, source, release, inventory, graph):
        return {'schema': SCHEMA, 'installedRuntime': self.binding(selection),
                'sourceControllerImageId': source, 'releaseSha256': release,
                'inventory': inventory, 'inventorySha256': self.digest(inventory),
                'graph': graph, 'graphSha256': self.digest(graph), **POLICIES}

    def install(self, approval):
        I.require_root()
        require(type(approval) is RootMigrationPolicyApproval)
        selection, source = approval.installation, approval.source_controller_image_id
        self.binding(selection)
        filename = self.source(source)
        inventory, graph = self.manifest(approval.inventory, approval.graph)
        require(self.digest(inventory) == approval.inventory_sha256
                and self.digest(graph) == approval.graph_sha256)
        broker = self.registry.configuration(source, selection)
        with self.registry.policy_lock(selection, exclusive=True) as generation:
            self.registry.not_revoked(generation)
            installed = self.enrollment.json(generation / 'installation.json')
            require(approval.release_sha256 == installed['releaseSha256'])
            broker.image()
            broker.code()
            record = self.record(selection, source, approval.release_sha256, inventory, graph)
            body = self.P.canonical(record)
            require(len(body) <= 2 * 1024 ** 2)
            directory = self.enrollment.child(generation, 'clean-target-migrations')
            self.enrollment.sync(generation)
            self.enrollment.immutable(directory / filename, body)
            self.registry.not_revoked(generation)
        return {'policySha256': self.digest(record), 'installedRuntime': self.binding(selection)}

    def read(self, selection, source, *, expected_sha256=None):
        I.require_root()
        self.binding(selection)
        filename = self.source(source)
        require(expected_sha256 is None or (isinstance(expected_sha256, str) and I.C.HEX.fullmatch(expected_sha256)))
        self.registry.configuration(source, selection)
        with self.registry.authority(selection):
            generation = self.registry.base / 'generations' / selection.identifier
            installed = self.enrollment.json(generation / 'installation.json')
            body = self.enrollment.read(generation / 'clean-target-migrations' / filename, 2 * 1024 ** 2)
            record = self.P.metadata(body, byte_limit=2 * 1024 ** 2)
            require(self.P.exact(record, {'schema', 'installedRuntime', 'sourceControllerImageId', 'releaseSha256',
                    'inventory', 'inventorySha256', 'graph', 'graphSha256', *POLICIES}))
            inventory, graph = self.manifest(record['inventory'], record['graph'])
            require(record == self.record(selection, source, installed['releaseSha256'], inventory, graph)
                    and body == self.P.canonical(record)
                    and (expected_sha256 is None or self.digest(record) == expected_sha256))
        return record

    def bootstrap_for(self, inspection, identifier, actor, *, guard, expected_sha256=None):
        """Assemble from Root evidence; guard supplies service and host exclusion."""
        I.require_root()
        require(callable(guard) and getattr(inspection, 'schema', None) == B.CoreVersionedCleanTargetBootstrap.inspection_schema
                and getattr(inspection, 'enrollment', None) is self.enrollment
                and callable(getattr(inspection, 'bootstrap_catalog', None)))
        broker = inspection.configuration
        require(broker.enrollment is self.enrollment and callable(getattr(broker, 'installed_authority', None)))
        selected = getattr(broker, 'installed_selection', None)
        selection = I.InstalledSelection(getattr(selected, 'identifier', None), getattr(selected, 'installation_sha256', None))
        source = broker.trust.source_controller_image_id
        with guard(), broker.installed_authority():
            policy = self.read(selection, source, expected_sha256=expected_sha256)
            catalog = inspection.bootstrap_catalog(identifier, actor)
            execution = B.TARGET.SOURCE.validate_profile(catalog['executionProfile'])
            profile = B.TARGET.bounded_clean_target_profile(self.enrollment.runtime.image(execution['imageId']),
                execution['role'], catalog['databaseExecution']['database'], catalog['databaseExecution']['locale'])
        approved_sha256 = self.digest(policy)

        @contextmanager
        def protected_guard():
            with guard(), broker.installed_authority():
                self.read(selection, source, expected_sha256=approved_sha256)
                yield
                self.read(selection, source, expected_sha256=approved_sha256)

        manager = B.CoreVersionedCleanTargetBootstrap.from_source_inspection(broker, inspection, identifier, actor,
            profile=profile, migration_inventory=policy['inventory'], migration_graph=policy['graph'], guard=protected_guard)
        with protected_guard():
            manager.validate(actor)
        return manager
