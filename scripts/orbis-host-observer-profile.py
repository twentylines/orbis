"""Recognize the fixed read-only Sentinel socket profile during helper changes."""

import ast
from contextlib import ExitStack
import grp
import hashlib
from pathlib import Path


ACTIVATION = 'orbis-observer-v1'
SOCKET = 'orbis-host-observer.socket'
DROP_IN = b'''[Unit]
Requires=orbis-host-observer.socket
After=orbis-host-observer.socket

[Service]
Sockets=orbis-host-observer.socket
'''
SOCKET_UNIT = b'''[Unit]
Description=Orbis read-only update progress

[Socket]
ListenStream=/run/orbis-observer/progress.sock
SocketUser=root
SocketGroup=orbis-observer
SocketMode=0660
DirectoryMode=0755
Backlog=16
FileDescriptorName=orbis-observer-v1
Service=orbis-host.service
RemoveOnStop=yes

[Install]
WantedBy=sockets.target
'''


def configuration(unit_file, query, authority, *, loaded=True):
    unit_file = Path(unit_file)
    drop_in = unit_file.parent / 'orbis-host.service.d' / 'sentinel-observer.conf'
    if drop_in.parent.exists() or drop_in.parent.is_symlink():
        with authority.protected_directory(drop_in.parent, private=False):
            if any(path.name != drop_in.name for path in drop_in.parent.glob('*.conf')):
                raise ValueError('Orbis helper unit has unreviewed systemd drop-ins')
    paths = query('show', '-p', 'DropInPaths', '--value', 'orbis-host.service')
    if not paths and not drop_in.exists() and not drop_in.is_symlink():
        return None
    if paths != str(drop_in):
        raise ValueError('Orbis helper unit has unreviewed systemd drop-ins')
    socket_unit = unit_file.parent / SOCKET
    with ExitStack() as stack:
        files = {}
        for path, expected in ((drop_in, DROP_IN), (socket_unit, SOCKET_UNIT)):
            directory = stack.enter_context(authority.protected_directory(path.parent, private=False))
            data = stack.enter_context(authority.protected_file(directory, path.name, 4096, private=False))
            if data != expected:
                raise ValueError('Sentinel observer configuration differs from its managed profile')
            files[str(path)] = hashlib.sha256(data).hexdigest()
        if loaded and (query('show', '-p', 'FragmentPath', '--value', SOCKET) != str(socket_unit)
                or query('show', '-p', 'DropInPaths', '--value', SOCKET)
                or query('show', '-p', 'TriggeredBy', '--value', 'orbis-host.service') != SOCKET
                or query('show', '-p', 'KillMode', '--value', 'orbis-host.service') != 'control-group'
                or any(query('show', '-p', 'NeedDaemonReload', '--value', name) != 'no'
                       for name in ('orbis-host.service', SOCKET))):
            raise ValueError('Sentinel observer loaded configuration needs review')
        try:
            group = grp.getgrnam('orbis-observer').gr_gid
        except KeyError as error:
            raise ValueError('Sentinel observer group is unavailable') from error
        if type(group) is not int or not 0 < group < 2**31:
            raise ValueError('Sentinel observer group is unavailable')
        return {'schema': 'orbis.sentinel-observer-profile.v1', 'files': files, 'groupId': group}


def require_support(directory, profile):
    if profile is None:
        return
    directory = Path(directory)
    source = directory / 'orbis-host-service.py'
    observer = directory / 'orbis-host-sentinel-observer.py'
    if any(path.is_symlink() or not path.is_file() for path in (source, observer)):
        raise ValueError('Helper does not support the enrolled Sentinel observer')
    values = []
    try:
        declarations = ast.parse(source.read_bytes()).body
    except SyntaxError as error:
        raise ValueError('Helper Sentinel observer declaration is invalid') from error
    for node in declarations:
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'SENTINEL_OBSERVER_ACTIVATION' for target in node.targets):
            values.append(ast.literal_eval(node.value))
        elif isinstance(node, (ast.AugAssign, ast.AnnAssign)) and isinstance(node.target, ast.Name) and node.target.id == 'SENTINEL_OBSERVER_ACTIVATION':
            raise ValueError('Helper Sentinel observer declaration is ambiguous')
    if values != [ACTIVATION]:
        raise ValueError('Helper does not support the enrolled Sentinel observer')
