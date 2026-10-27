import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvUtils } from '@/modules/env/env.utils';
import { ConfigurationService, isValidIpOrCidr, parseTrustedProxyIps } from './configuration.service';

const { errorLog, warnLog } = vi.hoisted(() => ({ errorLog: vi.fn(), warnLog: vi.fn() }));
vi.mock('../logger/logger.service', () => ({
  LOG_LEVEL_ENUM: { debug: 'debug', info: 'info', warn: 'warn', error: 'error' },
  LoggerService: class {
    error = errorLog;
    warn = warnLog;
  },
}));

describe('configuration diagnostics', () => {
  beforeEach(() => {
    errorLog.mockClear();
    warnLog.mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('reports invalid field names without exposing their values in logs or exceptions', () => {
    const input = 'do-not-log';
    vi.stubEnv('POSTGRES_PORT', input);
    let failure: unknown;
    try {
      new ConfigurationService(new EnvUtils());
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('POSTGRES_PORT');
    expect((failure as Error).message).not.toContain(input);
    expect(errorLog).toHaveBeenCalled();
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(input);
  });
});

describe('isValidIpOrCidr', () => {
  it('accepts valid IPv4 and IPv6 addresses', () => {
    expect(isValidIpOrCidr('192.0.2.10')).toBe(true);
    expect(isValidIpOrCidr('2001:db8::1')).toBe(true);
  });

  it('accepts valid IPv4 and IPv6 CIDR ranges', () => {
    expect(isValidIpOrCidr('192.0.2.0/24')).toBe(true);
    expect(isValidIpOrCidr('2001:db8::/32')).toBe(true);
    expect(isValidIpOrCidr('0.0.0.0/0')).toBe(true);
    expect(isValidIpOrCidr('::/0')).toBe(true);
  });

  it('rejects malformed addresses and invalid CIDR prefixes', () => {
    expect(isValidIpOrCidr('192.0.2.999')).toBe(false);
    expect(isValidIpOrCidr('192.0.2.0/33')).toBe(false);
    expect(isValidIpOrCidr('2001:db8::/129')).toBe(false);
    expect(isValidIpOrCidr('2001:db8::/abc')).toBe(false);
    expect(isValidIpOrCidr('192.0.2.0/24/extra')).toBe(false);
  });
});

describe('parseTrustedProxyIps', () => {
  it('trims tokens and returns only valid IPs and CIDRs', () => {
    const result = parseTrustedProxyIps(' 192.0.2.10 , invalid , 2001:db8::/32, 192.0.2.0/33, , ::1 ');

    expect(result.trustedProxyIps).toEqual(['192.0.2.10', '2001:db8::/32', '::1']);
    expect(result.invalidProxyIps).toEqual(['invalid', '192.0.2.0/33']);
  });
});
