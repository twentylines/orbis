import { describe, expect, it } from 'vitest';
import type { ArchiveEntry } from '@/core/archive/archive.service';
import { validateArchiveLinks } from '../backup-links';
import path from 'node:path';

const normal = (value: string) => {
  if (path.posix.isAbsolute(value)) throw new Error('Backup contains unsupported file types');
  const result = path.posix.normalize(value.replace(/^(\.\/)+/, ''));
  if (result === '..' || result.startsWith('../')) throw new Error('Backup contains unsupported file types');
  return result;
};
const file = { path: 'app-data/logs/dated.log', type: '-' };
describe('backup archive link containment', () => {
  it('accepts relative file links and bounded chains within one application tree', () => {
    expect(() =>
      validateArchiveLinks(
        [
          file,
          { path: 'app-data/logs/latest.log', type: 'l', linkTarget: 'dated.log' },
          { path: 'app-data/latest', type: 'l', linkTarget: 'logs/latest.log' },
        ],
        normal,
      ),
    ).not.toThrow();
  });
  it.each(
    [
      [{ path: 'app-data/logs/latest', type: 'l', linkTarget: '/app-data/logs/dated.log' }],
      [{ path: 'app-data/logs/latest', type: 'l', linkTarget: '../../../outside' }],
      [
        { path: 'app-data/latest', type: 'l', linkTarget: '../app/config.json' },
        { path: 'app/config.json', type: '-' },
      ],
      [
        { path: 'app-data/a', type: 'l', linkTarget: 'b' },
        { path: 'app-data/b', type: 'l', linkTarget: 'a' },
      ],
      [{ path: 'app-data/latest', type: 'l', linkTarget: 'missing' }],
      [
        { path: 'user-config/latest', type: 'l', linkTarget: 'file' },
        { path: 'user-config/file', type: '-' },
      ],
      [{ path: 'app-data/pipe', type: 'p' }],
      [{ path: 'app-data/hard', type: 'h', linkTarget: 'app-data/logs/dated.log' }],
      [
        { path: 'app-data/logs/link', type: 'l', linkTarget: '.' },
        { path: 'app-data/logs/link/replaced', type: '-' },
        { path: 'app-data/logs', type: 'd' },
      ],
      [{ path: '../outside', type: '-' }],
      [{ path: 'app-data/logs/dated.log', type: 'l', linkTarget: 'other' }],
    ].map((entries) => ({ entries: entries as ArchiveEntry[] })),
  )('rejects unsafe links, special files, duplicates and writes through links: $entries', ({ entries }) => {
    expect(() => validateArchiveLinks([file, ...entries], normal)).toThrow('Backup contains unsupported file types');
  });
});
