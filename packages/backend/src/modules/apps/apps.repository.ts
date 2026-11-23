import { commitOrdinaryAppUpdate, readCurrentOrdinaryUpdateCommit, type OrdinaryUpdateResult } from './app-update-commit';
import { commitExistingAppBaseline, readExistingAppBaseline } from './app-existing-baseline';
import type { ExistingBaselineBinding } from './app-existing-baseline-schema';
import type { ExistingAppBaseline } from '../docker/app-existing-storage';
import { commitFreshInstall, readFreshInstallCommit, readCurrentFreshInstallCommit, type FreshInstallResult } from './app-fresh-commit';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import { DATABASE, type Database } from '@/core/database/database.module';
import { app, appMigration } from '@/core/database/drizzle/schema';
import type { App, AppStatus, NewApp } from '@/core/database/drizzle/types';
import { Inject, Injectable } from '@nestjs/common';
import type { AppUrn } from '@runtipi/common/types';
import { and, asc, eq, ne, notInArray } from 'drizzle-orm';
import { commitFreshInstallBaseline, readFreshInstallBaseline } from './app-fresh-baseline';
import type { AppUpdateStage } from '../docker/app-update-stage';
import type { AppMigrationLedger } from './app-migration-ledger';
import type { MigrationJournalState } from '../backups/app-migration-journal';
import { settleMigrationRollback, readMigrationRollback } from './app-migration-rollback';
import { commitAppMigration, readAppMigrationCommit } from './app-migration-commit';
import { appSettingsBinding } from './app-settings-binding';

export type InstallAppReservation = Pick<App, 'id' | 'createdAt' | 'appName' | 'appStoreSlug'> &
  Partial<Pick<App, 'version'>> & { preserveExisting?: true };

const installReservationFilter = (reservation: InstallAppReservation) =>
  and(
    eq(app.id, reservation.id),
    eq(app.createdAt, reservation.createdAt),
    eq(app.appName, reservation.appName),
    eq(app.appStoreSlug, reservation.appStoreSlug),
    eq(app.status, 'installing'),
    reservation.version === undefined ? undefined : eq(app.version, reservation.version),
  );

@Injectable()
export class AppsRepository {
  constructor(@Inject(DATABASE) private db: Database) {}

  public commitOrdinaryAppUpdate(stage: AppUpdateStage, result: OrdinaryUpdateResult) {
    return commitOrdinaryAppUpdate(this.db, stage, result);
  }
  public readCurrentOrdinaryUpdateCommit(result: OrdinaryUpdateResult) {
    return readCurrentOrdinaryUpdateCommit(this.db, result);
  }
  public commitExistingAppBaseline(stage: AppUpdateStage, proof: ExistingAppBaseline) {
    return commitExistingAppBaseline(this.db, stage, proof);
  }
  public readExistingAppBaseline(binding: ExistingBaselineBinding) {
    return readExistingAppBaseline(this.db, binding);
  }
  public commitFreshInstall(stage: AppUpdateStage, result: FreshInstallResult) {
    return commitFreshInstall(this.db, stage, result);
  }
  public readCurrentFreshInstallCommit(result: FreshInstallResult) {
    return readCurrentFreshInstallCommit(this.db, result);
  }
  public readFreshInstallCommit(result: FreshInstallResult) {
    return readFreshInstallCommit(this.db, result);
  }
  public commitFreshInstallBaseline(stage: AppUpdateStage) {
    return commitFreshInstallBaseline(this.db, stage);
  }
  public readFreshInstallBaseline(stage: AppUpdateStage) {
    return readFreshInstallBaseline(this.db, stage);
  }

  public commitMigration(state: Readonly<MigrationJournalState>, status: 'running' | 'stopped', pendingRestart?: boolean) {
    return commitAppMigration(this.db, state, status, pendingRestart);
  }

  public readMigrationCommit(state: Readonly<MigrationJournalState>) {
    return readAppMigrationCommit(this.db, state);
  }

  public settleMigrationRollback(state: Readonly<MigrationJournalState>, status: 'running' | 'stopped', pendingRestart?: true) {
    return settleMigrationRollback(this.db, state, status, pendingRestart);
  }

