import type { ThemePackReference } from '@runtipi/common/schemas/theme-pack';

export const themeApplyHandoffKey = 'orbis-theme-apply-v1';
export type ThemeApplyHandoff = { version: 1; savedAt: number; selected: ThemePackReference | null };

export function decodeThemeApplyHandoff(raw: string | null, now = Date.now()): ThemeApplyHandoff | null {
  if (!raw || raw.length > 512) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(',') !== 'savedAt,selected,version' ||
      record.version !== 1 ||
      !Number.isSafeInteger(record.savedAt) ||
      typeof record.savedAt !== 'number' ||
      record.savedAt > now ||
      now - record.savedAt >= 120_000
    )
      return null;
    if (record.selected !== null) {
      if (!record.selected || typeof record.selected !== 'object' || Array.isArray(record.selected)) return null;
      const selected = record.selected as Record<string, unknown>;
      if (
        Object.keys(selected).sort().join(',') !== 'id,version' ||
        typeof selected.id !== 'string' ||
        !/^[a-z][a-z0-9-]{2,47}$/.test(selected.id) ||
        typeof selected.version !== 'string' ||
        !/^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/.test(selected.version)
      )
        return null;
    }
    return record as ThemeApplyHandoff;
  } catch {
    return null;
  }
}

export function readThemeApplyHandoff(storage: Pick<Storage, 'getItem' | 'removeItem'> = sessionStorage): ThemeApplyHandoff | null {
  try {
    const raw = storage.getItem(themeApplyHandoffKey);
    const value = decodeThemeApplyHandoff(raw);
    if (raw && !value) storage.removeItem(themeApplyHandoffKey);
    return value;
  } catch {
    return null;
  }
}

export function writeThemeApplyHandoff(selected: ThemePackReference | null, storage: Pick<Storage, 'getItem' | 'setItem'> = sessionStorage) {
  try {
    const raw = JSON.stringify({ version: 1, savedAt: Date.now(), selected });
    storage.setItem(themeApplyHandoffKey, raw);
    return storage.getItem(themeApplyHandoffKey) === raw;
  } catch {
    return false;
  }
}

export function clearThemeApplyHandoff() {
  try {
    sessionStorage.removeItem(themeApplyHandoffKey);
  } catch {
    /* Storage may be unavailable during recovery. */
  }
  document.documentElement.removeAttribute('data-orbis-theme-reload');
}

export const themeApplyPrepaintCss =
  '#orbis-theme-reload-fallback{display:none}html[data-orbis-theme-reload=failed] #orbis-theme-reload-fallback{display:grid;place-content:center;gap:20px;padding:32px;text-align:center;overflow:auto}#orbis-theme-reload-fallback a{display:inline-block;color:#fff;border:1px solid #c6c6d0;border-radius:8px;padding:12px 20px;margin:6px;min-height:44px}#orbis-theme-reload-fallback a:focus-visible{outline:3px solid #fff;outline-offset:4px}html[data-orbis-theme-reload]{background:#000!important}html[data-orbis-theme-reload] body{background:#000!important}html[data-orbis-theme-reload] #root{visibility:hidden}html[data-orbis-theme-reload]::before{content:"";position:fixed;inset:0;background:#000;z-index:2147483645;pointer-events:auto}';
export const themeApplyHandoffBootstrap = `(()=>{const decode=${decodeThemeApplyHandoff.toString()};try{const raw=sessionStorage.getItem(${JSON.stringify(themeApplyHandoffKey)});if(decode(raw)){const root=document.documentElement;root.setAttribute('data-orbis-theme-reload','pending');if(typeof setTimeout==='function')setTimeout(()=>{if(!root.getAttribute('data-orbis-theme-reload')||root.getAttribute('data-orbis-theme-reload')==='failed'||(typeof document.querySelector==='function'&&document.querySelector('.theme-apply-cover')))return;try{sessionStorage.removeItem(${JSON.stringify(themeApplyHandoffKey)});}catch{}root.setAttribute('data-orbis-theme-reload','failed');},20000);}else if(raw){sessionStorage.removeItem(${JSON.stringify(themeApplyHandoffKey)});}}catch{}})();`;
