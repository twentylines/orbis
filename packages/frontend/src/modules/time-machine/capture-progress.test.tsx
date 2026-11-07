import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MotionPreferences } from '@/desktop/motion-preferences';
import { WindowVisibilityContext } from '@/desktop/window-visibility';
import { capturePresentation } from './capture-presentation';
import { TimeMachineCaptureProgress } from './capture-progress';
import { historicalPoint } from './time-machine.test-data';

function capturing(stage = 'capturing-core') {
  return { ...historicalPoint(), status: 'capturing' as const, stage, metadata: null, completedBytes: 512, totalBytes: null as number | null };
}

test('core capture stages drive a semantic scene without fabricating measured progress', () => {
  for (const [stage, pose, label] of [
    ['queued', 'waiting', 'Waiting to capture'],
    ['preparing', 'preparing', 'Preparing capture'],
    ['saving-preview', 'preview', 'Saving the Home preview'],
    ['capturing-core', 'collecting', 'Capturing the server state'],
    ['retaining-images', 'collecting', 'Saving Docker images'],
    ['database-dump', 'collecting', 'Saving the database'],
    ['copying-files', 'collecting', 'Copying app configuration'],
    ['encrypting', 'sealing', 'Encrypting capture'],
    ['sealing', 'sealing', 'Verifying capture'],
  ]) {
    const value = capturePresentation(capturing(stage));
    expect(value).toMatchObject({ pose, stage: label, percentage: undefined, active: stage !== 'queued' });
  }
  expect(capturePresentation(capturing('new-server-stage')).stage).toBe('Server stage: new server stage');
});

test('only consistent server byte totals show a percentage and unsealed captures stop at 99', () => {
  const point = capturing();
  const unknown = renderToStaticMarkup(<TimeMachineCaptureProgress point={point} />);
  expect(unknown).toContain('The server has not reported a total size.');
  expect(unknown).not.toContain('value=');
  expect(unknown).not.toContain('512 B');
  expect(unknown).not.toContain('<progress');
  expect(unknown).toContain('data-running="true"');
  point.totalBytes = 1024;
  const measured = renderToStaticMarkup(<TimeMachineCaptureProgress point={point} />);
  expect(measured).toContain('value="50"');
  expect(measured).toContain('512 B of 1 KiB reported by the server');
  expect(measured).toContain('data-running="false"');
  expect(measured).not.toContain('data-known="false"');
  point.completedBytes = 1024;
  expect(capturePresentation(point).percentage).toBe(99);
  for (const [completedBytes, totalBytes] of [
    [1025, 1024],
    [-1, 1024],
    [0, 0],
    [1.5, 1024],
    [512, Number.NaN],
  ] as const)
    expect(capturePresentation({ ...point, completedBytes, totalBytes }).percentage).toBeUndefined();
});

test('lost contact drops stale progress and stops the scene without announcing a saved point', () => {
  const point = { ...capturing(), totalBytes: 1024 };
  expect(capturePresentation(point, true)).toMatchObject({ active: false, percentage: undefined, stage: 'Waiting for capture status' });
  const html = renderToStaticMarkup(<TimeMachineCaptureProgress point={point} unavailable />);
  expect(html).toContain('data-running="false"');
  expect(html).toContain('Completion is not yet confirmed.');
  expect(html).not.toContain('value=');
  expect(html).not.toContain('512 B');
  expect(html).not.toContain('Capture saved');
});

test('terminal states never animate, retain an explicit result, and omit active progress', () => {
  for (const status of ['failed', 'interrupted', 'sealed'] as const) {
    const point = { ...capturing(), status };
    const html = renderToStaticMarkup(<TimeMachineCaptureProgress point={point} />);
    expect(html).toContain('data-running="false"');
    expect(html).not.toContain('<progress');
    expect(html).toContain(status === 'sealed' ? 'Capture saved' : status === 'failed' ? 'Capture failed' : 'Capture interrupted');
    if (status !== 'sealed') expect(html).not.toContain('confirmed this saved point');
  }
});

test('low effects and hidden windows retain readable status with the capture motion paused', () => {
  const point = capturing();
  const reduced = renderToStaticMarkup(
    <MotionPreferences reduced>
      <TimeMachineCaptureProgress point={point} />
    </MotionPreferences>,
  );
  expect(reduced).toContain('data-reduced="true"');
  expect(reduced).toContain('data-running="false"');
  const hidden = renderToStaticMarkup(
    <WindowVisibilityContext.Provider value={false}>
      <TimeMachineCaptureProgress point={point} />
    </WindowVisibilityContext.Provider>,
  );
  expect(hidden).toContain('data-visible="false"');
  expect(hidden).toContain('data-running="false"');
  expect(hidden).toContain('Capturing the server state');
  expect(hidden.match(/class="tm-capture-plane /g)).toHaveLength(3);
  expect(hidden).not.toContain('<svg');
  expect(hidden).toContain('</div><div class="tm-capture-scan" aria-hidden="true"></div><div class="tm-capture-copy">');
});
