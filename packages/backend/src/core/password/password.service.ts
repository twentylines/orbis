import { Injectable, type OnModuleInit } from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';

@Injectable()
export class PasswordService implements OnModuleInit {
  private fallback?: Promise<string>;

  onModuleInit() {
    return this.loginFallbackHash().then(() => undefined);
  }

  public loginFallbackHash() {
    // Unknown accounts still perform a real password check using the current hashing cost.
    this.fallback ??= this.hash(randomBytes(32).toString('hex'));
    return this.fallback;
  }
  /**
   * Hash a password asynchronously
   * @param password - The plain text password to hash
   * @returns Promise resolving to the hashed password
   */
  public async hash(password: string): Promise<string> {
    return argon2.hash(password);
  }

  /**
   * Verify a password against a hash
   * @param password - The plain text password to verify
   * @param hash - The hash to verify against
   * @returns Promise resolving to true if the password matches the hash, false otherwise
   */
  public async verify(password: string, hash: string): Promise<boolean> {
    return argon2.verify(hash, password);
  }
}
