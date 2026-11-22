import { DATABASE, type Database } from '@/core/database/database.module';
import { user } from '@/core/database/drizzle/schema';
import type { NewUser } from '@/core/database/drizzle/types';
import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm/sql';
import { AsyncLocalStorage } from 'node:async_hooks';
import { credentialWriters, CredentialWriterError } from '../sentinel-recovery/writer-gate';

const FIRST_OPERATOR_LOCK_ID = 7_301_001;
type UserTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type TransactionLease = { tx: UserTransaction; active: boolean; children: Set<Promise<unknown>>; failure?: { error: unknown } };
type TransactionScope = { lease: TransactionLease; active: boolean };

@Injectable()
export class UserRepository {
  private readonly transactions = new AsyncLocalStorage<TransactionScope>();
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  private get db() {
    const scope = this.transactions.getStore();
    if (scope && (!scope.active || !scope.lease.active)) throw new CredentialWriterError('stale');
    return scope?.lease.tx ?? this.database;
  }

  private invokeTransaction<T>(lease: TransactionLease, work: (repository: UserRepository) => Promise<T>) {
    const scope: TransactionScope = { lease, active: true };
    return this.transactions.run(scope, async () => {
      try {
        return await work(this);
      } finally {
        scope.active = false;
      }
    });
  }

  /** Trusted planning/write boundary; passkey plans must be acquired afterwards.
   * The callback must finish SQL before granting sessions on another connection.
   * SQL rollback does not roll back a committed passkey file or host journal.
   * Nested failures poison this transaction; nested scopes are not savepoints.
   */
  public withCredentialTransaction<T>(work: (repository: UserRepository) => Promise<T>): Promise<T> {
    return credentialWriters.run(async () => {
      const parent = this.transactions.getStore();
      if (parent) {
        if (!parent.active || !parent.lease.active) throw new CredentialWriterError('stale');
        const child = this.invokeTransaction(parent.lease, work);
        parent.lease.children.add(child);
        void child.then(
          () => parent.lease.children.delete(child),
          (error: unknown) => {
            parent.lease.failure ??= { error };
            parent.lease.children.delete(child);
          },
        );
        return child;
      }
      return this.database.transaction(async (tx) => {
        // Keep the same order as first-operator creation and account reset.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${FIRST_OPERATOR_LOCK_ID})`);
        await tx.execute(sql`LOCK TABLE ${user} IN SHARE ROW EXCLUSIVE MODE`);
        const lease: TransactionLease = { tx, active: true, children: new Set() };
        let value!: T;
        let failure: { error: unknown } | undefined;
        try {
          value = await this.invokeTransaction(lease, work);
        } catch (error) {
          failure = { error };
        }
        // Drain before PostgreSQL COMMIT/ROLLBACK, not merely before releasing
        // the process gate. An admitted child must never query a returned client.
        while (lease.children.size) await Promise.allSettled([...lease.children]);
        lease.active = false;
        if (failure) throw failure.error;
        if (lease.failure) throw lease.failure.error;
        return value;
      });
    });
  }

  /**
   * Given a username, return the user associated to it
   *
   * @param {string} username - The username of the user to return
   */
  public async getUserByUsername(username: string) {
    return this.db.query.user.findFirst({ where: eq(user.username, username.trim().toLowerCase()) });
  }

  /**
   * Given a userId, return the user associated to it
   *
   * @param {number} id - The id of the user to return
   */
  public async getUserById(id: number) {
    return this.db.query.user.findFirst({ where: eq(user.id, Number(id)) });
  }

  /**
   * Given a userId, return the user associated to it with only the id, username, and totpEnabled fields
   *
   * @param {number} id - The id of the user to return
   */
  public async getUserDtoById(id: number) {
    return this.db.query.user.findFirst({
      where: eq(user.id, Number(id)),
      columns: { id: true, username: true, totpEnabled: true, locale: true, operator: true, hasSeenWelcome: true },
    });
  }

  /**
   * Given a userId, update the user with the given data
   *
   * @param {number} id - The id of the user to update
   * @param {Partial<NewUser>} data - The data to update the user with
   */
  public async updateUser(id: number, data: Partial<NewUser>) {
    return this.withCredentialTransaction(async () => {
      const updatedUsers = await this.db
        .update(user)
        .set(data)
        .where(eq(user.id, Number(id)))
        .returning();
      return updatedUsers[0];
    });
  }

  /**
   * Returns all operators registered in the system
   */
  public async getOperators() {
    return this.db.select().from(user).where(eq(user.operator, true));
  }

  /**
   * Returns the first operator found in the system
   */
  public async getFirstOperator() {
    return this.db.query.user.findFirst({ where: eq(user.operator, true) });
  }

  /**
   * Given user data, creates a new user
   *
   * @param {NewUser} data - The data to create the user with
   */
  public async createUser(data: NewUser) {
    return this.withCredentialTransaction(async () => {
      const newUsers = await this.db.insert(user).values(data).returning();
      return newUsers[0];
    });
  }

  public async createFirstOperator(data: Omit<NewUser, 'operator'>) {
    return this.withCredentialTransaction(async () => {
      const existingOperators = await this.db.select().from(user).where(eq(user.operator, true));
      if (existingOperators.length > 0) {
        return null;
      }

      const newUsers = await this.db
        .insert(user)
        .values({ ...data, operator: true })
        .returning();
      return newUsers[0] ?? null;
    });
  }
}
