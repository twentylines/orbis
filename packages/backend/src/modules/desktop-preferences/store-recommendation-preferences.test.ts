import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'vitest-mock-extended';
import { ConfigurationService } from '@/core/config/configuration.service';
import { desktopPreferencesSchema } from './desktop-preferences.dto';
import { DEFAULT_DESKTOP_PREFERENCES, DesktopPreferencesService } from './desktop-preferences.service';
import { patchSelectedPreferences, selectedPreferences } from './desktop-preferences-sync';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

describe('Store recommendation preference storage', () => {
  it('validates optional legacy defaults and rejects malformed visibility/category values', () => {
    const { showStoreRecommendations: _shown, hiddenStoreRecommendationCategories: _hidden, ...legacy } = DEFAULT_DESKTOP_PREFERENCES;
    expect(desktopPreferencesSchema.allows(legacy)).toBe(true);
    for (const update of [
      { showStoreRecommendations: null },
      { showStoreRecommendations: 'false' },
      { hiddenStoreRecommendationCategories: ['unknown'] },
      { hiddenStoreRecommendationCategories: ['gaming', 'gaming'] },
    ])
      expect(desktopPreferencesSchema.allows({ ...DEFAULT_DESKTOP_PREFERENCES, ...update })).toBe(false);
  });
  it('persists independent per-account choices and defaults old records without a listener or network', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-recommendation-preferences-'));
    directories.push(directory);
    const config = mock<ConfigurationService>();
    config.get.calledWith('directories').mockReturnValue({ dataDir: directory } as never);
    const service = new DesktopPreferencesService(config);
    await service.write(1, {
      ...DEFAULT_DESKTOP_PREFERENCES,
      showStoreRecommendations: false,
      hiddenStoreRecommendationCategories: ['gaming', 'finance'],
    });
    const saved = await new DesktopPreferencesService(config).read(1);
    expect(saved.showStoreRecommendations).toBe(false);
    expect(saved.hiddenStoreRecommendationCategories).toEqual(['gaming', 'finance']);
    expect((await service.read(2)).showStoreRecommendations).toBe(true);
    const { showStoreRecommendations: _shown, hiddenStoreRecommendationCategories: _hidden, ...legacy } = DEFAULT_DESKTOP_PREFERENCES;
    await fs.writeFile(path.join(directory, 'state', 'desktop', '2.json'), JSON.stringify(legacy));
    expect((await service.read(2)).showStoreRecommendations).toBe(true);
    expect((await service.read(2)).hiddenStoreRecommendationCategories).toEqual([]);
    const on = await service.write(1, { ...saved, showStoreRecommendations: true });
    expect(on.hiddenStoreRecommendationCategories).toEqual(['gaming', 'finance']);
  });
  it('existing selected customisation sync preserves recommendation choices exactly', () => {
    const raw = `${JSON.stringify({ ...DEFAULT_DESKTOP_PREFERENCES, showStoreRecommendations: false, hiddenStoreRecommendationCategories: ['gaming'] })}\n`;
    const selected = selectedPreferences(raw, DEFAULT_DESKTOP_PREFERENCES);
    const changed = patchSelectedPreferences(raw, selected, { ...selected, preset: 'forest' });
    const parsed = JSON.parse(changed);
    expect(parsed.showStoreRecommendations).toBe(false);
    expect(parsed.hiddenStoreRecommendationCategories).toEqual(['gaming']);
  });
});
