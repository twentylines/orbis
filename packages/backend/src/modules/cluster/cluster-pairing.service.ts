import { randomBytes, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { UserRepository } from '../user/user.repository';
import { ClusterStateService, clusterName, type ClusterState } from './cluster-state.service';
import { bindClusterCertificate, clusterCertificate, type ClusterCertificate } from './cluster-certificate';
import { clusterRequest, digest, accountPairingCodeHash, equalSecret, PAIRING_AUTH_PROTOCOL } from './cluster-transport';

const invalid = 'Pairing code or authorization expired. Generate a new code on the other server.';
const denied = 'The other server could not authorize pairing. Check its password and authentication code.';
const uncertain = 'Pairing was not confirmed. Check cluster status on both servers before reconnecting.';
const limited = 'Too many pairing attempts. Wait five minutes and generate a new code.';
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const token = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
type Actor = { userId: number; session: string };
type Proposal = { requestId: string; adminId: string; adminName: string; clusterName: string; secret: string; name?: string };
type Target = { origin: string; certificateSha256?: string };
type Challenge = { protocol: typeof PAIRING_AUTH_PROTOCOL; id: string; name: string; challenge: string; expiresAt: string; totpRequired: boolean };
type RemotePending = { hostId: string; inviteHash: string; ownerId: number; proposal: Proposal; target: Target; expiresAt: number };
type Pending = {
  actor: Actor;
  proposal: Proposal;
  url: string;
  certificate?: ClusterCertificate;
  remote: Challenge;
  expiresAt: number;
  status: 'ready' | 'applying' | 'unknown';
};

function fields(body: unknown, allowed: string[]): asserts body is Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !allowed.includes(key)))
    throw new BadRequestException('Provide only the requested pairing details.');
}
function proposal(input: unknown): Proposal {
  fields(input, ['requestId', 'adminId', 'adminName', 'clusterName', 'secret', 'name']);
  if (!uuid(input.requestId) || !uuid(input.adminId) || !token(input.secret)) throw new BadRequestException('Invalid pairing request.');
  return {
    requestId: input.requestId,
    adminId: input.adminId,
    adminName: clusterName(input.adminName),
    clusterName: clusterName(input.clusterName),
    secret: input.secret,
    ...(input.name === undefined ? {} : { name: clusterName(input.name) }),
  };
}
function target(input: unknown): Target {
  fields(input, ['origin', 'certificateSha256']);
  if (typeof input.origin !== 'string' || input.origin.length > 2048) throw new BadRequestException('Use HTTPS for account pairing.');
  let url: URL;
  try {
    url = new URL(typeof input.origin === 'string' ? input.origin : 'invalid:');
  } catch {
    throw new BadRequestException('Use HTTPS for account pairing.');
  }
  if (url.protocol !== 'https:' || url.origin !== input.origin || (input.certificateSha256 !== undefined && !token(input.certificateSha256)))
    throw new BadRequestException('Use HTTPS for account pairing.');
  return { origin: url.origin, ...(input.certificateSha256 === undefined ? {} : { certificateSha256: input.certificateSha256 }) };
}
function credentials(body: Record<string, unknown>) {
  if (
    typeof body.password !== 'string' ||
    !body.password ||
    body.password.length > 1024 ||
    (body.totpCode !== undefined && (typeof body.totpCode !== 'string' || !/^\d{6}$/.test(body.totpCode)))
  )
    throw new UnauthorizedException(denied);
  return { password: body.password, totpCode: body.totpCode as string | undefined };
}

@Injectable()
export class ClusterPairingService {
  private pending = new Map<string, Pending>();
  private challenges = new Map<string, RemotePending>();
  private attempts = new Map<string, { count: number; expiresAt: number }>();
  constructor(
    private readonly state: ClusterStateService,
    private readonly auth: AuthService,
    private readonly users: UserRepository,
  ) {}

  private sweep() {
    const now = Date.now();
    for (const [key, entry] of this.pending) if (entry.expiresAt <= now && entry.status !== 'applying') this.pending.delete(key);
    for (const [key, entry] of this.challenges) if (entry.expiresAt <= now) this.challenges.delete(key);
    for (const [key, entry] of this.attempts) if (entry.expiresAt <= now) this.attempts.delete(key);
  }

  private admin(state: ClusterState, url?: string) {
    if (state.role !== 'admin') throw new ForbiddenException('Create a cluster on its admin server first.');
    if (state.peers.length >= 12) throw new ConflictException('A cluster supports up to 12 paired servers.');
    if (url && state.peers.some((peer) => peer.url === url)) throw new ConflictException('This address is already paired.');
  }

