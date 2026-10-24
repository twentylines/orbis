import { createHash } from 'node:crypto';
import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { lt, valid } from 'semver';
import validator from 'validator';
import { DatabaseService } from '@/core/database/database.service';
import { HostUpdatesService, type HostUpdatePlan } from './host-updates.service';
import { AutomaticUpdatesService } from './automatic-updates.service';

const TAG = /^v[0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z.-]+)?$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
// Bump this contract when persisted non-database state becomes incompatible.
const DATA_CONTRACT = 'orbis.data.v1';
const LEGACY_90 = {
  tag: 'v0.1.0-beta.90',
  commit: 'b2cb88b8f31d2a00d054ec4a62867a8f659eab96',
  digest: 'sha256:e6fc6d1bd23d97994c780a560fc5ae72133975739831c65a7f54487ffbdf62ef',
  migrations: 'sha256:ed90c4f22eb28f9c594d4fa56f27eb7447dbd39962659f4a8657cf2a47cca5ae',
};
type Review = HostUpdatePlan & { expiresAt: number; migrationFingerprint: string; compatibility: string };

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

export function downgradeManifest(raw: unknown, tag: string, runtime: string) {
  const value = raw as Record<string, unknown> | null;
  if (
    !value ||
    value.schema !== 'orbis.release.v1' ||
    value.tag !== tag ||
    value.image !== 'ghcr.io/twentylines/orbis' ||
    typeof value.commit !== 'string' ||
    !/^[a-f0-9]{40}$/.test(value.commit) ||
    typeof value.digest !== 'string' ||
    !DIGEST.test(value.digest) ||
    value.installationProtocol !== 'orbis.installation-state.v1'
  )
    throw new BadRequestException('This release does not support a verified Orbis downgrade.');
  if (typeof value.runtipiCompatibility !== 'string' || value.runtipiCompatibility.replace(/^v/, '') !== runtime.replace(/^v/, '')) {
    throw new BadRequestException('This release requires a different Runtipi version. Runtipi cannot be downgraded here.');
  }
  const legacy = tag === LEGACY_90.tag && value.commit === LEGACY_90.commit && value.digest === LEGACY_90.digest;
  const migrations = legacy ? LEGACY_90.migrations : value.migrationFingerprint;
  if ((!legacy && value.dataCompatibility !== DATA_CONTRACT) || typeof migrations !== 'string' || !DIGEST.test(migrations)) {
    throw new BadRequestException('This release has no compatible data contract. Downgrades are supported from beta 90 onward.');
  }
  return { digest: value.digest, migrations, usernames: !legacy && value.accountIdentifierCompatibility === 'orbis.account-identifier.v1' };
}

@Injectable()
export class OrbisDowngradeService {
  private readonly reviews = new Map<string, Review>();
  constructor(
    private readonly host: HostUpdatesService,
    private readonly database: DatabaseService,
    private readonly automaticUpdates: AutomaticUpdatesService,
  ) {}

  private async fingerprint() {
    const result = await this.database.db.execute<{ created_at: string; hash: string }>(
      sql`SELECT created_at, hash FROM drizzle.__drizzle_migrations ORDER BY id`,
    );
    return migrationFingerprint(result.rows);
  }

  private async check(tag: unknown) {
    const installed = process.env.ORBIS_VERSION;
    const runtime = process.env.TIPI_VERSION;
    if (typeof tag !== 'string' || tag.length > 80 || !TAG.test(tag) || !valid(tag) || !installed || !valid(installed) || !lt(tag, installed)) {
      throw new BadRequestException('Choose an older published Orbis version.');
    }
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
    let raw: unknown;
    try {
      const response = await fetch(`https://github.com/twentylines/orbis/releases/download/${tag}/release-manifest.json`, {
        signal: AbortSignal.timeout(12_000),
        headers: { 'User-Agent': 'Orbis-update-center/1' },
      });
      if (!response.ok || !response.body) throw new Error('Release unavailable');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 16 * 1024) throw new Error('Release manifest exceeded its limit');
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
      }
      raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new ServiceUnavailableException('The published downgrade manifest could not be verified. Try again later.');
    }
    const manifest = downgradeManifest(raw, tag, runtime);
    const fingerprint = await this.fingerprint();
    if (fingerprint !== manifest.migrations) {
      throw new BadRequestException('This release cannot read the installed database schema. No data or services were changed.');
    }
    if (!manifest.usernames) {
      const accounts = await this.database.db.execute<{ username: unknown }>(sql`SELECT username FROM "user" LIMIT 4097`);
      if (accounts.rows.length > 4096 || accounts.rows.some(({ username }) => typeof username !== 'string' || !validator.isEmail(username))) {
        throw new BadRequestException(
          'This release requires email sign-in. Change username-only account identifiers to email addresses in Settings → Security before downgrading.',
        );
      }
    }
    return { installed, tag, manifest, fingerprint };
  }

  async plan(tag: unknown): Promise<Review> {
    const checked = await this.check(tag);
    const plan = await this.host.plan(checked.tag, true);
    if (plan.currentTag !== checked.installed || plan.targetTag !== checked.tag || plan.targetDigest !== checked.manifest.digest) {
      throw new BadRequestException('The checked release changed. Create a new downgrade review.');
    }
    const review = {
      ...plan,
      expiresAt: Date.now() + 15 * 60_000,
      migrationFingerprint: checked.fingerprint,
      compatibility: 'Same Runtipi version and database schema. Applications and current data are retained.',
    };
    for (const [id, previous] of this.reviews) if (previous.expiresAt < Date.now()) this.reviews.delete(id);
    if (this.reviews.size >= 16) this.reviews.delete(this.reviews.keys().next().value as string);
    this.reviews.set(plan.planId, review);
    return review;
  }

  async apply(planId: unknown) {
    const review = typeof planId === 'string' ? this.reviews.get(planId) : undefined;
    if (!review || review.expiresAt < Date.now()) throw new BadRequestException('Create a new downgrade review before continuing.');
    const checked = await this.check(review.targetTag);
    if (
      checked.installed !== review.currentTag ||
      checked.manifest.digest !== review.targetDigest ||
      checked.fingerprint !== review.migrationFingerprint
    ) {
      throw new BadRequestException('The installation changed. Create a new downgrade review.');
    }
    this.reviews.delete(review.planId);
    await this.automaticUpdates.pauseForDowngrade();
    return this.host.apply(review.planId, true);
  }
}
