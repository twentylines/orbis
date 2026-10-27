import { createHash } from 'node:crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { lt, valid } from 'semver';
import validator from 'validator';
import { isPublishedOrbisReleaseTag, isStableOrbisReleaseTag, downgradeAllowedOnChannel } from '@runtipi/common/schemas/orbis-release-channel';
import { DatabaseService } from '@/core/database/database.service';
import { HostUpdatesService, type HostUpdatePlan } from './host-updates.service';
import { AutomaticUpdatesService } from './automatic-updates.service';
import { DesktopPreferencesService, type DesktopPreferences } from '../desktop-preferences/desktop-preferences.service';
import { fetchPublishedReleaseManifest, publishedReleaseManifest, RELEASE_DIGEST, type PublishedReleaseManifest } from './published-release-manifest';
import { OrbisReleaseChannelsService } from '../system/orbis-release-channels.service';
import { OrbisReleaseService } from '../system/orbis-release.service';

// Bump this contract when persisted non-database state becomes incompatible.
const DATA_CONTRACT = 'orbis.data.v1';
const LEGACY_90 = {
  tag: 'v0.1.0-beta.90',
  commit: 'b2cb88b8f31d2a00d054ec4a62867a8f659eab96',
  digest: 'sha256:e6fc6d1bd23d97994c780a560fc5ae72133975739831c65a7f54487ffbdf62ef',
  migrations: 'sha256:ed90c4f22eb28f9c594d4fa56f27eb7447dbd39962659f4a8657cf2a47cca5ae',
};
type Review = HostUpdatePlan & {
  expiresAt: number;
  migrationFingerprint: string;
  compatibility: string;
  forced: boolean;
  warnings: string[];
  returnToStable: boolean;
  operation: 'update' | 'downgrade';
};
type StoredReview = Review & { riskFingerprint: string; hostBinding: string };
const FORCE_WARNING =
  'Forcing a downgrade can make current data unreadable, prevent sign-in, or reset settings. A recovery snapshot is still required.';

