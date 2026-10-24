import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/server';

export function passkeyAuthenticator() {
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = key.publicKey.export({ format: 'jwk' });
  const id = randomBytes(32);
  const credentialId = id.toString('base64url');
  const cose = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x ?? '', 'base64url')],
      [-3, Buffer.from(jwk.y ?? '', 'base64url')],
    ]),
  );
  const hash = (value: string | Buffer) => createHash('sha256').update(value).digest();
  const client = (type: string, challenge: string, origin: string) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  function register(challenge: string, origin = 'https://orbis.example.test', rpID = 'orbis.example.test', uv = true): RegistrationResponseJSON {
    const size = Buffer.alloc(2);
    size.writeUInt16BE(id.length);
    const authData = Buffer.concat([hash(rpID), Buffer.from([uv ? 0x45 : 0x41]), Buffer.alloc(4), Buffer.alloc(16), size, id, cose]);
    const attestation = isoCBOR.encode(
      new Map<string, unknown>([
        ['fmt', 'none'],
        ['authData', authData],
        ['attStmt', new Map()],
      ]) as never,
    );
    return {
      id: credentialId,
      rawId: credentialId,
      type: 'public-key',
      clientExtensionResults: { credProps: { rk: true } },
      response: {
        clientDataJSON: client('webauthn.create', challenge, origin).toString('base64url'),
        attestationObject: Buffer.from(attestation).toString('base64url'),
        transports: ['internal'],
      },
    };
  }
  function authenticate(
    challenge: string,
    userHandle: string,
    counter = 1,
    origin = 'https://orbis.example.test',
    rpID = 'orbis.example.test',
    uv = true,
  ): AuthenticationResponseJSON {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(counter);
    const authData = Buffer.concat([hash(rpID), Buffer.from([uv ? 5 : 1]), count]);
    const clientData = client('webauthn.get', challenge, origin);
    const signature = sign('sha256', Buffer.concat([authData, hash(clientData)]), key.privateKey);
    return {
      id: credentialId,
      rawId: credentialId,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientData.toString('base64url'),
        authenticatorData: authData.toString('base64url'),
        signature: signature.toString('base64url'),
        userHandle,
      },
    };
  }
  return { id: credentialId, register, authenticate };
}
