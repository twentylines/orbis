"""Real live guard/claim files; lifecycle Docker, SQL and source proof are fixtures."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest import mock
import test_orbis_host_service as HOST


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    sys.modules[key] = module
    spec.loader.exec_module(module)
    return module


F = load('test_orbis_host_core_live_restoration.py', 'live_custody_upstream_fixture')
STAGE = 'ac380ec4-3798-496f-ac3d-0b4ab3a45681'
OTHER = 'ac380ec4-3798-496f-ac3d-0b4ab3a45682'


class LiveImportCustodyTests(unittest.TestCase):
    def setUp(self):
        self.fixture = f = F.LiveRestorationTests()
        f.setUp()
        self.addCleanup(f.doCleanups)
        self.live, self.service = f.live, f.service
        self.assertTrue(f.finish()['readyForImport'])

    def checked(self):
        return self.live._checked_stage(F.ID, F.ACTOR)

    def abort(self):
        return self.live.abort(self.fixture.observe | {'action': F.L.ABORT}, privileged_peer=True)

    def test_guard_is_typed_thread_bound_and_expires_without_reopening_original(self):
        with self.checked() as checked:
            self.assertIs(type(checked), F.L.CheckedLiveRestoration)
            self.assertIs(checked.owner, self.live)
            self.assertEqual(checked.record['phase'], 'awaiting-import')
            errors = []

            def other_thread():
                try:
                    with checked.guard():
                        pass
                except ValueError:
                    errors.append('expired-or-foreign')

            thread = threading.Thread(target=other_thread)
            thread.start(); thread.join(timeout=2)
            self.assertFalse(thread.is_alive())
            self.assertEqual(errors, ['expired-or-foreign'])
            with self.assertRaises(ValueError):
                self.abort()
        with self.assertRaises(ValueError), checked.guard():
            pass
        self.assertFalse(self.fixture.facts['allowConnections'])
        self.assertFalse(self.fixture.fixture.raw['State']['Running'])

    def test_claim_is_exact_durable_once_and_cannot_be_reassigned_or_used_after_scope(self):
        with self.checked() as checked:
            claim = checked.claim(STAGE)
            self.assertEqual(claim, {'schema': F.L.IMPORT_CLAIM, 'liveJobId': F.ID,
                                    'liveAdmissionSha256': self.live.digest(checked.admission), 'stageId': STAGE})
            self.assertEqual(self.live._read(F.ID, 'import-claim.json'), claim)
            for stage in (STAGE, OTHER):
                with self.assertRaises(ValueError):
                    checked.claim(stage)
        with self.assertRaises(ValueError):
            checked.claim(OTHER)
        self.assertEqual(self.live._read(F.ID, 'import-claim.json'), claim)

    def test_import_claim_refuses_known_live_and_prepared_identifiers(self):
        with self.checked() as checked:
            for stage in (F.ID, checked.admission['reviewId'], checked.admission['targetPreparationId'], '../escape'):
                with self.subTest(stage=stage), self.assertRaises(ValueError):
                    checked.claim(stage)
            self.assertFalse((self.live._directory(F.ID) / 'import-claim.json').exists())

    def test_unsettled_claim_refuses_abort_before_any_reopening_or_restart(self):
        with self.checked() as checked:
            claim = checked.claim(STAGE)
        importer = SimpleNamespace(assert_settled_for_abort=mock.Mock(return_value=True))
        importer.assert_settled_for_abort.side_effect = ValueError('unknown import worker custody')
        self.service.core_live_imports = mock.Mock(return_value=importer)
        before = copy.deepcopy(self.fixture.calls)
        with self.assertRaises(ValueError):
            self.abort()
        importer.assert_settled_for_abort.assert_called_once_with(F.ID, claim, F.ACTOR)
        self.assertEqual(self.fixture.calls, before)
        self.assertFalse(self.fixture.facts['allowConnections'])
        self.assertTrue(self.live._marker_path().exists())
        self.assertFalse((self.live._directory(F.ID) / 'abort-decision.json').exists())

    def test_settled_claim_requires_independent_importer_before_original_abort(self):
        with self.checked() as checked:
            claim = checked.claim(STAGE)
        importer = SimpleNamespace(assert_settled_for_abort=mock.Mock(return_value=True))
        self.service.core_live_imports = mock.Mock(return_value=importer)
        self.assertEqual(self.abort()['phase'], 'aborted')
        importer.assert_settled_for_abort.assert_called_once_with(F.ID, claim, F.ACTOR)
        self.assertTrue(self.fixture.facts['allowConnections'])
        self.assertFalse(self.live._marker_path().exists())

    def test_false_settlement_result_cannot_authorize_abort(self):
        with self.checked() as checked:
            checked.claim(STAGE)
        self.service.core_live_imports = lambda: SimpleNamespace(assert_settled_for_abort=lambda *args: False)
        with self.assertRaises(ValueError):
            self.abort()
        self.assertFalse(self.fixture.facts['allowConnections'])
        self.assertTrue(self.live._marker_path().exists())

    def test_wrong_claim_binding_is_refused_before_importer_lookup(self):
        with self.checked() as checked:
            checked.claim(STAGE)
        path = self.live._directory(F.ID) / 'import-claim.json'
        value = json.loads(path.read_bytes()); value['liveAdmissionSha256'] = 'f' * 64
        path.chmod(0o600); path.write_bytes(self.live.P.canonical(value)); path.chmod(0o400)
        self.service.core_live_imports = mock.Mock()
        with self.assertRaises(ValueError):
            self.abort()
        self.service.core_live_imports.assert_not_called()
        self.assertFalse(self.fixture.facts['allowConnections'])

    def test_output_replacement_invalidates_normal_scope_exit(self):
        with self.assertRaises(ValueError), self.checked():
            path = self.live._directory(F.ID) / 'output/result.json'
            body = path.read_bytes(); path.unlink(); path.write_bytes(body); path.chmod(0o400)
        self.assertFalse(self.fixture.facts['allowConnections'])
        self.assertTrue(self.live._marker_path().exists())
        self.assertFalse(self.live._active)

    def test_foreign_actor_is_refused_and_reservation_is_released(self):
        actor = {**F.ACTOR, 'sessionBinding': 'f' * 64}
        with self.assertRaises(ValueError), self.live._checked_stage(F.ID, actor):
            pass
        self.assertFalse(self.live._active)
        self.assertFalse(self.fixture.facts['allowConnections'])


class LiveImportFactoryTests(unittest.TestCase):
    def test_factory_returns_one_importer_without_starting_mutations(self):
        service = object.__new__(HOST.SERVICE.HostService)
        service.core_live_import_factory_lock = threading.Lock()
        service.core_live_import_service = None
        service.core_live_import_module = None
        service.core_live_restorations = mock.Mock()
        importer = SimpleNamespace(prepare=mock.Mock(), verify_imported=mock.Mock())
        module = SimpleNamespace(CoreLiveDerivedLogicalStage=mock.Mock(return_value=importer))
        with mock.patch.object(HOST.SERVICE, 'load_script', return_value=module) as loader:
            self.assertIs(service.core_live_imports(), importer)
            self.assertIs(service.core_live_imports(), importer)
        loader.assert_called_once_with('orbis-host-core-live-import.py', 'orbis_core_live_import_for_service')
        module.CoreLiveDerivedLogicalStage.assert_called_once_with(service)
        self.assertIs(service.core_live_import_module, module)
        importer.prepare.assert_not_called()
        importer.verify_imported.assert_not_called()


if __name__ == '__main__':
    unittest.main()
