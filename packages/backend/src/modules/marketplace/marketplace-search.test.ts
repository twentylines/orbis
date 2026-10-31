import { describe, expect, it, vi } from 'vitest';
import { MarketplaceService } from './marketplace.service';

describe('marketplace search used by Store, global search and cluster installation', () => {
  it('matches punctuation, typos and fragments while preserving ranking, filters and cursors', async () => {
    const service = new MarketplaceService({} as never, {} as never, {} as never, {} as never);
    const apps = [
      { urn: 'pihole:tools', name: 'Pi-hole', short_desc: 'DNS filtering', categories: ['network'] },
      { urn: 'pihloe:tools', name: 'Pihloe', short_desc: '', categories: ['network'] },
      { urn: 'jellyfin:tools', name: 'Jellyfin', short_desc: 'Media', categories: ['media'] },
    ];
    vi.spyOn(service, 'getAvailableApps').mockResolvedValue(apps as never);
    for (const search of ['pihole', 'pihol', 'pi.hole']) {
      const result = await service.searchApps({ search, category: 'network', pageSize: 1 });
      expect(result.data[0]?.name).toBe('Pi-hole');
      expect(result.total).toBeGreaterThanOrEqual(1);
    }
    const first = await service.searchApps({ search: 'pihole', pageSize: 1 });
    expect(first.total).toBe(2);
    const next = await service.searchApps({ search: 'pihole', pageSize: 1, cursor: first.nextCursor });
    expect(next.data[0]?.name).toBe('Pihloe');
    expect((await service.searchApps({ search: 'jelyfin' })).data[0]?.name).toBe('Jellyfin');
    expect((await service.searchApps({ search: 'jelyfin', category: 'network' })).total).toBe(0);
    expect((await service.searchApps({ search: 'nothing matches' })).total).toBe(0);
  });
});
