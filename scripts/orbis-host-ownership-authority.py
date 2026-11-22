"""Root-issued holds for nonparticipating Main account ownership writes.

The issuer supplies a positively verified, current admission under the existing
host locks. This module cannot infer unmanaged from an absent service, database,
configuration or journal. It never revokes or replaces Sentinel authority.
"""
import copy
import hashlib
import json
import os
import re
import secrets
import sqlite3
import stat
from contextlib import contextmanager
from pathlib import Path


OWNER = 0
SCHEMA = 'orbis.main-ownership-authority.v2'
LEDGER_SCHEMA = 'orbis.main-ownership-completed.v1'
ADMISSION = 'orbis.main-ownership-admission.v1'
STATE = 'main-ownership-authority.json'
PENDING = '.' + STATE + '.pending'
LIMIT = 262144
MAX_RECORDS = 128
PURPOSES = frozenset({'first-registration', 'account-removal', 'credential-change'})
_HASH = re.compile(r'[a-f0-9]{64}\Z')
_TABLES = {
    'metadata': 'CREATE TABLE metadata (singleton INTEGER PRIMARY KEY CHECK (singleton=1), schema TEXT NOT NULL, ledger_id TEXT NOT NULL, count INTEGER NOT NULL)',
    'receipts': 'CREATE TABLE receipts (operation_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, body BLOB NOT NULL)',
}
_TRIGGERS = {
    'receipts_no_update': "CREATE TRIGGER receipts_no_update BEFORE UPDATE ON receipts BEGIN SELECT RAISE(ABORT,'Completed receipts are immutable'); END",
    'receipts_no_delete': "CREATE TRIGGER receipts_no_delete BEFORE DELETE ON receipts BEGIN SELECT RAISE(ABORT,'Completed receipts are immutable'); END",
}
_RECEIPT_SELECT = ('SELECT CASE WHEN typeof(operation_id)=\'text\' AND length(operation_id)=64 THEN operation_id END,'
                   'CASE WHEN typeof(request_id)=\'text\' AND length(request_id)=64 THEN request_id END,'
                   'CASE WHEN typeof(body)=\'blob\' AND length(body) BETWEEN 1 AND '
                   + str(LIMIT) + ' THEN body ELSE NULL END FROM receipts ')


class OwnershipAuthorityError(ValueError):
    def __init__(self):
        super().__init__('Account ownership requires current Root authority; preserve the hold for local review.')


def fail():
    raise OwnershipAuthorityError() from None


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def valid_hash(value):
    return type(value) is str and _HASH.fullmatch(value) is not None


def admission(value):
    fields = {'schema', 'mode', 'managedEver', 'installationId', 'controllerId', 'imageId', 'controllerEpoch', 'authorityEpoch'}
    if (type(value) is not dict or set(value) != fields or value['schema'] != ADMISSION
            or value['mode'] != 'unmanaged' or value['managedEver'] is not False
            or not all(valid_hash(value[key]) for key in ('installationId', 'controllerId', 'controllerEpoch', 'authorityEpoch'))
            or type(value['imageId']) is not str or not value['imageId'].startswith('sha256:')
            or not valid_hash(value['imageId'][7:])):
        fail()
    return copy.deepcopy(value)


def operation(request_id, purpose, proof):
    if not valid_hash(request_id) or purpose not in PURPOSES:
        fail()
    return digest({'schema': SCHEMA, 'requestId': request_id, 'purpose': purpose, 'admission': admission(proof)})


def decoded(body):
    def pairs(values):
        result = {}
        for key, value in values:
            if key in result:
                fail()
            result[key] = value
        return result

    def invalid(_):
        fail()

    try:
        return json.loads(body, object_pairs_hook=pairs, parse_float=invalid, parse_constant=invalid)
    except (ValueError, UnicodeError, RecursionError):
        fail()


def seal(info):
    return tuple(getattr(info, key) for key in ('st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_mode',
                                               'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns'))


