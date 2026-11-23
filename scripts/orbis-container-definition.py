"""Canonical Docker mount observations for identity comparisons.

Mount order in an inspect response has no configuration meaning. Every mount
field remains part of the comparison. This module performs no host operations.
"""
import copy
import posixpath


def mounts(value):
    if type(value) is not list or len(value) > 4096:
        raise ValueError('Container mounts could not be verified')
    destinations = set()
    for item in value:
        destination = item.get('Destination') if type(item) is dict else None
        if (type(destination) is not str or not destination.startswith('/') or destination.startswith('//')
                or posixpath.normpath(destination) != destination or '\\' in destination
                or any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in destination)
                or len(destination.encode('utf-8', errors='strict')) > 4096
                or destination in destinations):
            raise ValueError('Container mounts could not be verified')
        destinations.add(destination)
    return sorted(copy.deepcopy(value), key=lambda item: item['Destination'])


def normalize(value):
    if type(value) is not dict or 'Mounts' not in value:
        raise ValueError('Container definition could not be verified')
    result = copy.deepcopy(value)
    result['Mounts'] = mounts(value['Mounts'])
    return result