function stateFingerprint(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function incompatibleDowngrade(message: string) {
  return new BadRequestException({ statusCode: 400, error: 'Bad Request', message, canForce: true });
}

export function requireLegacyDesktopCompatibility(preferences: DesktopPreferences) {
  const launch = preferences.appLaunch;
  const wallpaperMode =
    (preferences.wallpaper && preferences.wallpaper !== 'sandstone') || preferences.appearance?.wallpaperImage ? 'custom' : 'theme';
  if (
    (launch && (launch.mode !== 'window' || Object.keys(launch.apps).length > 0)) ||
    (preferences.wallpaperMode && preferences.wallpaperMode !== wallpaperMode) ||
    preferences.wallpaperPreset
  ) {
    throw incompatibleDowngrade('Beta 90 cannot preserve your app opening or wallpaper settings. Choose beta 91 or later to keep these choices.');
  }
}

export function migrationFingerprint(rows: Array<{ created_at: unknown; hash: unknown }>): string {
  if (!rows.length || rows.length > 4096) throw new BadRequestException('The installed database migration history is unavailable.');
  let previous = 0;
  const ledger = rows.map((row) => {
    const createdAt = Number(row.created_at);
    if (!Number.isSafeInteger(createdAt) || createdAt <= previous || typeof row.hash !== 'string' || !/^[a-f0-9]{64}$/.test(row.hash)) {
      throw new BadRequestException('The installed database migration history is invalid.');
    }
    previous = createdAt;
    return { createdAt, hash: row.hash };
  });
  return `sha256:${createHash('sha256').update(JSON.stringify(ledger)).digest('hex')}`;
}

function manifestCompatibility(value: PublishedReleaseManifest, runtime: string, forced: boolean) {
  if (value.runtipiCompatibility !== runtime.replace(/^v/, '')) {
    throw new BadRequestException('This release requires a different Runtipi version. Runtipi cannot be downgraded here.');
  }
  const legacy = value.tag === LEGACY_90.tag && value.commit === LEGACY_90.commit && value.digest === LEGACY_90.digest;
  const migrations = legacy ? LEGACY_90.migrations : value.migrationFingerprint;
  const warnings: string[] = [];
  if ((!legacy && value.dataCompatibility !== DATA_CONTRACT) || typeof migrations !== 'string' || !RELEASE_DIGEST.test(migrations)) {
    if (!forced) throw incompatibleDowngrade('This release has no compatible data contract. Downgrades are supported from beta 90 onward.');
    warnings.push('This release has no verified compatible data contract. Its ability to read current data and settings is unknown.');
  }
  return {
    digest: value.digest,
    migrations: typeof migrations === 'string' && RELEASE_DIGEST.test(migrations) ? migrations : null,
    usernames: !legacy && value.accountIdentifierCompatibility === 'orbis.account-identifier.v1',
    legacyDesktop: legacy,
    warnings,
  };
}

export function downgradeManifest(raw: unknown, tag: string, runtime: string, forced = false) {
  return manifestCompatibility(publishedReleaseManifest(raw, tag), runtime, forced);
}

@Injectable()
export class OrbisDowngradeService {
  private readonly reviews = new Map<string, StoredReview>();
  constructor(
    private readonly host: HostUpdatesService,
    private readonly database: DatabaseService,
    private readonly automaticUpdates: AutomaticUpdatesService,
    private readonly preferences: DesktopPreferencesService,
    private readonly channels: OrbisReleaseChannelsService,
    private readonly releases: OrbisReleaseService,
  ) {}

  private async fingerprint() {
    const result = await this.database.db.execute<{ created_at: string; hash: string }>(
      sql`SELECT created_at, hash FROM drizzle.__drizzle_migrations ORDER BY id`,
    );
    return migrationFingerprint(result.rows);
  }

  async releaseCompatibility(tag: unknown) {
    const runtime = process.env.TIPI_VERSION;
    if (!runtime || !valid(runtime)) throw new BadRequestException('The installed Runtipi version is unavailable.');
    const manifest = await fetchPublishedReleaseManifest(tag);
    const currentRuntipiVersion = runtime.replace(/^v/, '');
    const targetRuntipiVersion = manifest.runtipiCompatibility;
    const crossesRuntipiBoundary = currentRuntipiVersion !== targetRuntipiVersion;
    const hostUpdateSupported = !crossesRuntipiBoundary && currentRuntipiVersion === '4.10.1';
    return {
      tag: manifest.tag,
      currentRuntipiVersion,
      targetRuntipiVersion,
      crossesRuntipiBoundary,
      hostUpdateSupported,
      warning: crossesRuntipiBoundary
        ? `This release requires Runtipi ${targetRuntipiVersion}; this server runs ${currentRuntipiVersion}. Crossing a Runtipi version boundary prevents downgrading to releases that require the previous version. The current host updater supports Runtipi 4.10.1 only and cannot apply this update.`
        : hostUpdateSupported
          ? null
          : 'The current host updater supports Runtipi 4.10.1 only and cannot apply this update.',
    };
  }

  private async check(tag: unknown, forced: boolean, returnToStable = false) {
    const installed = process.env.ORBIS_VERSION;
    const runtime = process.env.TIPI_VERSION;
    if (!isPublishedOrbisReleaseTag(tag) || !valid(tag) || !installed || !valid(installed) || tag === installed) {
      throw new BadRequestException('Choose an older published Orbis version.');
    }
    const channel = await this.channels.read();
    const downgrading = lt(tag, installed);
    if (returnToStable) {
      const latest = await this.releases.latest('stable');
      if (channel.channel !== 'nightly' || !isStableOrbisReleaseTag(tag) || latest?.tag !== tag || !latest.imageManifestUrl)
        throw new BadRequestException('Review the latest published Stable release before leaving Nightly.');
      if (!downgrading && forced) throw new BadRequestException('A Stable update does not require a forced downgrade.');
    } else if (!downgradeAllowedOnChannel(tag, installed, channel.channel))
      throw new BadRequestException('Choose an allowed earlier release on this update channel.');
    if (!runtime) throw new BadRequestException('The installed Runtipi version is unavailable.');
    const status = await this.host.status();
    if (
      !status.available ||
      !status.enrolled ||
      !status.imageMatches ||
      status.coreState !== 'running' ||
      status.coreHealth !== 'healthy' ||
      status.currentTag !== installed
    ) {
      throw new BadRequestException('The enrolled Orbis release must be running and healthy before downgrading.');
    }
    if (['queued', 'running', 'recovering', 'interrupted'].includes(status.job?.state ?? '')) {
      throw new BadRequestException('Finish or recover the current host update before downgrading.');
    }
    const published = await fetchPublishedReleaseManifest(tag);
    const manifest = manifestCompatibility(published, runtime, forced);
    const warnings = forced ? [FORCE_WARNING, ...manifest.warnings] : [];
    const fingerprint = await this.fingerprint();
    if (downgrading && fingerprint !== manifest.migrations) {
      if (!forced) throw incompatibleDowngrade('This release cannot read the installed database schema. No data or services were changed.');
      warnings.push('The target database schema does not match the installed schema. Data may be unreadable or damaged after this downgrade.');
    }
    const accountState: unknown[] = [];
    if (downgrading && !manifest.usernames) {
      const accounts = await this.database.db.execute<{ id: number; username: unknown }>(sql`SELECT id, username FROM "user" ORDER BY id LIMIT 4097`);
      if (accounts.rows.length > 4096 || accounts.rows.some(({ username }) => typeof username !== 'string' || !validator.isEmail(username))) {
        if (!forced) {
          throw incompatibleDowngrade(
            'This release requires email sign-in. Change username-only account identifiers to email addresses in Settings → Security before downgrading.',
          );
        }
        warnings.push('This release requires email sign-in. Current account identifiers may prevent sign-in after the downgrade.');
      }
      for (const account of accounts.rows) {
        const preferences = manifest.legacyDesktop ? await this.preferences.read(account.id) : undefined;
        accountState.push({ id: account.id, username: account.username, preferences });
        if (preferences) {
          try {
            requireLegacyDesktopCompatibility(preferences);
          } catch (error) {
            if (!forced) throw error;
            const warning = 'Beta 90 cannot preserve current app opening or wallpaper settings. These choices may be reset.';
            if (!warnings.includes(warning)) warnings.push(warning);
          }
        }
      }
    }
    return {
      installed,
      tag,
      manifest,
      fingerprint,
      warnings,
      operation: downgrading ? ('downgrade' as const) : ('update' as const),
      riskFingerprint: stateFingerprint({ published, fingerprint, accountState, warnings, channel, returnToStable }),
      hostBinding: stateFingerprint({ tag: status.currentTag, digest: status.currentDigest ?? null }),
    };
  }

  async planStable(forced = false): Promise<Review> {
    const latest = await this.releases.latest('stable');
    if (!latest?.imageManifestUrl) throw new BadRequestException('No verified Stable release is available for this server yet.');
    return this.plan(latest.tag, forced, true);
  }

  async plan(tag: unknown, forced = false, returnToStable = false): Promise<Review> {
    if (typeof forced !== 'boolean') throw new BadRequestException('Choose whether to force this downgrade.');
    const checked = await this.check(tag, forced, returnToStable);
    const plan = await this.host.plan(checked.tag, checked.operation === 'downgrade', returnToStable);
    if (plan.currentTag !== checked.installed || plan.targetTag !== checked.tag || plan.targetDigest !== checked.manifest.digest) {
      throw new BadRequestException('The checked release changed. Create a new downgrade review.');
    }
    const review = {
      ...plan,
      expiresAt: Date.now() + 15 * 60_000,
      migrationFingerprint: checked.fingerprint,
      compatibility: forced
        ? 'Same Runtipi version. Data compatibility checks are overridden; current data or settings may stop working.'
        : 'Same Runtipi version and database schema. Applications and current data are retained.',
      forced,
      warnings: checked.warnings,
      returnToStable,
      operation: checked.operation,
    };
    if (returnToStable && checked.operation === 'update')
      review.compatibility = 'Installs the reviewed Stable release on the same Runtipi version. The channel changes only after healthy verification.';
    if (returnToStable && checked.operation === 'downgrade')
      review.warnings.push('Automatic Orbis and system updates are paused for a downgrade. Your schedules and per-app rules are retained.');
    for (const [id, previous] of this.reviews) if (previous.expiresAt < Date.now()) this.reviews.delete(id);
    if (this.reviews.size >= 16) this.reviews.delete(this.reviews.keys().next().value as string);
    this.reviews.set(plan.planId, { ...review, riskFingerprint: checked.riskFingerprint, hostBinding: checked.hostBinding });
    return review;
  }

  async apply(planId: unknown, forced = false, returnToStable = false) {
    if (typeof forced !== 'boolean') throw new BadRequestException('Confirm whether to force this downgrade.');
    const review = typeof planId === 'string' ? this.reviews.get(planId) : undefined;
    if (!review || review.expiresAt < Date.now()) throw new BadRequestException('Create a new downgrade review before continuing.');
    if (review.forced !== forced || review.returnToStable !== returnToStable)
      throw new BadRequestException('Confirm the same channel and force choices shown in the installation review.');
    const checked = await this.check(review.targetTag, forced, returnToStable);
    if (
      checked.installed !== review.currentTag ||
      checked.manifest.digest !== review.targetDigest ||
      checked.fingerprint !== review.migrationFingerprint ||
      checked.riskFingerprint !== review.riskFingerprint ||
      checked.hostBinding !== review.hostBinding
    ) {
      throw new BadRequestException('The installation changed. Create a new downgrade review.');
    }
    this.reviews.delete(review.planId);
    if (review.operation === 'downgrade') await this.automaticUpdates.pauseForDowngrade();
    return this.host.apply(review.planId, review.operation === 'downgrade', returnToStable);
  }
}