def validate(value):
    if (type(value) is not dict or set(value) != {'schema', 'generation', 'active', 'operations', 'completed'}
            or value['schema'] != SCHEMA or type(value['generation']) is not int
            or not 0 <= value['generation'] < 9007199254740991
            or value['active'] is not None and not valid_hash(value['active'])
            or type(value['operations']) is not dict or len(value['operations']) > MAX_RECORDS):
        fail()
    completed = value['completed']
    if (completed is not None and (type(completed) is not dict or set(completed) != {'id', 'count'}
            or not valid_hash(completed['id']) or type(completed['count']) is not int
            or not 0 <= completed['count'] < 9007199254740991)):
        fail()
    requests, pending = set(), []
    for key, row in value['operations'].items():
        if (not valid_hash(key) or type(row) is not dict
                or set(row) != {'requestId', 'purpose', 'admission', 'phase', 'disposition'}
                or not valid_hash(row['requestId']) or row['requestId'] in requests
                or row['purpose'] not in PURPOSES or row['phase'] not in ('pending', 'completed')
                or key != operation(row['requestId'], row['purpose'], row['admission'])
                or row['phase'] == 'pending' and row['disposition'] is not None
                or row['phase'] == 'completed' and row['disposition'] not in ('committed', 'not-written')):
            fail()
        requests.add(row['requestId'])
        if row['phase'] == 'pending':
            pending.append(key)
    if pending != ([] if value['active'] is None else [value['active']]):
        fail()
    return value


