import { createHash } from 'node:crypto';
import { normaliseDesktopAppearance } from '@runtipi/common/schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { DatabaseService } from '@/core/database/database.service';
import { HostUpdatesService } from './host-updates.service';
import { downgradeManifest, migrationFingerprint, OrbisDowngradeService, requireLegacyDesktopCompatibility } from './orbis-downgrade.service';
import { AutomaticUpdatesService } from './automatic-updates.service';
import { DEFAULT_DESKTOP_PREFERENCES, DesktopPreferencesService, type DesktopPreferences } from '../desktop-preferences/desktop-preferences.service';

const { readFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
const row = { created_at: '1234567890000', hash: 'a'.repeat(64) };
const fingerprint = migrationFingerprint([row]);
const target = 'v0.1.0-beta.91';
const id = '00000000-0000-4000-8000-000000000000';
const manifest = {
  schema: 'orbis.release.v1',
  image: 'ghcr.io/twentylines/orbis',
  tag: target,
  commit: 'b'.repeat(40),
  digest: `sha256:${'c'.repeat(64)}`,
  runtipiCompatibility: '4.10.1',
  installationProtocol: 'orbis.installation-state.v1',
  dataCompatibility: 'orbis.data.v1',
  accountIdentifierCompatibility: 'orbis.account-identifier.v1',
  migrationFingerprint: fingerprint,
};
const legacyManifest = {
  ...manifest,
  tag: 'v0.1.0-beta.90',
  commit: 'b2cb88b8f31d2a00d054ec4a62867a8f659eab96',
  digest: 'sha256:e6fc6d1bd23d97994c780a560fc5ae72133975739831c65a7f54487ffbdf62ef',
  dataCompatibility: undefined,
  accountIdentifierCompatibility: undefined,
  migrationFingerprint: undefined,
};
const migrationDirectory = new URL('../../core/database/drizzle/', import.meta.url);
const legacyLedger = JSON.parse(readFileSync(new URL('meta/_journal.json', migrationDirectory), 'utf8')).entries.slice(0, 32) as Array<{
  when: number;
  tag: string;
}>;
const legacyRows = legacyLedger.map((entry) => ({
  created_at: String(entry.when),
  hash: createHash('sha256')
    .update(readFileSync(new URL(`${entry.tag}.sql`, migrationDirectory)))
    .digest('hex'),
}));

describe('beta90 desktop preference compatibility', () => {
  it('matches the immutable beta90 migration ledger', () => {
    expect(migrationFingerprint(legacyRows)).toBe('sha256:ed90c4f22eb28f9c594d4fa56f27eb7447dbd39962659f4a8657cf2a47cca5ae');
  });
  it.each<Partial<DesktopPreferences>>([
    { appLaunch: { mode: 'tab' as const, apps: {} } },
    { appLaunch: { mode: 'window' as const, apps: { 'whoami:migrated': { mode: 'tab' as const } } } },
    { appLaunch: { mode: 'window' as const, apps: { 'whoami:migrated': { bounds: { x: 20, y: 30, width: 800, height: 600 } } } } },
    { wallpaperMode: 'custom' as const, wallpaper: 'sandstone' as const },
    { wallpaperMode: 'theme' as const, wallpaper: 'tidal' as const },
    { wallpaperPreset: 'ocean' as const },
  ])('rejects choices beta90 would erase: %j', (choices) => {
    expect(() => requireLegacyDesktopCompatibility({ ...DEFAULT_DESKTOP_PREFERENCES, ...choices })).toThrow('cannot preserve');
  });
  it('allows defaults and wallpaper choices retained by beta90', () => {
    expect(() => requireLegacyDesktopCompatibility(DEFAULT_DESKTOP_PREFERENCES)).not.toThrow();
    expect(() => requireLegacyDesktopCompatibility({ ...DEFAULT_DESKTOP_PREFERENCES, wallpaper: 'tidal', wallpaperMode: 'custom' })).not.toThrow();
    expect(() =>
      requireLegacyDesktopCompatibility({
        ...DEFAULT_DESKTOP_PREFERENCES,
        appearance: normaliseDesktopAppearance({ wallpaperImage: 'a'.repeat(64) }),
        wallpaperMode: 'custom',
      }),
    ).not.toThrow();
  });
});

describe('reviewed Orbis downgrades', () => {
  const host = mock<HostUpdatesService>();
  const automaticUpdates = mock<AutomaticUpdatesService>();
  const preferences = mock<DesktopPreferencesService>();
  const execute = vi.fn();
  const database = { db: { execute } } as unknown as DatabaseService;
  let service: OrbisDowngradeService;
  const status = { available: true, enrolled: true, imageMatches: true, currentTag: 'v0.1.0-beta.92', coreState: 'running', coreHealth: 'healthy' };
  beforeEach(() => {
    vi.stubEnv('ORBIS_VERSION', status.currentTag);
    vi.stubEnv('TIPI_VERSION', '4.10.1');
    host.status.mockReset();
    host.plan.mockReset();
    host.apply.mockReset();
    execute.mockReset();
    automaticUpdates.pauseForDowngrade.mockReset();
    automaticUpdates.pauseForDowngrade.mockResolvedValue(undefined);
    preferences.read.mockReset();
    preferences.read.mockResolvedValue(DEFAULT_DESKTOP_PREFERENCES);
    host.status.mockResolvedValue(status);
    host.plan.mockResolvedValue({
      planId: id,
      currentTag: status.currentTag,
      targetTag: target,
      targetDigest: manifest.digest,
      snapshotBytes: 1024,
      appsMustBeStopped: false,
    });
    host.apply.mockResolvedValue({ jobId: id, state: 'running' });
    execute.mockResolvedValue({ rows: [row] });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => Response.json(manifest)),
    );
    service = new OrbisDowngradeService(host, database, automaticUpdates, preferences);
  });

  function legacyTarget() {
    vi.mocked(fetch).mockImplementation(async () => Response.json(legacyManifest));
    execute
      .mockResolvedValueOnce({ rows: legacyRows })
      .mockResolvedValueOnce({ rows: [{ id: 1, username: 'owner@example.test' }] })
      .mockResolvedValueOnce({ rows: legacyRows })
      .mockResolvedValueOnce({ rows: [{ id: 1, username: 'owner@example.test' }] });
    host.plan.mockResolvedValue({
      planId: id,
      currentTag: status.currentTag,
      targetTag: legacyManifest.tag,
      targetDigest: legacyManifest.digest,
      snapshotBytes: 1024,
      appsMustBeStopped: false,
    });
    return legacyManifest.tag;
  }

  it('rejects incompatible saved preferences before creating any host plan', async () => {
    const tag = legacyTarget();
    preferences.read.mockResolvedValue({ ...DEFAULT_DESKTOP_PREFERENCES, appLaunch: { mode: 'tab', apps: {} } });
    await expect(service.plan(tag)).rejects.toThrow('cannot preserve');
    expect(preferences.read).toHaveBeenCalledWith(1);
    expect(host.plan).not.toHaveBeenCalled();
    expect(host.apply).not.toHaveBeenCalled();
    expect(automaticUpdates.pauseForDowngrade).not.toHaveBeenCalled();
  });
  it('rechecks preferences before accepting a previously compatible legacy review', async () => {
    const tag = legacyTarget();
    await service.plan(tag);
    preferences.read.mockResolvedValueOnce({ ...DEFAULT_DESKTOP_PREFERENCES, wallpaperPreset: 'blush' });
    await expect(service.apply(id)).rejects.toThrow('cannot preserve');
    expect(preferences.read).toHaveBeenCalledTimes(2);
    expect(host.apply).not.toHaveBeenCalled();
    expect(automaticUpdates.pauseForDowngrade).not.toHaveBeenCalled();
  });
  it('checks preferences for every account on the installation', async () => {
    const tag = legacyTarget();
    execute
      .mockReset()
      .mockResolvedValueOnce({ rows: legacyRows })
      .mockResolvedValueOnce({
        rows: [
          { id: 1, username: 'first@example.test' },
          { id: 2, username: 'second@example.test' },
        ],
      });
    preferences.read.mockImplementation(async (userId) => ({
      ...DEFAULT_DESKTOP_PREFERENCES,
      appLaunch: { mode: userId === 2 ? 'tab' : 'window', apps: {} },
    }));
    await expect(service.plan(tag)).rejects.toThrow('cannot preserve');
    expect(preferences.read.mock.calls).toEqual([[1], [2]]);
    expect(host.plan).not.toHaveBeenCalled();
  });
  it('retains the eligible beta90 downgrade path for compatible settings', async () => {
    const tag = legacyTarget();
    await service.plan(tag);
    await expect(service.apply(id)).resolves.toEqual({ jobId: id, state: 'running' });
    expect(preferences.read).toHaveBeenCalledTimes(2);
    expect(host.apply).toHaveBeenCalledWith(id, true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('matches the release generator canonical migration ledger', () => {
    const ledger = [{ createdAt: Number(row.created_at), hash: row.hash }];
    expect(fingerprint).toBe(`sha256:${createHash('sha256').update(JSON.stringify(ledger)).digest('hex')}`);
    for (const rows of [[], [{ ...row, hash: 'wrong' }], [row, row], [{ ...row, created_at: 'NaN' }]])
      expect(() => migrationFingerprint(rows)).toThrow();
  });
  it('rejects runtime, state contract and migration identity mismatches', () => {
    expect(() => downgradeManifest({ ...manifest, runtipiCompatibility: '4.11.0' }, target, '4.10.1')).toThrow('different Runtipi');
    expect(() => downgradeManifest({ ...manifest, dataCompatibility: 'orbis.data.v2' }, target, '4.10.1')).toThrow('data contract');
    expect(() => downgradeManifest({ ...manifest, migrationFingerprint: undefined }, target, '4.10.1')).toThrow('data contract');
    expect(() => downgradeManifest({ ...manifest, tag: 'other' }, target, '4.10.1')).toThrow('verified Orbis downgrade');
  });
  it('permits only the previously verified immutable beta90 legacy contract', () => {
    expect(downgradeManifest(legacyManifest, legacyManifest.tag, '4.10.1').migrations).toBe(
      'sha256:ed90c4f22eb28f9c594d4fa56f27eb7447dbd39962659f4a8657cf2a47cca5ae',
    );
    expect(downgradeManifest(legacyManifest, legacyManifest.tag, '4.10.1').usernames).toBe(false);
    expect(downgradeManifest(legacyManifest, legacyManifest.tag, '4.10.1').legacyDesktop).toBe(true);
    expect(() => downgradeManifest({ ...legacyManifest, commit: 'd'.repeat(40) }, legacyManifest.tag, '4.10.1')).toThrow('data contract');
  });
  it('reviews and rechecks before using the existing verified host transaction once', async () => {
    const plan = await service.plan(target);
    expect(plan.compatibility).toContain('Same Runtipi');
    expect(host.plan).toHaveBeenCalledWith(target, true);
    expect(await service.apply(id)).toEqual({ jobId: id, state: 'running' });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(host.apply).toHaveBeenCalledTimes(1);
    expect(host.apply).toHaveBeenCalledWith(id, true);
    expect(automaticUpdates.pauseForDowngrade).toHaveBeenCalledTimes(1);
    expect(preferences.read).not.toHaveBeenCalled();
    await expect(service.apply(id)).rejects.toThrow('new downgrade review');
  });
  it('rejects changed database state before contacting host apply', async () => {
    await service.plan(target);
    execute.mockResolvedValue({ rows: [{ ...row, hash: 'e'.repeat(64) }] });
    await expect(service.apply(id)).rejects.toThrow('database schema');
    expect(host.apply).not.toHaveBeenCalled();
    expect(automaticUpdates.pauseForDowngrade).not.toHaveBeenCalled();
  });
  it('rejects an email-only target when a current account uses a bare username', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ ...manifest, accountIdentifierCompatibility: undefined }));
    execute.mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [{ username: 'sai' }] });
    await expect(service.plan(target)).rejects.toThrow('requires email sign-in');
    expect(host.plan).not.toHaveBeenCalled();
    expect(host.apply).not.toHaveBeenCalled();
  });
  it('rechecks account sign-in compatibility when confirming an email-only target', async () => {
    vi.mocked(fetch).mockImplementation(async () => Response.json({ ...manifest, accountIdentifierCompatibility: undefined }));
    execute
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [{ username: 'sai@example.test' }] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [{ username: 'sai' }] });
    await service.plan(target);
    await expect(service.apply(id)).rejects.toThrow('requires email sign-in');
    expect(host.apply).not.toHaveBeenCalled();
    expect(automaticUpdates.pauseForDowngrade).not.toHaveBeenCalled();
  });
  it('does not start a downgrade if automatic updates could not be paused safely', async () => {
    await service.plan(target);
    automaticUpdates.pauseForDowngrade.mockRejectedValueOnce(new Error('Storage is unavailable'));
    await expect(service.apply(id)).rejects.toThrow('Storage is unavailable');
    expect(host.apply).not.toHaveBeenCalled();
    await expect(service.apply(id)).rejects.toThrow('new downgrade review');
  });
  it('rejects a changed published digest or installed version on confirmation', async () => {
    await service.plan(target);
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ ...manifest, digest: `sha256:${'f'.repeat(64)}` }));
    await expect(service.apply(id)).rejects.toThrow('installation changed');
    host.status.mockResolvedValue({ ...status, currentTag: 'v0.1.0-beta.93' });
    await expect(service.apply(id)).rejects.toThrow('healthy');
    expect(host.apply).not.toHaveBeenCalled();
  });
  it('rejects invalid direction, pending jobs, expired reviews and oversize remote responses without downtime', async () => {
    for (const tag of ['v0.1.0-beta.93', status.currentTag, 'https://bad.invalid', null]) await expect(service.plan(tag)).rejects.toThrow('older');
    expect(host.plan).not.toHaveBeenCalled();
    host.status.mockResolvedValueOnce({ ...status, job: { id, state: 'running', targetTag: target, startedAt: Date.now() } });
    await expect(service.plan(target)).rejects.toThrow('current host update');
    vi.mocked(fetch).mockResolvedValueOnce(new Response('x'.repeat(16385)));
    await expect(service.plan(target)).rejects.toThrow('could not be verified');
    await service.plan(target);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 16 * 60_000);
    await expect(service.apply(id)).rejects.toThrow('new downgrade review');
    expect(host.apply).not.toHaveBeenCalled();
  });
  it('rejects host plans that differ from the checked release', async () => {
    host.plan.mockResolvedValueOnce({
      planId: id,
      currentTag: status.currentTag,
      targetTag: target,
      targetDigest: 'wrong',
      snapshotBytes: 1024,
      appsMustBeStopped: false,
    });
    await expect(service.plan(target)).rejects.toThrow('release changed');
    expect(host.apply).not.toHaveBeenCalled();
  });
});
