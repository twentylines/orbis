import crypto from 'node:crypto';
import { CacheService } from '@/core/cache/cache.service';
import { Injectable } from '@nestjs/common';

@Injectable()
export class SessionManager {
  private COOKIE_MAX_AGE = 60 * 60 * 24; // 1 day

  constructor(private cache: CacheService) {}

  /**
   * Create a new session for the given user.
   * @param userId - The ID of the user to create a session for.
   * @returns The session ID.
   */
  public async createSession(userId: number) {
    const sessionId = crypto.randomUUID();
    const sessionKey = `session:${sessionId}`;

    this.cache.set(sessionKey, userId.toString(), this.COOKIE_MAX_AGE * 7);
    this.cache.set(`session:${userId}:${sessionId}`, sessionKey, this.COOKIE_MAX_AGE * 7);

    return sessionId;
  }

  public generateSalt() {
    return crypto.randomBytes(16).toString('hex');
  }

  public isSessionForUser(sessionId: string, userId: number) {
    return this.cache.get(`session:${sessionId}`) === String(userId);
  }

  /**
   * Delete a session by its ID.
   * @param sessionId - The ID of the session to delete.
   */
  public async deleteSession(sessionId: string) {
    const sessionKey = `session:${sessionId}`;
    const userId = this.cache.get(sessionKey);

    this.cache.del(sessionKey);
    if (userId) {
      this.cache.del(`session:${userId}:${sessionId}`);
    }
  }

  /**
   * Given a user ID, destroy all sessions for that user
   *
   * @param {number} userId - The user ID
   */
  public destroyAllSessionsByUserId = async (userId: number) => {
    const pendingTotp = await this.cache.getByPrefix(`totp-by-user:${userId}:`);
    for (const grant of pendingTotp) {
      if (grant.val) this.cache.del(grant.val);
      this.cache.del(grant.key);
    }
    const sessions = await this.cache.getByPrefix(`session:${userId}:`);

    await Promise.all(
      sessions.map(async (session) => {
        // Keep the index until revocation succeeds so a failed deletion remains retryable.
        if (session.val) this.cache.del(session.val);
        this.cache.del(session.key);
      }),
    );
  };
}
