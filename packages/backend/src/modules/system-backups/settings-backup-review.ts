import { randomUUID } from 'node:crypto';
import {
  settingsBackupRestoreSelectionSchema,
  settingsBackupSelectionContained,
  type SettingsBackupSelection,
} from '@runtipi/common/schemas/settings-backup';
import { importSettingsBundle } from './settings-backup-format';
import { readSettingsJsonPart } from './settings-backup-json-parts';

type Imported = Awaited<ReturnType<typeof importSettingsBundle>>;
export type SettingsBundlePart = Imported['parts'][number];
export type SettingsBundleInspection = Readonly<{ items: number; pointId?: string; capturedAt?: number; orbisVersion?: string }>;
type OtherKind = 'wallpapers' | 'themes' | 'time-machine';
const fail = () => new Error('Review this backup again before restoring. No settings were restored.');
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

/** Verifies contents and selection only. The service must separately authorize and journal any live restore. */
export async function openSettingsBackupReview(options: {
  source: string;
  directory: string;
  passphrase: string;
  signal: AbortSignal;
  progress?: (completedBytes: number) => void;
  inspect?: Partial<Record<OtherKind, (part: SettingsBundlePart, signal: AbortSignal) => Promise<SettingsBundleInspection>>>;
}) {
  const opened = await importSettingsBundle(options);
  let disposed = false;
  let closing = false;
  let claimed = false;
  let active: Promise<void> | undefined;
  let disposal: Promise<void> | undefined;
  const reviewId = randomUUID();
  const read = async (part: SettingsBundlePart) => {
    options.signal.throwIfAborted();
    if (part.kind === 'settings' || part.kind === 'dashboard') {
      const payload = await readSettingsJsonPart({ ...part, kind: part.kind, passphrase: options.passphrase, signal: options.signal });
      return { inspection: { items: Object.keys(payload.desktop).length + (payload.server ? Object.keys(payload.server).length : 0) }, payload };
    }
    const inspector = options.inspect?.[part.kind];
    if (!inspector) throw fail();
    const inspection = await inspector(part, options.signal);
    if (
      !inspection ||
      Object.keys(inspection).some((key) => !['items', 'pointId', 'capturedAt', 'orbisVersion'].includes(key)) ||
      !Number.isSafeInteger(inspection.items) ||
      inspection.items < 0 ||
      inspection.items > 250_000 ||
      (inspection.capturedAt !== undefined && (!Number.isSafeInteger(inspection.capturedAt) || inspection.capturedAt < 1)) ||
      (inspection.orbisVersion !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(inspection.orbisVersion)) ||
      (part.kind === 'time-machine' &&
        (inspection.pointId !== part.id || inspection.capturedAt === undefined || inspection.orbisVersion === undefined)) ||
      (part.kind !== 'time-machine' && inspection.pointId !== undefined)
    )
      throw fail();
    return { inspection, payload: null };
  };
  try {
    const contents = [];
    const available: SettingsBackupSelection = { version: 1, settings: false, dashboard: false, wallpapers: false, themes: false, timeMachine: [] };
    for (const part of opened.parts) {
      const result = await read(part);
      if (part.kind === 'time-machine') {
        if (!part.id) throw fail();
        available.timeMachine.push(part.id);
      } else available[part.kind] = true;
      contents.push({ kind: part.kind, id: part.id, bytes: part.bytes, ...result.inspection });
    }
    const expiresAt = Date.now() + 15 * 60_000;
    const summary = freeze({
      version: 1 as const,
      reviewId,
      archiveSha256: opened.archiveSha256,
      createdAt: opened.manifest.createdAt,
      orbisVersion: opened.manifest.orbisVersion,
      contents,
      available,
      expiresAt,
    });
    return {
      summary,
      withSelection: async <T>(
        request: unknown,
        consume: (value: {
          selection: SettingsBackupSelection;
          parts: {
            part: SettingsBundlePart;
            inspection: SettingsBundleInspection;
            payload: Awaited<ReturnType<typeof readSettingsJsonPart>> | null;
          }[];
        }) => Promise<T>,
      ): Promise<T> => {
        if (disposed || closing || claimed || active || Date.now() >= expiresAt) throw fail();
        const selected = settingsBackupRestoreSelectionSchema.assert(request);
        if (
          selected.reviewId !== reviewId ||
          selected.archiveSha256 !== opened.archiveSha256 ||
          !settingsBackupSelectionContained(available, selected.contents)
        )
          throw fail();
        let release: () => void = () => undefined;
        active = new Promise<void>((resolve) => {
          release = resolve;
        });
        try {
          const parts = [];
          for (const part of opened.parts) {
            const include =
              part.kind === 'time-machine' ? !!part.id && selected.contents.timeMachine.includes(part.id) : selected.contents[part.kind];
            if (include) parts.push({ part: { ...part }, ...(await read(part)) });
          }
          if (disposed || closing || Date.now() >= expiresAt) throw fail();
          claimed = true;
          return await consume(freeze({ selection: structuredClone(selected.contents), parts }));
        } finally {
          active = undefined;
          release();
        }
      },
      dispose: () => {
        if (!disposal)
          disposal = (async () => {
            closing = true;
            await active;
            if (!disposed) {
              await opened.dispose();
              disposed = true;
            }
          })();
        return disposal;
      },
    };
  } catch (error) {
    await opened.dispose();
    throw error;
  }
}
