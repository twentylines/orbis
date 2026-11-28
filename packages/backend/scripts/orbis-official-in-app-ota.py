"""Exercise the exact Updates API path in an official disposable Linux rehearsal."""

import re
import time
import uuid
from urllib.parse import quote

CHANNEL = '/api/system/orbis-release-channels'
RELEASE = '/api/system/orbis-release'
HOST = '/api/host-updates'
TAG = re.compile(r'v[0-9]+\.[0-9]+\.[0-9]+(?:-(?:beta|rc)\.[0-9]+)?')
ACTIVE = {'queued', 'running', 'recovering', 'interrupted'}
TERMINAL = {'complete', 'failed', 'rolled-back', 'recovery-required'}


def get(runtime, path, cookie):
    return runtime.http('GET', path, cookie=cookie, timeout=25)[0]


def select_nightly(runtime, cookie):
    channel = get(runtime, CHANNEL, cookie)
    runtime.require(isinstance(channel, dict) and channel.get('current') in ('stable', 'nightly')
                    and isinstance(channel.get('revision'), str) and 0 < len(channel['revision']) <= 64,
                    'ota-channel-state-invalid')
    if channel['current'] == 'nightly':
        return
    runtime.http('PUT', HOST + '/channel', cookie=cookie, timeout=35,
                 body={'channel': 'nightly', 'revision': channel['revision'], 'acknowledgeNightly': True})
    runtime.require(get(runtime, CHANNEL, cookie).get('current') == 'nightly', 'ota-channel-write-unverified')


def review(runtime, cookie, source, target, *, supported=True):
    build = get(runtime, '/api/system/build', cookie)
    runtime.require(isinstance(build, dict) and build.get('version') == source[0]
                    and build.get('commit') == source[1] and build.get('imageDigest') == source[2]
                    and build.get('runtipiCompatibility') == source[3], 'ota-build-identity-invalid')
    shown = get(runtime, RELEASE + '?channel=nightly', cookie)
    tag = shown.get('tag') if isinstance(shown, dict) else None
    runtime.require(isinstance(tag, str) and TAG.fullmatch(tag), 'ota-no-published-target')
    if tag != target[0]:
        raise runtime.Refused('ota-discovery-skipped-required-release', shownRelease=tag)
    expected_url = f'https://github.com/twentylines/orbis/releases/download/{tag}/release-manifest.json'
    runtime.require(shown.get('imageManifestUrl') == expected_url, 'ota-unverified-discovery-manifest')
    response = get(runtime, HOST + '/release-compatibility?tag=' + quote(target[0], safe=''), cookie)
    runtime.require(isinstance(response, dict) and response.get('tag') == target[0]
                    and response.get('currentRuntipiVersion') == source[3] and response.get('targetRuntipiVersion') == target[3]
                    and response.get('crossesRuntipiBoundary') is (source[3] != target[3]), 'ota-review-identity-invalid')
    runtime.require(response.get('hostUpdateSupported') is supported, 'ota-displayed-release-support-mismatch')


def accept(runtime, cookie, source, target):
    plan, _ = runtime.http('POST', HOST + '/plan', body={'tag': target[0]}, cookie=cookie, timeout=60)
    valid_id = isinstance(plan, dict) and isinstance(plan.get('planId'), str)
    try:
        valid_id = valid_id and str(uuid.UUID(plan['planId'], version=4)) == plan['planId']
    except ValueError:
        valid_id = False
    runtime.require(valid_id and (plan.get('currentTag'), plan.get('targetTag'), plan.get('targetDigest'))
                    == (source[0], target[0], target[2]), 'ota-plan-target-invalid')
    if source[3] != target[3]:
        runtime.require(plan.get('backupPolicy') == 'automatic', 'ota-cross-base-checkpoint-missing')
    # A lost reply is never retried. The protected job must settle under this exact ID.
    accepted, _ = runtime.http('POST', HOST + '/apply', body={'planId': plan['planId']},
                               cookie=cookie, timeout=45, expect=(202,))
    runtime.require(isinstance(accepted, dict) and accepted.get('jobId') == plan['planId']
                    and accepted.get('state') in ACTIVE, 'ota-accepted-operation-invalid')
    return accepted['jobId']


def terminal(runtime, operation, source, target, *, seconds=1000):
    service = runtime.load('orbis-host-service')
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        job = service.read_private(runtime.STATE / 'job.json')
        if job is None or job.get('id') != operation:
            if job and job.get('state') in ACTIVE:
                raise runtime.Refused('ota-foreign-active-operation')
            time.sleep(0.3)
            continue
        refs = [tuple(job[name][key] for key in ('tag', 'commit', 'digest')) for name in ('current', 'target')]
        runtime.require(refs == [source[:3], target[:3]], 'ota-job-release-invalid')
        state = job.get('state')
        if state == 'complete':
            return
        if state in TERMINAL:
            raise runtime.Refused('ota-operation-failed', acceptedJobState=state)
        runtime.require(state in ACTIVE, 'ota-operation-state-invalid')
        time.sleep(0.3)
    raise runtime.Refused('ota-operation-terminal-not-observed')
