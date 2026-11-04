import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MotionPreferences } from '@/desktop/motion-preferences';
import { WindowVisibilityContext } from '@/desktop/window-visibility';
import { RecoveryProgress, RecoveryProgressBar } from './recovery-progress';

test('inline progress reports measured transfer bytes without a background and waits for confirmed completion', () => {
  const markup = renderToStaticMarkup(<RecoveryProgress label="Receiving backup" completed={512} total={1024} />);
  expect(markup).toContain('aria-label="Receiving backup"');
  expect(markup).toContain('value="50"');
  expect(markup).toContain('512 B of 1 KiB');
  expect(markup).toContain('data-journey="false"');
  expect(markup).not.toContain('depth-travel');
  expect(renderToStaticMarkup(<RecoveryProgress label="Receiving backup" completed={1024} total={1024} />)).toContain('value="99"');
  const confirmed = renderToStaticMarkup(<RecoveryProgress label="Backup received" completed={1024} total={1024} settled />);
  expect(confirmed).toContain('value="100"');
  expect(confirmed).toContain('data-active="false"');
});
test('unknown restore totals do not invent a percentage or imply completion', () => {
  const markup = renderToStaticMarkup(<RecoveryProgress label="Restoring this server" />);
  expect(markup).toContain('Working…');
  expect(markup).toContain('data-known="false"');
  expect(markup).not.toContain('value=');
  expect(markup).not.toContain('50%<');
  expect(markup).not.toContain('100%');
});
test('indeterminate glint is omitted from measured progress and receives a pause state when hidden', () => {
  const indeterminate = renderToStaticMarkup(<RecoveryProgressBar label="Checking restore" />);
  expect(indeterminate).toContain('data-known="false"');
  expect(indeterminate).toContain('data-motion="true"');
  expect(indeterminate).toContain('<span aria-hidden="true"></span>');

  const measured = renderToStaticMarkup(<RecoveryProgressBar label="Checking restore" percentage={42} />);
  expect(measured).toContain('data-known="true"');
  expect(measured).not.toContain('<span aria-hidden="true"></span>');
  expect(measured).toContain('value="42"');

  const hidden = renderToStaticMarkup(
    <WindowVisibilityContext.Provider value={false}>
      <RecoveryProgressBar label="Checking restore" />
    </WindowVisibilityContext.Provider>,
  );
  expect(hidden).toContain('data-visible="false"');
});
test('indeterminate glint stays within the track and pauses while hidden', async () => {
  const styles = await Bun.file(new URL('./recovery-progress.css', import.meta.url)).text();
  expect(styles).toMatch(/\.recovery-progress-bar\s*\{[^}]*overflow:\s*hidden/s);
  expect(styles).toMatch(/\.recovery-progress-bar > span\s*\{[^}]*inset:\s*0 auto 0 0;[^}]*width:\s*35%;[^}]*animation:\s*recovery-glint-track/s);
  expect(styles).toContain('translateX(-100%)');
  expect(styles).toContain('translateX(285.72%)');
  expect(styles).toMatch(/\[data-visible="false"\] > span\s*\{[^}]*animation-play-state:\s*paused/s);
  expect(styles).not.toContain('.recovery-progress-bar > span::after');
  expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
});
test('record preparation and reduced-motion preference retain honest accessible progress', () => {
  const markup = renderToStaticMarkup(
    <MotionPreferences reduced>
      <RecoveryProgress label="Checking database" completed={3} total={12} unit="records" />
    </MotionPreferences>,
  );
  expect(markup).toContain('3 of 12 records');
  expect(markup).toContain('value="25"');
  expect(markup).toContain('data-reduced="true"');
});

test('compact progress can omit decorative depth without losing measured or unknown status', () => {
  const measured = renderToStaticMarkup(<RecoveryProgress label="Creating backup" completed={25} total={100} journey={false} />);
  expect(measured).toContain('value="25"');
  expect(measured).toContain('25 B of 100 B');
  expect(measured).not.toContain('depth-travel');
  const unknown = renderToStaticMarkup(<RecoveryProgress label="Checking backup" journey={false} />);
  expect(unknown).toContain('Working…');
  expect(unknown).not.toContain('value=');
  const decorated = renderToStaticMarkup(<RecoveryProgress label="Creating backup" completed={25} total={100} journey />);
  expect(decorated).toContain('data-journey="true"');
  expect(decorated).toContain('class="depth-travel recovery-flight" aria-hidden="true"');
  expect(decorated.match(/class="depth-travel-plane"/g)).toHaveLength(3);
  expect(decorated.match(/--depth-stars:/g)).toHaveLength(3);
  expect(decorated).not.toContain('<i ');
  expect(decorated).toContain('data:image/svg+xml');
  expect(decorated).not.toContain('<video');
});

test('update downloads show measured sizes, unknown totals and cached files without an invented percentage', async () => {
  const { UpdateDownloadProgress } = await import('./update-download-progress');
  const { readDownloadProgress } = await import('@/desktop/download-progress');
  const value = {
    schema: 'orbis.download-progress.v1',
    phase: 'downloading',
    currentBytes: 512,
    totalBytes: 1024,
    totalKnown: true,
    alreadyCached: false,
    layersComplete: 0,
    layersTotal: 2,
    updatedAt: 1700000000,
  };
  const render = (input: unknown) => renderToStaticMarkup(<UpdateDownloadProgress value={input} />);
  expect(render(value)).toContain('512 B of 1 KiB');
  expect(render(value)).toContain('value="50"');
  const unknown = render({ ...value, totalKnown: false, totalBytes: null });
  expect(unknown).toContain('512 B downloaded');
  expect(unknown).not.toContain('value=');
  const cached = render({ ...value, phase: 'complete', currentBytes: 0, totalBytes: 0, alreadyCached: true });
  expect(cached).toContain('Update files are already downloaded.');
  expect(cached).toContain('value="100"');
  expect(render({ ...value, phase: 'extracting', currentBytes: 1024 })).toContain('Unpacking update');
  expect(render({ ...value, phase: 'extracting', currentBytes: 1024 })).not.toContain('value=');
  for (const changed of [{ currentBytes: -1 }, { totalBytes: 10 }, { totalKnown: false }, { layersComplete: 3 }, { updatedAt: Number.NaN }]) {
    expect(readDownloadProgress({ ...value, ...changed })).toBeUndefined();
    expect(render({ ...value, ...changed })).toBe('');
  }
});
