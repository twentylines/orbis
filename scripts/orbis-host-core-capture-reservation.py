"""Strict saved-point reservation descriptor for unexposed core admission."""
import copy
import hashlib
import json
import re


UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}')
SAFE_INTEGER = 9007199254740991
LIMIT = 32768
FIELDS = {'version', 'id', 'ownerId', 'createdAt', 'envelope'}
POINT_FIELDS = FIELDS | {'kind', 'coreFormat', 'core', 'status', 'backupJobId', 'issue',
                         'archiveBytes', 'archiveSha256', 'metadataSha256'}

# Only the validated UUID is an argument; the pathname and reader program are
# fixed by root. The source bytes never come from the admission request.
POINT_READER = r"""
const fs=require('node:fs');
const id=process.argv[1];
if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id))throw Error('id');
const dirs=['/data','/data/backups','/data/backups/time-machine','/data/backups/time-machine/points'];
dirs.push(dirs.at(-1)+'/'+id);
const target=dirs.at(-1)+'/point.json';
const keys=['dev','ino','uid','gid','mode'];
const sealKeys=[...keys,'nlink','size','mtimeNs','ctimeNs'];
const seal=(s,k)=>k.map(n=>String(s[n])).join(':');
const directory=p=>{const s=fs.lstatSync(p,{bigint:true});
 if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0n||(s.mode&0o022n)!==0n||fs.realpathSync(p)!==p)throw Error('directory');
 return s;};
const before=dirs.map(directory);
if((before.at(-1).mode&0o077n)!==0n)throw Error('private');
const fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
try{
 const s=fs.fstatSync(fd,{bigint:true});
 if(!s.isFile()||s.uid!==0n||s.nlink!==1n||(s.mode&0o777n)!==0o600n||s.size<1n||s.size>32768n)throw Error('file');
 const b=Buffer.alloc(Number(s.size)+1);let count=0;
 while(count<b.length){const n=fs.readSync(fd,b,count,b.length-count,null);if(!n)break;count+=n;}
 if(BigInt(count)!==s.size||seal(s,sealKeys)!==seal(fs.fstatSync(fd,{bigint:true}),sealKeys)||
    seal(s,sealKeys)!==seal(fs.lstatSync(target,{bigint:true}),sealKeys))throw Error('changed');
 dirs.forEach((p,i)=>{if(seal(before[i],keys)!==seal(directory(p),keys))throw Error('changed');});
 process.stdout.write(b.subarray(0,count));
}finally{fs.closeSync(fd);}
"""


class ReservationError(ValueError):
    pass


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def sha256(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def identifier(value):
    if not isinstance(value, str) or not UUID.fullmatch(value):
        raise ReservationError('A canonical point UUID is required')
    return value


def validate_reservation(value, point):
    identifier(point)
    if (not isinstance(value, dict) or set(value) != FIELDS or type(value['version']) is not int
            or value['version'] != 3 or value['id'] != point
            or any(type(value[key]) is not int or not 1 <= value[key] <= SAFE_INTEGER
                   for key in ('ownerId', 'createdAt'))):
        raise ReservationError('Invalid saved-point reservation')
    envelope = value['envelope']
    if (not isinstance(envelope, dict) or set(envelope) != {'version', 'keyId', 'nonce', 'tag', 'value'}
            or type(envelope['version']) is not int or envelope['version'] != 1
            or any(not isinstance(envelope[key], str) or not re.fullmatch('[a-f0-9]{' + str(length) + '}', envelope[key])
                   for key, length in (('keyId', 64), ('nonce', 24), ('tag', 32), ('value', 86)))):
        raise ReservationError('Invalid saved-point key envelope')
    return copy.deepcopy(value)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ReservationError('Duplicate saved-point field')
        result[key] = value
    return result


def invalid_number(_):
    raise ReservationError('Invalid saved-point number')


def reservation(body, point):
    identifier(point)
    if not isinstance(body, bytes) or not 1 <= len(body) <= LIMIT:
        raise ReservationError('Invalid saved-point reservation size')
    try:
        value = json.loads(body.decode('utf-8'), object_pairs_hook=unique_object,
                           parse_constant=invalid_number)
    except (UnicodeError, json.JSONDecodeError, RecursionError) as error:
        raise ReservationError('Invalid saved-point reservation JSON') from error
    if (not isinstance(value, dict) or set(value) not in (POINT_FIELDS, POINT_FIELDS | {'assetBytes'})
            or value['kind'] != 'orbis-core' or value['coreFormat'] != 'orbis.time-machine-core.v1'
            or value['status'] != 'capturing' or value['core'] is not None
            or any(value[key] is not None for key in ('backupJobId', 'issue', 'archiveSha256', 'metadataSha256'))
            or type(value['archiveBytes']) is not int or value['archiveBytes'] != 0
            or ('assetBytes' in value and (type(value['assetBytes']) is not int or value['assetBytes'] != 0))):
        raise ReservationError('The saved point is not an empty core reservation')
    return validate_reservation({key: value[key] for key in FIELDS}, point)
