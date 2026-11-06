"""Kernel state of an original source-init pidfd retained in trusted custody.

An arbitrary dead pidfd cannot identify a capture. The caller must authenticate
the original named custody slot and its protected generation record first.
"""
import os
import re
import select
import sys


class SourceProcessError(ValueError):
    pass


def init_reaped(descriptor, original_pid):
    if (sys.platform != 'linux' or type(descriptor) is not int or descriptor < 0
            or type(original_pid) is not int or not 1 < original_pid <= 2 ** 31 - 1):
        raise SourceProcessError('Original source process tracking is unavailable')
    held = None
    try:
        held = os.dup(descriptor)
        descriptor = held
        if os.readlink('/proc/self/fd/' + str(descriptor)) != 'anon_inode:[pidfd]':
            raise SourceProcessError('Original source handle is not a pidfd')
        poll = select.poll()
        poll.register(descriptor, select.POLLIN | select.POLLHUP | select.POLLERR)
        events = poll.poll(0)
        if len(events) > 1 or any(fd != descriptor or flags & (select.POLLNVAL | select.POLLERR) for fd, flags in events):
            raise SourceProcessError('Original source handle cannot be observed')
        flags = events[0][1] if events else 0
        fd = os.open('/proc/self/fdinfo/' + str(descriptor), os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            body = os.read(fd, 8193)
        finally:
            os.close(fd)
        if not body or len(body) > 8192:
            raise SourceProcessError('Original source handle information is unavailable')
        fields = {}
        for line in body.decode('ascii', 'strict').splitlines():
            key, separator, value = line.partition(':')
            if not separator or key in fields:
                raise SourceProcessError('Invalid original source handle information')
            fields[key] = value.strip()
        if not re.fullmatch(r'-1|0|[1-9][0-9]{0,9}', fields.get('Pid', '')):
            raise SourceProcessError('Invalid original source handle PID')
        pid = int(fields['Pid'])
        namespace_pids = fields.get('NSpid', '').split()
        if not namespace_pids or any(not re.fullmatch(r'-1|0|[1-9][0-9]{0,9}', item) for item in namespace_pids):
            raise SourceProcessError('Invalid original source PID namespace')
        namespace_pids = [int(item) for item in namespace_pids]
        if pid == -1:
            if namespace_pids != [-1] or not flags & select.POLLIN:
                raise SourceProcessError('Inconsistent original source termination evidence')
            # Linux6.8 pidfd_poll has no POLLHUP. Kernel pidfd fdinfo reports
            # -1 only after its original task is detached; unrelated namespaces
            # report 0. Neither PID-path absence nor an exit timeout is evidence.
            return True
        if (pid != original_pid or namespace_pids[0] != original_pid or namespace_pids[-1] != 1
                or any(not 1 <= item <= 2 ** 31 - 1 for item in namespace_pids) or flags & select.POLLHUP):
            raise SourceProcessError('Original source generation does not match')
        return False
    except (OSError, UnicodeError) as error:
        raise SourceProcessError('Original source process tracking is unavailable') from error
    finally:
        if held is not None:
            os.close(held)
