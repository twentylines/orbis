"""Root/worker contract fixtures; Docker state is synthetic, not Linux proof."""
import copy
import json
from unittest import mock

import test_orbis_host_core_source_configuration as source

M = source.module


class TargetSupervisor(source.Supervisor):
    def wait(self, role, timeout):
        super().wait(role, timeout)
        request = self.record['request']
        output = self.manager.directory(self.record['id']) / 'output'
        environment = b"JWT_SECRET='declared-private-fixture-not-live'\n"
        settings = b'{"timeZone":"UTC"}\n'
        auth = (output / 'source-authentication.json').read_bytes()
        self.manager.enrollment.immutable(output / 'target.env', environment)
        self.manager.enrollment.immutable(output / 'target-settings.json', settings)
        report = json.loads((output / 'result.json').read_bytes())
        report['schema'] = 'orbis.core-target-configuration-worker-result.v1'
        report['target'] = {
            'schema': 'orbis.core-target-configuration.v1',
            'destinationWitnessSha256': request['destinationWitnessSha256'],
            'destinationConfigurationSha256': request['destinationConfigurationSha256'],
            'databaseName': request['targetDatabaseName'], 'configurationSha256': M.sha(environment),
            'settingsSha256': M.sha(settings), 'sourceAuthenticationSha256': M.sha(auth),
            'sessionPolicy': 'new-empty-cache-required', 'environmentProved': False,
            'restoreAuthority': False, 'activation': False,
        }
        (output / 'result.json').unlink()
        self.manager.enrollment.immutable(output / 'result.json', source.Publication.canonical(report))


class TargetBrokerTests(source.BrokerTests):
    def setUp(self):
        super().setUp()
        self.target = M.RootTargetConfiguration(b'JWT_SECRET=destination-private-fixture\n', 'orbis_restored', '9' * 64)
        self.broker = M.CoreSourceConfigurationPreparation(self.enrollment, self.trust, target=self.target)
        patcher = mock.patch.object(M.SUPERVISOR, 'InspectionSupervisor', TargetSupervisor)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_projection_body_has_only_private_code_input_and_output_mounts(self):
        body = self.broker.body(self.root / 'projection', self.identifier, 'e' * 64)
        self.assertEqual(body['Cmd'][-1], '--project-target')
        self.assertEqual(body['Labels']['io.orbis.core-inspection.role'], 'target-configuration')
        self.assertNotEqual(self.broker.worker_role(), M.CoreSourceConfigurationPreparation(self.enrollment, self.trust).worker_role())
        self.assertEqual(len(body['HostConfig']['Mounts']), 3)
        self.assertEqual(body['HostConfig']['NetworkMode'], 'none')
        self.assertTrue(body['HostConfig']['ReadonlyRootfs'])

    def test_rejected_actor_creates_no_preparation(self):
        with mock.patch.object(self.enrollment, 'actor', side_effect=ValueError('invalid actor')):
            with self.assertRaises(ValueError):
                self.prepare()
        self.assertFalse((self.root / 'core-target-configuration-preparations').exists())

    def test_distinct_handle_schema_and_namespace(self):
        result = self.prepare()
        self.assertIs(type(result), M.PreparedTargetConfiguration)
        self.assertIsNot(type(result), M.PreparedConfiguration)
        directory = self.broker.directory(self.identifier)
        self.assertEqual(directory.parent.name, 'core-target-configuration-preparations')
        record = self.broker.record(self.identifier)
        self.assertEqual(record['schema'], M.TARGET_SCHEMA)
        self.assertEqual(record['request']['schema'], 'orbis.core-target-configuration-worker-input.v1')
        self.assertEqual(record['request']['targetDatabaseName'], 'orbis_restored')
        self.assertEqual((directory / 'input/destination.env').read_bytes(), self.target.configuration)
        receipt = json.loads((directory / 'receipt.json').read_bytes())
        self.assertEqual(receipt['schema'], 'orbis.core-target-configuration-receipt.v1')
        self.assertEqual(receipt['sessionPolicy'], 'new-empty-cache-required')
        self.assertEqual(receipt['destinationWitnessSha256'], self.target.witness_sha256)
        self.assertNotIn(b'destination-private-fixture', (directory / 'job.json').read_bytes())

    def test_invalid_target_refuses_before_directory_creation(self):
        values = [None, bytearray(b'not immutable'), b'', b'\xff', b'bad\0value', b'x' * (1024 * 1024 + 1)]
        for value in values:
            with self.subTest(value_type=type(value).__name__), self.assertRaises(M.PreparationError):
                M.CoreSourceConfigurationPreparation(self.enrollment, self.trust,
                    target=M.RootTargetConfiguration(value, 'orbis_restored', '9' * 64))
        for name in ['postgres', 'POSTGRES', 'template0', 'template1', '../bad', 'a' * 64]:
            with self.subTest(name=name), self.assertRaises(M.PreparationError):
                M.CoreSourceConfigurationPreparation(self.enrollment, self.trust,
                    target=M.RootTargetConfiguration(b'valid', name, '9' * 64))
        with self.assertRaises(M.PreparationError):
            M.CoreSourceConfigurationPreparation(self.enrollment, self.trust,
                target={'configuration': b'valid', 'database_name': 'orbis_restored', 'witness_sha256': '9' * 64})
        self.assertFalse((self.root / 'core-target-configuration-preparations').exists())

    def test_changed_destination_binding_refuses_completed_output(self):
        self.prepare()
        original = self.broker.target
        for target in [M.RootTargetConfiguration(b'changed', original.database_name, original.witness_sha256),
                       M.RootTargetConfiguration(original.configuration, 'another_db', original.witness_sha256),
                       M.RootTargetConfiguration(original.configuration, original.database_name, '8' * 64)]:
            self.broker.target = target
            with self.assertRaises(M.PreparationError):
                self.broker.checked(self.identifier, self.actor, self.source)
        self.broker.target = original
        self.assertIs(type(self.broker.checked(self.identifier, self.actor, self.source)), M.PreparedTargetConfiguration)

    def test_missing_or_changed_target_outputs_refuse(self):
        self.prepare()
        directory = self.broker.directory(self.identifier)
        for name in ['target.env', 'target-settings.json']:
            path = directory / 'output' / name
            body = path.read_bytes()
            path.chmod(0o600)
            path.write_bytes(body + b' ')
            path.chmod(0o400)
            with self.assertRaises(M.PreparationError):
                self.broker.checked(self.identifier, self.actor, self.source)
            path.chmod(0o600)
            path.write_bytes(body)
            path.chmod(0o400)

    def test_changed_target_report_or_false_flags_refuse(self):
        self.prepare()
        report_path = self.broker.directory(self.identifier) / 'output/result.json'
        original = json.loads(report_path.read_bytes())
        for field, value in [('sessionPolicy', 'reuse-cache'), ('databaseName', 'another'),
                             ('sourceAuthenticationSha256', '0' * 64), ('activation', True), ('activation', 0),
                             ('environmentProved', 0), ('restoreAuthority', True)]:
            report = copy.deepcopy(original)
            report['target'][field] = value
            report_path.chmod(0o600)
            report_path.write_bytes(source.Publication.canonical(report))
            report_path.chmod(0o400)
            with self.subTest(field=field, value=value), self.assertRaises(M.PreparationError):
                self.broker.checked(self.identifier, self.actor, self.source)


if __name__ == '__main__':
    import unittest
    unittest.main()
