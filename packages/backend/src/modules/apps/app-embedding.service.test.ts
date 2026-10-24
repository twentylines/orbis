import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import type { RequestOptions as HttpsRequestOptions } from 'node:https';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { createMockApp, createMockAppInfo } from '@/tests/helpers/app-mocks';
import { fromPartial } from '@total-typescript/shoehorn';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AppFilesManager } from './app-files-manager';
import { AppEmbeddingService, embeddingHeaders, embeddingPolicy, embeddingUrl, safeEmbeddingAddress } from './app-embedding.service';
import { AppsRepository } from './apps.repository';

const network = vi.hoisted(() => ({ lookup: vi.fn(), http: vi.fn(), https: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: network.lookup }));
vi.mock('node:http', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('node:http');
  return { ...actual, default: { ...actual, request: network.http } };
});
vi.mock('node:https', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('node:https');
  return { ...actual, default: { ...actual, request: network.https } };
});

const urn = createAppUrn('beszel', 'store');
const parent = new URL('http://10.0.0.2:80');
const target = new URL('http://10.0.0.2:8090/');
let rawHeaders: string[];
let statusCode: number;
let autoReply: boolean;
let replies: Array<() => void>;
let destroyed: ReturnType<typeof vi.fn<() => void>>;
let requestDestroyed: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  vi.clearAllMocks();
  network.lookup.mockResolvedValue([{ address: '10.0.0.2', family: 4 }]);
  rawHeaders = [];
  statusCode = 200;
  autoReply = true;
  replies = [];
  destroyed = vi.fn();
  requestDestroyed = vi.fn();
  const send = (_options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    const emitter = new EventEmitter();
    const request = Object.assign(emitter, {
      end: vi.fn(() => {
        const reply = () => {
          callback(
            fromPartial<IncomingMessage>({
              statusCode,
              rawHeaders,
              destroy: () => {
                destroyed();
                emitter.emit('close');
                return fromPartial<IncomingMessage>({});
              },
            }),
          );
        };
        if (autoReply) queueMicrotask(reply);
        else replies.push(reply);
      }),
      destroy: (error: Error) => {
        requestDestroyed();
        emitter.emit('error', error);
        emitter.emit('close');
      },
    });
    return request as unknown as ClientRequest;
  };
  network.http.mockImplementation(send);
  network.https.mockImplementation(send);
});
afterEach(() => vi.useRealTimers());

describe('embedding policy observations', () => {
  const policy = (policies: string[] = [], frameOptions: string[] = [], code = 200, origin = parent) =>
    embeddingPolicy({ policies, frameOptions, statusCode: code }, origin, target);

  it('identifies explicit cross-origin XFO denial without claiming other responses work', () => {
    expect(policy([], ['deny'])).toEqual({ status: 'blocked', reason: 'x-frame-options-deny' });
    expect(policy([], ['SAMEORIGIN'])).toEqual({ status: 'blocked', reason: 'x-frame-options-sameorigin' });
    expect(policy([], ['SAMEORIGIN'], 200, target).status).toBe('not-blocked-by-headers');
    expect(policy().status).toBe('not-blocked-by-headers');
    expect(policy([], ['ALLOW-FROM http://10.0.0.2']).status).toBe('unknown');
    expect(policy([], ['SAMEORIGIN', 'DENY']).status).toBe('unknown');
    expect(policy([], ['SAMEORIGIN, SAMEORIGIN']).status).toBe('unknown');
  });

  it('honors enforced frame-ancestors over XFO and intersects multiple policies', () => {
    expect(policy(['frame-ancestors *'], ['DENY']).status).toBe('not-blocked-by-headers');
    expect(policy(["frame-ancestors 'none'"]).status).toBe('blocked');
    expect(policy(["frame-ancestors 'self'"]).status).toBe('blocked');
    expect(policy(['frame-ancestors http://10.0.0.2', "frame-ancestors 'self'"]).status).toBe('blocked');
    expect(policy(["frame-ancestors *, frame-ancestors 'none'"]).status).toBe('blocked');
    expect(policy(["default-src 'none'; frame-src 'none'"]).status).toBe('not-blocked-by-headers');
    expect(policy(["frame-ancestors *; frame-ancestors 'none'"]).status).toBe('not-blocked-by-headers');
  });

  it('matches schemes, default ports, explicit ports and subdomains conservatively', () => {
    const origin = new URL('https://orbis.example.com:8443');
    expect(policy(['frame-ancestors https://*.example.com:*'], [], 200, origin).status).toBe('not-blocked-by-headers');
    expect(policy(['frame-ancestors https://*.example.com'], [], 200, origin).status).toBe('blocked');
    expect(policy(['frame-ancestors https://orbis.example.com:8443'], [], 200, origin).status).toBe('not-blocked-by-headers');
    expect(policy(['frame-ancestors https:'], [], 200, origin).status).toBe('not-blocked-by-headers');
    expect(policy(['frame-ancestors https://*.example.com'], [], 200, new URL('https://example.com')).status).toBe('blocked');
    expect(policy(['frame-ancestors http://orbis.example.com:80'], [], 200, new URL('https://orbis.example.com')).status).toBe('unknown');
  });

  it('keeps unsupported syntax and non-document responses unknown', () => {
    expect(policy(['frame-ancestors https://orbis.example.com/path']).status).toBe('unknown');
    expect(policy(['frame-ancestors https://orbis.example.com/path *']).status).toBe('not-blocked-by-headers');
    expect(policy(['frame-ancestors invalid:value'], ['DENY']).status).toBe('unknown');
    expect(policy(['frame-ancestors http://10.0.0.2']).status).toBe('unknown');
    expect(policy(['frame-ancestors http://*']).status).toBe('unknown');
    expect(policy([], ['DENY'], 302).reason).toBe('redirect');
    for (const code of [401, 403, 405, 501, 204, 500]) expect(policy([], ['DENY'], code).status).toBe('unknown');
  });
});

