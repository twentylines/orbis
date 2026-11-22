import { TranslatableError } from '@/common/error/translatable-error';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { DOCKERODE } from '@/modules/docker/docker.module';
import { Test } from '@nestjs/testing';
import type { AppUrn } from '@runtipi/common/types';
import { fromAny, fromPartial } from '@total-typescript/shoehorn';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { SubnetManagerService } from '../subnet-manager.service';
import type Dockerode from 'dockerode';

// Create a mock for Dockerode
const dockerMock = {
  listNetworks: vi.fn().mockResolvedValue([]),
  pruneNetworks: vi.fn(),
};

describe('SubnetManagerService', () => {
  let service: SubnetManagerService;
  let appsRepository = mock<AppsRepository>();

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [SubnetManagerService, { provide: DOCKERODE, useValue: dockerMock }],
    })
      .useMocker(mock)
      .compile();

    service = moduleRef.get<SubnetManagerService>(SubnetManagerService);
    appsRepository = moduleRef.get(AppsRepository);

    vi.clearAllMocks();
    dockerMock.listNetworks.mockReset().mockResolvedValue([]);
    dockerMock.pruneNetworks.mockReset().mockResolvedValue(undefined);
    appsRepository.getApps.mockResolvedValue([]);
  });

  describe('staged update subnet reservation', () => {
    const updateUrn = 'update:store' as AppUrn;
    const otherUrn = 'other:store' as AppUrn;
    const selected = '10.128.10.0/24';

    it('plans without writing and refuses a concurrently claimed subnet', async () => {
      const app = { id: 1, subnet: null as string | null };
      const other = { id: 2, subnet: null as string | null };
      appsRepository.getAppByUrn.mockImplementation(async (urn) => fromPartial(urn === updateUrn ? app : other));
      appsRepository.getApps.mockImplementation(async () => fromPartial([app, other]));
      appsRepository.updateAppById.mockImplementation(async (id, { subnet }) => {
        const current = id === app.id ? app : other;
        current.subnet = subnet ?? null;
        return fromPartial(current);
      });

      expect(await service.planUpdateSubnet(updateUrn, null)).toBe(selected);
      expect(appsRepository.updateAppById).not.toHaveBeenCalled();
      expect(await service.allocateSubnet(otherUrn)).toBe(selected);
      await expect(service.reserveUpdateSubnet(updateUrn, null, selected)).rejects.toThrow('no longer available');
      expect(appsRepository.updateAppById).toHaveBeenCalledExactlyOnceWith(other.id, { subnet: selected });
      expect(app.subnet).toBeNull();
    });

    it('uses its exact reservation for subsequent updates without rewriting the record', async () => {
      const app = { id: 1, subnet: null as string | null };
      appsRepository.getAppByUrn.mockImplementation(async () => fromPartial(app));
      appsRepository.getApps.mockImplementation(async () => fromPartial([app]));
      appsRepository.updateAppById.mockImplementation(async (_id, { subnet }) => {
        app.subnet = subnet ?? null;
        return fromPartial(app);
      });

      await expect(service.reserveUpdateSubnet(updateUrn, null, selected)).resolves.toBeUndefined();
      expect(await service.planUpdateSubnet(updateUrn, selected)).toBe(selected);
      await expect(service.reserveUpdateSubnet(updateUrn, selected, selected)).resolves.toBeUndefined();
      await expect(service.reserveUpdateSubnet(updateUrn, null, selected)).rejects.toThrow('subnet changed');
      expect(appsRepository.updateAppById).toHaveBeenCalledExactlyOnceWith(app.id, { subnet: selected });
    });
  });

  describe('allocateSubnet', () => {
    it('keeps an existing subnet during repeated Compose generation without rewriting or querying Docker', async () => {
      const appUrn = 'app:store' as AppUrn;
      appsRepository.getAppByUrn.mockResolvedValue(fromPartial({ id: 1, subnet: '10.128.12.0/24' }));
      dockerMock.listNetworks.mockRejectedValue(new Error('The engine is temporarily unavailable'));
      expect(await service.allocateSubnet(appUrn)).toBe('10.128.12.0/24');
      expect(await service.allocateSubnet(appUrn)).toBe('10.128.12.0/24');
      expect(appsRepository.updateAppById).not.toHaveBeenCalled();
      expect(appsRepository.getApps).not.toHaveBeenCalled();
      expect(dockerMock.listNetworks).not.toHaveBeenCalled();
    });

    it('should throw an error if app is not found', async () => {
      // arrange
      const appUrn = 'app:test/app' as AppUrn;
      appsRepository.getAppByUrn.mockResolvedValue(fromAny(null));

      // act & assert
      await expect(service.allocateSubnet(appUrn)).rejects.toThrow(TranslatableError);
    });

    it('should allocate a new subnet if app does not have one', async () => {
      // arrange
      const appUrn = 'app:test/app' as AppUrn;
      const newSubnet = '10.128.10.0/24';
      appsRepository.getAppByUrn.mockResolvedValue(
        fromPartial({
          id: 1,
          subnet: null,
        }),
      );

      dockerMock.listNetworks.mockResolvedValue([]);
      appsRepository.updateAppById.mockResolvedValue(fromPartial({ id: 1, subnet: newSubnet }));

      // act
      const result = await service.allocateSubnet(appUrn);

      // assert
      expect(result).toBe(newSubnet);
      expect(appsRepository.updateAppById).toHaveBeenCalledWith(1, { subnet: newSubnet });
    });

    it('should skip already allocated subnets when allocating a new one', async () => {
      // arrange
      const appUrn = 'app:test/app' as AppUrn;
      const expectedSubnet = '10.128.12.0/24';

      dockerMock.listNetworks.mockResolvedValue([
        { IPAM: { Config: [{ Subnet: '10.128.10.0/24' }] } },
        { IPAM: { Config: [{ Subnet: '10.128.11.0/24' }] } },
      ]);

      appsRepository.getAppByUrn.mockResolvedValue(fromPartial({ id: 1, subnet: null }));
      appsRepository.updateAppById.mockResolvedValue(fromPartial({ id: 1, subnet: expectedSubnet }));

      // act
      const result = await service.allocateSubnet(appUrn);

      // assert
      expect(result).toBe(expectedSubnet);
      expect(appsRepository.updateAppById).toHaveBeenCalledWith(1, { subnet: expectedSubnet });
    });

    it('should throw an error when no more subnets are available', async () => {
      // arrange
      const appUrn = 'app:test/app' as AppUrn;

      // Create mock for Docker with all subnets allocated
      const networkMocks = [];
      for (let y = 128; y <= 254; y++) {
        for (let z = 0; z <= 254; z++) {
          networkMocks.push({
            IPAM: { Config: [{ Subnet: `10.${y}.${z}.0/24` }] },
          });
        }
      }
      dockerMock.listNetworks.mockResolvedValue(networkMocks);

      appsRepository.getAppByUrn.mockResolvedValue(
        fromPartial({
          id: 1,
          subnet: null,
        }),
      );

      // act & assert
      await expect(service.allocateSubnet(appUrn)).rejects.toThrow(TranslatableError);
      expect(appsRepository.updateAppById).not.toHaveBeenCalled();
    });
  });

  describe('findNextAvailableSubnet', () => {
    it('should return the first available subnet after reserved subnets', async () => {
      // arrange
      const appUrn = 'app:test/app' as AppUrn;
      appsRepository.getAppByUrn.mockResolvedValue(
        fromPartial({
          id: 1,
          subnet: null,
        }),
      );
      dockerMock.listNetworks.mockResolvedValue([]);
      appsRepository.updateAppById.mockImplementation((id, subnet) => Promise.resolve(fromAny({ id, subnet })));

      // act
      const result = await service.allocateSubnet(appUrn);

      // assert
      expect(result).toBe('10.128.10.0/24');
    });

    it('should find gaps in allocated subnets', async () => {
      // arrange
      const appUrn = 'app:test/app' as AppUrn;

      dockerMock.listNetworks.mockResolvedValue([
        { IPAM: { Config: [{ Subnet: '10.128.10.0/24' }] } },
        { IPAM: { Config: [{ Subnet: '10.128.12.0/24' }] } },
        { IPAM: { Config: [{ Subnet: '10.128.13.0/24' }] } },
      ]);

      appsRepository.getAppByUrn.mockResolvedValue(
        fromPartial({
          id: 1,
          subnet: null,
        }),
      );
      appsRepository.updateAppById.mockImplementation((id, subnet) => Promise.resolve(fromAny({ id, subnet })));

      // act
      const result = await service.allocateSubnet(appUrn);

      // assert
      expect(result).toBe('10.128.11.0/24');
    });

    it('should handle malformed subnet strings correctly', async () => {
      // arrange
      const appUrn = 'app:test/app' as AppUrn;

      dockerMock.listNetworks.mockResolvedValue([
        { IPAM: { Config: [{ Subnet: '10.128.10.0/24' }] } },
        { IPAM: { Config: [{ Subnet: 'invalid-subnet' }] } },
        { IPAM: { Config: [{ Subnet: '10.128.11.0/24' }] } },
      ]);

      appsRepository.getAppByUrn.mockResolvedValue(
        fromPartial({
          id: 1,
          subnet: null,
        }),
      );
      appsRepository.updateAppById.mockImplementation((id, subnet) => Promise.resolve(fromAny({ id, subnet })));

      // act
      const result = await service.allocateSubnet(appUrn);

      // assert
      expect(result).toBe('10.128.12.0/24');
    });

    it('should increase the second octet when all third octets are used', async () => {
      // arrange
      const appUrn = 'app:test/app' as AppUrn;
      const expectedSubnet = '10.129.0.0/24';
      const networkMocks: Partial<Dockerode.NetworkInspectInfo>[] = [];

      // Fill up the entire 10.128.x.0/24 range
      for (let i = 0; i <= 254; i++) {
        networkMocks.push(
          fromPartial({
            IPAM: { Config: [{ Subnet: `10.128.${i}.0/24` }] },
          }),
        );
      }
      dockerMock.listNetworks.mockResolvedValue(networkMocks);

      appsRepository.getAppByUrn.mockResolvedValue(fromPartial({ id: 1, subnet: null }));
      appsRepository.updateAppById.mockResolvedValue(fromPartial({ id: 1, subnet: expectedSubnet }));

      // act
      const result = await service.allocateSubnet(appUrn);

      // assert
      expect(result).toBe(expectedSubnet);
      expect(appsRepository.updateAppById).toHaveBeenCalledWith(1, {
        subnet: expectedSubnet,
      });
    });
  });
});
