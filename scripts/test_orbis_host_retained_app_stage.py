import copy
import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest import mock

from test_orbis_host_retained_restore import D, M
from test_orbis_host_app_runtime import fixture


class RetainedAppStageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.base.chmod(0o700)
        self.capture = M.CAPTURE
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(self.capture.AUTHORITY, 'OWNER', os.getuid()).start()
        self.app = self.capture.APP
        self.value, self.expected = fixture()
        self.expected.update(rootSha256=D.hashed(str(self.base).encode()), dockerContextSha256=D.hashed(b'fixture-context'))
        self.value.pop('sha256'); self.value.update(self.expected)
        self.value = self.app.seal(self.value, self.expected)
        self.point = self.expected['pointId']
        self.body = self.app.canonical(self.value)
        self.original = self.base / 'origin'
        self.retained = self.base / 'retained'
        self.content = self.base / 'content'
        for directory in (self.original, self.retained, self.content):
            directory.mkdir(mode=0o700)
        self.write(self.original / 'app-runtime.json', self.body)
        self.write(self.retained / 'app-runtime.json', self.body)
        self.prepared = {'pointId': self.point, 'rootSha256': self.expected['rootSha256'],
                         'contextSha256': self.expected['dockerContextSha256'],
                         'configuration': {'configurationSetSha256': self.expected['configurationSetSha256']},
                         'publicationReceipt': {'preparationSha256': self.expected['preparationSha256']}}
        self.preparation = {'appRuntimeSha256': D.hashed(self.body), 'appRuntimeDaemonSha256': self.expected['daemonSha256']}
        mock.patch.object(self.capture, 'load_preparation', return_value=self.prepared).start()
        mock.patch.object(self.capture, 'load_app_preparation', return_value=self.preparation).start()
        mock.patch.object(self.capture, 'directory', return_value=self.original).start()
        self.runtime = object.__new__(D.DockerRestoreRuntime)
        self.runtime.manager = SimpleNamespace(CAPTURE=self.capture, state=self.base)
        self.runtime.root, self.runtime.context = self.base, 'fixture-context'
        self.runtime.a = self.capture.AUTHORITY
        self.runtime.P = M.P
        self.authority = {'schema': 'orbis.controller-capture-authority.v4', 'version': 4,
                          'appRuntimeSha256': D.hashed(self.body), 'appRuntimeDaemonSha256': self.expected['daemonSha256']}
        self.metadata = {'appRuntimeSha256': D.hashed(self.body)}
        app = self.value['apps'][0]
        self.record = {'schema': 'orbis.time-machine-image-capture.v2',
                       'apps': [{key: app[key] for key in ('urn', 'project', 'userConfigEnabled', 'sourceSha256', 'configurationSha256')}],
                       'containers': [], 'inventory': {'version': 1, 'images': [], 'bindings': []}}
        self.record['apps'][0]['services'] = ['whoami']
        for container in self.value['containers']:
            raw, image = container['inspect'], container['image']
            key = 'apps/' + container['appUrn'] + '/' + container['service'] + '/' + str(container['ordinal'])
            self.record['containers'].append(dict(id=raw['Id'], imageId=image['sourceImageId'], reference=raw['Config']['Image'],
                project=app['project'], service=container['service'], oneOff=False, running=False, paused=False, restarting=False,
                role='app', appUrn=app['urn'], key=key, ordinal=container['ordinal'], wasRunning=container['wasRunning']))
            self.record['inventory']['bindings'].append({'key': key, 'imageId': image['sourceImageId']})
            self.record['inventory']['images'].append({'imageId': image['sourceImageId'], 'repoDigests': [],
                'archive': 'image-' + image['sourceImageId'][7:] + '.tar', 'bytes': 10240, 'sha256': 'f' * 64,
                'identity': {'kind': 'oci', 'configId': 'sha256:' + '9' * 64, 'manifestId': image['creationReference'],
                             'archiveRootId': 'sha256:' + '8' * 64, 'platform': image['platform'], 'expandedBytes': 100}})
        self.manifest = {'format': 'orbis-full-backup', 'version': 1, 'files': copy.deepcopy(app['savedFiles'])}
        for name, body in [('app-data/demo/whoami/app.env', b'MODE=saved-new\n'), ('data/apps/demo/whoami/config.json', b'{}\n')]:
            self.write(self.content / name, body)

    def write(self, path, body):
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        path.write_bytes(body)
        path.chmod(0o600)

    def review(self):
        return self.runtime.review_app_runtime({'pointId': self.point}, self.authority, self.metadata,
                                              self.record, self.retained, self.content, self.manifest)

    def test_actual_private_files_bind_mixed_replicas_and_pending_saved_config(self):
        self.assertEqual(self.review(), self.body)
        self.assertTrue(self.value['apps'][0]['pendingRestart'])
        self.assertNotEqual(self.value['containers'][0]['inspect']['Config']['Env'][0], 'MODE=saved-new')

    def test_rehashed_imported_definition_cannot_replace_root_original(self):
        changed = copy.deepcopy(self.value)
        changed.pop('sha256')
        changed['containers'][0]['inspect']['Config']['Env'][0] = 'MODE=forged'
        changed = self.app.seal(changed, self.expected)
        body = self.app.canonical(changed)
        self.write(self.retained / 'app-runtime.json', body)
        self.metadata['appRuntimeSha256'] = D.hashed(body)
        self.authority['appRuntimeSha256'] = D.hashed(body)
        with self.assertRaises(ValueError): self.review()

    def test_independent_receipt_hash_daemon_and_root_original_fail_closed(self):
        for field in ('appRuntimeSha256', 'appRuntimeDaemonSha256'):
            with self.subTest(field=field), mock.patch.dict(self.preparation, {field: '0' * 64}), self.assertRaises(ValueError): self.review()
        self.write(self.original / 'app-runtime.json', self.body + b' ')
        with self.assertRaises(ValueError): self.review()

    def test_replica_runtime_identity_and_archived_creation_graph_are_exact(self):
        mutations = [lambda x: x['containers'].pop(),
                     lambda x: x['containers'][0].update(wasRunning=False),
                     lambda x: x['containers'][0].update(ordinal=2),
                     lambda x: x['containers'][0].update(reference='new-saved:tag'),
                     lambda x: x['inventory']['images'][0]['identity'].update(manifestId='sha256:' + '0' * 64),
                     lambda x: x['inventory']['images'][0]['identity']['platform'].update(variant='v9'),
                     lambda x: x['inventory']['bindings'].append(copy.deepcopy(x['inventory']['bindings'][0])),
                     lambda x: x['apps'][0].update(userConfigEnabled=False)]
        for change in mutations:
            with self.subTest(change=change):
                original = self.record
                self.record = copy.deepcopy(original)
                change(self.record)
                try:
                    with self.assertRaises((ValueError, KeyError)): self.review()
                finally: self.record = original

    def test_saved_source_manifest_and_actual_file_bytes_are_separate_authority(self):
        self.manifest['files'][0]['sha256'] = '0' * 64
        with self.assertRaises(ValueError): self.review()
        self.manifest['files'][0] = copy.deepcopy(self.value['apps'][0]['savedFiles'][0])
        self.write(self.content / 'app-data/demo/whoami/app.env', b'MODE=changed\n')
        with self.assertRaises(ValueError): self.review()

    def test_absent_saved_override_cannot_be_injected_outside_manifest(self):
        self.write(self.content / 'data/user-config/demo/whoami/docker-compose.yml', b'services: {}')
        with self.assertRaises(ValueError): self.review()

    def test_symlink_substitution_and_duplicate_manifest_names_fail(self):
        path = self.content / 'app-data/demo/whoami/app.env'
        path.unlink()
        path.symlink_to(self.original / 'app-runtime.json')
        with self.assertRaises((ValueError, OSError)): self.review()
        path.unlink()
        self.write(path, b'MODE=saved-new\n')
        self.manifest['files'].append(copy.deepcopy(self.manifest['files'][0]))
        with self.assertRaises(ValueError): self.review()

    def test_legacy_manifest_fractional_mtime_does_not_relax_authority_parser(self):
        manifest = copy.deepcopy(self.manifest)
        manifest['files'][0]['mtime'] = 1793548800000.5
        self.manifest = self.runtime.json_bytes(json.dumps(manifest).encode())
        self.assertEqual(self.review(), self.body)
        with self.assertRaises(ValueError): self.runtime.P.metadata(json.dumps(manifest).encode())

    def destination_fixture(self):
        observed = copy.deepcopy(self.value)
        observed.pop('sha256')
        observed['daemonSha256'] = D.hashed(b'current-root-daemon')
        expected = {key: observed[key] for key in self.expected}
        observed = self.app.seal(observed, expected)
        source = {'controllerId': 'c' * 64, 'imageId': 'sha256:' + 'd' * 64, 'daemonId': 'current-root-daemon'}
        apps = []
        for container in observed['containers']:
            raw = container['inspect']
            apps.append({'container': {'id': raw['Id'], 'fingerprint': self.runtime.node_fingerprint(raw),
                         'running': container['wasRunning'], 'restart': raw['HostConfig']['RestartPolicy']},
                         'project': container['appUrn'].replace(':', '_')})
        configuration = {'configurationSetSha256': 'f' * 64}
        self.runtime.manager.service = SimpleNamespace(_capture_controller_config_locked=mock.Mock(return_value=configuration))
        self.runtime.host = SimpleNamespace()
        self.runtime.image = mock.Mock(return_value={'Os': 'linux', 'Architecture': 'arm64', 'Variant': 'v8'})
        return observed, source, {'identity': {'apps': apps}}

    def test_current_retirement_set_is_observed_independently_before_quiescence(self):
        observed, source, bootstrap = self.destination_fixture()
        with mock.patch.object(self.app, 'observe', return_value=observed) as observe:
            actual, bindings = self.runtime.destination_app_runtime({'pointId': self.point}, source, bootstrap)
        self.assertEqual(actual, observed)
        self.assertEqual(bindings, [])
        self.assertIs(observe.call_args.kwargs['driver'], self.runtime)
        self.runtime.manager.service._capture_controller_config_locked.assert_called_once_with(self.point, source['controllerId'], source['imageId'])

    def test_backend_cannot_omit_or_replace_a_current_managed_container(self):
        observed, source, bootstrap = self.destination_fixture()
        for change in (lambda value: value['identity']['apps'].pop(),
                       lambda value: value['identity']['apps'][0]['container'].update(fingerprint='0' * 64),
                       lambda value: value['identity']['apps'][0]['container'].update(running=False),
                       lambda value: value['identity']['apps'][0].update(project='other')):
            modified = copy.deepcopy(bootstrap)
            change(modified)
            with self.subTest(change=change), mock.patch.object(self.app, 'observe', return_value=observed), self.assertRaises(ValueError):
                self.runtime.destination_app_runtime({'pointId': self.point}, source, modified)

    def test_destination_scope_excludes_only_observation_time_and_its_self_hash(self):
        observed, _, _ = self.destination_fixture()
        before = self.runtime.destination_app_digest(observed, [])
        observed['capturedAt'] += 1000
        observed['sha256'] = '0' * 64
        self.assertEqual(self.runtime.destination_app_digest(observed, []), before)
        observed['containers'][0]['inspect']['Config']['Env'].append('NEW=changed')
        self.assertNotEqual(self.runtime.destination_app_digest(observed, []), before)

    def test_allocation_pins_root_private_destination_and_rejects_review_drift(self):
        observed, source, bootstrap = self.destination_fixture()
        directory = self.base / 'transaction'
        directory.mkdir(mode=0o700)
        self.runtime.manager.directory = mock.Mock(return_value=directory)
        self.runtime.manager.save = mock.Mock()
        record = {'id': '22222222-2222-4222-8222-222222222222', 'pointId': self.point, 'source': source,
                  'stage': {'bootstrap': bootstrap, 'destinationAppRuntimeSha256': self.runtime.destination_app_digest(observed, [])}}
        with mock.patch.object(self.runtime, 'destination_app_runtime', return_value=(observed, [])):
            self.runtime.pin_destination_apps(record)
        self.assertEqual((directory / 'destination-app-runtime.json').read_bytes(), self.app.canonical(observed))
        self.assertEqual(record['destinationAppBindingsSha256'], D.hashed(b'[]'))
        self.assertEqual((directory / 'destination-app-runtime.json').stat().st_mode & 0o777, 0o600)
        observed['containers'][0]['inspect']['Config']['Env'].append('NEW=changed')
        with mock.patch.object(self.runtime, 'destination_app_runtime', return_value=(observed, [])), self.assertRaises(ValueError):
            self.runtime.pin_destination_apps(record)


if __name__ == '__main__': unittest.main()
