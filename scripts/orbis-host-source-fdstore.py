#!/usr/bin/env python3
"""Systemd custody of original capture source descriptors.

Custody metadata is not process identity. No authority is granted by this module.
"""
import array
import fcntl
import json
import os
import re
import select
import socket
import stat
import subprocess
import sys
import threading
import time

_NAME = re.compile(r'orbis-source-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-(?:init|pidns|mntns|root)\Z')
_UNIT = 'orbis-host.service'
_ANCHOR = 'multi-user.target'
_MAX = 4096
_LOCK = threading.RLock()


class CustodyError(RuntimeError):
    """Descriptor custody could not be established or verified."""


def _name(value):
    if not isinstance(value, str) or not _NAME.fullmatch(value):
        raise CustodyError('Invalid descriptor name')


def _command(args):
    try:
        proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, close_fds=True)
        deadline = time.monotonic() + 5
        data = bytearray()
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([proc.stdout], [], [], remaining)[0]:
                raise CustodyError('Manager query timed out')
            chunk = os.read(proc.stdout.fileno(), 8192)
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > 1048576:
                raise CustodyError('Manager response too large')
        if proc.wait(timeout=max(0.01, deadline - time.monotonic())) != 0:
            raise CustodyError('Manager query failed')
        return data.decode('utf-8', 'strict')
    except (OSError, UnicodeError, subprocess.TimeoutExpired) as exc:
        raise CustodyError('Manager query failed') from exc
    finally:
        if 'proc' in locals():
            if proc.poll() is None:
                proc.kill()
                proc.wait()
            proc.stdout.close()


def _parse_inventory(raw):
    try:
        def unique(pairs):
            value = {}
            for key, item in pairs:
                if key in value:
                    raise ValueError()
                value[key] = item
            return value
        obj = json.loads(raw, object_pairs_hook=unique)
        if not isinstance(obj, dict) or set(obj) != {'type', 'data'} or obj['type'] != 'a(suuutuusu)':
            raise ValueError()
        data = obj['data']
        if not isinstance(data, list) or len(data) != 1 or not isinstance(data[0], list) or len(data[0]) > _MAX:
            raise ValueError()
        result = {}
        for row in data[0]:
            if not isinstance(row, list) or len(row) != 9:
                raise ValueError()
            name, mode, major, minor, ino, rmajor, rminor, path, flags = row
            if not isinstance(name, str) or not name or len(name) > 255 or not isinstance(path, str) or len(path) > 4096:
                raise ValueError()
            if any(ord(c) < 32 or ord(c) == 127 for c in name + path):
                raise ValueError()
            for value, bits in zip((mode, major, minor, ino, rmajor, rminor, flags), (32, 32, 32, 64, 32, 32, 32)):
                if type(value) is not int or not 0 <= value < 2 ** bits:
                    raise ValueError()
            if name in result:
                raise ValueError()
            result[name] = tuple(row)
        return result
    except (ValueError, TypeError, KeyError, json.JSONDecodeError) as exc:
        raise CustodyError('Invalid manager inventory') from exc


def _metadata(fd):
    try:
        s = os.fstat(fd)
        return (s.st_mode, os.major(s.st_dev), os.minor(s.st_dev), s.st_ino,
                os.major(s.st_rdev), os.minor(s.st_rdev))
    except (OSError, ValueError) as exc:
        raise CustodyError('Invalid descriptor') from exc


