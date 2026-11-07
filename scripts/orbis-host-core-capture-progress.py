"""Observe capture authority without acquiring, reconciling or retiring a lease."""
import os
from pathlib import Path
from types import SimpleNamespace


class CaptureProgress:
    def __init__(self, service, reader):
        self.service, self.reader, self.W = service, reader, reader.worker
        self.state, self.root = Path(service.state_dir), Path(service.root)
        self.context = service.context
        self.seen = {}

    def read(self, directory, name, *, optional=False):
        key = (Path(directory), name)
        maximum = (16 * 1024 * 1024 if name in {'job.json', 'checkpoint.json'}
                   else 8 * 1024 * 1024 if name == 'binding.json' else 65536)
        try:
            with self.W.A.protected_directory(directory) as parent:
                with self.W.A.protected_file(parent, name, maximum) as body:
                    value = self.W.P.metadata(body, byte_limit=maximum)
                    if type(value) is not dict or self.W.P.canonical(value) != body:
                        raise ValueError('Capture progress is unavailable')
                    result = (value, body, self.W.A.seal(os.stat(name, dir_fd=parent, follow_symlinks=False)))
        except FileNotFoundError:
            if not optional:
                raise
            result = None
        if key in self.seen and self.seen[key] != result:
            raise ValueError('Capture progress changed during observation')
        self.seen[key] = result
        return None if result is None else result[:2]

    def unchanged(self):
        for directory, name in list(self.seen):
            self.read(directory, name, optional=True)

    def response(self, point, state, phase, *, restart=False, completed=0, total=None):
        self.unchanged()
        return {'version': 1, 'id': point, 'state': state, 'phase': phase,
                'completedBytes': completed, 'totalBytes': total, 'restartVerified': restart}

    def controller_healthy(self, frame):
        w = self.W
        if (type(frame) is not dict or set(frame) != {'id', 'imageId', 'startedAt', 'definitionSha256'}
                or any(type(frame[key]) is not str or not w.HASH.fullmatch(frame[key])
                       for key in ('id', 'definitionSha256'))):
            raise ValueError('Capture controller evidence is unavailable')
        runtime = SimpleNamespace(host=w.CORE.HOST, root=self.root)
        body = w.CORE.D.DockerRestoreRuntime.bounded_output(runtime,
            ['docker', '--context', self.context, 'container', 'inspect', '--format', '{{json .}}', frame['id']],
            8 * 1024 * 1024, 1)
        raw = w.P.metadata(body, byte_limit=8 * 1024 * 1024, string_limit=2 * 1024 * 1024)
        state = raw.get('State', {})
        if (raw.get('Id') != frame['id'] or raw.get('Image') != frame['imageId']
                or state.get('StartedAt') != frame['startedAt']
                or w.CORE.TX.APPS.digest(w.CORE.D.DockerRestoreRuntime.definition(SimpleNamespace(P=w.P), raw)) != frame['definitionSha256']):
            raise ValueError('The captured controller changed')
        return (state.get('Running') is True and state.get('Status') == 'running'
                and not state.get('Restarting') and not state.get('Paused')
                and type(state.get('Health')) is dict and state['Health'].get('Status') == 'healthy')

    def publication_current(self, point, proof):
        w = self.W
        module = w.load('orbis-host-core-capture-completion.py', 'capture_progress_publication')
        runtime = SimpleNamespace(host=w.CORE.HOST, root=self.root)
        body = w.CORE.D.DockerRestoreRuntime.bounded_output(runtime,
            ['docker', '--context', self.context, 'exec', proof['controller']['id'], '/usr/local/bin/node',
             '-e', module.PUBLICATION_SEAL_READER, point], 8192, 1)
        if w.P.metadata(body, byte_limit=8192) != proof.get('publicationSeal'):
            raise ValueError('The saved capture changed after verification')

    def selected_view(self):
        # The lifecycle constructor creates directories. Observation uses only
        # status/verify_wrapper and supplies no lifecycle core implementation.
        view = object.__new__(self.W.SELECTED.SelectedCapture)
        view.service, view.host = self.service, self.W.CORE.HOST
        view.root, view.state, view.authority = self.root, self.state, self.W.A
        view.core = SimpleNamespace(a=self.W.A, P=self.W.P)
        view.base = self.state / 'selected-captures'
        return view

    def completed(self, point, directory, request, hold):
        w = self.W
        if self.read(directory, 'completion-commit.json', optional=True) is None:
            return None
        retirement_module = w.load('orbis-host-core-capture-retirement.py', 'capture_progress_retirement')
        retirement = retirement_module.CaptureRetirement(w, self.state, self.root, self.context, point)
        commit = retirement.inspect_retired()
        proof, body = self.read(directory, 'completion-ready.json')
        original, request_body = self.read(directory, 'request.json')
        retired = self.read(directory, 'source-retired.json', optional=True)
        if (w.digest(body) != commit['completionSha256'] or w.digest(request_body) != commit['requestSha256']
                or original != request or proof.get('schema') != 'orbis.core-capture-completion-ready.v1'
                or proof.get('id') != point or proof.get('requestSha256') != commit['requestSha256']
                or proof.get('leaseNonce') != request['leaseNonce']
                or proof.get('sourceHoldSha256') != commit['sourceHoldSha256']
                or proof.get('pointReservationSha256') != commit['pointReservationSha256']
                or w.digest(hold[1]) != commit['sourceHoldSha256']):
            raise ValueError('Capture completion is unavailable')
        if retired is None:
            return self.response(point, 'running', 'sealing')
        expected = {'schema': 'orbis.core-capture-retirement-witness.v1', 'id': point,
                    'completionSha256': commit['completionSha256'], 'continuationSha256': commit['continuationSha256'],
                    'sourceHoldSha256': commit['sourceHoldSha256']}
        witness = retired[0]
        if (set(witness) != set(expected) | {'namespace'} or any(witness[key] != value for key, value in expected.items())
                or type(witness['namespace']) is not dict
                or witness['namespace'].get('schema') != 'orbis.core-capture-source-retirement.v1'
                or witness['namespace'].get('id') != point
                or witness['namespace'].get('sourceHoldSha256') != commit['sourceHoldSha256']):
            raise ValueError('Capture retirement is unavailable')
        healthy = self.controller_healthy(proof.get('controller'))
        if not healthy:
            return self.response(point, 'running', 'starting-orbis')
        self.publication_current(point, proof)
        selected = self.selected(point)
        if selected is not None:
            if selected['state'] == 'recovery-required':
                return self.response(point, 'recovery-required', selected['phase'])
            if selected['restartVerified'] is not True:
                return self.response(point, 'running', selected['phase'])
            manager = self.selected_view()
            # This verifies the authenticated wrapper, not just its plain status.
            manager.verify_wrapper(point, proof['controller']['id'])
            if not self.controller_healthy(proof['controller']):
                return self.response(point, 'running', 'starting-orbis')
        retirement.inspect_retired()
        return self.response(point, 'complete', 'complete', restart=True)

    def selected(self, point):
        binding = self.read(self.state / 'selected-captures' / point, 'binding.json', optional=True)
        if binding is None:
            return None
        return self.selected_view().status(point)

    def progress(self, point):
        w = self.W
        w.require_root()
        w.identifier(point)
        directory = self.state / 'core-capture-admissions' / point
        request, _ = self.read(directory, 'request.json')
        if (request.get('id') != point or request.get('root') != str(self.root)
                or request.get('context') != self.context):
            raise ValueError('Capture progress belongs to a different installation')
        hold = self.read(directory, 'source-hold.json')
        if (hold[0].get('schema') not in {'orbis.core-capture-source-hold.v1', 'orbis.core-capture-source-hold.v2'}
                or hold[0].get('id') != point or hold[0].get('sourceSha256') != request.get('sourceSha256')):
            raise ValueError('Capture source evidence is unavailable')
        completed = self.completed(point, directory, request, hold)
        if completed is not None:
            return completed
        result = self.reader.status(point, {
            'sourceSha256': request['sourceSha256'], 'sourceHoldSha256': w.digest(hold[1])})
        if result.get('id') != point:
            raise ValueError('Capture progress identity changed')
        selected = self.selected(point)
        if result['state'] == 'recovery-required' or selected is not None and selected['state'] == 'recovery-required':
            return self.response(point, 'recovery-required', 'sealing')
        if result['state'] in {'reserved', 'launch-unsettled'}:
            return self.response(point, 'waiting', 'preparing')
        if result['state'] == 'resumed-awaiting-publication':
            return self.response(point, 'running', 'sealing')
        if result['state'] != 'running':
            raise ValueError('Capture state is unavailable')
        if selected is not None and selected['phase'] in {'stopping-apps', 'saving-apps', 'starting-apps'}:
            return self.response(point, 'running', selected['phase'])
        core_directory = self.state / 'time-machine-core' / point
        core = self.read(core_directory, 'job.json', optional=True)
        phase = 'preparing'
        if core is not None:
            job = core[0]
            if (job.get('schema') != w.CORE.SCHEMA or job.get('id') != point
                    or job.get('root') != str(self.root) or job.get('context') != self.context
                    or job.get('scope') != w.CORE.SCOPE):
                raise ValueError('Capture journal identity changed')
            phase = {'preparing': 'preparing', 'checkpointing': 'saving-orbis', 'checkpoint-ready': 'saving-orbis',
                     'resuming': 'starting-orbis', 'complete': 'sealing', 'recovery-required': 'sealing'}.get(job.get('phase'))
            if phase is None:
                raise ValueError('Capture journal stage is unavailable')
            if job['phase'] == 'recovery-required':
                return self.response(point, 'recovery-required', phase)
            if job['phase'] == 'checkpointing':
                journal = self.read(core_directory, 'checkpoint.json', optional=True)
                if journal is not None:
                    value = journal[0]
                    if (value.get('schema') != w.CORE.TX.SCHEMA or value.get('review') != job.get('checkpoint')
                            or value.get('stage') not in {'prepared', 'quiescing', 'snapshotting', 'ready'}):
                        raise ValueError('Capture checkpoint journal changed')
                    if value.get('stage') in {'prepared', 'quiescing'}:
                        phase = 'stopping-orbis'
        return self.response(point, 'running', phase)