class OwnershipAuthority:
    """The fixed Root issuer supplies scope(), yielding a live guard and admit().

    admit() must independently revalidate the installation/controller and its
    never-managed authority epoch. No HTTP body can supply that callback/proof.
    A returned pending grant has both a durable lifecycle fence and journal.
    There is no timeout or automatic retirement of an interrupted grant.
    """
    def __init__(self, host, root, context, scope):
        if not callable(scope):
            fail()
        self.host, self.root, self.context, self.scope = host, Path(root), context, scope

    def _guard(self, guard):
        if (os.geteuid() != OWNER or not isinstance(guard, self.host.CREDENTIAL_FENCE._Guard)
                or guard._host.LOCK_DESCRIPTOR is not self.host.LOCK_DESCRIPTOR
                or guard._host.AUTHORITY is not self.host.AUTHORITY
                or guard._root != self.root or guard._context != self.context):
            fail()
        guard._check()

    @contextmanager
    def _operation(self):
        try:
            with self.scope() as (guard, admit):
                self._guard(guard)
                if not callable(admit):
                    fail()
                expected = admission(admit())

                def check():
                    self._guard(guard)
                    if admission(admit()) != expected:
                        fail()
                    return expected

                yield guard, expected, check
                check()
        except Exception:
            fail()

    def _read(self, guard):
        self._guard(guard)
        state_name, pending_name = self._names(guard)
        directory = guard._directory.fd
        try:
            os.stat(pending_name, dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            fail()
        try:
            fd = os.open(state_name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=directory)
        except FileNotFoundError:
            return {'schema': SCHEMA, 'generation': 0, 'active': None, 'operations': {}, 'completed': None}
        try:
            before = os.fstat(fd)
            if (not stat.S_ISREG(before.st_mode) or before.st_uid != OWNER or before.st_nlink != 1
                    or stat.S_IMODE(before.st_mode) != 0o600 or not 0 < before.st_size <= LIMIT):
                fail()
            body = bytearray()
            while len(body) <= LIMIT:
                part = os.read(fd, min(8192, LIMIT + 1 - len(body)))
                if not part:
                    break
                body.extend(part)
            if (len(body) != before.st_size or any(seal(info) != seal(before) for info in
                    (os.fstat(fd), os.stat(state_name, dir_fd=directory, follow_symlinks=False)))):
                fail()
            value = validate(decoded(body))
            if bytes(body) != canonical(value) + b'\n':
                fail()
            return value
        finally:
            os.close(fd)

    def _names(self, guard):
        # Reviewed namespaces have their own directory. Fresh installations can
        # instead use a protected parent; keep each installation's journal next
        # to its matching, already installation-specific lifecycle fence.
        self._guard(guard)
        selected = guard._selected
        layout = self.host.AUTHORITY.LAYOUT
        if selected == layout.legacy_path(self.root, 'credential-fence'):
            suffix = 'credential-fence.json'
            if not selected.name.endswith(suffix):
                fail()
            name = selected.name[:-len(suffix)] + STATE
        elif selected == layout.namespace(self.root) / 'credential-fence.json':
            name = STATE
        else:
            fail()
        if max(len(os.fsencode('.' + name + '.pending')), len(os.fsencode(name + '.completed.sqlite3-journal'))) > 255:
            fail()
        return name, '.' + name + '.pending'

    def _ledger_name(self, guard):
        return self._names(guard)[0] + '.completed.sqlite3'

    @contextmanager
    def _ledger(self, guard, completed, *, write=False, create=False):
        """Bounded indexed queries, private Root inode, no pending-hold recovery.

        The ledger only contains completed receipts. A partial SQLite journal is
        preserved for review; this reader never runs automatic hot recovery.
        """
        self._guard(guard)
        name, directory = self._ledger_name(guard), guard._directory.fd
        for suffix in ('-journal', '-wal', '-shm'):
            try:
                os.stat(name + suffix, dir_fd=directory, follow_symlinks=False)
            except FileNotFoundError:
                continue
            fail()
        if completed is None:
            try:
                os.stat(name, dir_fd=directory, follow_symlinks=False)
            except FileNotFoundError:
                yield None
                return
            fail()
        created = False
        try:
            fd = os.open(name, (os.O_RDWR if write else os.O_RDONLY) | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                         dir_fd=directory)
        except FileNotFoundError:
            if not write or not create or completed['count'] != 0:
                fail()
            fd = os.open(name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=directory)
            os.fchmod(fd, 0o600)
            os.fsync(directory)
            created = True
        connection = None
        try:
            before = os.fstat(fd)
            if (not stat.S_ISREG(before.st_mode) or before.st_uid != OWNER or before.st_nlink != 1
                    or stat.S_IMODE(before.st_mode) != 0o600 or not created and before.st_size <= 0):
                fail()
            header = os.pread(fd, 100, 0)
            if not created and (len(header) != 100 or header[:16] != b'SQLite format 3\0' or header[18:20] != b'\1\1'):
                fail()
            identity = seal(before)[:6]

            def check():
                self._guard(guard)
                for current in (os.fstat(fd), os.stat(name, dir_fd=directory, follow_symlinks=False)):
                    if seal(current)[:6] != identity or not write and seal(current) != seal(before):
                        fail()

            check()
            connection = sqlite3.connect((guard._directory.path / name).as_uri() + ('?mode=rw' if write else '?mode=ro'),
                                         uri=True, timeout=0, isolation_level=None)
            # Python 3.10 lacks setlimit; the fixed SELECT bounds every fetched
            # receipt there too, without hiding an invalid row as a missing one.
            if hasattr(connection, 'setlimit'):
                connection.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, LIMIT)
            ticks = [0]
            def progress():
                ticks[0] += 1
                return int(ticks[0] > 200)
            connection.set_progress_handler(progress, 1000)
            connection.execute('PRAGMA trusted_schema=OFF')
            if write:
                if connection.execute('PRAGMA journal_mode=DELETE').fetchone() != ('delete',):
                    fail()
                connection.execute('PRAGMA synchronous=FULL')
                if connection.execute('PRAGMA synchronous').fetchone() != (2,):
                    fail()
                connection.execute('BEGIN IMMEDIATE')
            if created:
                for statement in (*_TABLES.values(), *_TRIGGERS.values()):
                    connection.execute(statement)
                connection.execute('INSERT INTO metadata VALUES (1,?,?,0)', (LEDGER_SCHEMA, completed['id']))
            expected_schema = sorted([
                *(('table', key, value) for key, value in _TABLES.items()),
                *(('trigger', key, value) for key, value in _TRIGGERS.items()),
                ('index', 'sqlite_autoindex_receipts_1', None), ('index', 'sqlite_autoindex_receipts_2', None),
            ], key=lambda row: row[1])
            if connection.execute('SELECT CASE WHEN length(type)<=16 THEN type END, '
                                  'CASE WHEN length(name)<=64 THEN name END, '
                                  'CASE WHEN length(sql)<=4096 THEN sql END FROM sqlite_master ORDER BY name LIMIT 9').fetchall() != expected_schema:
                fail()
            metadata = connection.execute('SELECT singleton, CASE WHEN length(schema)<=64 THEN schema END, '
                                          'CASE WHEN length(ledger_id)=64 THEN ledger_id END, count FROM metadata LIMIT 2').fetchall()
            if (len(metadata) != 1 or metadata[0][:3] != (1, LEDGER_SCHEMA, completed['id'])
                    or type(metadata[0][3]) is not int or metadata[0][3] not in
                    ((completed['count'], completed['count'] + 1) if write else (completed['count'],))):
                fail()
            check()
            yield connection
            if write:
                connection.execute('COMMIT')
                os.fsync(fd)
                os.fsync(directory)
            check()
        finally:
            if connection is not None:
                connection.close()
            os.close(fd)

    def _receipt(self, completed, result):
        if result is None:
            return None
        identifier, request_id, body = result
        if not valid_hash(identifier) or not valid_hash(request_id) or type(body) is not bytes or not 0 < len(body) <= LIMIT:
            fail()
        value = decoded(body)
        if (type(value) is not dict or set(value) != {'schema', 'ledgerId', 'operationId', 'row'}
                or value['schema'] != LEDGER_SCHEMA or value['ledgerId'] != completed['id']
                or value['operationId'] != identifier or type(value['row']) is not dict
                or value['row'].get('requestId') != request_id or value['row'].get('phase') != 'completed'
                or body != canonical(value) + b'\n'):
            fail()
        validate({'schema': SCHEMA, 'generation': 0, 'active': None,
                  'completed': completed, 'operations': {identifier: value['row']}})
        return value['row']

    def _archived(self, guard, state, field, selected):
        if field not in ('request_id', 'operation_id') or not valid_hash(selected):
            fail()
        with self._ledger(guard, state['completed']) as connection:
            if connection is None:
                return None
            row = self._receipt(state['completed'], connection.execute(
                _RECEIPT_SELECT + 'WHERE ' + field + '=?', (selected,)).fetchone())
            return copy.deepcopy(row)

    def _archive(self, guard, state, identifier, row):
        completed = state['completed']
        if completed is None or row['phase'] != 'completed':
            fail()
        body = canonical({'schema': LEDGER_SCHEMA, 'ledgerId': completed['id'], 'operationId': identifier, 'row': row}) + b'\n'
        with self._ledger(guard, completed, write=True, create=True) as connection:
            found = connection.execute(_RECEIPT_SELECT + 'WHERE operation_id=? OR request_id=?',
                                       (identifier, row['requestId'])).fetchall()
            count = connection.execute('SELECT count FROM metadata WHERE singleton=1').fetchone()[0]
            if found:
                if (len(found) != 1 or self._receipt(completed, found[0]) != row
                        or count != completed['count'] + 1):
                    fail()
            else:
                if count != completed['count']:
                    fail()
                connection.execute('INSERT INTO receipts VALUES (?,?,?)', (identifier, row['requestId'], body))
                connection.execute('UPDATE metadata SET count=count+1 WHERE singleton=1')
        # JSON removal follows the durable indexed receipt, never the reverse.
        changed = copy.deepcopy(state)
        changed['generation'] += 1
        changed['completed']['count'] += 1
        del changed['operations'][identifier]
        self._write(guard, state, changed)

    def _write(self, guard, before, after):
        validate(after)
        if after['generation'] != before['generation'] + 1 or self._read(guard) != before:
            fail()
        body = canonical(after) + b'\n'
        if len(body) > LIMIT:
            fail()
        directory = guard._directory.fd
        state_name, pending_name = self._names(guard)
        fd = os.open(pending_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                     0o600, dir_fd=directory)
        try:
            os.fchmod(fd, 0o600)
            remaining = memoryview(body)
            while remaining:
                count = os.write(fd, remaining)
                if count <= 0:
                    fail()
                remaining = remaining[count:]
            os.fsync(fd)
        finally:
            os.close(fd)
        # Preserve any interrupted pending file and the shared fence for review.
        self._guard(guard)
        os.replace(pending_name, state_name, src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
        if self._read(guard) != after:
            fail()

    @staticmethod
    def _reply(identifier, row):
        return {'operationId': identifier, 'requestId': row['requestId'], 'purpose': row['purpose'],
                'admissionBinding': digest(row['admission']), 'state': row['phase']}

    def prepare(self, request_id, purpose):
        with self._operation() as (guard, proof, check):
            identifier, binding = operation(request_id, purpose, proof), digest(proof)
            state, marker = self._read(guard), guard.read()
            expected = guard._value(identifier, binding)
            if marker is not None and marker != expected:
                fail()
            matches = [key for key, row in state['operations'].items() if row['requestId'] == request_id]
            if matches and matches != [identifier] or state['active'] not in (None, identifier):
                fail()
            row = state['operations'].get(identifier)
            if row is not None:
                if row['phase'] == 'pending' and marker != expected:
                    fail()
                if row['phase'] == 'pending' and self._archived(guard, state, 'request_id', request_id) is not None:
                    fail()
                check()
                return self._reply(identifier, row)
            archived = self._archived(guard, state, 'request_id', request_id)
            if archived is not None:
                if operation(request_id, archived['purpose'], archived['admission']) != identifier:
                    fail()
                check()
                return self._reply(identifier, archived)
            if len(state['operations']) >= MAX_RECORDS:
                fail()
            check()
            # The shared selector is durable BEFORE recording or granting work.
            # A failure between these writes still excludes enrollment/lifecycle.
            guard.begin(identifier, binding)
            row = {'requestId': request_id, 'purpose': purpose, 'admission': proof,
                   'phase': 'pending', 'disposition': None}
            changed = copy.deepcopy(state)
            changed['generation'] += 1
            changed['active'] = identifier
            changed['operations'][identifier] = row
            self._write(guard, state, changed)
            check()
            guard.check(identifier, binding)
            return self._reply(identifier, row)

    def check(self, identifier, binding, purpose):
        with self._operation() as (guard, proof, check):
            row = self._selected(guard, proof, identifier, binding, purpose)
            if row['phase'] != 'pending':
                fail()
            check()
            guard.check(identifier, binding)
            return self._reply(identifier, row)

    def _selected(self, guard, proof, identifier, binding, purpose):
        if not valid_hash(identifier) or not valid_hash(binding) or purpose not in PURPOSES or binding != digest(proof):
            fail()
        state = self._read(guard)
        row = state['operations'].get(identifier) or self._archived(guard, state, 'operation_id', identifier)
        if (row is None or row['purpose'] != purpose or row['admission'] != proof
                or state['active'] != (identifier if row['phase'] == 'pending' else None)):
            fail()
        if row['phase'] == 'pending' and self._archived(guard, state, 'request_id', row['requestId']) is not None:
            fail()
        return row

    def complete(self, identifier, binding, purpose, disposition):
        if disposition not in ('committed', 'not-written'):
            fail()
        with self._operation() as (guard, proof, check):
            row = self._selected(guard, proof, identifier, binding, purpose)
            if row['phase'] == 'pending':
                guard.check(identifier, binding)
                state = self._read(guard)
                changed = copy.deepcopy(state)
                changed['generation'] += 1
                changed['active'] = None
                changed['operations'][identifier].update(phase='completed', disposition=disposition)
                check()
                self._write(guard, state, changed)
            elif row['disposition'] != disposition:
                fail()

            state = self._read(guard)
            if identifier in state['operations']:
                if state['completed'] is None:
                    changed = copy.deepcopy(state)
                    changed['generation'] += 1
                    changed['completed'] = {'id': secrets.token_hex(32), 'count': 0}
                    self._write(guard, state, changed)
                    state = changed
                check()
                self._archive(guard, state, identifier, state['operations'][identifier])

            def completed():
                check()
                current = self._selected(guard, proof, identifier, binding, purpose)
                return current['phase'] == 'completed' and current['disposition'] == disposition

            guard.finish(identifier, binding, verify_completed=completed)
            return self._reply(identifier, self._selected(guard, proof, identifier, binding, purpose))
