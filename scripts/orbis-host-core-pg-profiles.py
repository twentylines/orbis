"""Closed PostgreSQL execution recipes; metadata selection grants no restore authority."""
from types import MappingProxyType


PG17_ARM64_IMAGE = 'sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24'
PG14_AMD64_IMAGE = 'sha256:d462928b1898dd74b749ef486797968828c1e7fc9befb5e5ca03a33bfbc32d64'
TOOLS = frozenset({'postgres', 'initdb', 'createdb', 'psql', 'pg_controldata', 'pg_dump', 'pg_restore'})
BASE_FIELDS = frozenset({'profileId', 'imageId', 'os', 'architecture', 'major', 'uid', 'gid'})
_PROFILES = MappingProxyType({
    'pg17-alpine-arm64.v1': MappingProxyType({
        'imageId': PG17_ARM64_IMAGE, 'os': 'linux', 'architecture': 'arm64', 'major': 17, 'uid': 70, 'gid': 70,
        'bin': '/usr/local/bin', 'locales': frozenset({'C', 'POSIX', 'C.UTF-8', 'C.utf8', 'en_US.utf8', 'en_US.UTF-8'}),
    }),
    'pg14-debian-amd64.v1': MappingProxyType({
        'imageId': PG14_AMD64_IMAGE, 'os': 'linux', 'architecture': 'amd64', 'major': 14, 'uid': 999, 'gid': 999,
        'bin': '/usr/lib/postgresql/14/bin', 'locales': frozenset({'C', 'C.utf8', 'en_US.utf8', 'POSIX'}),
    }),
})


class ProfileError(ValueError):
    pass


def fail():
    return ProfileError('No bounded PostgreSQL execution recipe matches the exact image and platform')


def execution_image_profile(image):
    if (not isinstance(image, dict) or not isinstance(image.get('Config'), dict) or image['Config'].get('Volumes') != {'/var/lib/postgresql/data': {}}):
        raise fail()
    for identifier, recipe in _PROFILES.items():
        if (image.get('Id') == recipe['imageId'] and image.get('Os') == recipe['os']
                and image.get('Architecture') == recipe['architecture']):
            return {'profileId': identifier, **{key: recipe[key] for key in BASE_FIELDS - {'profileId'}}}
    raise fail()


def _recipe(profile):
    if not isinstance(profile, dict) or not isinstance(profile.get('profileId'), str):
        raise fail()
    recipe = _PROFILES.get(profile['profileId'])
    if recipe is None:
        raise fail()
    expected = {'profileId': profile['profileId'], **{key: recipe[key] for key in BASE_FIELDS - {'profileId'}}}
    if (any(key not in profile or type(profile[key]) is not type(value) or profile[key] != value
            for key, value in expected.items())):
        raise fail()
    return recipe


def image_for_profile(profile):
    recipe = _recipe(profile)
    return {'Id': recipe['imageId'], 'Os': recipe['os'], 'Architecture': recipe['architecture'],
            'Config': {'Volumes': {'/var/lib/postgresql/data': {}}}}


def binary_for(profile, tool):
    recipe = _recipe(profile)
    if not isinstance(tool, str) or tool not in TOOLS:
        raise fail()
    return recipe['bin'] + '/' + tool


def locales_for(profile):
    return _recipe(profile)['locales']
