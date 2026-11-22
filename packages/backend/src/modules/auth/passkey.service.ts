import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { BadRequestException, ForbiddenException, Injectable, Optional, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
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
import { sensitiveAccountBinding } from './sensitive-action-context';
import { credentialWriters } from '../sentinel-recovery/writer-gate';
import { CredentialSynchronization } from '../sentinel-recovery/credential-synchronization.service';
import { MainPasskeySynchronization } from '../sentinel-recovery/main-passkey-synchronization.service';
import type { MainCounterCeremony } from '../sentinel-recovery/host-broker';

export const PASSKEY_COOKIE = 'orbis-passkey-ceremony';
export const PASSKEY_TTL = 5 * 60_000;
type Context = { origin: string; rpID: string };
type Ceremony = Context & {
  challenge: string;
  expires: number;
  kind: 'register' | 'login' | 'sensitive';
  userId?: number;
  sessionId?: string;
  accountHash?: string;
  name?: string;
  actionBinding?: string;
  securityBinding?: string;
  counter?: MainCounterCeremony;
};
type PasskeyUser = NonNullable<Awaited<ReturnType<UserRepository['getUserById']>>>;
const proofHash = (user: PasskeyUser) =>
  createHash('sha256').update(`${user.password}/${user.totpEnabled}/${user.totpSecret}/${user.salt}`).digest('hex');
const totpBinding = (user: PasskeyUser) =>
  user.totpEnabled && user.totpSecret && user.salt ? createHash('sha256').update(`${user.totpSecret}/${user.salt}`).digest('hex') : null;
const accountPolicy = (account: Pick<PasskeyState['users'][string], 'totpAfterPasskey'> | undefined, user: PasskeyUser) => {
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
    @Optional() private readonly credentialSync?: CredentialSynchronization,
    @Optional() private readonly counterSync?: MainPasskeySynchronization,
  ) {}
  private credentialChanges() {
    if (!this.credentialSync)
      throw new ServiceUnavailableException('The credential change could not be verified. Check recovery before trying again.');
    return this.credentialSync;
  }
  private async recheckCredentialAccount(user: Readonly<PasskeyUser>, req: Request) {
    const current = await this.users.getUserById(user.id);
    this.auth.assertSecurityChangeAllowed();
    this.browser(req);
    if (!current || proofHash(current) !== proofHash(user)) throw fail();
  }
  private counterChanges() {
    if (!this.counterSync) throw new ServiceUnavailableException('The passkey could not be synchronized. Check recovery before trying again.');
    return this.counterSync;
  }
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
  updatePolicy = credentialWriters.wrap(async (req: Request, raw: unknown) => {
    this.context(req);
    const { userId } = this.browser(req);
    const body = this.object(raw, ['requireTotpAfterPasskey', 'password', 'totpCode']);
    if (
      typeof body.requireTotpAfterPasskey !== 'boolean' ||
      typeof body.password !== 'string' ||
      (body.totpCode !== undefined && typeof body.totpCode !== 'string')
    )
      throw fail();
    return this.credentialChanges().change({
      accountId: userId,
      authorize: async (user) => {
        const proof = await this.auth.verifySensitiveAction(userId, body.password as string, body.totpCode as string | undefined);
        if (proofHash(user) !== proofHash(proof)) throw fail();
        await this.recheckCredentialAccount(user, req);
      },
      plan: (user, state) => {
        const binding = totpBinding(user);
        const account = state.users[userId];
        if (body.requireTotpAfterPasskey) {
          if (!binding) throw new BadRequestException('Enable authenticator codes before requiring them after passkey sign-in.');
          if (!account?.credentials.length) throw new BadRequestException('Add a passkey before requiring an extra verification.');
          account.totpAfterPasskey = binding;
        } else if (account) delete account.totpAfterPasskey;
        return { patch: {}, value: accountPolicy(account, user) };
      },
    });
  });
  registrationOptions = credentialWriters.wrap(async (req: Request, raw: unknown) => {
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
    this.prune();
    const authorize = async (user: Readonly<PasskeyUser>) => {
      const proof = await this.auth.verifySensitiveAction(browser.userId, body.password as string, body.totpCode as string | undefined);
      if (proofHash(user) !== proofHash(proof)) throw fail();
      await this.recheckCredentialAccount(user, req);
    };
    const existing = await this.credentialChanges().inspect(browser.userId, async (user, state) => {
      const account = state.users[user.id];
      if (!account) return null;
      await authorize(user);
      if (account.credentials.length >= 10) throw new BadRequestException('Remove a passkey before adding another.');
      return { user: structuredClone(user), account: structuredClone(account) };
    });
    const { user, account } =
      existing ??
      (await this.credentialChanges().change({
        accountId: browser.userId,
        authorize,
        plan: (user, state) => {
          const current = state.users[user.id] ?? { handle: randomBytes(32).toString('base64url'), credentials: [] };
          if (current.credentials.length >= 10 || (!state.users[user.id] && Object.keys(state.users).length >= 256))
            throw new BadRequestException('Remove a passkey before adding another.');
          state.users[user.id] = current;
          return { patch: {}, value: { user: structuredClone(user), account: structuredClone(current) } };
        },
      }));
    const options = await generateRegistrationOptions({
      rpName: 'Orbis',
      rpID: context.rpID,
      userID: new Uint8Array(Buffer.from(account.handle, 'base64url')),
      userName: user.username,
      attestationType: 'none',
      timeout: PASSKEY_TTL,
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      excludeCredentials: account.credentials
        .filter((key) => key.rpID === context.rpID)
        .map(({ id, transports }) => ({ id, transports: [...transports] })),
      supportedAlgorithmIDs: [-7, -257],
    });
    this.auth.assertSecurityChangeAllowed();
    this.browser(req);
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
  });
  verifyRegistration = credentialWriters.wrap(async (req: Request, raw: unknown) => {
    this.auth.assertSecurityChangeAllowed();
    const context = this.context(req);
    const browser = this.browser(req);
    const body = this.object(raw, ['response']);
    const ceremony = this.take(`register:${browser.sessionId}`, 'register', context);
    if (ceremony.userId !== browser.userId || !ceremony.name || !body.response || typeof body.response !== 'object') throw fail();
    let enrolled: StoredPasskey | undefined;
    return this.credentialChanges().change({
      accountId: browser.userId,
      authorize: async (user) => {
        this.auth.assertSecurityChangeAllowed();
        this.browser(req);
        if (ceremony.expires <= Date.now() || ceremony.accountHash !== proofHash(user)) throw fail();
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
        await this.recheckCredentialAccount(user, req);
        if (ceremony.expires <= Date.now()) throw fail();
        const { credential } = verification.registrationInfo;
        enrolled = {
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
        };
      },
      plan: (_user, state) => {
        const credential = enrolled;
        const account = state.users[browser.userId];
        if (
          !credential ||
          !account ||
          account.credentials.length >= 10 ||
          Object.values(state.users).some((u) => u.credentials.some((c) => c.id === credential.id))
        )
          throw fail();
        account.credentials.push(credential);
        return { patch: {}, value: { success: true } };
      },
    });
  });
  async loginOptions(req: Request, raw: unknown) {
    const context = this.context(req);
    this.object(raw, []);
    this.prune();
    const previous = req.cookies?.[PASSKEY_COOKIE];
    if (typeof previous === 'string') this.challenges.delete(previous);
    await this.store.snapshot();
    const id = randomUUID();
    const counter = await this.counterChanges().prepare({
      ...context,
      purpose: 'login',
      ceremonyBinding: createHash('sha256')
        .update(JSON.stringify(['login', id, context]))
        .digest('hex'),
    });
    const options = await generateAuthenticationOptions({
      rpID: context.rpID,
      timeout: counter.mode === 'managed' ? 120_000 : PASSKEY_TTL,
      userVerification: 'required',
      ...(counter.mode === 'managed'
        ? {
            challenge: new Uint8Array(Buffer.from(counter.challenge ?? '', 'base64url')),
            allowCredentials: counter.credentialIds?.map((id) => ({ id })),
          }
        : {}),
    });
    this.prune();
    this.challenges.set(id, {
      ...context,
      kind: 'login',
      challenge: options.challenge,
      expires: counter.expiresAtMs ?? Date.now() + PASSKEY_TTL,
      counter,
    });
    return { id, options };
  }
  async sensitiveOptions(req: Request, actionBinding: string) {
    const context = this.context(req);
    const actor = await this.auth.operatorActionContext(req);
    if (!/^[a-f0-9]{64}$/.test(actionBinding)) throw fail();
    const state = await this.store.snapshot();
    const user = await this.users.getUserById(actor.userId);
    const account = state.users[actor.userId];
    const credentials = account?.credentials.filter((credential) => credential.rpID === context.rpID) ?? [];
    if (!user?.operator || !credentials.length || sensitiveAccountBinding(user, structuredClone(state) as PasskeyState) !== actor.securityBinding)
      throw fail();
    this.prune();
    const id = randomUUID();
    const counter = await this.counterChanges().prepare({
      ...context,
      purpose: 'sensitive',
      ceremonyBinding: createHash('sha256')
        .update(JSON.stringify(['sensitive', id, context, actor, actionBinding]))
        .digest('hex'),
    });
    if (counter.mode === 'managed' && (counter.accountId !== actor.userId || !credentials.some((key) => counter.credentialIds?.includes(key.id))))
      throw fail();
    const options = await generateAuthenticationOptions({
      rpID: context.rpID,
      timeout: 2 * 60_000,
      userVerification: 'required',
      ...(counter.mode === 'managed' ? { challenge: new Uint8Array(Buffer.from(counter.challenge ?? '', 'base64url')) } : {}),
      allowCredentials: credentials
        .filter((key) => counter.mode !== 'managed' || counter.credentialIds?.includes(key.id))
        .map(({ id, transports }) => ({ id, transports })),
    });
    this.prune();
    const expires = Math.min(counter.expiresAtMs ?? Number.POSITIVE_INFINITY, Date.now() + 2 * 60_000);
    this.challenges.set(id, {
      ...context,
      kind: 'sensitive',
      challenge: options.challenge,
      expires,
      userId: actor.userId,
      sessionId: actor.sessionBinding,
      securityBinding: actor.securityBinding,
      actionBinding,
      counter,
    });
    const { extensions: _extensions, ...publicOptions } = options;
    return { challengeId: id, options: publicOptions, expiresAt: expires, requiresTotp: accountPolicy(account, user).requireTotpAfterPasskey };
  }
  verifySensitive = credentialWriters.wrap(async (req: Request, actionBinding: string, raw: unknown) => {
    const context = this.context(req);
    const body = this.object(raw, ['challengeId', 'response', 'totpCode']);
    const ceremony = this.take(body.challengeId, 'sensitive', context);
    const actor = await this.auth.operatorActionContext(req);
    if (
      ceremony.userId !== actor.userId ||
      ceremony.sessionId !== actor.sessionBinding ||
      ceremony.securityBinding !== actor.securityBinding ||
      ceremony.actionBinding !== actionBinding
    )
      throw fail();
    const response = body.response as AuthenticationResponseJSON | undefined;
    if (
      !response ||
      typeof response.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,2048}$/.test(response.id) ||
      !response.response ||
      typeof response.response !== 'object' ||
      (body.totpCode !== undefined && (typeof body.totpCode !== 'string' || !/^\d{6}$/.test(body.totpCode)))
    )
      throw fail();
    if (!ceremony.counter) throw fail();
    return this.counterChanges().verify({
      ceremony: ceremony.counter,
      challenge: ceremony.challenge,
      ...context,
      response,
      authorize: async (state, repository) => {
        const account = state.users[actor.userId];
        const user = await repository.getUserById(actor.userId);
        const credential = account?.credentials.find((value) => value.id === response.id && value.rpID === context.rpID);
        if (
          !user?.operator ||
          !account ||
          !credential ||
          sensitiveAccountBinding(user, structuredClone(state) as PasskeyState) !== actor.securityBinding ||
          (response.response.userHandle != null && response.response.userHandle !== account.handle)
        )
          throw fail();
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
              transports: [...credential.transports],
            },
          });
        } catch {
          throw fail();
        }
        if (!verification.verified) throw fail();
        if (accountPolicy(account, user).requireTotpAfterPasskey)
          await this.auth.verifyPasskeyActionCode(user.id, body.totpCode as string | undefined);
        this.auth.assertSecurityChangeAllowed();
        const current = await repository.getUserById(user.id);
        const browser = this.browser(req);
        if (
          ceremony.expires <= Date.now() ||
          !current?.operator ||
          sensitiveAccountBinding(current, structuredClone(state) as PasskeyState) !== actor.securityBinding ||
          browser.userId !== actor.userId ||
          createHash('sha256').update(browser.sessionId).digest('hex') !== actor.sessionBinding
        )
          throw fail();
        return { accountId: user.id, credentialId: credential.id, newCounter: verification.authenticationInfo.newCounter, value: actor };
      },
      afterSuccess: async (actor) => {
        this.auth.assertSecurityChangeAllowed();
        return actor;
      },
    });
  });
  verifyLogin = credentialWriters.wrap(async (req: Request, raw: unknown) => {
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
    if (!ceremony.counter) throw fail();
    return this.counterChanges().verify({
      ceremony: ceremony.counter,
      challenge: ceremony.challenge,
      ...context,
      response,
      authorize: async (state, repository) => {
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
              transports: [...credential.transports],
            },
          });
        } catch {
          throw fail();
        }
        if (!verification.verified) throw fail();
        const user = await repository.getUserById(Number(entry[0]));
        if (!user) throw fail();
        return {
          accountId: user.id,
          credentialId: credential.id,
          newCounter: verification.authenticationInfo.newCounter,
          value: { userId: user.id, totpAfterPasskey: entry[1].totpAfterPasskey, accountHash: proofHash(user) },
        };
      },
      afterSuccess: async ({ userId, totpAfterPasskey, accountHash }) => {
        // Keep credential revocation and new-session creation in the same serialized operation.
        this.auth.assertSecurityChangeAllowed();
        const user = await this.users.getUserById(userId);
        this.auth.assertSecurityChangeAllowed();
        if (!user || proofHash(user) !== accountHash) throw fail();
        if (totpAfterPasskey && totpAfterPasskey === totpBinding(user)) return this.auth.beginVerifiedLogin(user);
        return { sessionId: await this.sessions.createSession(userId) };
      },
    });
  });
  remove = credentialWriters.wrap(async (req: Request, raw: unknown) => {
    this.context(req);
    const { userId } = this.browser(req);
    const body = this.object(raw, ['id', 'password', 'totpCode']);
    if (typeof body.id !== 'string' || typeof body.password !== 'string' || (body.totpCode !== undefined && typeof body.totpCode !== 'string'))
      throw fail();
    return this.credentialChanges().change({
      accountId: userId,
      authorize: async (user) => {
        const proof = await this.auth.verifySensitiveAction(userId, body.password as string, body.totpCode as string | undefined);
        if (proofHash(user) !== proofHash(proof)) throw fail();
        await this.recheckCredentialAccount(user, req);
      },
      plan: (_user, state) => {
        const user = state.users[userId];
        if (user) user.credentials = user.credentials.filter((key) => key.id !== body.id);
        return { patch: {}, value: { success: true } };
      },
      afterSuccess: async (value: { success: boolean }) => {
        await this.sessions.destroyAllSessionsByUserId(userId);
        for (const [id, value] of this.challenges) if (value.userId === userId) this.challenges.delete(id);
        return value;
      },
    });
  });
}
