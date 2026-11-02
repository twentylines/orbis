#!/usr/bin/env python3
"""Validate root-bound, mutation-held candidate bootstrap and broker observations."""
import ipaddress

QUEUES = ['app-events-queue', 'repo-queue', 'system-events-queue']
LEASE_MS = 900000
SAFE_INTEGER = 2 ** 53 - 1


def fail():
    return ValueError('Normal bootstrap requires protected candidate and broker recovery')


def exact(value, keys):
    return isinstance(value, dict) and set(value) == set(keys)


def integer(value, lower=0, upper=SAFE_INTEGER):
    return type(value) is int and lower <= value <= upper


def queues(value, consumers):
    if not isinstance(value, list) or len(value) != len(QUEUES):
        raise fail()
    result = []
    for item in value:
        if (not exact(item, {'name', 'messages_ready', 'messages_unacknowledged', 'consumers'})
                or item['name'] not in QUEUES or type(item['consumers']) is not int or item['consumers'] != consumers
                or type(item['messages_ready']) is not int or item['messages_ready'] != 0
                or type(item['messages_unacknowledged']) is not int or item['messages_unacknowledged'] != 0):
            raise fail()
        result.append({'name': item['name'], 'messagesReady': 0, 'messagesUnacknowledged': 0, 'consumers': consumers})
    if len({item['name'] for item in result}) != len(QUEUES):
        raise fail()
    return sorted(result, key=lambda item: QUEUES.index(item['name']))


def peer_address(value):
    if not isinstance(value, str): raise fail()
    try:
        address = ipaddress.ip_address(value)
    except ValueError as error:
        raise fail() from error
    return str(address.ipv4_mapped or address) if isinstance(address, ipaddress.IPv6Address) else str(address)


def consumers(value, channels, connections, peer_addresses):
    if (not isinstance(value, list) or len(value) != 3 or not isinstance(channels, list) or len(channels) > 256
            or not isinstance(connections, list) or len(connections) > 64 or not peer_addresses):
        raise fail()
    addresses = {peer_address(value) for value in peer_addresses}
    connected = {}
    for item in connections:
        if (not exact(item, {'pid', 'peer_host', 'vhost', 'state'}) or not isinstance(item['pid'], str)
                or not 1 <= len(item['pid']) <= 256 or item['pid'] in connected or item['vhost'] != '/'
                or item['state'] != 'running' or peer_address(item['peer_host']) not in addresses):
            raise fail()
        connected[item['pid']] = item
    available = {}
    for item in channels:
        if (not exact(item, {'pid', 'connection', 'vhost', 'consumer_count', 'messages_unacknowledged'})
                or not isinstance(item['pid'], str) or not 1 <= len(item['pid']) <= 256 or item['pid'] in available
                or item['connection'] not in connected or item['vhost'] != '/' or not integer(item['consumer_count'], 0, 3)
                or type(item['messages_unacknowledged']) is not int or item['messages_unacknowledged'] != 0):
            raise fail()
        available[item['pid']] = item
    used, names, tags = {}, set(), set()
    for item in value:
        required = {'queue_name', 'channel_pid', 'consumer_tag', 'ack_required', 'prefetch_count', 'arguments'}
        if (not isinstance(item, dict) or not required <= set(item) or set(item) - required - {'active'}
                or item['queue_name'] not in QUEUES or item['queue_name'] in names
                or item['channel_pid'] not in available or item['ack_required'] is not True
                or not integer(item['prefetch_count'], 1, 65535) or not isinstance(item['consumer_tag'], str)
                or not 1 <= len(item['consumer_tag']) <= 256 or item['consumer_tag'] in tags
                or item.get('active', True) is not True or item['arguments'] not in ({}, [])):
            raise fail()
        names.add(item['queue_name']); tags.add(item['consumer_tag'])
        used[item['channel_pid']] = used.get(item['channel_pid'], 0) + 1
    if names != set(QUEUES) or any(item['consumer_count'] != used.get(pid, 0) for pid, item in available.items()):
        raise fail()


def receipt(value, record, proof, lease, now):
    keys = {'version', 'transactionId', 'pointId', 'terminalProofSha256', 'operationSha256', 'candidateId',
            'bootstrapLeaseId', 'queueGeneration', 'queues', 'readyAt'}
    expected = {'version': 1, 'transactionId': record['id'], 'pointId': record['pointId'],
                'terminalProofSha256': proof['proofSha256'], 'operationSha256': proof['operationSha256'],
                'candidateId': record['candidateId'], 'bootstrapLeaseId': lease['id']}
    if (not exact(value, keys) or type(value['version']) is not int or any(value[key] != child for key, child in expected.items())
            or not integer(value['queueGeneration'], 1) or not integer(value['readyAt'])
            or not lease['startedAt'] <= value['readyAt'] <= now < lease['expiresAt']
            or value['queues'] != [{'name': name, 'messagesReady': 0, 'consumers': 1} for name in QUEUES]
            or any(type(item['messagesReady']) is not int or type(item['consumers']) is not int for item in value['queues'])):
        raise fail()
    return value