  public readMigrationRollback(state: Readonly<MigrationJournalState>, status: 'running' | 'stopped') {
    return readMigrationRollback(this.db, state, status);
  }

  public async reserveCustomDraft(reservation: InstallAppReservation, data: Partial<NewApp>) {
    const [row] = await this.db
      .update(app)
      .set({ ...data, status: 'installing', updatedAt: Math.floor(Date.now() / 1000) })
      .where(
        and(
          eq(app.id, reservation.id),
          eq(app.createdAt, reservation.createdAt),
          eq(app.appName, reservation.appName),
          eq(app.appStoreSlug, '_user'),
          eq(app.appStoreSlug, reservation.appStoreSlug),
          eq(app.status, 'missing'),
          eq(app.migrationsBaselined, false),
          reservation.version === undefined ? undefined : eq(app.version, reservation.version),
        ),
      )
      .returning();
    return row;
  }

  public async deleteInstallReservation(reservation: InstallAppReservation) {
    // A saved custom draft predates the request. Releasing its reservation must never delete it.
    if (reservation.preserveExisting) {
      const rows = await this.db
        .update(app)
        .set({ status: 'missing', updatedAt: Math.floor(Date.now() / 1000) })
        .where(installReservationFilter(reservation))
        .returning({ id: app.id });
      return rows.length === 1;
    }
    const rows = await this.db.delete(app).where(installReservationFilter(reservation)).returning({ id: app.id });
    return rows.length === 1;
  }

  public async finishInstallReservation(reservation: InstallAppReservation, status: 'running' | 'stopped') {
    const rows = await this.db
      .update(app)
      .set({ status, updatedAt: Math.floor(Date.now() / 1000) })
      .where(installReservationFilter(reservation))
      .returning({ id: app.id });
    return rows.length === 1;
  }

  public async getMigrationLedger(appId: number) {
    const rows = await this.db
      .select({ baselined: app.migrationsBaselined, migrationId: appMigration.migrationId })
      .from(app)
      .leftJoin(appMigration, eq(app.id, appMigration.appId))
      .where(eq(app.id, appId))
      .orderBy(asc(appMigration.migrationId));
    if (!rows[0]) throw new Error('Application migration ledger is unavailable');
    return { baselined: rows[0].baselined, migrationIds: rows.flatMap(({ migrationId }) => (migrationId === null ? [] : [migrationId])) };
  }

  public async replaceMigrationLedger(appId: number, ledger: AppMigrationLedger, data: Partial<NewApp> = {}) {
    return this.db.transaction(async (transaction) => {
      const [updated] = await transaction
        .update(app)
        .set({ ...data, migrationsBaselined: ledger.baselined, updatedAt: Math.floor(Date.now() / 1000) })
        .where(eq(app.id, appId))
        .returning();
      if (!updated) throw new Error('Application migration ledger is unavailable');
      await transaction.delete(appMigration).where(eq(appMigration.appId, appId));
      if (ledger.migrationIds.length) {
        await transaction.insert(appMigration).values(ledger.migrationIds.map((migrationId) => ({ appId, migrationId })));
      }
      return updated;
    });
  }

  /**
   * Given an app id, return the app
   *
   * @param {string} appId - The id of the app to return
   */
  public async getAppById(appId: number) {
    return this.db.query.app.findFirst({ where: eq(app.id, appId), with: { appStore: true } });
  }

  public async getAppByUrn(appUrn: AppUrn) {
    const { appStoreId, appName } = extractAppUrn(appUrn);

    return this.db.query.app.findFirst({ where: and(eq(app.appName, appName), eq(app.appStoreSlug, appStoreId)), with: { appStore: true } });
  }

  /**
   * Given an app id, update the app with the given data
   *
   * @param {string} appId - The id of the app to update
   * @param {Partial<NewApp>} data - The data to update the app with
   */
  public async updateAppById(appId: number, data: Partial<NewApp>) {
    const updatedApps = await this.db
      .update(app)
      .set({ ...data, updatedAt: Math.floor(Date.now() / 1000) })
      .where(eq(app.id, appId))
      .returning()
      .execute();
    return updatedApps[0];
  }

