"""Bounded streaming I/O for selected capture; legacy snapshots do not use this."""
import hashlib
import os
from pathlib import Path
import selectors
import signal
import stat
import subprocess
import time

CHUNK = 64 * 1024


class BoundsError(ValueError):
    pass


class Budget:
    def __init__(self, maximum, seconds, state, reserve, clock=time.monotonic):
        self.maximum, self.written = maximum, 0
        self.clock, self.deadline = clock, clock() + seconds
        self.state, self.reserve = Path(state), reserve

    def remaining(self):
        value = self.deadline - self.clock()
        if value <= 0:
            raise BoundsError('Selected capture exceeded its aggregate deadline. Recovery authority was retained.')
        return value

    def check(self):
        self.remaining()

    def consume(self, size):
        self.check()
        if size < 0 or self.written + size > self.maximum:
            raise BoundsError('Selected capture exceeded its aggregate write budget. Recovery authority was retained.')
        usage = os.statvfs(self.state)
        if usage.f_bavail * usage.f_frsize < self.reserve + size:
            raise BoundsError('Selected capture must preserve free recovery storage. Recovery authority was retained.')
        self.written += size


class Writer:
    def __init__(self, stream, budget, maximum):
        self.stream, self.budget, self.maximum, self.count = stream, budget, maximum, 0

    def write(self, body):
        if self.count + len(body) > self.maximum:
            raise BoundsError('Selected app data exceeds the supported component size. Recovery authority was retained.')
        self.budget.consume(len(body))
        self.count += len(body)
        written = self.stream.write(body)
        if written != len(body):
            raise BoundsError('Selected capture write did not complete. Recovery authority was retained.')
        self.budget.check()
        return written


class Reader:
    def __init__(self, descriptor, budget):
        self.descriptor, self.budget = descriptor, budget
        self.hash, self.count = hashlib.sha256(), 0

    def read(self, size):
        self.budget.check()
        data = os.read(self.descriptor, min(size, CHUNK))
        self.budget.check()
        self.hash.update(data)
        self.count += len(data)
        return data


def wait_owned(child, timeout):
    """Only this child's returned kernel status establishes a successful reap."""
    end = time.monotonic() + timeout
    while True:
        try:
            pid, status = os.waitpid(child.pid, os.WNOHANG)
        except InterruptedError:
            continue
        except ChildProcessError as error:
            raise BoundsError('Selected capture child could not be reaped; kernel exit evidence is unavailable.') from error
        if pid == child.pid:
            child.returncode = os.waitstatus_to_exitcode(status)
            return child.returncode
        if pid != 0:
            raise BoundsError('Selected capture child could not be reaped; kernel exit identity changed.')
        remaining = end - time.monotonic()
        if remaining <= 0:
            raise BoundsError('Selected capture child could not be reaped; external state remains recovery-required.')
        time.sleep(min(0.01, remaining))


def process(arguments, budget, maximum, *, writer=None, pass_fds=(), seconds=None):
    """Own and positively reap the CLI; a Docker timeout never settles daemon work."""
    budget.check()
    end = budget.clock() + min(budget.remaining(), seconds if seconds is not None else budget.remaining())
    output, count, settled = bytearray(), 0, False
    child = subprocess.Popen(arguments, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             pass_fds=pass_fds, start_new_session=True)
    try:
        os.set_blocking(child.stdout.fileno(), False)
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            while selector.get_map():
                remaining = min(budget.remaining(), end - budget.clock())
                if remaining <= 0:
                    raise BoundsError('Selected capture CLI exceeded its deadline. Recovery authority was retained.')
                if not selector.select(remaining):
                    raise BoundsError('Selected capture CLI exceeded its deadline. Recovery authority was retained.')
                body = os.read(child.stdout.fileno(), CHUNK)
                budget.check()
                if not body:
                    selector.unregister(child.stdout)
                    continue
                count += len(body)
                if count > maximum:
                    raise BoundsError('Selected capture CLI exceeded its byte limit. Recovery authority was retained.')
                if writer is None:
                    output.extend(body)
                else:
                    writer.write(body)
        status = wait_owned(child, min(budget.remaining(), max(0.001, end - budget.clock())))
        budget.check()
        if status:
            raise BoundsError('Selected capture CLI failed. Recovery authority was retained.')
        settled = True
        return bytes(output)
    finally:
        if not settled or child.returncode is None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except OSError:
                # A failed kill still requires a positive wait below.
                pass
        try:
            if child.returncode is None:
                wait_owned(child, 5)
        finally:
            child.stdout.close()


