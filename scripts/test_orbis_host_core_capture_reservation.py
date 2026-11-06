import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest


SPEC = importlib.util.spec_from_file_location('core_reservation_subject', Path(__file__).with_name('orbis-host-core-capture-reservation.py'))
R = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(R)
POINT = '00000000-0000-4000-8000-000000000001'


def point():
    return {'version': 3, 'id': POINT, 'ownerId': 1, 'createdAt': 1793923200000,
            'envelope': {'version': 1, 'keyId': 'a' * 64, 'nonce': 'b' * 24, 'tag': 'c' * 32, 'value': 'd' * 86},
            'kind': 'orbis-core', 'coreFormat': 'orbis.time-machine-core.v1', 'core': None,
            'status': 'capturing', 'backupJobId': None, 'issue': None, 'archiveBytes': 0,
            'archiveSha256': None, 'metadataSha256': None}


class CoreReservationTests(unittest.TestCase):
    def parse(self, value):
        return R.reservation(json.dumps(value).encode(), POINT)

    def test_exact_descriptor_uses_verifier_canonical_shape(self):
        value = point()
        descriptor = self.parse(value)
        expected = {key: value[key] for key in ('version', 'id', 'ownerId', 'createdAt', 'envelope')}
        self.assertEqual(descriptor, expected)
        canonical = ('{"createdAt":1793923200000,"envelope":{"keyId":"' + 'a' * 64 + '","nonce":"' + 'b' * 24
                     + '","tag":"' + 'c' * 32 + '","value":"' + 'd' * 86 + '","version":1},"id":"' + POINT
                     + '","ownerId":1,"version":3}').encode()
        self.assertEqual(R.canonical(descriptor), canonical)
        self.assertEqual(R.sha256(descriptor), hashlib.sha256(canonical).hexdigest())
        self.assertEqual(self.parse({**value, 'assetBytes': 0}), descriptor)
        descriptor['envelope']['value'] = 'e' * 86
        self.assertEqual(value['envelope']['value'], 'd' * 86)

    def test_all_undeclared_or_missing_point_fields_are_rejected(self):
        value = point()
        for key in value:
            with self.subTest(key=key), self.assertRaises(R.ReservationError):
                self.parse({name: item for name, item in value.items() if name != key})
        for key in ('onboardingAttemptId', 'runtimeBytes', 'writersStopped', 'path', 'command'):
            with self.subTest(key=key), self.assertRaises(R.ReservationError):
                self.parse({**value, key: None})

    def test_only_empty_capturing_core_points_are_accepted(self):
        for key, replacement in [('version', 2), ('version', 3.0), ('version', True), ('kind', 'runtime'),
                                 ('coreFormat', 'orbis.time-machine-core.v2'), ('core', {}),
                                 ('status', 'sealed'), ('status', 'failed'), ('status', 'interrupted'),
                                 ('backupJobId', POINT), ('issue', 'capture-failed'), ('archiveBytes', 1),
                                 ('archiveBytes', 0.0), ('archiveBytes', False), ('archiveSha256', 'a' * 64),
                                 ('metadataSha256', 'a' * 64), ('assetBytes', 1), ('assetBytes', False), ('assetBytes', 0.0)]:
            with self.subTest(key=key, replacement=replacement), self.assertRaises(R.ReservationError):
                self.parse({**point(), key: replacement})

    def test_owner_timestamp_uuid_and_envelope_are_strict(self):
        for key in ('ownerId', 'createdAt'):
            for value in (0, -1, True, 1.0, '1', None, R.SAFE_INTEGER + 1):
                with self.subTest(key=key, value=value), self.assertRaises(R.ReservationError):
                    self.parse({**point(), key: value})
        self.parse({**point(), 'ownerId': R.SAFE_INTEGER, 'createdAt': R.SAFE_INTEGER})
        for value in ('A' + POINT[1:], '../' + POINT, POINT.replace('-4', '-5'), '00000000-0000-4000-8000-000000000002', None):
            with self.subTest(value=value), self.assertRaises(R.ReservationError):
                self.parse({**point(), 'id': value})
        for key, length in [('keyId', 64), ('nonce', 24), ('tag', 32), ('value', 86)]:
            for value in ('a' * (length - 1), 'a' * (length + 1), 'A' * length, None, 1):
                with self.subTest(key=key, value=value), self.assertRaises(R.ReservationError):
                    self.parse({**point(), 'envelope': {**point()['envelope'], key: value}})
        for envelope in (None, {}, {**point()['envelope'], 'version': True}, {**point()['envelope'], 'version': 1.0},
                         {**point()['envelope'], 'unknown': None}):
            with self.subTest(envelope=envelope), self.assertRaises(R.ReservationError):
                self.parse({**point(), 'envelope': envelope})

    def test_duplicate_json_fields_invalid_bytes_and_unbounded_input_are_rejected(self):
        body = json.dumps(point()).encode()
        invalid = [b'', b'[]', b'null', b'\xff', b'{', b' ' * (R.LIMIT + 1), body.decode(),
                   body.replace(b'"version": 3', b'"version": 2,"version": 3'),
                   body.replace(b'"version": 1', b'"version": 2,"version": 1'),
                   body.replace(b'"ownerId": 1', b'"ownerId": NaN'),
                   body.replace(b'"ownerId": 1', b'"ownerId": Infinity'),
                   body.replace(b'"ownerId": 1', b'"ownerId": 1e400')]
        for value in invalid:
            with self.subTest(index=invalid.index(value)), self.assertRaises(R.ReservationError):
                R.reservation(value, POINT)

    def test_retained_descriptor_rejects_unknown_missing_and_mutable_invalid_fields(self):
        descriptor = self.parse(point())
        self.assertEqual(R.validate_reservation(descriptor, POINT), descriptor)
        for key in descriptor:
            invalid = copy.deepcopy(descriptor)
            invalid.pop(key)
            with self.subTest(key=key), self.assertRaises(R.ReservationError):
                R.validate_reservation(invalid, POINT)
        with self.assertRaises(R.ReservationError):
            R.validate_reservation({**descriptor, 'status': 'capturing'}, POINT)
        with self.assertRaises(R.ReservationError):
            R.validate_reservation(descriptor, '../point')


if __name__ == '__main__':
    unittest.main()
