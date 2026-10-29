import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MotionPreferences } from '@/desktop/motion-preferences';
import { RecoveryProgress } from './recovery-progress';

test('space journey reports measured transfer bytes and waits for confirmed completion', () => {
  const markup = renderToStaticMarkup(<RecoveryProgress label="Receiving backup" completed={512} total={1024} />);
  expect(markup).toContain('aria-label="Receiving backup"');
  expect(markup).toContain('value="50"');
  expect(markup).toContain('512 B of 1 KiB');
  expect(markup).toContain('aria-hidden="true"');
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