class _Runtime:
    def validate(self, unit):
        if sys.platform != 'linux' or os.geteuid() != 0 or unit != _UNIT:
            raise CustodyError('Unsupported manager context')
        keys = ('MainPID', 'InvocationID', 'NotifyAccess', 'FileDescriptorStoreMax',
                'FileDescriptorStorePreserve', 'ActiveState', 'NeedDaemonReload', 'WantedBy')
        raw = _command(['/usr/bin/systemctl', 'show', unit, '--no-pager'] + ['--property=' + k for k in keys])
        props = {}
        for line in raw.splitlines():
            key, sep, value = line.partition('=')
            if not sep or key not in keys or key in props:
                raise CustodyError('Invalid manager properties')
            props[key] = value
        invocation = os.environ.get('INVOCATION_ID', '')
        cap = props.get('FileDescriptorStoreMax', '')
        pid = props.get('MainPID', '')
        if (set(props) != set(keys) or not re.fullmatch(r'[1-9][0-9]{0,9}', pid) or int(pid) != os.getpid()
                or not re.fullmatch(r'[0-9a-f]{32}', invocation) or props['InvocationID'] != invocation
                or props['NotifyAccess'] != 'main' or props['FileDescriptorStorePreserve'] != 'yes'
                or _ANCHOR not in props['WantedBy'].split()
                or props['ActiveState'] not in ('active', 'activating') or props['NeedDaemonReload'] != 'no'
                or not re.fullmatch(r'[1-9][0-9]{0,3}', cap) or int(cap) > _MAX):
            raise CustodyError('Manager context does not support custody')
        # An unreferenced unit can unload and lose its store after a full stop.
        # The enabled host service is pinned by the active boot target.
        if _command(['/usr/bin/systemctl', 'show', _ANCHOR, '--no-pager', '--property=ActiveState']) != 'ActiveState=active\n':
            raise CustodyError('Manager custody reference is unavailable')
        if not os.environ.get('NOTIFY_SOCKET'):
            raise CustodyError('Notify socket unavailable')
        return int(cap)

    def inventory(self, unit):
        return _parse_inventory(_command(['/usr/bin/busctl', '--system', '--json=short', 'call',
            'org.freedesktop.systemd1', '/org/freedesktop/systemd1',
            'org.freedesktop.systemd1.Manager', 'DumpUnitFileDescriptorStore', 's', unit]))

    def notify(self, message, fd=None):
        address = os.environ.get('NOTIFY_SOCKET', '')
        if address.startswith('@'):
            address = '\0' + address[1:]
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as sock:
                ancillary = [] if fd is None else [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', [fd]))]
                sock.sendmsg([message.encode('ascii')], ancillary, 0, address)
        except (OSError, ValueError) as exc:
            raise CustodyError('Manager notification failed') from exc

    def barrier(self):
        read_fd, write_fd = os.pipe()
        try:
            self.notify('BARRIER=1', write_fd)
            os.close(write_fd)
            write_fd = -1
            if not select.select([read_fd], [], [], 5)[0] or os.read(read_fd, 1) != b'':
                raise CustodyError('Manager barrier failed')
        finally:
            os.close(read_fd)
            if write_fd >= 0:
                os.close(write_fd)


class DescriptorStore:
    def __init__(self, unit=_UNIT, runtime=None):
        if unit != _UNIT:
            raise CustodyError('Invalid unit')
        self.unit = unit
        self.runtime = runtime if runtime is not None else _Runtime()

    def deposit(self, name, fd):
        _name(name)
        with _LOCK:
            cap = self.runtime.validate(self.unit)
            try:
                held = os.dup(fd)
            except OSError as exc:
                raise CustodyError('Invalid descriptor') from exc
            try:
                metadata = _metadata(held)
                before = self.runtime.inventory(self.unit)
                if name in before or len(before) >= cap:
                    raise CustodyError('Descriptor name unavailable or store full')
                self.runtime.notify('FDSTORE=1\nFDPOLL=0\nFDNAME=' + name, held)
                self.runtime.barrier()
                after = self.runtime.inventory(self.unit)
                record = after.get(name)
                if (record is None or record[1:7] != metadata or len(after) != len(before) + 1
                        or {k: v for k, v in after.items() if k != name} != before):
                    raise CustodyError('Descriptor deposit was not confirmed')
            finally:
                os.close(held)

    def remove(self, name):
        _name(name)
        with _LOCK:
            self.runtime.validate(self.unit)
            before = self.runtime.inventory(self.unit)
            if name not in before:
                raise CustodyError('Descriptor name absent')
            self.runtime.notify('FDSTOREREMOVE=1\nFDNAME=' + name)
            self.runtime.barrier()
            after = self.runtime.inventory(self.unit)
            if after != {k: v for k, v in before.items() if k != name}:
                raise CustodyError('Descriptor removal was not confirmed')

    def take_inherited(self, expected_names):
        names_expected = list(expected_names)
        for name in names_expected:
            _name(name)
        if len(set(names_expected)) != len(names_expected) or len(names_expected) > _MAX:
            raise CustodyError('Invalid expected descriptors')
        with _LOCK:
            self.runtime.validate(self.unit)
            pid, count, raw = (os.environ.get(k, '') for k in ('LISTEN_PID', 'LISTEN_FDS', 'LISTEN_FDNAMES'))
            if not re.fullmatch(r'[1-9][0-9]{0,9}', pid) or int(pid) != os.getpid() or not re.fullmatch(r'(?:0|[1-9][0-9]{0,3})', count) or int(count) > _MAX:
                raise CustodyError('Invalid inherited descriptors')
            names = raw.split(':') if raw else []
            if len(names) != int(count) or len(set(names)) != len(names) or set(names) != set(names_expected):
                raise CustodyError('Invalid inherited descriptors')
            fds = list(range(3, 3 + int(count)))
            try:
                for fd in fds:
                    fcntl.fcntl(fd, fcntl.F_GETFD)
                for fd in fds:
                    fcntl.fcntl(fd, fcntl.F_SETFD, fcntl.fcntl(fd, fcntl.F_GETFD) | fcntl.FD_CLOEXEC)
            except OSError as exc:
                raise CustodyError('Invalid inherited descriptors') from exc
            for key in ('LISTEN_PID', 'LISTEN_FDS', 'LISTEN_FDNAMES'):
                os.environ.pop(key, None)
            return dict(zip(names, fds))
