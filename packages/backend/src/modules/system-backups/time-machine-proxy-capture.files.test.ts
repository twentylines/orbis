import { HttpException } from '@nestjs/common';
import { decodeControllerCaptureAuthority } from '../host-updates/host-controller-capture-authority';
import { createCaptureCoherenceReceipt } from './time-machine-capture-coherence';
import { canonicalRuntimeJson, runtimePayload } from './time-machine-runtime-payload';
import type { ControllerPublicationReceipt } from '../host-updates/host-controller-publication';
import { createHash } from 'node:crypto';
import { canonicalAppRuntimeJson, decodeAppRuntimeCapture } from './time-machine-app-runtime-capture';
import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TimeMachineCaptureRuntime } from './time-machine-capture-runtime';
import { connectedCaptureFixture } from './time-machine-capture.fixture';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
it('defaults to v4 host policy support and pins it inside the capture lease before quiescence', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-capture-')));
  roots.push(root);
  await fs.chmod(root, 0o700);
  await fs.writeFile(path.join(root, '.env'), 'DISPOSABLE_FIXTURE=true', { mode: 0o600 });
  const config = { get: (name: string) => (name === 'directories' ? { dataDir: root } : name === 'architecture' ? 'arm64' : undefined) };
  const fixture = await connectedCaptureFixture(root, config);
  const prepareProxyHostIdentity = vi.fn(async () => ({ fixture: 'root-protected-policy' }));
  const acquire = fixture.host.acquireControllerCaptureFence.getMockImplementation();
  if (!acquire) throw new Error('Missing capture fence fixture');
  fixture.host.acquireControllerCaptureFence.mockImplementation(async (...args) => ({ ...(await acquire(...args)), prepareProxyHostIdentity }));
  const host = { ...fixture.host, requireProxyHostIdentity: vi.fn(async () => undefined) };
  const apps = { requireNoPendingAppImageUpdates: vi.fn(async () => undefined) };
  const docker = { getContainer: () => ({ inspect: async () => ({ Id: fixture.ids.core, Image: fixture.image.id }) }) };
  const runtime = new TimeMachineCaptureRuntime(
    ...([config, host, apps, docker, fixture.engine] as unknown as ConstructorParameters<typeof TimeMachineCaptureRuntime>),
  );
  const signal = new AbortController().signal;
  const gatedV6 = new TimeMachineCaptureRuntime(
    ...([config, host, apps, docker, fixture.engine, 6] as unknown as ConstructorParameters<typeof TimeMachineCaptureRuntime>),
  );
  await expect(gatedV6.requireSupport(signal)).rejects.toMatchObject({ response: { code: 'host-capture-support-required' } });
  expect(host.requireControllerCaptureAuthoritySupport).not.toHaveBeenCalled();
  await runtime.requireSupport(signal);
  expect(host.requireControllerCaptureAuthoritySupport).toHaveBeenCalledWith(signal, 2);
  expect(host.requireProxyHostIdentity).toHaveBeenCalledWith(signal);
  const operation = runtime.operation('11111111-1111-4111-8111-111111111111', signal, () => undefined);
  try {
    await operation.hostPreflight(signal);
    expect((fixture.host.acquireControllerCaptureFence.mock.calls as unknown[][])[0]?.[4]).toBe(true);
    expect(prepareProxyHostIdentity).toHaveBeenCalledTimes(1);
    expect(fixture.engine.saveImage).not.toHaveBeenCalled();
  } finally {
    await operation.dispose();
  }
  host.requireProxyHostIdentity.mockRejectedValueOnce(new Error('Legacy proxy storage overlaps capture'));
  await expect(runtime.requireSupport(signal)).rejects.toMatchObject({ response: { code: 'proxy-layout-migration-required' } });
});

