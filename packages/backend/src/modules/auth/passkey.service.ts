import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { BadRequestException, ForbiddenException, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import type { Request } from 'express';
import { ConfigurationService } from '@/core/config/configuration.service';
import { SESSION_COOKIE_NAME } from '@/common/constants';
import { UserRepository } from '../user/user.repository';
import { SessionManager } from './session.manager';
import { AuthService } from './auth.service';
import { PasskeyStore, type StoredPasskey, type PasskeyState } from './passkey.store';

export const PASSKEY_COOKIE = 'orbis-passkey-ceremony';
export const PASSKEY_TTL = 5 * 60_000;
type Context = { origin: string; rpID: string };
type Ceremony = Context & {
  challenge: string;
  expires: number;
  kind: 'register' | 'login';
  userId?: number;
  sessionId?: string;
  accountHash?: string;
  name?: string;
};
type PasskeyUser = NonNullable<Awaited<ReturnType<UserRepository['getUserById']>>>;
const proofHash = (user: PasskeyUser) =>
  createHash('sha256').update(`${user.password}/${user.totpEnabled}/${user.totpSecret}/${user.salt}`).digest('hex');
const totpBinding = (user: PasskeyUser) =>
  user.totpEnabled && user.totpSecret && user.salt ? createHash('sha256').update(`${user.totpSecret}/${user.salt}`).digest('hex') : null;
const accountPolicy = (account: PasskeyState['users'][string] | undefined, user: PasskeyUser) => {
  const binding = totpBinding(user);
  return { requireTotpAfterPasskey: Boolean(binding && account?.totpAfterPasskey === binding), totpEnabled: user.totpEnabled };
};
const fail = () => new BadRequestException('The passkey could not be verified. Try again or use your password.');
const transports = new Set(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']);

@Injectable()
export class PasskeyService {
  private readonly challenges = new Map<string, Ceremony>();
  constructor(
    private readonly config: ConfigurationService,
    private readonly store: PasskeyStore,
    private readonly auth: AuthService,
    private readonly users: UserRepository,
    private readonly sessions: SessionManager,
  ) {}
  private origins() {
    const settings = this.config.get('userSettings');
    return [settings.domain, settings.localDomain].flatMap((domain) => {
      if (!domain || /[\s/@?#]/.test(domain)) return [];
      try {
        const url = new URL(`https://${domain}${settings.sslPort && settings.sslPort !== 443 ? `:${settings.sslPort}` : ''}`);
        if (isIP(url.hostname) || url.hostname === 'localhost' || !url.hostname.includes('.')) return [];
        return [url.origin];
      } catch {
        return [];
      }
    });
  }
  private context(req: Request): Context {
    if (this.config.get('demoMode')) throw new ForbiddenException('Passkeys are unavailable in demo mode.');
    const raw = req.headers.origin;
    if (typeof raw !== 'string' || raw.length > 512) throw new ForbiddenException('Passkeys require a trusted HTTPS origin or localhost.');
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ForbiddenException('Passkeys require a trusted HTTPS origin or localhost.');
    }
    if (raw !== url.origin || url.username || url.password) throw new ForbiddenException('Invalid passkey origin.');
    const localhost =
      url.hostname === 'localhost' &&
      ['http:', 'https:'].includes(url.protocol) &&
      req.headers.host === url.host &&
      ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress ?? '');
    if (!localhost && !this.origins().includes(url.origin))
      throw new ForbiddenException('Passkeys require HTTPS on the configured Orbis domain. Use your password on this address.');
    return { origin: url.origin, rpID: url.hostname };
  }
  availability(req: Request) {
    try {
      const origin =
        req.headers.origin ??
        (req.headers.host?.startsWith('localhost:') || req.headers.host === 'localhost'
          ? `http://${req.headers.host}`
          : this.origins().find((value) => new URL(value).host === req.headers.host));
      this.context({ ...req, headers: { ...req.headers, origin } } as Request);
      return { available: true };
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : 'Passkeys require a trusted HTTPS address.' };
    }
  }
  private browser(req: Request) {
    if (req.authMethod !== 'session' || !req.user?.id || typeof req.cookies?.[SESSION_COOKIE_NAME] !== 'string')
      throw new UnauthorizedException('A browser session is required.');
    if (!this.sessions.isSessionForUser(req.cookies[SESSION_COOKIE_NAME], req.user.id))
      throw new UnauthorizedException('Sign in again before managing passkeys.');
    return { userId: req.user.id, sessionId: req.cookies[SESSION_COOKIE_NAME] as string };
  }
  private prune() {
    for (const [id, value] of this.challenges) if (value.expires <= Date.now()) this.challenges.delete(id);
    if (this.challenges.size >= 256) throw new ServiceUnavailableException('Too many passkey requests. Try again shortly.');
  }
  private take(id: unknown, kind: Ceremony['kind'], context: Context) {
    const value = typeof id === 'string' ? this.challenges.get(id) : undefined;
    if (typeof id === 'string') this.challenges.delete(id);
    if (!value || value.kind !== kind || value.expires <= Date.now() || value.origin !== context.origin || value.rpID !== context.rpID) throw fail();
    return value;
  }
  private object(raw: unknown, keys: string[]) {
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      Object.keys(raw).some((key) => !keys.includes(key)) ||
      JSON.stringify(raw).length > 100_000
    )
      throw fail();
    return raw as Record<string, unknown>;
  }
  async list(req: Request) {
    const { userId } = this.browser(req);
    try {
      const [state, user] = await Promise.all([this.store.snapshot(), this.users.getUserById(userId)]);
      if (!user) throw new UnauthorizedException();
      return {
        ...this.availability(req),
        credentials: (state.users[userId]?.credentials ?? []).map(({ id, name, createdAt, lastUsedAt }) => ({ id, name, createdAt, lastUsedAt })),
        policy: accountPolicy(state.users[userId], user),
      };
    } catch {
      return { available: false, reason: 'Passkey storage is unavailable. Your password still works.', credentials: [] };
    }
  }
  async readPolicy(req: Request) {
    const { userId } = this.browser(req);
    const [state, user] = await Promise.all([this.store.snapshot(), this.users.getUserById(userId)]);
    if (!user) throw new UnauthorizedException();
    return accountPolicy(state.users[userId], user);
  }
  async updatePolicy(req: Request, raw: unknown) {
    this.context(req);
    const { userId } = this.browser(req);
    const body = this.object(raw, ['requireTotpAfterPasskey', 'password', 'totpCode']);
    if (
      typeof body.requireTotpAfterPasskey !== 'boolean' ||
      typeof body.password !== 'string' ||
      (body.totpCode !== undefined && typeof body.totpCode !== 'string')
    )
      throw fail();
    const proof = await this.auth.verifySensitiveAction(userId, body.password, body.totpCode as string | undefined);
    return this.store.change(async (state) => {
      const user = await this.users.getUserById(userId);
      this.auth.assertSecurityChangeAllowed();
      this.browser(req);
      if (!user || proofHash(user) !== proofHash(proof)) throw fail();
      const binding = totpBinding(user);
      const account = state.users[userId];
      if (body.requireTotpAfterPasskey) {
        if (!binding) throw new BadRequestException('Enable authenticator codes before requiring them after passkey sign-in.');
        if (!account?.credentials.length) throw new BadRequestException('Add a passkey before requiring an extra verification.');
        account.totpAfterPasskey = binding;
      } else if (account) delete account.totpAfterPasskey;
      return accountPolicy(account, user);
    });
  }
  async registrationOptions(req: Request, raw: unknown) {
    const context = this.context(req);
    const browser = this.browser(req);
    const body = this.object(raw, ['password', 'totpCode', 'name']);
    if (
      typeof body.password !== 'string' ||
      typeof body.name !== 'string' ||
      !body.name.trim() ||
      body.name.trim().length > 60 ||
      Array.from(body.name).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
      (body.totpCode !== undefined && typeof body.totpCode !== 'string')
    )
      throw fail();
    const user = await this.auth.verifySensitiveAction(browser.userId, body.password, body.totpCode as string | undefined);
    this.prune();
    const account = await this.store.change((state) => {
      const current = state.users[user.id] ?? { handle: randomBytes(32).toString('base64url'), credentials: [] };
      if (current.credentials.length >= 10 || (!state.users[user.id] && Object.keys(state.users).length >= 256))
        throw new BadRequestException('Remove a passkey before adding another.');
      state.users[user.id] = current;
      return structuredClone(current);
    });
    const options = await generateRegistrationOptions({
      rpName: 'Orbis',
      rpID: context.rpID,
      userID: new Uint8Array(Buffer.from(account.handle, 'base64url')),
      userName: user.username,
      attestationType: 'none',
      timeout: PASSKEY_TTL,
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      excludeCredentials: account.credentials.filter((key) => key.rpID === context.rpID).map(({ id, transports }) => ({ id, transports })),
      supportedAlgorithmIDs: [-7, -257],
    });
    for (const [id, value] of this.challenges) if (value.kind === 'register' && value.sessionId === browser.sessionId) this.challenges.delete(id);
    this.prune();
    this.challenges.set(`register:${browser.sessionId}`, {
      ...context,
      ...browser,
      kind: 'register',
      challenge: options.challenge,
      expires: Date.now() + PASSKEY_TTL,
      accountHash: proofHash(user),
      name: body.name.trim(),
    });
    return { options };
  }
  async verifyRegistration(req: Request, raw: unknown) {
    this.auth.assertSecurityChangeAllowed();
    const context = this.context(req);
    const browser = this.browser(req);
    const body = this.object(raw, ['response']);
    const ceremony = this.take(`register:${browser.sessionId}`, 'register', context);
    if (ceremony.userId !== browser.userId || !ceremony.name || !body.response || typeof body.response !== 'object') throw fail();
    const user = await this.users.getUserById(browser.userId);
    if (!user || ceremony.accountHash !== proofHash(user)) throw fail();
    let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verification = await verifyRegistrationResponse({
        response: body.response as RegistrationResponseJSON,
        expectedChallenge: ceremony.challenge,
        expectedOrigin: context.origin,
        expectedRPID: context.rpID,
        requireUserVerification: true,
        supportedAlgorithmIDs: [-7, -257],
      });
    } catch {
      throw fail();
    }
    if (!verification.verified || !verification.registrationInfo) throw fail();
    const { credential } = verification.registrationInfo;
    await this.store.change(async (state) => {
      const currentUser = await this.users.getUserById(browser.userId);
      this.auth.assertSecurityChangeAllowed();
      if (!currentUser || proofHash(currentUser) !== ceremony.accountHash) throw fail();
      this.browser(req);
      const account = state.users[browser.userId];
      if (!account || account.credentials.length >= 10 || Object.values(state.users).some((u) => u.credentials.some((c) => c.id === credential.id)))
        throw fail();
      account.credentials.push({
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter,
        name: ceremony.name ?? 'Passkey',
        rpID: context.rpID,
        createdAt: Date.now(),
        lastUsedAt: null,
        transports: [...new Set(credential.transports ?? [])]
          .filter((value): value is StoredPasskey['transports'][number] => transports.has(value))
          .slice(0, 8),
      });
    });
    return { success: true };
  }
  async loginOptions(req: Request, raw: unknown) {
    const context = this.context(req);
    this.object(raw, []);
    this.prune();
    const previous = req.cookies?.[PASSKEY_COOKIE];
    if (typeof previous === 'string') this.challenges.delete(previous);
    await this.store.snapshot();
    const options = await generateAuthenticationOptions({ rpID: context.rpID, timeout: PASSKEY_TTL, userVerification: 'required' });
    this.prune();
    const id = randomUUID();
    this.challenges.set(id, { ...context, kind: 'login', challenge: options.challenge, expires: Date.now() + PASSKEY_TTL });
    return { id, options };
  }
  async verifyLogin(req: Request, raw: unknown) {
    const context = this.context(req);
    const body = this.object(raw, ['response', 'redirectUrl']);
    const ceremony = this.take(req.cookies?.[PASSKEY_COOKIE], 'login', context);
    const response = body.response as AuthenticationResponseJSON | undefined;
    if (
      !response ||
      typeof response.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,2048}$/.test(response.id) ||
      typeof response.response?.userHandle !== 'string'
    )
      throw fail();
    return this.store.change(
      async (state) => {
        const entry = Object.entries(state.users).find(([, account]) =>
          account.credentials.some((credential) => credential.id === response.id && credential.rpID === context.rpID),
        );
        if (!entry || entry[1].handle !== response.response.userHandle) throw fail();
        const credential = entry[1].credentials.find((value) => value.id === response.id);
        if (!credential) throw fail();
        let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
        try {
          verification = await verifyAuthenticationResponse({
            response,
            expectedChallenge: ceremony.challenge,
            expectedOrigin: context.origin,
            expectedRPID: context.rpID,
            requireUserVerification: true,
            credential: {
              id: credential.id,
              publicKey: new Uint8Array(Buffer.from(credential.publicKey, 'base64url')),
              counter: credential.counter,
              transports: credential.transports,
            },
          });
        } catch {
          throw fail();
        }
        if (!verification.verified) throw fail();
        credential.counter = verification.authenticationInfo.newCounter;
        credential.lastUsedAt = Date.now();
        return { userId: Number(entry[0]), totpAfterPasskey: entry[1].totpAfterPasskey };
      },
      async ({ userId, totpAfterPasskey }) => {
        // Keep credential revocation and new-session creation in the same serialized operation.
        this.auth.assertSecurityChangeAllowed();
        const user = await this.users.getUserById(userId);
        this.auth.assertSecurityChangeAllowed();
        if (!user) throw fail();
        if (totpAfterPasskey && totpAfterPasskey === totpBinding(user)) return this.auth.beginVerifiedLogin(user);
        return { sessionId: await this.sessions.createSession(userId) };
      },
    );
  }
  async remove(req: Request, raw: unknown) {
    this.context(req);
    const { userId } = this.browser(req);
    const body = this.object(raw, ['id', 'password', 'totpCode']);
    if (typeof body.id !== 'string' || typeof body.password !== 'string' || (body.totpCode !== undefined && typeof body.totpCode !== 'string'))
      throw fail();
    await this.auth.verifySensitiveAction(userId, body.password, body.totpCode as string | undefined);
    await this.store.change(
      (state) => {
        this.browser(req);
        const user = state.users[userId];
        if (user) user.credentials = user.credentials.filter((key) => key.id !== body.id);
      },
      async () => {
        await this.sessions.destroyAllSessionsByUserId(userId);
      },
    );
    for (const [id, value] of this.challenges) if (value.userId === userId) this.challenges.delete(id);
    return { success: true };
  }
}
