import { expect, test } from 'bun:test';
import {
  approveTransferOffer,
  cancelTransfer,
  cancelTransferOffer,
  claimTransfer,
  createTransferOffer,
  readTransfers,
  sourceOrigin,
  startTransfer,
  transferEndpoint,
  TransferApiError,
  transferPollingInterval,
  type TransferJob,
  type TransferOffer,
} from './transfer-api';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const offer: TransferOffer = {
  id,
  backupId: id,
  sourceFingerprint: 'a'.repeat(64),
  destinationFingerprint: 'b'.repeat(64),
  status: 'awaiting-approval',
  expiresAt: Date.now() + 60_000,
  bytes: 1024,
  completedBytes: 0,
};
const job: TransferJob = {
  id,
  importId: id,
  sourceOrigin: 'https://source.example.test',
  sourceFingerprint: offer.sourceFingerprint,
  destinationFingerprint: 'b'.repeat(64),
  status: 'awaiting-source-approval',
  expiresAt: offer.expiresAt,
  completedBytes: 0,
  totalBytes: 1024,
  message: 'Waiting for source approval.',
  requiresReview: true,
};
const credentials = { password: 'disposable-ui-transfer-password', totpCode: '123456' };
async function withFetch(response: Response, run: (calls: { url: unknown; init?: RequestInit }[]) => Promise<void>) {
  const original = globalThis.fetch;
  const calls: { url: unknown; init?: RequestInit }[] = [];
  globalThis.fetch = Object.assign(
    async (url: unknown, init?: RequestInit) => {
      calls.push({ url, init });
      return response.clone();
    },
    { preconnect: original.preconnect },
  );
  try {
    await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

test('offer creation freshly authenticates using a fixed same-origin POST body and explicit export approval', async () => {
  await withFetch(Response.json({ ...offer, code: 'c'.repeat(64) }), async (calls) => {
    const result = await createTransferOffer(id, credentials);
    expect(result.code).toBe('c'.repeat(64));
    expect(calls[0]?.url).toBe('/api/system-backups/transfers/offers');
    expect(calls[0]?.init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ backupId: id, ...credentials, confirmExport: true });
  });
});
test('source approval binds the exact destination comparison value and rejects an unclaimed offer', async () => {
  await withFetch(Response.json(offer), async (calls) => {
    await approveTransferOffer(offer, credentials);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ ...credentials, destinationFingerprint: offer.destinationFingerprint });
    await expect(approveTransferOffer({ ...offer, destinationFingerprint: undefined }, credentials)).rejects.toThrow('Wait for a destination');
    expect(calls).toHaveLength(1);
  });
});
test('destination credentials and pairing code go only to the local transfer API', async () => {
  await withFetch(Response.json(job), async (calls) => {
    await claimTransfer('https://source.example.test/', 'c'.repeat(64), credentials);
    expect(calls[0]?.url).toBe('/api/system-backups/transfers/imports');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ sourceOrigin: job.sourceOrigin, code: 'c'.repeat(64), ...credentials });
    expect(String(calls[0]?.url)).not.toContain(credentials.password);
    expect(String(calls[0]?.url)).not.toContain('source.example.test');
  });
});
test('starting requires the selected source fingerprint and never sends the encryption passphrase', async () => {
  await withFetch(Response.json(job), async (calls) => {
    await startTransfer(job);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ sourceFingerprint: job.sourceFingerprint });
    expect(calls[0]?.url).toBe(`/api/system-backups/transfers/imports/${id}/start`);
    expect(String(calls[0]?.init?.body)).not.toContain('passphrase');
  });
});
test('cancellation uses explicit local actions with no URL credentials or remote destination', async () => {
  await withFetch(Response.json({ ...job, status: 'cancelled' }), async (calls) => {
    await cancelTransfer(id);
    expect(calls[0]?.url).toBe(`/api/system-backups/transfers/imports/${id}/cancel`);
    expect(calls[0]?.init?.body).toBe('{}');
  });
  await withFetch(Response.json({ ...offer, status: 'cancelled' }), async (calls) => {
    await cancelTransferOffer(id);
    expect(calls[0]?.url).toBe(`/api/system-backups/transfers/offers/${id}/cancel`);
  });
});
test('arbitrary, peer and malformed endpoint paths are refused before fetch', () => {
  for (const path of [
    'https://other.example',
    '//other.example',
    '/peer/claim',
    '/offers/../../settings',
    `/offers/${id}/start`,
    `/imports/${id}/approve`,
    `/imports/${id}/start?code=value`,
  ])
    expect(() => transferEndpoint(path)).toThrow('Invalid transfer action');
});
test('source addresses reject insecure schemes and URL credential or path data', () => {
  for (const value of [
    'http://192.168.1.1',
    'https://user:password@192.168.1.1',
    'https://192.168.1.1/path',
    'https://192.168.1.1/?code=value',
    'https://192.168.1.1/#value',
    'file:///tmp/file',
  ])
    expect(() => sourceOrigin(value)).toThrow();
  expect(sourceOrigin(' https://source.example.test:8443/ ')).toBe('https://source.example.test:8443');
});
test('runtime list validation refuses leaked code/token fields and invalid progress or review status', async () => {
  for (const snapshot of [
    { offers: [{ ...offer, code: 'c'.repeat(64) }], jobs: [] },
    { offers: [], jobs: [{ ...job, claimToken: 'c'.repeat(64) }] },
    { offers: [], jobs: [{ ...job, completedBytes: -1 }] },
    { offers: [], jobs: [{ ...job, requiresReview: false }] },
    { offers: [], jobs: [{ ...job, status: 'restored' }] },
    { offers: Array.from({ length: 17 }, () => offer), jobs: [] },
  ])
    await withFetch(Response.json(snapshot), async () => {
      await expect(readTransfers()).rejects.toThrow('could not be verified');
    });
});
test('server error values never become UI copy and trusted ingress failures are actionable', async () => {
  for (const status of [400, 401, 403, 404, 409, 429, 503])
    await withFetch(Response.json({ message: 'private-upstream-value' }, { status }), async () => {
      try {
        await readTransfers();
        throw new Error('Expected transfer failure');
      } catch (error) {
        expect(error).toBeInstanceOf(TransferApiError);
        expect((error as Error).message).not.toContain('private-upstream');
        if (status === 403) expect((error as Error).message).toContain('Orbis HTTPS proxy');
        if (status === 503) {
          expect((error as Error).message).toContain('HTTPS hostname');
          expect((error as Error).message).toContain('certificate');
        }
      }
    });
});
test('HTML responses and invalid transfer codes are rejected without echoing them', async () => {
  await withFetch(new Response('<html>private-upstream</html>'), async () => {
    await expect(readTransfers()).rejects.toThrow('could not be read');
  });
  await withFetch(Response.json(job), async (calls) => {
    await expect(claimTransfer(job.sourceOrigin, 'short', credentials)).rejects.toThrow('64-character');
    expect(calls).toHaveLength(0);
  });
});
test('only visible unfinished transfers poll frequently', () => {
  expect(transferPollingInterval({ offers: [offer], jobs: [] }, true)).toBe(1500);
  expect(transferPollingInterval({ offers: [], jobs: [job] }, true)).toBe(1500);
  expect(transferPollingInterval({ offers: [], jobs: [{ ...job, status: 'complete' }] }, true)).toBe(15_000);
  expect(transferPollingInterval({ offers: [offer], jobs: [job] }, false)).toBe(false);
});

test('local certificate trust is explicit, job-local and goes only to the fixed import endpoint', async () => {
  const certificate = { pem: '-----BEGIN CERTIFICATE-----\nMAIBAA==\n-----END CERTIFICATE-----\n', sha256: 'd'.repeat(64), confirmed: false };
  await withFetch(Response.json(job), async (calls) => {
    await expect(claimTransfer(job.sourceOrigin, 'c'.repeat(64), credentials, undefined, certificate)).rejects.toThrow('Compare the certificate');
    expect(calls).toHaveLength(0);
    await claimTransfer(job.sourceOrigin, 'c'.repeat(64), credentials, undefined, { ...certificate, confirmed: true });
    expect(calls[0]?.url).toBe('/api/system-backups/transfers/imports');
    expect(calls[0]?.init).toMatchObject({ credentials: 'same-origin', redirect: 'error' });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      sourceOrigin: job.sourceOrigin,
      code: 'c'.repeat(64),
      ...credentials,
      sourceCertificatePem: certificate.pem,
      sourceCertificateSha256: certificate.sha256,
      confirmSourceCertificate: true,
    });
    const status = await readTransfers().catch(() => null);
    expect(status).toBeNull();
    expect(calls[1]?.init?.body).toBeUndefined();
  });
});
