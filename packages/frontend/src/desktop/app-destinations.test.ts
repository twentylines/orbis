/// <reference types="bun" />
import { expect, test } from 'bun:test';
import type { GetAppDto } from '@/api-client';
import { appDestinations } from './app-destinations';

const fixture = () =>
  ({
    app: { status: 'running', port: 8081, openPort: true, exposedLocal: true, exposed: true, domain: 'photos.example.test' },
    info: { port: 80, dynamic_config: true, https: false, no_gui: false, url_suffix: '/photos?view=grid' },
    metadata: { localSubdomain: 'photos' },
  }) as GetAppDto & { app: NonNullable<GetAppDto['app']> };
const settings = { localDomain: 'home.test', sslPort: 443 };

test('uses the installed port, configured domains and app path', () => {
  expect(appDestinations(fixture(), settings, '192.0.2.10')).toEqual([
    { label: 'Server address', url: 'http://192.0.2.10:8081/photos?view=grid' },
    { label: 'Local domain', url: 'https://photos.home.test/photos?view=grid' },
    { label: 'Domain', url: 'https://photos.example.test/photos?view=grid' },
  ]);
});
test('formats IPv6 and a nonstandard TLS port', () => {
  const data = fixture();
  data.info.https = true;
  const addresses = appDestinations(data, { ...settings, sslPort: 8443 }, '2001:db8::1');
  expect(addresses[0]?.url).toBe('https://[2001:db8::1]:8081/photos?view=grid');
  expect(addresses[1]?.url).toBe('https://photos.home.test:8443/photos?view=grid');
});
test('does not launch stopped, missing or headless apps', () => {
  const data = fixture();
  data.app.status = 'stopped';
  expect(appDestinations(data, settings, 'localhost')).toEqual([]);
  data.app.status = 'running';
  data.info.no_gui = true;
  expect(appDestinations(data, settings, 'localhost')).toEqual([]);
  expect(appDestinations({ ...data, app: null }, settings, 'localhost')).toEqual([]);
});
test('only offers enabled routes and does not invent a missing local domain', () => {
  const data = fixture();
  data.app.openPort = false;
  data.app.exposed = false;
  expect(appDestinations(data, {}, 'localhost')).toEqual([]);
});
test('rejects malformed saved addresses and embedded credentials', () => {
  const data = fixture();
  data.app.domain = 'user:password@example.test';
  expect(appDestinations(data, {}, '').map(({ label }) => label)).toEqual([]);
});
test('deduplicates equivalent local and public addresses', () => {
  const data = fixture();
  data.app.openPort = false;
  data.app.domain = 'photos.home.test';
  expect(appDestinations(data, settings, 'localhost')).toHaveLength(1);
});
