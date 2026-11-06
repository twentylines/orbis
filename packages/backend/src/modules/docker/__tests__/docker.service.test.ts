import type { AppUrn } from '@runtipi/common/types';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { DockerService } from '../docker.service';

const authority = vi.hoisted(() => vi.fn());
vi.mock('../app-volume-authority', () => ({ readAppVolumeAuthority: authority }));

describe('DockerService', () => {
  let dockerService: DockerService;

  beforeEach(async () => {
    authority.mockResolvedValue(null);
    const moduleRef = await Test.createTestingModule({
      providers: [DockerService],
    })
      .useMocker(mock)
      .compile();

    dockerService = moduleRef.get(DockerService);
  });

  it('should be defined', () => {
    expect(dockerService).toBeDefined();
  });
});

describe('retained volume lifecycle', () => {
  it('retains binding metadata independently of user overrides and explicit image updates', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const crypto = await import('node:crypto');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'volume-lifecycle-'));
    try {
      const dataDir = root;
      const appUrn = 'app:store' as AppUrn;
      const retained = {
        version: 1,
        appUrn,
        project: 'app_store',
        services: [{ name: 'app', mounts: [{ target: '/data', volume: 'restored', readOnly: false }] }],
      };
      authority.mockResolvedValue({ pins: retained });
      const imageDir = path.join(root, 'state', 'time-machine', 'image-pins');
      await fs.mkdir(imageDir, { recursive: true, mode: 0o700 });
      const tx = crypto.randomUUID();
      const guard = path.join(imageDir, `${crypto.createHash('sha256').update(appUrn).digest('hex')}.update.json`);
      await fs.writeFile(guard, JSON.stringify({ version: 1, appUrn, id: tx, phase: 'prepared' }), { mode: 0o600 });
      const files = {
        getAppEnv: async () => ({ path: '/app.env' }),
        getUserEnv: async () => ({ path: '/user.env', content: 'x' }),
        getGeneratedDockerComposeYaml: async () => ({ path: '/generated.yml' }),
        getUserComposeFile: async () => ({ path: '/user.yml', content: 'x' }),
      };
      let enabled = true;
      const service = new DockerService(
        {} as never,
        { get: () => ({ dataDir }) } as never,
        files as never,
        {} as never,
        { getApp: async () => ({ app: { userConfigEnabled: enabled } }) } as never,
      );
      vi.spyOn(service, 'readAppImagePins').mockResolvedValue({ pins: {} as never, path: '/images.json' });
      const ordinary = await service.getBaseComposeArgsApp(appUrn, { imagePinUpdate: tx });
      expect(ordinary.volumePins?.appUrn).toBe(appUrn);
      expect(ordinary.args).toContain('/user.yml');
      expect(ordinary.args).toContain('/images.json');
      enabled = false;
      const update = await service.getBaseComposeArgsApp(appUrn, { imagePins: 'explicit-update', imagePinUpdate: tx });
      expect(update.volumePins).toEqual(ordinary.volumePins);
      expect(update.args).not.toContain('/user.yml');
      expect(update.args).not.toContain('/images.json');
      expect(authority).toHaveBeenCalledWith(dataDir, { appUrn, project: 'app_store' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