def file_hash(path, budget):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise BoundsError('Selected capture hash requires a regular file.')
        reader = Reader(descriptor, budget)
        while reader.read(CHUNK):
            pass
        after = os.fstat(descriptor)
        identity = lambda details: tuple(getattr(details, key) for key in
                                         ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns'))
        if identity(before) != identity(after) or identity(after) != identity(os.stat(path, follow_symlinks=False)):
            raise BoundsError('Selected capture data changed while hashing.')
        return reader.hash.hexdigest()
    finally:
        os.close(descriptor)

def collect(sources, pack, budget, archive=None, *, hash_files=True):
    entries, links, manifest_bytes = [], {}, 0
    def append(entry):
        nonlocal manifest_bytes
        manifest_bytes += len(pack.canonical(entry)) + 1
        if manifest_bytes > pack.METADATA_LIMIT or len(entries) >= 100_000:
            raise pack.CheckpointError('The portable storage manifest exceeds its metadata bound')
        entries.append(entry)

    def visit(parent, name, path, portable, index):
        budget.check()
        before = os.stat(name, dir_fd=parent, follow_symlinks=False)
        entry = {'path': pack.relative(portable), **pack.metadata(before)}
        if stat.S_ISLNK(before.st_mode):
            target = os.readlink(name, dir_fd=parent)
            if (not target or target.startswith('/') or any(ord(char) < 32 or ord(char) == 127 for char in target)):
                raise pack.CheckpointError('A symbolic link is not a contained relative link')
            # /proc anchors the metadata lookup to the already opened directory.
            anchored = Path('/proc/self/fd') / str(parent) / name if os.path.exists('/proc/self/fd') else path
            entry.update(type='symlink', target=target, xattrs=pack.attributes(anchored))
            if archive:
                pack.tar_entry(archive, entry)
            if entry['xattrs'] != pack.attributes(anchored):
                raise pack.CheckpointError('Symbolic link metadata changed while packaging')
            append(entry)
        elif stat.S_ISDIR(before.st_mode) or stat.S_ISREG(before.st_mode):
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
            if stat.S_ISDIR(before.st_mode):
                flags |= os.O_DIRECTORY
            descriptor = os.open(name, flags, dir_fd=parent)
            try:
                if pack.seal(before) != pack.seal(os.fstat(descriptor)):
                    raise pack.CheckpointError('A copied resource changed while opening')
                entry['xattrs'] = pack.attributes(descriptor)
                if stat.S_ISDIR(before.st_mode):
                    entry['type'] = 'directory'
                    append(entry)
                    if archive:
                        pack.tar_entry(archive, entry)
                    children = []
                    with os.scandir(descriptor) as directory:
                        for child in directory:
                            budget.check()
                            if len(children) >= 100_000:
                                raise pack.CheckpointError('The portable directory exceeds its entry bound')
                            children.append(child.name)
                    for child in sorted(children):
                        pack.relative(child)
                        visit(descriptor, child, path / child, portable + '/' + child, index)
                else:
                    key = (before.st_dev, before.st_ino)
                    group = links.setdefault(key, {'index': index, 'count': 0, 'expected': before.st_nlink, 'entry': None})
                    if group['index'] != index or group['expected'] != before.st_nlink:
                        raise pack.CheckpointError('A hard link crosses captured resource boundaries')
                    group['count'] += 1
                    entry.update(type='file', bytes=before.st_size)
                    if group['entry'] is not None:
                        prior = group['entry']
                        entry.update(type='hardlink', target=prior['path'], sha256=prior['sha256'])
                        if archive:
                            pack.tar_entry(archive, entry)
                    else:
                        reader = Reader(descriptor, budget)
                        if archive:
                            pack.tar_entry(archive, entry, reader)
                        elif hash_files:
                            while reader.read(CHUNK):
                                pass
                        if (archive or hash_files) and reader.count != before.st_size:
                            raise pack.CheckpointError('A copied file changed length while packaging')
                        entry['sha256'] = reader.hash.hexdigest() if archive or hash_files else None
                        group['entry'] = entry
                    append(entry)
                if pack.seal(before) != pack.seal(os.fstat(descriptor)) or entry['xattrs'] != pack.attributes(descriptor):
                    raise pack.CheckpointError('Copied storage or metadata changed while packaging')
            finally:
                os.close(descriptor)
        else:
            raise pack.CheckpointError('Special storage files cannot be packaged')
        if pack.seal(before) != pack.seal(os.stat(name, dir_fd=parent, follow_symlinks=False)):
            raise pack.CheckpointError('A copied resource was replaced while packaging')

    for index, source in enumerate(sources):
        source = Path(source)
        budget.check()
        descriptor = os.open(source.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            if not stat.S_ISDIR(os.stat(source.name, dir_fd=descriptor, follow_symlinks=False).st_mode):
                raise pack.CheckpointError('A selected resource has the wrong type')
            visit(descriptor, source.name, source, f'resources/{index:04d}', index)
        finally:
            os.close(descriptor)
    if any(group['count'] != group['expected'] for group in links.values()):
        raise pack.CheckpointError('A hard link is not wholly contained in its captured resource')
    if len({entry['path'] for entry in entries}) != len(entries):
        raise pack.CheckpointError('The portable manifest contains duplicate paths')
    budget.check()
    pack.check_links(entries)
    budget.check()
    return entries