describe('embedding transport security', () => {
  it.each([
    '127.0.0.1',
    '0.0.0.0',
    '169.254.169.254',
    '100.100.100.200',
    '224.0.0.1',
    '255.255.255.255',
    '192.0.2.5',
    '198.18.0.1',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    'fe80::1',
    'ff02::1',
    'fd00:ec2::254',
    'fd20:ce::254',
    '2001:db8::1',
    '2001::1',
    '2002:7f00:1::',
  ])('rejects unsafe address %s', (address) => {
    expect(safeEmbeddingAddress(address)).toBe(false);
  });

  it.each(['10.0.0.2', '172.18.0.3', '192.168.1.2', '100.64.1.2', '93.184.216.34', 'fd12:3456::1', '2606:4700::1111'])(
    'permits authorized LAN/VPN or public address %s',
    (address) => {
      expect(safeEmbeddingAddress(address)).toBe(true);
    },
  );

  it('pins one validated DNS result while preserving the destination hostname and TLS verification', async () => {
    await embeddingHeaders(new URL('https://beszel.example.com/ui?lang=en'));
    expect(network.lookup).toHaveBeenCalledOnce();
    expect(network.lookup).toHaveBeenCalledWith('beszel.example.com', { all: true });
    expect(network.http).not.toHaveBeenCalled();
    const options = network.https.mock.calls[0]?.[0] as HttpsRequestOptions;
    expect(options).toMatchObject({
      hostname: 'beszel.example.com',
      port: 443,
      path: '/ui?lang=en',
      method: 'HEAD',
      maxHeaderSize: 16384,
      agent: false,
    });
    expect(options.rejectUnauthorized).not.toBe(false);
    expect(options.headers).toEqual({ Accept: 'text/html', 'User-Agent': 'Orbis embedding compatibility', Connection: 'close' });
    const callback = vi.fn();
    const pin = options.lookup as (
      hostname: string,
      options: object,
      callback: (error: Error | null, address: string, family: number) => void,
    ) => void;
    pin('beszel.example.com', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '10.0.0.2', 4);
    expect(destroyed).toHaveBeenCalledOnce();
  });

  it('refuses every mixed DNS answer before connecting', async () => {
    network.lookup.mockResolvedValue([
      { address: '10.0.0.2', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]);
    await expect(embeddingHeaders(new URL('https://beszel.example.com'))).rejects.toThrow('Unsafe');
    expect(network.https).not.toHaveBeenCalled();
    await expect(embeddingHeaders(new URL('http://[::ffff:127.0.0.1]'))).rejects.toThrow('Unsafe');
    expect(network.http).not.toHaveBeenCalled();
  });

  it('does not follow redirects, read a response body or substitute GET for HEAD', async () => {
    rawHeaders = [
      'Location',
      'http://169.254.169.254/latest',
      'Content-Security-Policy-Report-Only',
      "frame-ancestors 'none'",
      'X-Frame-Options',
      'DENY',
    ];
    statusCode = 302;
    const observed = await embeddingHeaders(target);
    expect(observed).toEqual({ statusCode: 302, policies: [], frameOptions: ['DENY'] });
    expect(embeddingPolicy(observed, parent, target).status).toBe('unknown');
    expect(network.http).toHaveBeenCalledOnce();
    expect(destroyed).toHaveBeenCalledOnce();
    expect(network.lookup).not.toHaveBeenCalled();
    statusCode = 405;
    expect(embeddingPolicy(await embeddingHeaders(target), parent, target).reason).toBe('head-unsupported');
    expect(network.http).toHaveBeenCalledTimes(2);
  });

  it('bounds DNS and socket time even if neither endpoint replies', async () => {
    vi.useFakeTimers();
    network.lookup.mockImplementation(() => new Promise(() => {}));
    const dns = expect(embeddingHeaders(new URL('https://beszel.example.com'))).rejects.toThrow('DNS timeout');
    await vi.advanceTimersByTimeAsync(6000);
    await dns;
    expect(network.https).not.toHaveBeenCalled();
    autoReply = false;
    const socket = expect(embeddingHeaders(target)).rejects.toThrow('Request timeout');
    await vi.advanceTimersByTimeAsync(6000);
    await socket;
    expect(requestDestroyed).toHaveBeenCalledOnce();
  });
});

describe('installed app authorization and bounded caching', () => {
  const repository = mock<AppsRepository>();
  const files = mock<AppFilesManager>();
  const configuration = mock<ConfigurationService>();
  let service: AppEmbeddingService;
  beforeEach(() => {
    repository.getAppByUrn.mockReset().mockResolvedValue(createMockApp({ appName: 'beszel', appStoreSlug: 'store', port: 8090 }));
    files.getInstalledAppInfo.mockReset().mockResolvedValue(createMockAppInfo({ port: 8090 }));
    configuration.getConfig.mockReturnValue(
      fromPartial({ internalIp: '10.0.0.2', userSettings: { domain: 'orbis.example.com', localDomain: 'local.example.com', sslPort: 443 } }),
    );
    service = new AppEmbeddingService(repository, files, configuration);
  });

  it('checks actual installed running GUI membership before every cached response', async () => {
    rawHeaders = ['X-Frame-Options', 'SAMEORIGIN'];
    expect((await service.check(urn, target, parent)).status).toBe('blocked');
    expect((await service.check(urn, target, parent)).status).toBe('blocked');
    expect(repository.getAppByUrn).toHaveBeenCalledTimes(2);
    expect(files.getInstalledAppInfo).toHaveBeenCalledTimes(2);
    expect(network.http).toHaveBeenCalledOnce();
    repository.getAppByUrn.mockResolvedValue(undefined);
    await expect(service.check(urn, target, parent)).rejects.toThrow('running installed');
    repository.getAppByUrn.mockResolvedValue(createMockApp({ status: 'stopped' }));
    await expect(service.check(urn, target, parent)).rejects.toThrow('running installed');
    repository.getAppByUrn.mockResolvedValue(createMockApp({ port: 8090 }));
    files.getInstalledAppInfo.mockResolvedValue(createMockAppInfo({ no_gui: true }));
    await expect(service.check(urn, target, parent)).rejects.toThrow('no launch');
    expect(network.http).toHaveBeenCalledOnce();
  });

  it('requires the exact managed destination, including scheme, port and suffix', async () => {
    for (const url of [
      'http://10.0.0.2:8080/',
      'http://other.example.com:8090/',
      'https://10.0.0.2:8090/',
      'http://10.0.0.2:8090/admin',
      'http://169.254.169.254/',
    ]) {
      expect((await service.check(urn, new URL(url), parent)).reason).toBe('unverified-destination');
    }
    expect(network.http).not.toHaveBeenCalled();
    expect(network.lookup).not.toHaveBeenCalled();
    files.getInstalledAppInfo.mockResolvedValue(createMockAppInfo({ port: 8090, url_suffix: '/ui?lang=en' }));
    expect((await service.check(urn, target, parent)).reason).toBe('unverified-destination');
    expect((await service.check(urn, new URL('http://10.0.0.2:8090/ui?lang=en'), parent)).status).toBe('not-blocked-by-headers');
  });

  it('derives local/exposed/configured aliases from installed settings and rechecks changes', async () => {
    repository.getAppByUrn.mockResolvedValue(
      createMockApp({ openPort: false, exposed: true, domain: 'beszel.example.com', exposedLocal: true, localSubdomain: 'beszel', port: 8090 }),
    );
    expect((await service.check(urn, new URL('https://beszel.example.com/'), parent)).status).toBe('not-blocked-by-headers');
    expect((await service.check(urn, new URL('https://beszel.local.example.com/'), parent)).status).toBe('not-blocked-by-headers');
    expect((await service.check(urn, target, parent)).reason).toBe('unverified-destination');
    repository.getAppByUrn.mockResolvedValue(createMockApp({ openPort: true, port: 8090 }));
    expect((await service.check(urn, new URL('http://orbis.example.com:8090/'), parent)).status).toBe('not-blocked-by-headers');
    expect((await service.check(urn, new URL('https://beszel.example.com/'), parent)).reason).toBe('unverified-destination');
    expect(network.https).toHaveBeenCalledTimes(2);
  });

  it('refuses mixed content and same-origin embedding without a network probe', async () => {
    expect((await service.check(urn, target, new URL('https://orbis.example.com'))).reason).toBe('mixed-content');
    expect((await service.check(urn, target, target)).reason).toBe('same-origin');
    expect(network.http).not.toHaveBeenCalled();
  });

  it('coalesces checks, expires results at 30 seconds and binds cache to parent origin', async () => {
    vi.useFakeTimers();
    const first = await Promise.all([service.check(urn, target, parent), service.check(urn, target, parent)]);
    expect(network.http).toHaveBeenCalledOnce();
    expect(first[0]).toEqual(first[1]);
    expect((first[0]?.expiresAt ?? 0) - (first[0]?.checkedAt ?? 0)).toBe(30000);
    await service.check(urn, target, new URL('http://different.example.com'));
    expect(network.http).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30000);
    await service.check(urn, target, parent);
    expect(network.http).toHaveBeenCalledTimes(3);
  });

  it('bounds distinct in-flight probes and never queues arbitrary targets', async () => {
    autoReply = false;
    const checks = Array.from({ length: 4 }, (_, index) => service.check(urn, target, new URL(`http://parent${index}.example.com`)));
    await vi.waitFor(() => expect(network.http).toHaveBeenCalledTimes(4));
    expect((await service.check(urn, target, parent)).reason).toBe('busy');
    for (const reply of replies) reply();
    await Promise.all(checks);
    expect(network.http).toHaveBeenCalledTimes(4);
  });

  it('evicts old results after 128 entries and sanitizes transport failures', async () => {
    for (let index = 0; index < 129; index++) await service.check(urn, target, new URL(`http://parent${index}.example.com`));
    expect(network.http).toHaveBeenCalledTimes(129);
    await service.check(urn, target, new URL('http://parent0.example.com'));
    expect(network.http).toHaveBeenCalledTimes(130);
    network.http.mockImplementation(() => {
      throw new Error('private transport details');
    });
    expect(await service.check(urn, target, parent)).toMatchObject({ status: 'unknown', reason: 'unreachable' });
  });

  it('rejects malformed URL inputs and never treats credentials as a destination', () => {
    for (const value of ['file:///etc/passwd', 'http://user:secret@10.0.0.2:8090', 'http://10.0.0.2\n:8090', ['http://10.0.0.2'], 'x'.repeat(2049)])
      expect(embeddingUrl(value)).toBeUndefined();
    expect(embeddingUrl('https://orbis.example.com/path', true)).toBeUndefined();
    expect(embeddingUrl('https://orbis.example.com/?q=1', true)).toBeUndefined();
  });
});
