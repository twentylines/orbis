import type { SourceCertificate } from '@/modules/host-transfer/source-certificate';
import type { ClusterPairRequest } from './cluster-pairing-api';

export function certificateReadGate() {
  let generation = 0;
  return {
    begin: () => ++generation,
    invalidate: () => {
      generation++;
    },
    current: (token: number) => token === generation,
  };
}

type PairingAuthority = { sessionIdentity: object; userId: number; username: string; operator: boolean; hostId?: string; role?: string };
export function authorityRequestGate() {
  const gate = certificateReadGate();
  let previous: PairingAuthority | undefined;
  return {
    ...gate,
    bind: (next: PairingAuthority) => {
      const keys = ['sessionIdentity', 'userId', 'username', 'operator', 'hostId', 'role'] as const;
      if (!previous || keys.some((key) => !Object.is(previous?.[key], next[key]))) gate.invalidate();
      previous = { ...next };
    },
  };
}

export function requestScope(gate: ReturnType<typeof certificateReadGate>) {
  const token = gate.begin();
  const current = () => gate.current(token);
  const commit = (update: () => void) => {
    if (current()) update();
  };
  return {
    current,
    commit,
    accept: async <T>(response: Promise<T>, update: (value: T) => void) => {
      const value = await response;
      commit(() => update(value));
    },
  };
}
export type PairingRequestScope = ReturnType<typeof requestScope>;

export type PairingDraft = {
  url: string;
  code: string;
  name: string;
  password: string;
  totpCode: string;
  allowInsecureLan: boolean;
  certificateMode: 'system' | 'peer';
  certificate: SourceCertificate | null;
  confirmedCertificate: boolean;
};

export function pairingRequest(draft: PairingDraft): ClusterPairRequest {
  let address: URL;
  try {
    address = new URL(draft.url.trim());
  } catch {
    throw new Error('Enter a complete server address.');
  }
  if (address.username || address.password || address.pathname !== '/' || address.search || address.hash)
    throw new Error('Enter the server origin only, without a path, query or sign-in details.');
  if (address.protocol !== 'https:' && address.protocol !== 'http:')
    throw new Error('Use an HTTPS address, or explicitly allow HTTP on a trusted private LAN.');
  if (address.protocol === 'http:' && !draft.allowInsecureLan)
    throw new Error('HTTP is unencrypted. Confirm the private LAN warning before pairing.');
  if (draft.certificateMode === 'peer' && address.protocol !== 'https:') throw new Error('A peer certificate can only be used with HTTPS.');
  const certificate = draft.certificateMode === 'peer' ? draft.certificate : null;
  if (draft.certificateMode === 'peer' && !certificate) throw new Error('Choose the other server’s public certificate, or use normal HTTPS trust.');
  if (certificate && (!draft.confirmedCertificate || !/^[a-f0-9]{64}$/.test(certificate.sha256)))
    throw new Error('Compare the fingerprint on the other server, then confirm it before pairing.');
  const code = draft.code.trim().toUpperCase();
  if (!/^[A-F0-9]{24}$/.test(code)) throw new Error('Enter the 24-character pairing code from the other server.');
  if (!draft.password) throw new Error('Enter your account password to approve pairing.');
  if (draft.totpCode && !/^\d{6}$/.test(draft.totpCode)) throw new Error('Enter the six-digit authentication code.');
  return {
    url: address.origin,
    code,
    password: draft.password,
    ...(draft.totpCode ? { totpCode: draft.totpCode } : {}),
    ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
    ...(address.protocol === 'http:' && draft.allowInsecureLan ? { allowInsecureLan: true as const } : {}),
    ...(certificate ? { peerCertificatePem: certificate.pem, peerCertificateSha256: certificate.sha256, confirmPeerCertificate: true as const } : {}),
  };
}

export function pairingConnectionRequest(draft: PairingDraft): ClusterPairRequest {
  const request = pairingRequest(draft);
  if (!request.url.startsWith('https://') || request.allowInsecureLan) throw new Error('Use HTTPS for account pairing.');
  return request;
}