it('prepares v6 replica images from the protected runtime before quiescence under the closed support gate', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'v6-capture-prep-')));
  roots.push(root);
  await fs.chmod(root, 0o700);
  await fs.writeFile(path.join(root, '.env'), 'DISPOSABLE_FIXTURE=true', { mode: 0o600 });
  const config = {
    get: (name: string) =>
      name === 'directories' ? { dataDir: root } : name === 'architecture' ? 'arm64' : name === 'envFilePath' ? path.join(root, '.env') : undefined,
  };
  const fixture = await connectedCaptureFixture(root, config);
  const first = fixture.values.get(fixture.ids.app);
  if (!first) throw new Error('Missing app fixture');
  const second = { ...first, id: 'e'.repeat(64), running: false };
  fixture.values.set(second.id, second);
  const core = fixture.values.get(fixture.ids.core);
  if (!core) throw new Error('Missing controller fixture');
  const proxy = { ...core, id: 'd'.repeat(64), service: 'runtipi-reverse-proxy', reference: 'traefik:v3' };
  fixture.values.set(proxy.id, proxy);
  let protectedRuntime: ReturnType<typeof decodeAppRuntimeCapture> | undefined;
  const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
  const acquire = fixture.host.acquireControllerCaptureFence.getMockImplementation();
  if (!acquire) throw new Error('Missing fence fixture');
  const prepareAppRuntime = vi.fn(async (expected: Parameters<typeof acquire>[0], receipt: Parameters<typeof acquire>[1]) => {
    const content = await fs.readFile(path.join(fixture.app, 'config.json'));
    const savedFiles = [
      { name: 'data/apps/store/fixture/config.json', bytes: content.length, sha256: sha(content) },
      { name: 'data/user-config/store/fixture/docker-compose.yml', bytes: Buffer.byteLength('disabled-override'), sha256: sha('disabled-override') },
    ];
    const raw = {
      schema: 'orbis.app-runtime-capture.v1',
      version: 1,
      pointId: expected.configuration.pointId,
      rootSha256: expected.configuration.rootIdentity.pathSha256,
      dockerContextSha256: sha('context'),
      daemonSha256: sha('daemon'),
      configurationSetSha256: expected.configuration.configurationSetSha256,
      preparationSha256: (receipt as ControllerPublicationReceipt).metadata.preparationSha256,
      capturedAt: Date.now(),
      apps: [
        {
          id: 1,
          urn: 'fixture:store',
          project: 'fixture_store',
          status: 'running',
          pendingRestart: true,
          userConfigEnabled: false,
          sourceSha256: sha(`orbis.app-runtime-saved-source.v1\n${canonicalAppRuntimeJson(savedFiles)}`),
          configurationSha256: sha(content),
          savedFiles,
          services: [{ name: 'web', replicas: 2 }],
        },
      ],
      containers: [first, second].map((container, index) => ({
        appUrn: 'fixture:store',
        service: 'web',
        ordinal: index + 1,
        wasRunning: container.running,
        inspect: {
          Id: container.id,
          Name: `/fixture-${index + 1}`,
          Image: container.imageId,
          Config: {
            Image: container.reference,
            Labels: {
              'com.docker.compose.project': 'fixture_store',
              'com.docker.compose.service': 'web',
              'com.docker.compose.container-number': String(index + 1),
              'com.docker.compose.oneoff': 'False',
              'runtipi.appurn': 'fixture:store',
              'runtipi.managed': 'true',
            },
          },
          HostConfig: {},
          Mounts: [],
          NetworkSettings: { Networks: {}, Ports: null },
        },
        image: {
          sourceImageId: container.imageId,
          creationReference: container.imageId,
          platform: { os: 'linux', architecture: 'arm64' },
          selection: 'docker-config.v1',
        },
        transformPolicy: 'orbis.app-runtime-transform.same-host.v1',
      })),
      networkDefinitions: [],
    };
    const bytes = Buffer.from(canonicalAppRuntimeJson({ ...raw, sha256: sha(`${raw.schema}\n${canonicalAppRuntimeJson(raw)}`) }));
    const appRuntime = decodeAppRuntimeCapture(bytes, {
      pointId: raw.pointId,
      rootSha256: raw.rootSha256,
      dockerContextSha256: raw.dockerContextSha256,
      daemonSha256: raw.daemonSha256,
      configurationSetSha256: raw.configurationSetSha256,
      preparationSha256: raw.preparationSha256,
      entrySha256: sha(bytes),
    });
    protectedRuntime = appRuntime;
    return { appRuntime };
  });
  fixture.host.acquireControllerCaptureFence.mockImplementation(async (...args) => {
    const fence = await acquire(...args);
    return {
      ...fence,
      prepareAppRuntime: () => prepareAppRuntime(args[0], args[1]),
      finalizeControllerArchive: async (...archiveArgs: Parameters<typeof fence.finalizeControllerArchive>) => {
        const authority = await fence.finalizeControllerArchive(...archiveArgs);
        if (!protectedRuntime) throw new Error('Missing protected runtime');
        const policy = {
          schema: 'orbis.proxy-host-identity-policy.v1',
          policy: 'preserve-live-proxy-identity.v1',
          rootSha256: args[0].configuration.rootIdentity.pathSha256,
          dockerContextSha256: sha('context'),
          configuration: {
            destination: '/etc/traefik',
            readOnly: true,
            staticSha256: sha('static-config'),
            capture: 'encrypted-review-only',
            restore: 'preserve-live',
          },
          mutableIdentity: { destination: '/shared', capture: 'excluded', restore: 'preserve-live', ownershipSha256: sha('ownership') },
          proxy: { containerId: proxy.id, imageId: proxy.imageId },
        };
        const proxyHostIdentity = { ...policy, sha256: sha(`orbis.proxy-host-identity-policy.v1\n${canonicalRuntimeJson(policy)}`) };
        const { authoritySha256: _old, ...base } = authority.metadata;
        const descriptor = {
          ...base,
          schema: 'orbis.controller-capture-authority.v4',
          version: 4,
          proxyHostIdentity,
          appRuntimeSha256: sha(protectedRuntime.read()),
          appRuntimeDaemonSha256: sha('daemon'),
        };
        return decodeControllerCaptureAuthority(
          { ...descriptor, authoritySha256: sha(`${descriptor.schema}\n${canonicalRuntimeJson(descriptor)}`) },
          args[0],
          args[1] as ControllerPublicationReceipt,
          archiveArgs[0],
        );
      },
    } as never;
  });
  const apps = { requireNoPendingAppImageUpdates: vi.fn(async () => undefined) };
  const docker = {
    getContainer: () => ({
      inspect: async () => ({
        Id: fixture.ids.core,
        Image: fixture.image.id,
        Config: { Labels: { 'com.docker.compose.project': 'runtipi', 'com.docker.compose.service': 'runtipi' } },
        Mounts: [{ Type: 'bind', Source: root, Destination: root }],
      }),
    }),
  };
  const runtime = new TimeMachineCaptureRuntime(
    ...([config, fixture.host, apps, docker, fixture.engine, 6] as unknown as ConstructorParameters<typeof TimeMachineCaptureRuntime>),
  );
  const signal = new AbortController().signal;
  await expect(runtime.requireSupport(signal)).rejects.toThrow();
  const operation = runtime.operation('11111111-1111-4111-8111-111111111111', signal, () => undefined);
  try {
    await operation.hostPreflight(signal);
    await operation.beforeQuiesce({ apps: [], runtime: { databaseId: fixture.ids.database, containers: [], images: [] } } as never, signal);
    expect(prepareAppRuntime).toHaveBeenCalledOnce();
    expect(fixture.engine.saveImage).toHaveBeenCalled();
    expect((fixture.host.acquireControllerCaptureFence.mock.calls as unknown[][])[0]?.slice(4, 6)).toEqual([true, true]);
    first.running = false;
    const content = path.join(root, 'snapshot');
    const fileValues = [
      { name: 'data/.env', bytes: await fs.readFile(path.join(root, '.env')) },
      { name: 'data/apps/store/fixture/config.json', bytes: await fs.readFile(path.join(fixture.app, 'config.json')) },
      { name: 'data/traefik/traefik.yml', bytes: Buffer.from('static-config') },
      { name: 'data/user-config/store/fixture/docker-compose.yml', bytes: Buffer.from('disabled-override') },
    ];
    for (const file of fileValues) {
      const target = path.join(content, file.name);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, file.bytes, { mode: 0o600 });
    }
    const now = Date.now();
    const manifest = Buffer.from(
      JSON.stringify({
        format: 'orbis-full-backup',
        version: 1,
        createdAt: now,
        orbisVersion: 'v0.5.0-beta.3',
        runtipiVersion: '4.10.1',
        architecture: 'arm64',
        files: fileValues.map((file) => ({
          name: file.name,
          bytes: file.bytes.length,
          sha256: sha(file.bytes),
          mode: 0o600,
          uid: 0,
          gid: 0,
          mtime: 0,
        })),
        directories: [],
        containers: [
          { id: first.id, project: first.project, running: true },
          { id: second.id, project: second.project, running: false },
        ],
        images: [
          { project: first.project, image: first.reference },
          { project: second.project, image: second.reference },
        ],
        exclusions: ['container-images', 'logs', 'cache', 'previous-backups'],
      }),
    );
    await fs.writeFile(path.join(content, 'manifest.json'), manifest, { mode: 0o600 });
    const sealCoherence = async (binding: Parameters<NonNullable<import('./system-backups.service').LocalBackupSnapshot['sealCoherence']>>[0]) => {
      const checkedAt = binding.hostFence.verifiedAt;
      const queue = {
        pauseId: '22222222-2222-4222-8222-222222222222',
        generation: 1,
        checkedAt,
        queues: [
          { name: 'app-events-queue' as const, messages: 0 as const, consumers: 0 as const },
          { name: 'repo-queue' as const, messages: 0 as const, consumers: 0 as const },
          { name: 'system-events-queue' as const, messages: 0 as const, consumers: 0 as const },
        ],
      };
      return createCaptureCoherenceReceipt({
        schema: 'orbis.capture-coherence.v1',
        scope: 'orbis-managed-writers.v1',
        transactionId: '33333333-3333-4333-8333-333333333333',
        createdAt: checkedAt,
        sealedAt: checkedAt,
        managedWritesHeldAt: checkedAt,
        database: { containerId: fixture.ids.database, bytes: 5, sha256: sha('db123') },
        manifestSha256: sha(manifest),
        apps: [
          { id: first.id, project: first.project, wasRunning: true, state: 'stopped' },
          { id: second.id, project: second.project, wasRunning: false, state: 'stopped' },
        ],
        queueStart: queue,
        queueEnd: queue,
        ...binding,
      });
    };
    const result = await operation.finalize({
      content,
      createdAt: now,
      manifestSha256: sha(manifest),
      software: { orbis: 'v0.5.0-beta.3', runtipi: '4.10.1', architecture: 'arm64' },
      files: [],
      databaseBytes: 5,
      apps: [],
      sealCoherence,
    });
    expect(result.controllerAuthority?.metadata.version).toBe(4);
    expect(result.appRuntime?.metadata.containers.map((item) => item.wasRunning)).toEqual([true, false]);
    expect(runtimePayload(result, { bytes: 52, cipherSha256: 'a'.repeat(64), manifestSha256: sha(manifest) }, signal).manifest.schema).toBe(
      'orbis.time-machine-runtime.v6',
    );
    const payload = runtimePayload(result, { bytes: 52, cipherSha256: 'a'.repeat(64), manifestSha256: sha(manifest) }, signal);
    const { encryptBackupStream } = await import('./backup-crypto');
    const source = path.join(root, 'runtime.orbis');
    await encryptBackupStream({
      source: payload.stream,
      plaintextBytes: payload.bytes,
      destination: source,
      passphrase: 'disposable-test-key',
      signal,
    });
    const stagingParent = path.join(root, 'reader-staging');
    await fs.mkdir(stagingParent, { mode: 0o700 });
    const { admitRuntimeFile } = await import('./time-machine-runtime-reader');
    const admitted = await admitRuntimeFile({
      source,
      stagingParent,
      passphrase: 'disposable-test-key',
      signal,
      maximumBytes: payload.bytes,
      expected: { manifest: payload.manifest, manifestSha256: payload.manifestSha256, publication: result.publicationExpectation },
    });
    try {
      expect(admitted.appRuntime?.metadata.containers.map((item) => item.wasRunning)).toEqual([true, false]);
      expect(admitted.appRuntime?.metadata.apps[0]).toMatchObject({
        pendingRestart: true,
        userConfigEnabled: false,
        savedFiles: [{ name: 'data/apps/store/fixture/config.json' }, { name: 'data/user-config/store/fixture/docker-compose.yml' }],
      });
      const { BackupDatabaseRecords } = await import('./backup-database-records');
      if (!admitted.appRuntime) throw new Error('Missing admitted app runtime');
      const { verifyCaptureAgainstBackup } = await import('./backup-image-capture');
      const check = () =>
        verifyCaptureAgainstBackup({
          capture: admitted.capture,
          content,
          manifestSha256: sha(manifest),
          appRuntime: admitted.appRuntime ?? undefined,
          signal,
        });
      await check();
      const overridePath = path.join(content, 'data/user-config/store/fixture/docker-compose.yml');
      await fs.writeFile(overridePath, 'changed');
      await expect(check()).rejects.toThrow();
      await fs.writeFile(overridePath, 'disabled-override');
      const records = new BackupDatabaseRecords('disposable-jwt-key', admitted.appRuntime);
      const { hash: passwordHash } = await import('argon2');
      records.accept('user', {
        id: 1,
        username: 'fixture@example.invalid',
        password: await passwordHash('disposable-password'),
        created_at: 1,
        updated_at: 1,
        operator: true,
        totp_secret: null,
        totp_enabled: false,
        salt: null,
        locale: 'en',
        has_seen_welcome: true,
      });
      const appRow = {
        id: 1,
        status: 'running',
        config: {},
        created_at: 1,
        updated_at: 1,
        version: 1,
        ignored_version: null,
        exposed: false,
        domain: null,
        is_visible_on_guest_dashboard: true,
        open_port: false,
        port: 80,
        exposed_local: false,
        app_store_slug: 'store',
        app_name: 'fixture',
        enable_auth: false,
        subnet: null,
        local_subdomain: null,
        pending_restart: true,
        user_config_enabled: false,
        max_backups: 0,
        template_urn: null,
        last_template_sync_at: null,
        template_version: null,
      };
      records.accept('app', appRow);
      expect((await records.finish(undefined, signal)).app).toBe(1);
      const changed = new BackupDatabaseRecords('disposable-jwt-key', admitted.appRuntime);
      expect(() => changed.accept('app', { ...appRow, pending_restart: false })).toThrow();
    } finally {
      await admitted.dispose();
    }
  } finally {
    await operation.dispose();
  }
});