  async connect(body: Record<string, unknown>, actor: Actor) {
    fields(body, ['password', 'totpCode', 'url', 'code', 'name', 'peerCertificatePem', 'peerCertificateSha256', 'confirmPeerCertificate']);
    const local = credentials(body);
    const user = await this.auth.verifySensitiveAction(actor.userId, local.password, local.totpCode);
    if (!user.operator) throw new ForbiddenException('An operator account is required for pairing.');
    const url = this.state.validatePeerUrl(body.url, false);
    if (!url.startsWith('https://')) throw new BadRequestException('Use HTTPS for account pairing.');
    const certificate = clusterCertificate(body);
    const code = typeof body.code === 'string' ? body.code.toUpperCase().replace(/\s/g, '') : '';
    if (!/^[A-F0-9]{24}$/.test(code)) throw new BadRequestException('Enter the 24-character pairing code from the joining server.');
    const current = await this.state.read();
    this.admin(current, url);
    this.sweep();
    if (this.pending.size >= 64) throw new HttpException(limited, 429);
    const proposed: Proposal = {
      requestId: randomUUID(),
      adminId: current.id,
      adminName: current.serverName,
      clusterName: current.name,
      secret: randomBytes(32).toString('hex'),
      ...(body.name === undefined ? {} : { name: clusterName(body.name) }),
    };
    const remote = await clusterRequest<Challenge>(
      url,
      '/api/cluster/pairing/challenge',
      {
        protocol: PAIRING_AUTH_PROTOCOL,
        code,
        proposal: proposed,
        target: { origin: url, ...(certificate ? { certificateSha256: certificate.sha256 } : {}) },
      },
      {},
      false,
      certificate,
    );
    if (
      !remote ||
      remote.protocol !== PAIRING_AUTH_PROTOCOL ||
      !uuid(remote.id) ||
      remote.id === current.id ||
      !token(remote.challenge) ||
      typeof remote.totpRequired !== 'boolean' ||
      typeof remote.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(remote.expiresAt)) ||
      Date.parse(remote.expiresAt) <= Date.now() ||
      Date.parse(remote.expiresAt) > Date.now() + 120_000
    )
      throw new ConflictException('Update both servers and generate a new pairing code.');
    const name = clusterName(remote.name);
    const latest = await this.state.read();
    this.admin(latest, url);
    if (latest.id !== current.id || latest.name !== current.name || latest.serverName !== current.serverName)
      throw new ConflictException('Cluster changed. Connect to the other server again.');
    for (const [key, entry] of this.pending) if (entry.actor.session === actor.session && entry.status === 'ready') this.pending.delete(key);
    if (this.pending.size >= 64) throw new HttpException(limited, 429);
    const id = randomBytes(32).toString('hex');
    this.pending.set(digest(id), {
      actor: { ...actor },
      proposal: proposed,
      url,
      certificate,
      remote: { ...remote, name },
      expiresAt: Date.parse(remote.expiresAt),
      status: 'ready',
    });
    return { pendingId: id, id: remote.id, name, origin: url, totpRequired: remote.totpRequired, expiresAt: remote.expiresAt };
  }

  async complete(body: Record<string, unknown>, actor: Actor) {
    fields(body, ['pendingId', 'password', 'totpCode']);
    const remoteAuth = credentials(body);
    this.sweep();
    const pending = token(body.pendingId) ? this.pending.get(digest(body.pendingId)) : undefined;
    if (!pending || pending.actor.userId !== actor.userId || !equalSecret(pending.actor.session, actor.session) || pending.expiresAt <= Date.now())
      throw new UnauthorizedException(invalid);
    if (pending.status !== 'ready') throw new ConflictException(uncertain);
    pending.status = 'applying';
    try {
      const state = await this.state.read();
      this.admin(state, pending.url);
      if (state.id !== pending.proposal.adminId || state.name !== pending.proposal.clusterName || state.serverName !== pending.proposal.adminName)
        throw new ConflictException('Cluster changed. Connect to the other server again.');
    } catch (error) {
      pending.status = 'ready';
      throw error;
    }
    let result: { protocol: string; id: string; name: string; requestId: string };
    try {
      result = await clusterRequest(
        pending.url,
        '/api/cluster/pairing/authorize',
        { protocol: PAIRING_AUTH_PROTOCOL, challenge: pending.remote.challenge, ...remoteAuth },
        {},
        false,
        pending.certificate,
      );
    } catch (error) {
      if (error instanceof HttpException && [400, 401, 403, 409, 429].includes(error.getStatus())) {
        pending.status = 'ready';
        throw error;
      }
      pending.status = 'unknown';
      throw new ServiceUnavailableException(uncertain);
    }
    if (!result || result.protocol !== PAIRING_AUTH_PROTOCOL || result.id !== pending.remote.id || result.requestId !== pending.proposal.requestId) {
      pending.status = 'unknown';
      throw new ConflictException(uncertain);
    }
    try {
      await this.state.transaction((current) => {
        this.admin(current, pending.url);
        if (
          current.id !== pending.proposal.adminId ||
          current.name !== pending.proposal.clusterName ||
          current.serverName !== pending.proposal.adminName ||
          current.peers.some((peer) => peer.id === result.id)
        )
          throw new ConflictException(uncertain);
        current.peers.push({
          id: result.id,
          name: clusterName(result.name),
          url: pending.url,
          secret: pending.proposal.secret,
          insecureLan: false,
          ...(pending.certificate
            ? { tls: bindClusterCertificate(pending.certificate, current.id, result.id, pending.url, pending.proposal.secret) }
            : {}),
        });
      });
    } catch {
      pending.status = 'unknown';
      throw new ConflictException(uncertain);
    }
    this.pending.delete(digest(body.pendingId as string));
    return {
      paired: true,
      id: result.id,
      name: clusterName(result.name),
      ...(pending.certificate ? { certificateSha256: pending.certificate.sha256 } : {}),
    };
  }

  async challenge(body: Record<string, unknown>) {
    fields(body, ['protocol', 'code', 'proposal', 'target']);
    if (body.protocol !== PAIRING_AUTH_PROTOCOL) throw new ConflictException('Update both servers and generate a new pairing code.');
    const proposed = proposal(body.proposal);
    const destination = target(body.target);
    const current = await this.state.read();
    const invite = current.invite;
    if (
      current.role !== 'standalone' ||
      !invite ||
      invite.authVersion !== 2 ||
      !Number.isSafeInteger(invite.ownerId) ||
      !invite.ownerId ||
      invite.expiresAt <= Date.now() ||
      typeof body.code !== 'string' ||
      !/^[A-Fa-f0-9]{24}$/.test(body.code) ||
      !equalSecret(accountPairingCodeHash(body.code), invite.hash) ||
      current.id === proposed.adminId
    )
      throw new UnauthorizedException(invalid);
    const user = await this.users.getUserDtoById(invite.ownerId);
    if (!user?.operator) throw new UnauthorizedException(invalid);
    this.sweep();
    const attempt = this.attempts.get(invite.hash);
    if ((attempt?.count ?? 0) >= 5 || this.challenges.size >= 64) throw new HttpException(limited, 429);
    const challenge = randomBytes(32).toString('hex');
    const expiresAt = Math.min(invite.expiresAt, Date.now() + 120_000);
    this.challenges.set(digest(challenge), {
      hostId: current.id,
      inviteHash: invite.hash,
      ownerId: invite.ownerId,
      proposal: proposed,
      target: destination,
      expiresAt,
    });
    return {
      protocol: PAIRING_AUTH_PROTOCOL,
      id: current.id,
      name: current.serverName,
      challenge,
      expiresAt: new Date(expiresAt).toISOString(),
      totpRequired: user.totpEnabled,
    };
  }

  async authorize(body: Record<string, unknown>) {
    fields(body, ['protocol', 'challenge', 'password', 'totpCode']);
    this.sweep();
    const key = token(body.challenge) ? digest(body.challenge) : '';
    const pending = this.challenges.get(key);
    if (body.protocol !== PAIRING_AUTH_PROTOCOL || !pending) throw new UnauthorizedException(invalid);
    const auth = credentials(body);
    const attempts = this.attempts.get(pending.inviteHash) ?? { count: 0, expiresAt: Date.now() + 300_000 };
    if (attempts.count >= 5) throw new HttpException(limited, 429);
    attempts.count++;
    this.attempts.set(pending.inviteHash, attempts);
    try {
      const user = await this.auth.verifySensitiveAction(pending.ownerId, auth.password, auth.totpCode);
      if (!user.operator) throw new UnauthorizedException();
    } catch {
      throw new UnauthorizedException(denied);
    }
    const result = await this.state.transaction(async (state) => {
      const currentUser = await this.users.getUserDtoById(pending.ownerId);
      if (!currentUser?.operator) throw new UnauthorizedException(denied);
      const invite = state.invite;
      if (
        this.challenges.get(key) !== pending ||
        pending.expiresAt <= Date.now() ||
        state.role !== 'standalone' ||
        state.id !== pending.hostId ||
        !invite ||
        invite.authVersion !== 2 ||
        invite.ownerId !== pending.ownerId ||
        invite.hash !== pending.inviteHash ||
        invite.expiresAt <= Date.now() ||
        state.id === pending.proposal.adminId
      )
        throw new UnauthorizedException(invalid);
      state.name = pending.proposal.clusterName;
      state.serverName = pending.proposal.name ?? state.serverName;
      state.admin = { id: pending.proposal.adminId, name: pending.proposal.adminName, secret: pending.proposal.secret };
      state.role = 'member';
      state.nonces = [];
      delete state.invite;
      return { protocol: PAIRING_AUTH_PROTOCOL, id: state.id, name: state.serverName, requestId: pending.proposal.requestId };
    });
    for (const [id, entry] of this.challenges) if (entry.inviteHash === pending.inviteHash) this.challenges.delete(id);
    return result;
  }
}