  public async updateSettingsIfCurrent(expected: App, data: Partial<NewApp>) {
    const binding = appSettingsBinding(expected);
    return this.db.transaction(
      async (transaction) => {
        const [current] = await transaction.select().from(app).where(eq(app.id, expected.id)).for('update');
        if (!current || appSettingsBinding(current) !== binding)
          throw new Error('The application changed before its settings could be saved. Refresh and try again.');
        const [updated] = await transaction
          .update(app)
          .set({ ...data, updatedAt: Math.floor(Date.now() / 1000) })
          .where(eq(app.id, expected.id))
          .returning();
        if (!updated) throw new Error('Application settings could not be saved.');
        return updated;
      },
      { isolationLevel: 'serializable' },
    );
  }

  /**
   * Given an app id, delete the app
   *
   * @param {string} appId - The id of the app to delete
   */
  public async deleteAppById(appId: number) {
    await this.db.delete(app).where(eq(app.id, appId)).execute();
  }

  /**
   * Given app data, creates a new app
   *
   * @param {NewApp} data - The data to create the app with
   */
  public async createApp(data: NewApp) {
    const newApps = await this.db.insert(app).values(data).returning().execute();

    const createdApp = newApps[0];

    if (!createdApp) {
      throw new Error('Failed to create app');
    }

    return createdApp;
  }

  /**
   * Returns all apps installed with the given status sorted by id ascending
   *
   * @param {AppStatus} status - The status of the apps to return
   */
  public async getAppsByStatus(status: AppStatus) {
    return this.db.query.app.findMany({ where: eq(app.status, status), orderBy: asc(app.appName) });
  }

  /**
   * Returns all apps installed sorted by id ascending
   */
  public async getApps() {
    return this.db.query.app.findMany({ orderBy: asc(app.appName), with: { appStore: true } });
  }

  /**
   * Returns all apps that are running and visible on guest dashboard sorted by id ascending
   */
  public async getGuestDashboardApps() {
    return this.db.query.app.findMany({
      where: and(eq(app.status, 'running'), eq(app.isVisibleOnGuestDashboard, true)),
      orderBy: asc(app.appName),
      with: { appStore: true },
    });
  }

  /**
   * Given a domain, return all apps that have this domain, are exposed and not the given id
   *
   * @param {string} domain - The domain to search for
   * @param {string} id - The id of the app to exclude
   */
  public async getAppsByDomain(domain: string, id?: number) {
    if (!id) {
      return this.db.query.app.findMany({ where: and(eq(app.domain, domain), eq(app.exposed, true)) });
    }
    return this.db.query.app.findMany({ where: and(eq(app.domain, domain), eq(app.exposed, true), ne(app.id, id)) });
  }

  /**
   * Given a local subdomain, return all apps that have this subdomain, have exposedLocal enabled and not the given id
   *
   * @param {string} localSubdomain - The local subdomain to search for
   * @param {number} id - The id of the app to exclude
   */
  public async getAppsByLocalSubdomain(localSubdomain: string, id?: number) {
    if (!id) {
      return this.db.query.app.findMany({
        where: and(eq(app.localSubdomain, localSubdomain), eq(app.exposedLocal, true)),
      });
    }
    return this.db.query.app.findMany({
      where: and(eq(app.localSubdomain, localSubdomain), eq(app.exposedLocal, true), ne(app.id, id)),
    });
  }

  /**
   * Given a port, return all apps that have this port, are open and not the given id
   *
   * @param {number} port - The port to search for
   * @param {number} id - The id of the app to exclude
   */
  public async getAppsByPort(port: number, id?: number) {
    if (!id) {
      return this.db.query.app.findMany({ where: and(eq(app.port, port), eq(app.openPort, true)) });
    }
    return this.db.query.app.findMany({ where: and(eq(app.port, port), eq(app.openPort, true), ne(app.id, id)) });
  }

  /**
   * Given an array of app status, update all apps that have a status not in the array with new values
   *
   * @param {AppStatus[]} statuses - The statuses to exclude from the update
   * @param {Partial<NewApp>} data - The data to update the apps with
   */
  public async updateAppsByStatusNotIn(statuses: AppStatus[], data: Partial<NewApp>) {
    return this.db
      .update(app)
      .set({ ...data, updatedAt: Math.floor(Date.now() / 1000) })
      .where(notInArray(app.status, statuses))
      .returning()
      .execute();
  }
}