it('binds a fresh protected v6 selection to one capture and rejects forged or reused selections', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'v6-selection-')));
  roots.push(root);
  await fs.chmod(root, 0o700);
  await fs.writeFile(path.join(root, '.env'), 'DISPOSABLE_FIXTURE=true\n', { mode: 0o600 });
  const config = { get: (name: string) => (name === 'directories' ? { dataDir: root } : name === 'architecture' ? 'arm64' : undefined) };
  const fixture = await connectedCaptureFixture(root, config);
  const capability = Object.freeze({ contractSha256: 'a'.repeat(64) });
  const host = { ...fixture.host, requireV6CaptureCapability: vi.fn(async () => capability), requireProxyHostIdentity: vi.fn(async () => undefined) };
  const apps = { requireNoPendingAppImageUpdates: vi.fn(async () => undefined) };
  const docker = { getContainer: () => ({ inspect: async () => ({ Id: fixture.ids.core, Image: fixture.image.id }) }) };
  const runtime = new TimeMachineCaptureRuntime(
    ...([config, host, apps, docker, fixture.engine] as unknown as ConstructorParameters<typeof TimeMachineCaptureRuntime>),
  );
  const signal = new AbortController().signal;
  const selection = await runtime.requireSupport(signal);
  expect(() => runtime.operation('11111111-1111-4111-8111-111111111111', signal, () => undefined, {})).toThrow();
  const operation = runtime.operation('11111111-1111-4111-8111-111111111111', signal, () => undefined, selection);
  expect(() => runtime.operation('11111111-1111-4111-8111-111111111111', signal, () => undefined, selection)).toThrow();
  try {
    await operation.hostPreflight(signal);
    expect((fixture.host.acquireControllerCaptureFence.mock.calls as unknown[][])[0]?.[6]).toBe(capability);
  } finally {
    await operation.dispose();
  }
  host.requireV6CaptureCapability.mockRejectedValueOnce(new HttpException('Changed', 409));
  await expect(runtime.requireSupport(signal)).rejects.toMatchObject({ response: { code: 'host-capture-support-required' } });
});
