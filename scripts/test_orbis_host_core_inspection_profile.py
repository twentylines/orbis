"""Actual copied files/config quarantine; native settings and transport remain a separate gate."""
import copy
import base64
import errno
import hashlib
import importlib.util
import os
import json
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import unittest
from unittest import mock


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


P = load('orbis-host-core-inspection-profile.py', 'core_inspection_profile_test')
A = load('orbis-host-retained-authority.py', 'core_inspection_profile_authority')
ID = 'a71c77d2-f420-440e-951b-083209514e72'


class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='core-inspection-profile-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.anchor = self.root / 'candidate'
        self.source = self.anchor / 'resources/0000/data'
        self.source.mkdir(parents=True)
        for path in (self.anchor, self.anchor / 'resources', self.source.parent, self.source):
            path.chmod(0o700)
        self.files = {'PG_VERSION': b'17\n', 'base/data': b'copied synthetic physical bytes',
                      'postgresql.auto.conf': b"shared_preload_libraries='untrusted-source-hook'\nautovacuum=on\n",
                      'postgresql.conf': b"include='untrusted-source-conf'\n", 'recovery.conf': b"restore_command='untrusted-source-command'\n",
                      'recovery.signal': b'', 'standby.signal': b''}
        for name, body in self.files.items():
            file = self.source / name
            file.parent.mkdir(mode=0o700, exist_ok=True)
            file.write_bytes(body)
            file.chmod(0o600)
            if sys.platform == 'darwin':
                os.chflags(file, file.stat().st_flags | 0x40 | 0x8000, follow_symlinks=False)
        self.target = self.root / 'inspection'
        self.profile = {**P.image_profile({'Id': P.PG17_ARM64_IMAGE, 'Os': 'linux', 'Architecture': 'arm64', 'Config': {'Volumes': {'/var/lib/postgresql/data': {}}}}),
                        'uid': os.geteuid(), 'gid': os.getegid()}
        self.native_validate = P.validate_profile
        def fixture_profile(value):
            owner = 999 if value.get('schema') == P.EXECUTION_SCHEMA and value.get('major') == 14 else 70
            self.native_validate({**value, 'uid': owner, 'gid': owner})
            return value
        self.enterContext(mock.patch.object(P, 'validate_profile', side_effect=fixture_profile))
        self.enterContext(mock.patch.object(A, 'OWNER', os.geteuid()))
        if not hasattr(os, 'listxattr') or not hasattr(os, 'getxattr'):
            self.enterContext(mock.patch.object(P.M.R.PACK, 'attributes', return_value={}))

    def prepare(self):
        return P.prepare_copy(self.anchor, 'resources/0000/data', self.target, self.profile, A)

    def prepare_fd(self, target=None, **changes):
        descriptor = os.open(self.source, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            result = P.prepare_copy_from_fd(descriptor, target or self.target, self.profile, A, **changes)
            os.fstat(descriptor)
            return result
        finally:
            os.close(descriptor)

    def originals(self):
        return {name: (self.source / name).read_bytes() for name in self.files}

    def test_captured_auto_and_recovery_config_are_quarantined_only_in_fresh_copy(self):
        before = self.originals()
        receipt = self.prepare()
        self.assertEqual(before, self.originals())
        self.assertFalse(receipt['restoreAuthority'])
        self.assertEqual((self.target / 'pgdata/postgresql.auto.conf').read_bytes(), b'')
        for name in P.QUARANTINE & set(self.files):
            self.assertEqual((self.target / 'quarantined-config' / name).read_bytes(), self.files[name])
            self.assertEqual(receipt['quarantined'][name]['sha256'], hashlib.sha256(self.files[name]).hexdigest())
            if name != 'postgresql.auto.conf':
                self.assertFalse((self.target / 'pgdata' / name).exists())
        self.assertEqual((self.target / 'pgdata/base/data').read_bytes(), self.files['base/data'])
        self.assertEqual(P.verify_overlay(self.target, receipt, A), receipt)
        self.assertEqual((self.target / 'config').stat().st_mode & 0o7777, 0o750)
        self.assertEqual((self.target / 'config/postgresql.conf').stat().st_mode & 0o7777, 0o440)
        with self.assertRaises(FileExistsError):
            self.prepare()

    def test_linked_auto_conf_never_reads_or_changes_external_config(self):
        external = self.root / 'outside'
        external.write_bytes(b'preserve external config')
        (self.source / 'postgresql.auto.conf').unlink()
        (self.source / 'postgresql.auto.conf').symlink_to(external)
        with self.assertRaises((ValueError, OSError)):
            self.prepare()
        self.assertEqual(external.read_bytes(), b'preserve external config')
        self.assertFalse((self.target / 'pgdata/postgresql.auto.conf').exists())

    def test_live_or_incomplete_backup_state_refuses_before_data_copy(self):
        for name in sorted(P.REFUSE):
            with self.subTest(name=name):
                target = self.root / ('inspection-' + name.replace('.', '-'))
                file = self.source / name
                file.write_bytes(b'unsupported source state')
                with self.assertRaises(ValueError):
                    P.prepare_copy(self.anchor, 'resources/0000/data', target, self.profile, A)
                self.assertEqual(list((target / 'pgdata').iterdir()), [])
                file.unlink()

    def test_nonregular_and_hardlinked_physical_data_refuse_without_source_changes(self):
        original = self.source / 'base/data'
        os.link(original, self.source / 'base/linked')
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertEqual(original.read_bytes(), self.files['base/data'])

    def test_wrong_major_owner_or_image_profile_refuses(self):
        (self.source / 'PG_VERSION').write_bytes(b'16\n')
        with self.assertRaises(ValueError):
            self.prepare()
        with self.assertRaises(ValueError):
            P.image_profile({'Id': 'sha256:' + '0' * 64, 'Os': 'linux', 'Architecture': 'arm64'})
        profile = {**self.profile, 'uid': self.profile['uid'] + 1}
        with self.assertRaises(ValueError):
            P.prepare_copy(self.anchor, 'resources/0000/data', self.root / 'wrong-owner', profile, A)

    def test_unexpected_image_volume_cannot_allocate_an_untracked_anonymous_volume(self):
        image = {'Id': P.PG17_ARM64_IMAGE, 'Os': 'linux', 'Architecture': 'arm64',
                 'Config': {'Volumes': {'/var/lib/postgresql/data': {}, '/unexpected': {}}}}
        with self.assertRaises(ValueError):
            P.image_profile(image)

    def test_interrupted_copy_stays_exclusive_and_source_is_unchanged(self):
        before = self.originals()
        with mock.patch.object(P.os, 'write', side_effect=OSError('synthetic interrupted private copy')):
            with self.assertRaises(OSError):
                self.prepare()
        self.assertTrue(self.target.is_dir())
        self.assertEqual(self.originals(), before)
        with self.assertRaises(FileExistsError):
            self.prepare()

    def test_overlay_mutation_and_reintroduced_auto_config_refuse(self):
        receipt = self.prepare()
        (self.target / 'pgdata/postgresql.auto.conf').write_bytes(b'autovacuum=on\n')
        with self.assertRaises(ValueError):
            P.verify_overlay(self.target, receipt, A)

    def test_exact_fixed_commands_and_mounts_have_no_account_or_host_authority(self):
        profile = P.image_profile({'Id': P.PG17_ARM64_IMAGE, 'Os': 'linux', 'Architecture': 'arm64', 'Config': {'Volumes': {'/var/lib/postgresql/data': {}}}})
        body = P.database_body(ID, 'a' * 64, self.target, profile)
        settings = dict(item.split('=', 1) for item in body['Cmd'][3::2])
        self.assertEqual(settings['autovacuum'], 'off')
        self.assertEqual(settings['config_file'], '/inspection-config/postgresql.conf')
        self.assertTrue(all(settings[name] == '' for name in ('shared_preload_libraries', 'restore_command', 'archive_command')))
        self.assertEqual(body['User'], '70:70')
        self.assertEqual(body['Env'], [])
        self.assertEqual(body['Healthcheck'], {'Test': ['NONE']})
        self.assertEqual({item['Target'] for item in body['HostConfig']['Mounts']}, {'/var/lib/postgresql/data', '/inspection-config', '/var/run/postgresql'})
        coordinator = P.coordinator_body(ID, 'a' * 64, self.target, profile, 'sha256:' + 'b' * 64)
        self.assertEqual(coordinator['User'], '0:70')
        self.assertNotIn('/var/lib/postgresql/data', {item['Target'] for item in coordinator['HostConfig']['Mounts']})
        for generated in (body, coordinator):
            self.assertEqual(generated['HostConfig']['NetworkMode'], 'none')
            self.assertEqual(generated['HostConfig']['CapDrop'], ['ALL'])
            self.assertFalse(generated['HostConfig']['Privileged'])
            self.assertTrue(generated['HostConfig']['ReadonlyRootfs'])
            self.assertEqual(generated['HostConfig']['RestartPolicy']['Name'], 'no')
            self.assertEqual(generated['HostConfig']['LogConfig'], {'Type': 'local', 'Config': {'max-size': '1m', 'max-file': '1', 'compress': 'false'}})

    def test_role_profile_keeps_v1_settings_and_quoted_hba_separate(self):
        image = {'Id': P.PG17_ARM64_IMAGE, 'Os': 'linux', 'Architecture': 'arm64', 'Config': {'Volumes': {'/var/lib/postgresql/data': {}}}}
        self.assertEqual(P.digest(P.M.R.PACK.canonical(P.SETTINGS)), '86efa76455380a719298af9684ba054fd42211877f69f0e1b2ac18da6ad0e72c')
        self.assertEqual(P.CONFIG['pg_hba.conf'], b'local all postgres trust\nlocal all all reject\n')
        for role in ('all', 'replication', 'Mixed_case', 'a' * 63):
            profile = P.role_bound_image_profile(image, role, 'd' * 64)
            self.assertEqual(P.settings_for(profile), P.SETTINGS | {'search_path': 'pg_catalog'})
            self.assertEqual(P.config_for(profile)['pg_hba.conf'], ('local all "' + role + '" trust\nlocal all all reject\n').encode())
            body = P.database_body(ID, 'a' * 64, self.target, profile)
            self.assertIn('search_path=pg_catalog', body['Cmd'])
        self.assertNotIn('search_path', P.SETTINGS)
        self.assertEqual(P.config_for(P.image_profile(image)), P.CONFIG)

    def test_private_role_bound_pgdata_preserves_a_different_filesystem_group(self):
        source_gid = self.source.stat().st_gid
        worker_gid = source_gid + 1
        self.profile = {**self.profile, 'schema': P.ROLE_SCHEMA, 'role': 'fixture',
                        'sourceProjectionSha256': 'd' * 64, 'gid': worker_gid}
        chown = os.fchown
        # This unprivileged fixture cannot join another group; native qualification uses real gids.
        with mock.patch.object(P.os, 'fchown', side_effect=lambda fd, uid, gid: chown(fd, uid, source_gid if gid == worker_gid else gid)):
            receipt = self.prepare_fd()
        self.assertEqual((self.target / 'pgdata').stat().st_gid, source_gid)
        self.assertEqual(self.source.stat().st_gid, source_gid)
        self.assertEqual(P.verify_overlay(self.target, receipt, A), receipt)
        inventory = self.prepared_inventory()
        self.assertEqual(inventory['root']['gid'], source_gid)
        self.assertNotEqual(inventory['root']['gid'], self.profile['gid'])
        self.assertEqual(P.database_body(ID, 'a' * 64, self.target, self.profile)['User'],
                         str(self.profile['uid']) + ':' + str(worker_gid))

    def test_different_group_does_not_relax_v1_or_private_owner_and_modes(self):
        self.profile['gid'] += 1
        with self.assertRaises(ValueError):
            self.prepare_fd(self.root / 'v1-group-mismatch')
        self.profile.update(schema=P.ROLE_SCHEMA, role='fixture', sourceProjectionSha256='d' * 64)
        for mode in (0o770, 0o777, 0o755):
            self.source.chmod(mode)
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                self.prepare_fd(self.root / ('unsafe-mode-' + str(mode)))
        self.source.chmod(0o700)
        self.profile['uid'] += 1
        with self.assertRaises(ValueError):
            self.prepare_fd(self.root / 'foreign-owner')

    def test_role_profile_rejects_invalid_roles_hashes_and_full_profile_tampering(self):
        image = {'Id': P.PG17_ARM64_IMAGE, 'Os': 'linux', 'Architecture': 'arm64', 'Config': {'Volumes': {'/var/lib/postgresql/data': {}}}}
        for role in ('', 'a' * 64, 'bad-role', 'a"b', 'a\nb', '角色', None, True):
            with self.subTest(role=role), self.assertRaises(ValueError):
                P.role_bound_image_profile(image, role, 'd' * 64)
        for sha in ('', 'D' * 64, 'd' * 63, None):
            with self.subTest(sha=sha), self.assertRaises(ValueError):
                P.role_bound_image_profile(image, 'bound_role', sha)
        profile = P.role_bound_image_profile(image, 'bound_role', 'd' * 64)
        for key, value in [('schema', P.SCHEMA), ('imageId', 'sha256:' + '0' * 64), ('uid', 0), ('gid', 0),
                           ('major', 17.0), ('architecture', 'amd64'), ('extra', True)]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.native_validate({**profile, key: value})
        with self.assertRaises(ValueError):
            self.native_validate({**P.image_profile(image), 'role': 'bound_role'})

    def test_role_overlay_binds_profile_settings_hba_and_rejects_fallback_or_relabel(self):
        self.profile = {**self.profile, 'schema': P.ROLE_SCHEMA, 'role': 'all', 'sourceProjectionSha256': 'd' * 64}
        receipt = self.prepare()
        self.assertEqual(receipt['schema'], P.ROLE_OVERLAY_SCHEMA)
        self.assertEqual(receipt['profile'], self.profile)
        self.assertEqual((self.target / 'config/pg_hba.conf').read_bytes(), b'local all "all" trust\nlocal all all reject\n')
        self.assertEqual(P.verify_overlay(self.target, receipt, A), receipt)
        for change in ('schema', 'profile', 'settings', 'hba'):
            altered = copy.deepcopy(receipt)
            if change == 'schema': altered['schema'] = 'orbis.core-inspection-fixed-overlay.v1'
            if change == 'profile': altered['profile']['role'] = 'postgres'
            if change == 'settings': altered['settingsSha256'] = P.digest(P.M.R.PACK.canonical(P.SETTINGS))
            if change == 'hba': altered['fixed']['pg_hba.conf'] = {'bytes': len(P.CONFIG['pg_hba.conf']), 'sha256': P.digest(P.CONFIG['pg_hba.conf'])}
            with self.subTest(change=change), self.assertRaises(ValueError):
                P.verify_overlay(self.target, altered, A)
        (self.target / 'config/pg_hba.conf').chmod(0o600)
        (self.target / 'config/pg_hba.conf').write_bytes(P.CONFIG['pg_hba.conf'])
        with self.assertRaises(ValueError):
            P.verify_overlay(self.target, receipt, A)

    def test_fd_entry_preserves_legacy_receipt_and_does_not_consume_caller_fd(self):
        before = self.originals()
        legacy = self.prepare()
        target = self.root / 'from-fd'
        copied = self.prepare_fd(target)
        self.assertEqual(copied, legacy)
        self.assertEqual(P.verify_overlay(target, copied, A), legacy)
        self.assertEqual(self.originals(), before)
        with self.assertRaises(FileExistsError): self.prepare_fd(target)

    def test_fd_role_bound_overlay_keeps_exact_settings_and_receipt(self):
        self.profile = {**self.profile, 'schema': P.ROLE_SCHEMA, 'role': 'captured_role', 'sourceProjectionSha256': 'd' * 64}
        receipt = self.prepare_fd()
        self.assertEqual(receipt['schema'], P.ROLE_OVERLAY_SCHEMA)
        self.assertEqual(receipt['profile'], self.profile)
        self.assertEqual(P.verify_overlay(self.target, receipt, A), receipt)

    def test_fd_byte_bound_refuses_without_writing_excess_physical_bytes(self):
        before = self.originals()
        with self.assertRaises(ValueError): self.prepare_fd(maximum=1)
        self.assertFalse(any(path.is_file() for path in (self.target / 'pgdata').rglob('*')))
        self.assertEqual(self.originals(), before)
        for maximum in (True, 0, -1, 64 * 1024 ** 3 + 1):
            target = self.root / ('bound-' + str(maximum))
            with self.subTest(maximum=maximum), self.assertRaises(ValueError): self.prepare_fd(target, maximum=maximum)
            self.assertFalse(target.exists())

    def test_fd_wrong_major_mode_owner_and_live_state_keep_original_guards(self):
        (self.source / 'PG_VERSION').write_bytes(b'16\n')
        with self.assertRaises(ValueError): self.prepare_fd(self.root / 'wrong-major-fd')
        (self.source / 'PG_VERSION').write_bytes(b'17\n')
        self.source.chmod(0o755)
        with self.assertRaises(ValueError): self.prepare_fd(self.root / 'wrong-mode-fd')
        self.source.chmod(0o700)
        self.profile['uid'] += 1
        with self.assertRaises(ValueError): self.prepare_fd(self.root / 'wrong-owner-fd')
        self.profile['uid'] -= 1
        for name in sorted(P.REFUSE):
            file = self.source / name; file.write_bytes(b'held source state')
            with self.subTest(name=name), self.assertRaises(ValueError): self.prepare_fd(self.root / ('held-' + name))
            file.unlink()

    def test_fd_symlink_and_hardlink_source_nodes_refuse(self):
        file = self.source / 'base/data'
        link = self.source / 'base/link'
        link.symlink_to('data')
        with self.assertRaises(ValueError): self.prepare_fd(self.root / 'symlink-fd')
        link.unlink(); os.link(file, link)
        with self.assertRaises(ValueError): self.prepare_fd(self.root / 'hardlink-fd')

    def test_fd_cross_device_quarantine_error_retains_failure_without_original_change(self):
        before = self.originals()
        with mock.patch.object(P.os, 'rename', side_effect=OSError(errno.EXDEV, 'fixture-cross-device')):
            with self.assertRaises(OSError): self.prepare_fd()
        self.assertEqual(self.originals(), before)
        self.assertTrue(self.target.is_dir())
        with self.assertRaises(FileExistsError): self.prepare_fd()

    def test_fd_source_growth_during_copy_refuses_before_excess_write(self):
        file = self.source / 'base/data'
        inode, read, changed = file.stat().st_ino, os.read, False
        def grow(descriptor, count):
            nonlocal changed
            block = read(descriptor, count)
            if os.fstat(descriptor).st_ino == inode and not changed:
                changed = True
                with file.open('ab') as stream: stream.write(b'excess bytes')
            return block
        with mock.patch.object(P.os, 'read', side_effect=grow):
            with self.assertRaises(ValueError): self.prepare_fd()
        self.assertTrue(changed)
        self.assertLessEqual((self.target / 'pgdata/base/data').stat().st_size, len(self.files['base/data']))

    def prepared_inventory(self, **changes):
        return P.prepared_copy_inventory(self.target, self.profile, A, **changes)

    def working_state(self):
        result = {}
        for path in [self.target, *sorted(self.target.rglob('*'))]:
            details = path.lstat()
            result[str(path.relative_to(self.target))] = [*A.seal(details), hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None]
        return result

    def test_prepared_inventory_is_readonly_stable_and_has_exact_hash_recipe(self):
        overlay = self.prepare(); before = self.working_state()
        value = self.prepared_inventory()
        self.assertEqual(value, self.prepared_inventory())
        self.assertEqual(value['schema'], 'orbis.core-inspection-prepared-pgdata.v1')
        self.assertEqual(set(value), {'schema', 'profileSha256', 'rootName', 'root', 'entries', 'fileBytes', 'entryCount', 'inventorySha256'})
        self.assertEqual(value['profileSha256'], P.digest(P.M.R.PACK.canonical(self.profile)))
        self.assertEqual(value['rootName'], 'pgdata'); self.assertEqual(value['root']['path'], '.')
        body = {key: item for key, item in value.items() if key != 'inventorySha256'}
        self.assertEqual(value['inventorySha256'], P.digest(P.M.R.PACK.canonical(body)))
        self.assertEqual(value['entryCount'], len(value['entries']))
        self.assertEqual(value['fileBytes'], sum(row.get('bytes', 0) for row in value['entries']))
        self.assertEqual([row['path'] for row in value['entries']], sorted(row['path'] for row in value['entries']))
        for row in [value['root'], *value['entries']]:
            self.assertEqual(set(row), {'path', 'kind', 'dev', 'ino', 'ctimeNs', 'uid', 'gid', 'mode', 'mtimeNs', 'xattrsSha256'}
                             | ({'bytes', 'sha256'} if row['kind'] == 'file' else set()))
        self.assertNotIn('copied synthetic physical bytes', json.dumps(value))
        self.assertEqual(self.working_state(), before)
        self.assertEqual(P.verify_overlay(self.target, overlay, A), overlay)

    def test_prepared_content_change_binds_new_hash_even_with_restored_mtime(self):
        self.prepare(); before = self.prepared_inventory()
        file = self.target / 'pgdata/base/data'; details = file.stat()
        file.write_bytes(b'x' * details.st_size)
        os.utime(file, ns=(details.st_atime_ns, details.st_mtime_ns))
        after = self.prepared_inventory()
        self.assertNotEqual(before['inventorySha256'], after['inventorySha256'])
        old = next(row for row in before['entries'] if row['path'] == 'base/data')
        new = next(row for row in after['entries'] if row['path'] == 'base/data')
        self.assertEqual(old['mtimeNs'], new['mtimeNs']); self.assertNotEqual(old['sha256'], new['sha256'])

    def test_prepared_identical_file_replacement_is_identity_bound(self):
        self.prepare(); before = self.prepared_inventory()
        file = self.target / 'pgdata/base/data'
        replacement = self.target / 'replacement'; shutil.copy2(file, replacement); replacement.replace(file)
        after = self.prepared_inventory()
        old = next(row for row in before['entries'] if row['path'] == 'base/data')
        new = next(row for row in after['entries'] if row['path'] == 'base/data')
        self.assertEqual(old['sha256'], new['sha256']); self.assertEqual(old['bytes'], new['bytes'])
        self.assertNotEqual((old['dev'], old['ino']), (new['dev'], new['ino']))
        self.assertNotEqual(before['inventorySha256'], after['inventorySha256'])

    def test_prepared_identical_root_replacement_is_identity_bound(self):
        self.prepare(); before = self.prepared_inventory()
        root = self.target / 'pgdata'; old = self.target / 'retained-pgdata'
        root.rename(old); shutil.copytree(old, root)
        after = self.prepared_inventory()
        self.assertNotEqual(before['root']['ino'], after['root']['ino'])
        self.assertNotEqual(before['inventorySha256'], after['inventorySha256'])

    def test_prepared_leaf_mode_is_bound_without_new_owner_policy(self):
        self.prepare(); before = self.prepared_inventory()
        (self.target / 'pgdata/base/data').chmod(0o640)
        after = self.prepared_inventory()
        self.assertNotEqual(before['inventorySha256'], after['inventorySha256'])
        self.assertEqual(next(row for row in after['entries'] if row['path'] == 'base/data')['mode'], 0o640)

    def test_prepared_root_version_auto_conf_and_refusal_conditions_remain_strict(self):
        self.prepare(); root = self.target / 'pgdata'
        (root / 'PG_VERSION').write_bytes(b'16\n')
        with self.assertRaises(ValueError): self.prepared_inventory()
        (root / 'PG_VERSION').write_bytes(b'17\n')
        root.chmod(0o755)
        with self.assertRaises(ValueError): self.prepared_inventory()
        root.chmod(0o700)
        (root / 'postgresql.auto.conf').write_bytes(b'autovacuum=on\n')
        with self.assertRaises(ValueError): self.prepared_inventory()
        (root / 'postgresql.auto.conf').write_bytes(b'')
        for name in sorted(P.REFUSE | (P.QUARANTINE - {'postgresql.auto.conf'})):
            file = root / name; file.write_bytes(b'forbidden before first start')
            with self.subTest(name=name), self.assertRaises(ValueError): self.prepared_inventory()
            file.unlink()
        self.profile['uid'] += 1
        with self.assertRaises(ValueError): self.prepared_inventory()

    def test_prepared_links_and_nonregular_nodes_refuse(self):
        self.prepare(); root = self.target / 'pgdata'
        link = root / 'base/alias'; link.symlink_to('data')
        with self.assertRaises(ValueError): self.prepared_inventory()
        link.unlink(); os.link(root / 'base/data', link)
        with self.assertRaises(ValueError): self.prepared_inventory()
        link.unlink(); os.mkfifo(link, 0o600)
        with self.assertRaises(ValueError): self.prepared_inventory()

    def test_prepared_xattr_values_are_only_hashed_and_unsupported_namespace_refuses(self):
        self.prepare()
        key = base64.b64encode(b'user.fixture').decode()
        value = base64.b64encode(b'fixture-private-value').decode()
        with mock.patch.object(P.M.R.PACK, 'attributes', return_value={key: value}):
            inventory = self.prepared_inventory()
            self.assertEqual(inventory['root']['xattrsSha256'], P.digest(P.M.R.PACK.canonical({key: value})))
            self.assertNotIn(key, json.dumps(inventory)); self.assertNotIn(value, json.dumps(inventory))
        forbidden = base64.b64encode(b'security.capability').decode()
        with mock.patch.object(P.M.R.PACK, 'attributes', return_value={forbidden: value}):
            with self.assertRaises(ValueError): self.prepared_inventory()

    def test_prepared_source_growth_or_directory_change_during_hash_refuses(self):
        self.prepare(); file = self.target / 'pgdata/base/data'
        inode, read, changed = file.stat().st_ino, os.read, False
        def grow(descriptor, count):
            nonlocal changed
            block = read(descriptor, count)
            if os.fstat(descriptor).st_ino == inode and not changed:
                changed = True
                with file.open('ab') as stream: stream.write(b'changed during read')
                (self.target / 'pgdata/unexpected').write_bytes(b'changed name set')
            return block
        with mock.patch.object(P.os, 'read', side_effect=grow):
            with self.assertRaises(ValueError): self.prepared_inventory()
        self.assertTrue(changed)

    def test_prepared_root_replaced_during_hash_refuses_held_old_directory(self):
        self.prepare(); root = self.target / 'pgdata'; file = root / 'base/data'
        inode, read, changed = file.stat().st_ino, os.read, False
        def replace(descriptor, count):
            nonlocal changed
            block = read(descriptor, count)
            if os.fstat(descriptor).st_ino == inode and not changed:
                changed = True
                root.rename(self.target / 'retained-original-pgdata'); root.mkdir(mode=0o700)
            return block
        with mock.patch.object(P.os, 'read', side_effect=replace):
            with self.assertRaises(ValueError): self.prepared_inventory()
        self.assertTrue(changed)

    def test_prepared_byte_metadata_and_time_bounds_refuse(self):
        self.prepare()
        for maximum in (1, True, 0, 64 * 1024 ** 3 + 1):
            with self.subTest(maximum=maximum), self.assertRaises(ValueError): self.prepared_inventory(maximum=maximum)
        with mock.patch.object(P.M.R.PACK, 'METADATA_LIMIT', 100):
            with self.assertRaises(ValueError): self.prepared_inventory()
        with mock.patch.object(P.time, 'monotonic', side_effect=[0, 301]):
            with self.assertRaises(ValueError): self.prepared_inventory()


    def execution_profile(self, major=14):
        image = {'Id': P.PG.PG14_AMD64_IMAGE if major == 14 else P.PG17_ARM64_IMAGE, 'Os': 'linux',
                 'Architecture': 'amd64' if major == 14 else 'arm64',
                 'Config': {'Volumes': {'/var/lib/postgresql/data': {}}}}
        return P.role_bound_execution_profile(image, 'fixture', 'd' * 64)

    def test_execution_profile_is_explicit_and_old_constructors_stay_closed(self):
        profile = self.execution_profile()
        self.assertEqual(profile['schema'], 'orbis.core-source-pg-inspection.v3')
        self.assertEqual(profile['profileId'], 'pg14-debian-amd64.v1')
        self.assertEqual(self.native_validate(profile), profile)
        with self.assertRaises(ValueError):
            P.image_profile(P.PG.image_for_profile(profile))
        for changed in ({'schema': P.ROLE_SCHEMA}, {'major': 17}, {'uid': 70}, {'gid': 70},
                        {'profileId': 'pg17-alpine-arm64.v1'}, {'role': '--help'},
                        {'sourceProjectionSha256': 'bad'}, {'archive_library': ''}, {'restoreAuthority': True}):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                self.native_validate(profile | changed)

    def test_new_settings_differ_only_by_14_archive_library_and_role_binding(self):
        expected = P.SETTINGS | {'search_path': 'pg_catalog'}
        self.assertEqual(P.settings_for(self.execution_profile(17)), expected)
        self.assertEqual(P.settings_for(self.execution_profile()), {k: v for k, v in expected.items() if k != 'archive_library'})
        self.assertEqual(P.config_for(self.execution_profile())['pg_hba.conf'], b'local all "fixture" trust\nlocal all all reject\n')

    def test_new_14_worker_uses_pinned_binary_identity_and_same_isolation(self):
        profile = self.execution_profile()
        # Worker construction uses real bounded identity; filesystem fixtures use the local owner separately.
        with mock.patch.object(P, 'validate_profile', side_effect=self.native_validate):
            body = P.database_body(ID, 'a' * 64, self.target, profile)
        self.assertEqual(body['Entrypoint'], ['/usr/lib/postgresql/14/bin/postgres'])
        self.assertEqual(body['User'], '999:999')
        self.assertNotIn('archive_library=', body['Cmd'])
        self.assertIn('default_transaction_read_only=on', body['Cmd'])
        self.assertEqual(body['HostConfig']['NetworkMode'], 'none')
        self.assertEqual(body['HostConfig']['CapDrop'], ['ALL'])
        self.assertTrue(body['HostConfig']['ReadonlyRootfs'])
        self.assertEqual({v['Target'] for v in body['HostConfig']['Mounts']},
                         {'/var/lib/postgresql/data', '/inspection-config', '/var/run/postgresql'})

    def prepare_execution_copy(self):
        (self.source / 'PG_VERSION').write_bytes(b'14\n')
        self.profile = self.execution_profile() | {'uid': os.geteuid(), 'gid': os.getegid()}
        return self.prepare_fd()

    def test_new_overlay_real_copy_binds_major_schema_and_keeps_source(self):
        receipt = self.prepare_execution_copy()
        self.assertEqual(receipt['schema'], 'orbis.core-inspection-fixed-overlay.v3')
        self.assertEqual(receipt['profile']['schema'], P.EXECUTION_SCHEMA)
        self.assertEqual(receipt['profile']['major'], 14)
        self.assertEqual((self.source / 'PG_VERSION').read_bytes(), b'14\n')
        self.assertEqual((self.target / 'pgdata/PG_VERSION').read_bytes(), b'14\n')
        self.assertEqual(P.verify_overlay(self.target, receipt, A), receipt)
        inventory = self.prepared_inventory()
        self.assertEqual(inventory['profileSha256'], P.digest(P.M.R.PACK.canonical(self.profile)))
        self.assertNotIn('archive_library', P.settings_for(self.profile))
        self.assertEqual((self.target / 'config/pg_hba.conf').stat().st_mode & 0o777, 0o440)
        for changes in ({'schema': P.ROLE_OVERLAY_SCHEMA}, {'settingsSha256': 'a' * 64},
                        {'profile': receipt['profile'] | {'major': 17}}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                P.verify_overlay(self.target, receipt | changes, A)

    def test_new_overlay_refuses_changed_pg_version_and_configuration(self):
        receipt = self.prepare_execution_copy()
        (self.target / 'pgdata/PG_VERSION').write_bytes(b'17\n')
        with self.assertRaises(ValueError):
            P.verify_overlay(self.target, receipt, A)
        (self.target / 'pgdata/PG_VERSION').write_bytes(b'14\n')
        file = self.target / 'config/pg_hba.conf';file.chmod(0o640);file.write_bytes(b'local all all trust\n')
        with self.assertRaises(ValueError):
            P.verify_overlay(self.target, receipt, A)

    def test_new_role_copy_keeps_captured_group_without_relaxing_owner(self):
        (self.source / 'PG_VERSION').write_bytes(b'14\n')
        source_gid = self.source.stat().st_gid;worker_gid = source_gid + 1
        self.profile = self.execution_profile() | {'uid': os.geteuid(), 'gid': worker_gid}
        chown = os.fchown
        with mock.patch.object(P.os, 'fchown', side_effect=lambda fd, uid, gid: chown(fd, uid, source_gid if gid == worker_gid else gid)):
            receipt = self.prepare_fd()
        self.assertEqual((self.target / 'pgdata').stat().st_gid, source_gid)
        self.assertEqual(P.verify_overlay(self.target, receipt, A), receipt)
        self.assertEqual(self.prepared_inventory()['root']['gid'], source_gid)
        changed = receipt | {'profile': receipt['profile'] | {'uid': receipt['profile']['uid'] + 1}}
        with self.assertRaises(ValueError):
            P.verify_overlay(self.target, changed, A)

    def test_new_profile_wrong_physical_major_refuses_before_copy(self):
        self.profile = self.execution_profile() | {'uid': os.geteuid(), 'gid': os.getegid()}
        with self.assertRaises(ValueError):
            self.prepare_fd()
        self.assertEqual(list((self.target / 'pgdata').iterdir()), [])


if __name__ == '__main__':
    unittest.main()
