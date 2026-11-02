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
test('indeterminate orb is omitted from measured progress and receives a pause state when hidden', () => {
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
  expect(hidden).toContain('data-motion="false"');
});
test('indeterminate orb is one clipped, fading sweep with a static inner glint', async () => {
  const styles = await Bun.file(new URL('./recovery-progress.css', import.meta.url)).text();
  expect(styles).toMatch(/\.recovery-progress-bar\s*\{[^}]*clip-path:\s*inset\(-4px 0 round 8px\)/s);
  expect(styles).toMatch(/\.recovery-progress-bar > span\s*\{[^}]*animation:\s*recovery-orb-sweep 1800ms linear infinite/s);
  expect(styles).toMatch(
    /@keyframes recovery-orb-sweep\s*\{[\s\S]*?from\s*\{[^}]*opacity:\s*0;[\s\S]*?to\s*\{[^}]*opacity:\s*0;[^}]*translate3d\(455%, -50%, 0\)/,
  );
  const innerGlint = styles.match(/\.recovery-progress-bar > span::after\s*\{([^}]*)\}/s)?.[1] ?? '';
  expect(innerGlint).not.toMatch(/\banimation\s*:/);
  expect(styles).not.toContain('@keyframes recovery-orb-glint');
  expect(styles).toContain('.recovery-progress-bar[data-motion="false"] > span');
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
  expect(decorated.match(/data-temperature="/g)).toHaveLength(144);
  expect(decorated.match(/data-temperature="warm"/g)).toHaveLength(6);
  expect(decorated.match(/data-temperature="cool"/g)).toHaveLength(15);
  expect(decorated).not.toContain('<video');
});
