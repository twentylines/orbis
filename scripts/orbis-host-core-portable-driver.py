"""Fixed current-image worker for destination-owned portable core staging."""
import copy
import re


class DriverError(ValueError):
    pass


class CorePortableDriver:
    def __init__(self, manager):
        self.manager, self.runtime = manager, manager.runtime

    def body(self, record, directory):
        return {'Image': record['destination']['imageId'], 'User': '0:0',
                'Entrypoint': ['node'], 'Cmd': ['/app/core-portable-worker.mjs', '--stage'],
                'WorkingDir': '/app', 'Env': ['NODE_ENV=production', 'HOME=/work', 'TMPDIR=/work'],
                'Labels': {'io.orbis.core-portable': record['id'], 'io.orbis.core-portable.nonce': record['workerNonce']},
                'HostConfig': {'NetworkMode': 'none', 'ReadonlyRootfs': True, 'Privileged': False,
                    'AutoRemove': False, 'RestartPolicy': {'Name': 'no', 'MaximumRetryCount': 0},
                    'CapDrop': ['ALL'], 'SecurityOpt': ['no-new-privileges'], 'PidsLimit': 128,
                    'Memory': 1024 * 1024 ** 2, 'NanoCpus': 2_000_000_000,
                    'Mounts': [{'Type': 'bind', 'Source': str(directory / name), 'Target': target,
                                'ReadOnly': readonly, 'BindOptions': {'Propagation': 'rprivate'}}
                               for name, target, readonly in [('input', '/input', True), ('work', '/work', False)]]}}

    def inspect(self, record):
        raw = self.runtime.inspect(record['workerId'])
        if (raw.get('Id') != record['workerId'] or raw.get('Image') != record['destination']['imageId']
                or raw.get('Name') != '/orbis-core-portable-' + record['id']):
            raise DriverError('The protected portable worker identity changed')
        self.runtime.check_intent(raw, record['workerBody'])
        host = raw['HostConfig']
        if (host.get('NetworkMode') != 'none' or host.get('ReadonlyRootfs') is not True
                or host.get('Privileged') is not False or host.get('AutoRemove') is not False
                or host.get('CapAdd') or host.get('CapDrop') != ['ALL']
                or host.get('PidMode') not in {'', None} or host.get('IpcMode') not in {'private', ''}
                or host.get('Binds') or host.get('VolumesFrom') or host.get('Devices')
                or host.get('SecurityOpt') != ['no-new-privileges']
                or not set(raw.get('NetworkSettings', {}).get('Networks', {})) <= {'none'}):
            raise DriverError('The portable worker isolation changed')
        return raw

    def stage(self, record, directory):
        # An ambiguous create/start/wait remains a durable hold. A later request
        # must not infer worker termination or launch another writer into work/.
        if 'workerIntent' in record:
            raise DriverError('A prior portable worker requires protected reconciliation')
        body = self.body(record, directory)
        record.update(workerBody=body, workerIntent='creating')
        self.manager.save(record)
        response = self.manager.P.metadata(self.runtime.engine('POST', '/containers/create?name=orbis-core-portable-' + record['id'], body))
        identifier = response.get('Id')
        if not isinstance(identifier, str) or not re.fullmatch('[a-f0-9]{64}', identifier):
            raise DriverError('The portable worker was not identified')
        record.update(workerId=identifier, workerIntent='starting')
        self.manager.save(record)
        raw = self.inspect(record)
        if not self.runtime.never_started(raw):
            raise DriverError('The portable worker started before its durable admission')
        record['workerDefinition'] = self.runtime.definition(raw)
        self.manager.save(record)
        self.runtime.change(['start', identifier])
        record['workerIntent'] = 'waiting'
        self.manager.save(record)
        # Killing this bounded Docker CLI does not kill the worker. On failure,
        # retain its identity and inputs; never retry the operation blindly.
        result = self.runtime.bounded_output(['docker', '--context', self.manager.context, 'wait', identifier], 32, 1800)
        terminal = self.inspect(record)
        state = terminal.get('State') or {}
        if (result.strip() != b'0' or state.get('Status') != 'exited' or state.get('Running') is not False
                or state.get('Restarting') is not False or state.get('Dead') is not False
                or state.get('OOMKilled') is not False or state.get('ExitCode') != 0
                or not isinstance(state.get('FinishedAt'), str) or state['FinishedAt'].startswith('0001-')
                or self.runtime.definition(terminal) != record['workerDefinition']):
            raise DriverError('The portable worker did not positively settle')
        record.update(workerIntent='complete', workerTerminal={'id': identifier,
                      'definitionSha256': record['workerDefinition'], 'state': copy.deepcopy(state)})
        self.manager.save(record)
        return self.manager.json(directory / 'work' / 'review.json', 2 * 1024 * 1024)
