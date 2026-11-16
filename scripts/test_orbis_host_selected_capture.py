import copy
import importlib.util
import os
import tarfile
import sys
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


S = load('orbis-host-selected-capture.py', 'selected_capture_subject')
F = load('test_orbis_host_time_machine_core.py', 'selected_capture_core_fixture')
COMPLETION = load('orbis-host-core-capture-completion.py', 'selected_capture_completion_subject')


class SelectedCaptureTests(unittest.TestCase):
    def setUp(self):
        self.fixture = F.CoreCaptureTests('test_real_review_checkpoint_and_same_id_resume_exclude_all_apps_and_proxy')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.root, self.reader, self.core = self.fixture.root, self.fixture.docker, self.fixture.capture
        inspect = self.reader._object
        def bounded_image_fixture(arguments):
            value = inspect(arguments)
            if arguments[:2] == ['image', 'inspect']:
                value['Size'] = 0
            return value
        self.reader._object = bounded_image_fixture
        for index in range(3):
            (self.root / 'apps' / 'migrated' / ('app' + str(index))).mkdir(parents=True)
            self.reader.apps[F.identifier('app-' + str(index))]['labels']['com.docker.compose.project.working_dir'] = str(
                self.root / 'apps' / 'migrated' / ('app' + str(index)))
        if not hasattr(os, 'listxattr') or not hasattr(os, 'getxattr'):
            self.enterContext(mock.patch.object(S.PACK, 'attributes', return_value={}))
        self.capture = S.SelectedCapture(self.fixture.service, self.core, F.C.HOST)
        preparation = self.fixture.state / 'core-capture-preparations' / F.POINT
        preparation.mkdir(parents=True, mode=0o700)
        preparation.parent.chmod(0o700)
        self.reservation = {'schema': 'synthetic-reservation', 'id': F.POINT}
        self.capture.write(preparation, 'point-reservation.json', self.reservation)
        self.enterContext(mock.patch.object(S.STORAGE.APPS, 'Docker', return_value=self.reader))
        self.review = self.capture.review(self.reader, ['app0:migrated'])
        self.choices = [{'urn': 'app0:migrated', 'mountIds': [self.review['apps'][0]['mounts'][0]['id']]}]

    def bind(self):
        return self.capture.bind(self.reader, F.POINT, {
            'pointId': F.OTHER, 'reviewId': self.review['reviewId'],
            'reviewSha256': self.review['reviewSha256'], 'coreReservationSha256': S.digest(self.reservation),
            'apps': self.choices,
        })

    def test_bound_selection_stops_and_resumes_only_selected_apps(self):
        self.bind()
        def copied(reader, binding, record, directory):
            self.assertEqual(reader.apps[F.identifier('app-0')]['state'], 'exited')
            self.assertEqual(reader.apps[F.identifier('app-1')]['state'], 'exited')
            record['artifact'] = {'bytes': 10240, 'sha256': 'b' * 64}
            record['manifest'] = {'fixture': 'copy-only-stub'}
        self.enterContext(mock.patch.object(self.capture, '_capture', side_effect=copied))
        admission = SimpleNamespace(point=F.POINT, request={'schema': 'orbis.core-capture-admission.v2'}, request_sha256='c' * 64, unchanged=lambda: None)
        receipt = self.capture.execute(admission, lambda: self.core.capture(F.POINT, host_writers_stopped=True))
        self.assertEqual(receipt['pointId'], F.POINT)
        calls = [args for args, _ in self.reader.calls if args[-1] in self.reader.apps]
        self.assertEqual({args[-1] for args in calls}, {F.identifier('app-0')})
        self.assertEqual([args[0] for args in calls], ['update', 'stop', 'start', 'update'])
        self.assertEqual(self.reader.apps[F.identifier('app-0')]['state'], 'running')
        self.assertEqual(self.capture.receipt(F.POINT)['resumedContainerIds'], [F.identifier('app-0')])
        core_record = self.core.read(self.core.base / F.POINT)
        original = copy.deepcopy(core_record)
        with self.assertRaises(Exception):
            self.core.verify(self.reader, core_record)
        view = self.capture.completion_record(admission, self.reader, core_record)
        self.core.verify(self.reader, view)
        self.assertEqual(core_record, original)
        self.assertEqual(self.core.read(self.core.base / F.POINT), original)
        self.assertEqual(set(view['expected']) - set(original['expected']), {F.identifier('app-0')})
        admission.state = self.fixture.state
        admission.request['sourceSha256'] = F.C.TX.APPS.digest(core_record['source'])
        controller_id = next(key for key, role in core_record['checkpoint']['roles'].items() if role == 'controller')
        controller = core_record['expected'][controller_id]
        preparation = {'controller': {'id': controller_id, 'imageId': controller['imageId'],
                                     'definitionSha256': F.C.TX.APPS.digest(controller['definition'])}}
        subject = object.__new__(COMPLETION.CoreCaptureCompletion)
        subject.manager = SimpleNamespace(service=self.fixture.service, capture=self.core, controller_marker=lambda value: b'fixture hold')
        subject.worker = SimpleNamespace(CORE=F.C, SELECTED=S)
        with mock.patch.object(COMPLETION, 'require_dependency_ready') as health:
            self.assertEqual(subject.observed(admission, self.reader, core_record, preparation, b'fixture hold')['id'], controller_id)
            self.assertEqual({call.args[2] for call in health.call_args_list}, set(core_record['checkpoint']['roles']))

        for field, value in [('phase', 'resuming'), ('pendingMutation', ['start', F.identifier('app-0')])]:
            directory = self.capture.directory(F.POINT)
            saved = self.capture.read(directory, 'operation.json')
            changed = dict(saved, **{field: value})
            self.capture.write(directory, 'operation.json', changed, replace=True)
            with self.assertRaises(S.SelectedCaptureError):
                self.capture.completion_record(admission, self.reader, core_record)
            self.capture.write(directory, 'operation.json', saved, replace=True)
        changed = copy.deepcopy(core_record)
        changed['checkpointSha256'] = 'f' * 64
        with self.assertRaises(S.SelectedCaptureError):
            self.capture.completion_record(admission, self.reader, changed)
        self.reader.apps[F.identifier('app-1')]['state'] = 'running'
        with self.assertRaises(S.SelectedCaptureError):
            self.capture.completion_record(admission, self.reader, core_record)
        self.reader.apps[F.identifier('app-1')]['state'] = 'exited'
        self.reader.apps[F.identifier('new-writer')] = copy.deepcopy(self.reader.apps[F.identifier('app-1')])
        self.reader.apps[F.identifier('new-writer')]['id'] = F.identifier('new-writer')
        with self.assertRaises(S.SelectedCaptureError):
            self.capture.completion_record(admission, self.reader, core_record)


    def test_selected_originally_stopped_app_is_copied_without_starting_or_stopping_it(self):
        self.reader.apps[F.identifier('app-0')]['state'] = 'exited'
        self.review = self.capture.review(self.reader, ['app0:migrated'])
        self.choices[0]['mountIds'] = [self.review['apps'][0]['mounts'][0]['id']]
        self.bind()
        def copied(reader, binding, record, directory):
            record['artifact'] = {'bytes': 10240, 'sha256': 'b' * 64}
            record['manifest'] = {'fixture': 'copy-only-stub'}
        self.enterContext(mock.patch.object(self.capture, '_capture', side_effect=copied))
        admission = SimpleNamespace(point=F.POINT, request={'schema': 'orbis.core-capture-admission.v2'},
                                    request_sha256='c' * 64, unchanged=lambda: None)
        self.capture.execute(admission, lambda: self.core.capture(F.POINT, host_writers_stopped=True))
        self.assertEqual(self.capture.receipt(F.POINT)['resumedContainerIds'], [])
        self.assertEqual(self.reader.apps[F.identifier('app-0')]['state'], 'exited')
        calls = [args for args, _ in self.reader.calls if args[-1] in self.reader.apps]
        self.assertEqual({args[-1] for args in calls}, {F.identifier('app-0')})
        self.assertEqual([args[0] for args in calls], ['update', 'update'])
        view = self.capture.completion_record(admission, self.reader, self.core.read(self.core.base / F.POINT))
        self.core.verify(self.reader, view)

    def test_real_selected_copy_seals_requested_bytes_and_excludes_media(self):
        self.real_selected_copy(False)

    def test_real_explicit_media_copy_seals_only_the_checked_external_mount(self):
        self.real_selected_copy(True)

    def real_selected_copy(self, include_media):
        source = self.root / 'app-data' / 'app-0'
        (source / 'settings.json').write_bytes(b'captured selected settings')
        media = self.fixture.parent / 'media'
        media.mkdir()
        (media / 'movie.bin').write_bytes(b'excluded media')
        self.reader.apps[F.identifier('app-0')]['mounts'].append(
            {'Type': 'bind', 'Source': str(media), 'Destination': '/media', 'RW': True})
        self.review = self.capture.review(self.reader, ['app0:migrated'])
        self.choices[0]['mountIds'] = [item['id'] for item in self.review['apps'][0]['mounts']
                                         if item['destination'] == '/data' or include_media]
        self.bind()
        def save_images(reader, images, descriptor, platform):
            os.write(descriptor, b'fixture Docker-save bytes; no daemon contacted')
        self.enterContext(mock.patch.object(self.capture, '_save_images', side_effect=save_images))
        if not hasattr(os, 'listxattr') or not hasattr(os, 'getxattr'):
            # Darwin's Python lacks the Linux xattr API. This fixture proves copied
            # bytes only; the production packer still requires lossless metadata.
            self.enterContext(mock.patch.object(S.PACK, 'attributes', return_value={}))
        admission = SimpleNamespace(point=F.POINT, request={'schema': 'orbis.core-capture-admission.v2'}, request_sha256='c' * 64, unchanged=lambda: None)
        self.capture.execute(admission, lambda: self.core.capture(F.POINT, host_writers_stopped=True))
        receipt = self.capture.receipt(F.POINT)
        with tarfile.open(self.capture.directory(F.POINT) / 'apps.tar', 'r:') as archive:
            settings = next(name for name in archive.getnames() if name.endswith('/settings.json'))
            self.assertEqual(archive.extractfile(settings).read(), b'captured selected settings')
            movies = [name for name in archive.getnames() if name.endswith('/movie.bin')]
            self.assertEqual(len(movies), 1 if include_media else 0)
            if include_media:
                self.assertEqual(archive.extractfile(movies[0]).read(), b'excluded media')
                self.assertIn('/media', [item['destination'] for item in receipt['manifest']['includedStorage']])
            self.assertEqual(len(receipt['manifest']['includedStorage']), 2 if include_media else 1)
        self.assertEqual({args[-1] for args, _ in self.reader.calls if args[-1] in self.reader.apps}, {F.identifier('app-0')})

    def test_shared_writer_is_rejected_before_any_stop(self):
        self.reader.apps[F.identifier('app-1')]['mounts'] = copy.deepcopy(self.reader.apps[F.identifier('app-0')]['mounts'])
        self.review = self.capture.review(self.reader, ['app0:migrated'])
        self.choices[0]['mountIds'] = [self.review['apps'][0]['mounts'][0]['id']]
        with self.assertRaisesRegex(S.SelectedCaptureError, 'another Docker writer'):
            self.bind()
        self.assertEqual(self.reader.calls, [])

    def test_media_mount_is_never_implicitly_selected(self):
        media = self.fixture.parent / 'media'
        media.mkdir()
        self.reader.apps[F.identifier('app-0')]['mounts'].append(
            {'Type': 'bind', 'Source': str(media), 'Destination': '/media', 'RW': True})
        self.review = self.capture.review(self.reader, ['app0:migrated'])
        choices = self.review['apps'][0]['mounts']
        self.assertEqual(next(item for item in choices if item['destination'] == '/media')['classification'], 'media')
        self.assertTrue(all(item['requiresExplicitInclusion'] for item in choices))
        self.choices[0]['mountIds'] = [next(item for item in choices if item['destination'] != '/media')['id']]
        self.bind()
        binding = self.capture.read(self.capture.directory(F.POINT), 'binding.json')
        self.assertEqual(len(binding['plan']['resources']), 1)
        self.assertNotIn(str(media), str(binding['plan']['resources']))

    def test_explicit_media_selection_is_in_the_immutable_plan(self):
        media = self.fixture.parent / 'media'
        media.mkdir()
        self.reader.apps[F.identifier('app-0')]['mounts'].append(
            {'Type': 'bind', 'Source': str(media), 'Destination': '/media', 'RW': True})
        self.review = self.capture.review(self.reader, ['app0:migrated'])
        self.choices[0]['mountIds'] = [item['id'] for item in self.review['apps'][0]['mounts']]
        self.bind()
        binding = self.capture.read(self.capture.directory(F.POINT), 'binding.json')
        self.assertIn(str(media), [item['identity']['source'] for item in binding['plan']['resources']])

    def test_stale_selection_rejects_before_any_stop(self):
        self.reader.apps[F.identifier('app-0')]['imageId'] = 'sha256:' + 'd' * 64
        with self.assertRaises(S.SelectedCaptureError):
            self.bind()
        self.assertEqual(self.reader.calls, [])

    def test_new_shared_writer_after_binding_rejects_before_any_stop(self):
        self.bind()
        self.reader.apps[F.identifier('app-1')]['mounts'] = copy.deepcopy(self.reader.apps[F.identifier('app-0')]['mounts'])
        admission = SimpleNamespace(point=F.POINT, request={'schema': 'orbis.core-capture-admission.v2'}, request_sha256='c' * 64, unchanged=lambda: None)
        with self.assertRaises(S.SelectedCaptureError):
            self.capture.execute(admission, lambda: self.fail('Core capture must not start'))
        self.assertEqual(self.reader.calls, [])

    def test_ambiguous_stop_preserves_durable_intent_and_never_restarts(self):
        self.bind()
        def interrupted(arguments):
            if arguments[0] == 'stop':
                raise F.Interrupted()
        self.reader.after_change = interrupted
        admission = SimpleNamespace(point=F.POINT, request={'schema': 'orbis.core-capture-admission.v2'}, request_sha256='c' * 64, unchanged=lambda: None)
        with self.assertRaises(F.Interrupted):
            self.capture.execute(admission, lambda: self.fail('Core capture must not start'))
        operation = self.capture.read(self.capture.directory(F.POINT), 'operation.json')
        self.assertEqual(operation['pendingMutation'], ['stop', F.identifier('app-0')])
        self.assertFalse(any(args[0] == 'start' for args, _ in self.reader.calls))
        self.assertFalse((self.capture.directory(F.POINT) / 'receipt.json').exists())

    def test_insufficient_aggregate_space_rejects_before_any_container_change(self):
        self.bind()
        self.enterContext(mock.patch.object(S.shutil, 'disk_usage', return_value=SimpleNamespace(free=1)))
        admission = SimpleNamespace(point=F.POINT, request={'schema': 'orbis.core-capture-admission.v2'}, request_sha256='c' * 64, unchanged=lambda: None)
        with self.assertRaises(ValueError):
            self.capture.execute(admission, lambda: self.fail('Core must not start'))
        self.assertEqual(self.reader.calls, [])

    def test_artifact_cap_failure_keeps_stopped_app_and_durable_hold_without_completion(self):
        self.bind()
        def preflight(reader, binding):
            self.capture.io.maximum = 1024 ** 3
            return {'sourceBytes': 0, 'imageExports': self.capture.image_descriptors(reader, binding)}
        self.enterContext(mock.patch.object(self.capture, 'preflight', side_effect=preflight))
        self.enterContext(mock.patch.object(S, 'LIMIT', 1024))
        self.enterContext(mock.patch.object(self.capture, '_save_images', side_effect=lambda reader, images, fd, platform: os.write(fd, b'fixture images')))
        if not hasattr(os, 'listxattr') or not hasattr(os, 'getxattr'):
            self.enterContext(mock.patch.object(S.PACK, 'attributes', return_value={}))
        admission = SimpleNamespace(point=F.POINT, request={'schema': 'orbis.core-capture-admission.v2'}, request_sha256='c' * 64, unchanged=lambda: None)
        with self.assertRaisesRegex(S.SelectedCaptureError, 'component size'):
            self.capture.execute(admission, lambda: self.fail('Core must not start after a capped write'))
        operation = self.capture.read(self.capture.directory(F.POINT), 'operation.json')
        self.assertEqual(operation['phase'], 'copying')
        self.assertEqual(self.reader.apps[F.identifier('app-0')]['state'], 'exited')
        self.assertFalse(any(args[0] == 'start' for args, _ in self.reader.calls))
        self.assertFalse((self.capture.directory(F.POINT) / 'receipt.json').exists())

    def assert_copy_failure_retains_hold(self, message):
        admission = SimpleNamespace(point=F.POINT, request={'schema': 'orbis.core-capture-admission.v2'},
                                    request_sha256='c' * 64, unchanged=lambda: None)
        with self.assertRaisesRegex(S.SelectedCaptureError, message):
            self.capture.execute(admission, lambda: self.fail('Core must not start'))
        operation = self.capture.read(self.capture.directory(F.POINT), 'operation.json')
        self.assertEqual(operation['phase'], 'copying')
        self.assertEqual(self.reader.apps[F.identifier('app-0')]['state'], 'exited')
        calls = [args for args, _ in self.reader.calls if args[-1] in self.reader.apps]
        self.assertEqual({args[-1] for args in calls}, {F.identifier('app-0')})
        self.assertFalse(any(args[0] == 'start' for args in calls))
        self.assertFalse((self.capture.directory(F.POINT) / 'receipt.json').exists())

    def test_production_image_pipe_and_final_tar_share_budget_and_keep_hold(self):
        self.bind()
        preflight = self.capture.preflight
        def bounded(reader, binding):
            result = preflight(reader, binding)
            self.capture.io.maximum = 160 * 1024
            result['aggregateWriteBytes'] = self.capture.io.maximum
            return result
        self.enterContext(mock.patch.object(self.capture, 'preflight', side_effect=bounded))
        process = S.IO.process
        def fixture(arguments, budget, maximum, **options):
            self.assertEqual(arguments[:4], ['docker', '--context', self.reader.context, 'image'])
            return process([sys.executable, '-c', 'import os; os.write(1, b"x" * 81920)'], budget, maximum, **options)
        self.enterContext(mock.patch.object(S.IO, 'process', side_effect=fixture))
        self.assert_copy_failure_retains_hold('aggregate write budget')
        directory = self.capture.directory(F.POINT)
        self.assertEqual(next(directory.glob('image-*.tar')).stat().st_size, 81920)
        self.assertLessEqual(sum(file.stat().st_size for file in directory.iterdir() if file.is_file()), self.capture.io.written)
        self.assertLessEqual(self.capture.io.written, self.capture.io.maximum)
        self.assertFalse((directory / 'copies').exists())

    def test_production_image_deadline_keeps_stopped_app_and_hold(self):
        self.bind()
        process = S.IO.process
        def fixture(arguments, budget, maximum, **options):
            budget.deadline = budget.clock() + 0.05
            return process([sys.executable, '-c', 'import time; time.sleep(2)'], budget, maximum, **options)
        self.enterContext(mock.patch.object(S.IO, 'process', side_effect=fixture))
        self.assert_copy_failure_retains_hold('deadline')

    def test_unsupported_metadata_is_rejected_before_selected_stops(self):
        self.bind()
        self.enterContext(mock.patch.object(S.PACK, 'attributes', side_effect=S.PACK.CheckpointError('Unsupported metadata')))
        admission = SimpleNamespace(point=F.POINT, request={'schema': 'orbis.core-capture-admission.v2'},
                                    request_sha256='c' * 64, unchanged=lambda: None)
        with self.assertRaisesRegex(S.PACK.CheckpointError, 'Unsupported metadata'):
            self.capture.execute(admission, lambda: self.fail('Core must not start'))
        self.assertEqual(self.reader.calls, [])


if __name__ == '__main__':
    unittest.main()
