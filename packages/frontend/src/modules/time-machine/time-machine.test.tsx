import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { HistoricalHomePreview as HistoricalHome } from './historical-home-preview';
import { HistoricalDateRuler, HistoricalPointStack, HistoricalTimelineBody } from './time-machine-journey';
import { DialogOpenContext } from '@/components/ui/Dialog/Dialog';
import {
  chronologicalPoints,
  historicalAssetPath,
  orderedPoints,
  pointSchema,
  selectedPointId,
  timeMachinePollDelay,
  visiblePointCards,
} from './contracts';
import {
  createPointTravelGate,
  capturePercent,
  eligibleRestoreReview,
  grantMatchesReview,
  pointCardPose,
  pointFoldDepth,
  pointMotionEnabled,
  pointMotionSeconds,
  pointPreviewAdmitted,
  pointStackCards,
  timelineIndexAt,
  timelineOffsets,
  timelineTarget,
  timelineWindow,
  verifiedRestoreReview,
} from './timeline-state';
import { historicalPoint, readyReview } from './time-machine.test-data';
import { CapturedContents, capturedContents } from './captured-contents';
import { timeMachineActivity } from './time-machine-activity';
import { openTimelineAt, TimeMachineSetupView } from './time-machine-settings';

test('historical projection uses sealed metadata without substituting a current wallpaper or live readings', () => {
  const point = historicalPoint();
  expect(pointSchema.allows(point)).toBe(true);
  const html = renderToStaticMarkup(<HistoricalHome point={point} />);
  for (const text of [
    'Saved server',
    'Saved Notes',
    'Running at capture',
    'Historical layout projection, not a screenshot',
    'No point-bound wallpaper',
  ])
    expect(html).toContain(text);
  expect(html).not.toContain('<img');
  expect(html).not.toContain('/wallpapers/');
  expect(html).toContain('Readings were not captured');
  expect(historicalAssetPath(point)).toBeNull();
});

test('disabled Time Machine setup names the captured content and keeps enabling state honest', () => {
  const ready = renderToStaticMarkup(<TimeMachineSetupView pending={false} onEnable={() => {}} />);
  expect(ready).toContain('What a Time Machine point includes');
  expect(ready).toContain('The server database');
  expect(ready).toContain('Orbis configuration');
  expect(ready).toContain('Managed app data');
  expect(ready).toContain('Operating system snapshots are not included.');
  expect(ready).toContain('>Enable Time Machine</button>');
  expect(ready).not.toContain('Experimental Time Machine');

  const pending = renderToStaticMarkup(<TimeMachineSetupView pending onEnable={() => {}} />);
  expect(pending).toContain('disabled=""');
  expect(pending).toContain('Enabling Time Machine…');
});

test('restore contents report sealed coverage without claiming omitted images or bulk storage', () => {
  const point = historicalPoint();
  const summary = capturedContents(point);
  expect(summary.included).toContain('Managed app files and databases, including saved preferences, accounts and integrations');
  expect(summary.excluded).toContain('Docker images and their versions');
  expect(summary.included).not.toContain('Files in the captured media directory');
  expect(summary.excluded).toContain('Operating system and installed system packages');
  expect(renderToStaticMarkup(<CapturedContents point={point} />)).toContain('aria-label="Restore contents"');
  if (!point.metadata) throw new Error('Fixture missing metadata');
  point.metadata.breakdown.push({ id: 'media', bytes: 20, entries: 1 });
  expect(capturedContents(point).included).toContain('Files in the captured media directory');
});

test('capture activity follows server state without a made-up completed percentage', () => {
  const point = historicalPoint();
  expect(timeMachineActivity(point)).toBeNull();
  expect(timeMachineActivity(undefined)).toBeNull();
  point.status = 'capturing';
  point.metadata = null;
  point.stage = 'encrypting';
  expect(timeMachineActivity(point)).toMatchObject({ title: 'Capturing', detail: 'Time Machine', stage: 'Encrypting capture', percentage: 99 });
  point.totalBytes = null;
  expect(timeMachineActivity(point)?.percentage).toBeUndefined();
  point.status = 'failed';
  expect(timeMachineActivity(point)).toBeNull();
});
test('unavailable preview and unresolved system mode are explicit rather than resolved from the viewer', () => {
  const point = historicalPoint();
  if (!point.metadata) throw new Error('Fixture metadata missing');
  point.metadata.preview = { available: false, reason: { code: 'preview-not-captured', message: 'No historical projection was captured.' } };
  expect(renderToStaticMarkup(<HistoricalHome point={point} />)).toContain('No captured Home preview');
  point.metadata.preview = historicalPoint().metadata?.preview ?? point.metadata.preview;
  if (!point.metadata.preview.available) throw new Error('Fixture preview missing');
  point.metadata.preview.desktop.mode = 'system';
  const html = renderToStaticMarkup(<HistoricalHome point={point} />);
  expect(html).toContain('data-captured-mode="system"');
  expect(html).toContain('neutral colours');
});
test('timeline preserves selection, sorts a copy, bounds depth cards and supports endpoint navigation', () => {
  const points = Array.from({ length: 12 }, (_, index) => ({
    ...historicalPoint(),
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    createdAt: 1000 + index,
  }));
  Object.freeze(points);
  const ordered = orderedPoints(points);
  expect(points[0]?.createdAt).toBe(1000);
  expect(ordered[0]?.createdAt).toBe(1011);
  const id = ordered[5]?.id ?? '';
  expect(selectedPointId(ordered, id)).toBe(id);
  expect(visiblePointCards(ordered, id)).toHaveLength(7);
  expect(timelineTarget(ordered, id, 'ArrowUp')).toBe(ordered[6]?.id ?? null);
  expect(timelineTarget(ordered, id, 'ArrowDown')).toBe(ordered[4]?.id ?? null);
  expect(timelineTarget(ordered, id, 'Home')).toBe(ordered.at(-1)?.id ?? null);
  expect(timelineTarget(ordered, id, 'End')).toBe(ordered[0]?.id ?? null);
  expect(timelineTarget([], null, 'Home')).toBeNull();
  const html = renderToStaticMarkup(
    <DialogOpenContext.Provider value={true}>
      <HistoricalPointStack points={ordered} selected={id} />
    </DialogOpenContext.Provider>,
  );
  expect(html.match(/class="tm-home-layer"/g) ?? []).toHaveLength(7);
  expect((html.match(/class="tm-point-silhouette"/g) ?? []).length).toBe(6);
  expect((html.match(/class="tm-historical-home"/g) ?? []).length).toBe(1);
  expect((html.match(/aria-hidden="true"/g) ?? []).length).toBeGreaterThanOrEqual(6);
});
test('sealed points never imply verified restoration and grants cannot cross expiry, point, digest or machine boundaries', () => {
  const point = historicalPoint();
  const review = readyReview();
  expect(verifiedRestoreReview(null, point, 1000)).toBe(false);
  expect(verifiedRestoreReview(review, point, 1000)).toBe(true);
  expect(verifiedRestoreReview(review, point, 10_000)).toBe(false);
  expect(verifiedRestoreReview({ ...review, status: 'reviewing', ready: false, expiresAt: null }, point, 1000)).toBe(false);
  const { status: _status, ready: _ready, blockers: _blockers, progress: _progress, ...binding } = review;
  const grant = { ...binding, expiresAt: 5000, grantId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
  expect(grantMatchesReview(grant, review, point, 1000)).toBe(true);
  for (const patch of [
    { expiresAt: 1000 },
    { expiresAt: 20_000 },
    { machineId: 'd'.repeat(64) },
    { archiveSha256: 'd'.repeat(64) },
    { reviewId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
  ])
    expect(grantMatchesReview({ ...grant, ...patch }, review, point, 1000)).toBe(false);
});
test('provisional eligibility is not verified readiness but supports only a matching unexpired grant', () => {
  const point = historicalPoint();
  const review = {
    ...readyReview(),
    status: 'eligible' as const,
    ready: false,
    progress: { stage: 'checking' as const, completedBytes: 0, totalBytes: null },
  };
  expect(verifiedRestoreReview(review, point, 1000)).toBe(false);
  expect(eligibleRestoreReview(review, point, 1000)).toBe(true);
  const { status: _status, ready: _ready, blockers: _blockers, progress: _progress, ...binding } = review;
  const grant = { ...binding, expiresAt: 5000, grantId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
  expect(grantMatchesReview(grant, review, point, 1000)).toBe(true);
  expect(grantMatchesReview({ ...grant, pointId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }, review, point, 1000)).toBe(false);
  expect(eligibleRestoreReview(review, point, 10000)).toBe(false);
});
test('progress remains indeterminate without a valid total and never completes from bytes alone', () => {
  expect(capturePercent(0, null)).toBeUndefined();
  expect(capturePercent(10, 0)).toBeUndefined();
  expect(capturePercent(11, 10)).toBeUndefined();
  expect(capturePercent(10, 10)).toBe(99);
  expect(capturePercent(10, 10, true)).toBe(100);
  expect(timeMachinePollDelay(null, false)).toBe(false);
});

test('the date ruler ascends oldest to newest independently of the newest-first preview stack', () => {
  const points = [historicalPoint(), { ...historicalPoint(), id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', createdAt: 1000 }];
  const ascending = chronologicalPoints(points);
  const descending = orderedPoints(points);
  expect(ascending[0]?.createdAt).toBe(1000);
  expect(descending[0]?.id).toBe(points[0]?.id);
  expect(points[0]?.id).toBe(descending[0]?.id);
  const oldest = ascending[0]?.id ?? null;
  const newest = ascending.at(-1)?.id ?? null;
  expect(timelineTarget(descending, newest, 'ArrowUp')).toBe(oldest);
  expect(timelineTarget(descending, oldest, 'ArrowDown')).toBe(newest);
  expect(timelineTarget(descending, newest, 'Home')).toBe(oldest);
  expect(timelineTarget(descending, oldest, 'End')).toBe(newest);
  const html = renderToStaticMarkup(<HistoricalDateRuler points={descending} selected={newest} onSelect={() => {}} />);
  expect(html.indexOf(`data-point-id="${oldest}"`)).toBeLessThan(html.indexOf(`data-point-id="${newest}"`));
  expect(html.match(/aria-current="date"/g)).toHaveLength(1);
  expect(html.match(/tabindex="0"/g)).toHaveLength(1);
  expect(html.match(/tm-ruler-tick/g)).toHaveLength(2);
  for (const point of points) {
    const date = new Date(point.createdAt);
    const expected = renderToStaticMarkup(
      <time dateTime={date.toISOString()}>{date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time>,
    );
    expect(html).toContain(expected);
  }
  expect(html).not.toContain('<a ');
});

// UI stress fixtures exceed the server's storage limit; they are never API or live data.
function timelineStressPoints(count: number) {
  const template = historicalPoint();
  return Array.from({ length: count }, (_, index) => {
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    const createdAt = template.createdAt + index * 60_000;
    return { ...template, id, createdAt, metadata: template.metadata ? { ...template.metadata, id, createdAt } : null };
  });
}

test('large metadata-only UI histories mount nearby dates and retain a distant selected date with its full list position', () => {
  for (const count of [100, 1000, 10_000]) {
    const points = timelineStressPoints(count);
    const selected = points.at(-1)?.id ?? null;
    const html = renderToStaticMarkup(<HistoricalDateRuler points={points} selected={selected} onSelect={() => {}} />);
    expect((html.match(/data-point-id=/g) ?? []).length).toBeLessThanOrEqual(14);
    expect(html).toContain(`data-point-id="${selected}"`);
    expect(html).toContain(`aria-posinset="${count}" aria-setsize="${count}"`);
    expect(html.match(/aria-current="date"/g)).toHaveLength(1);
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    const stack = renderToStaticMarkup(
      <DialogOpenContext.Provider value={true}>
        <HistoricalPointStack points={points} selected={selected} />
      </DialogOpenContext.Provider>,
    );
    expect(stack.match(/class="tm-home-layer"/g)).toHaveLength(10);
    expect(stack.match(/class="tm-historical-home"/g)).toHaveLength(1);
    expect(stack).toContain('Saved server');
  }
});

test('closing rejoins every known capture behind the selected Home at either endpoint and the middle', () => {
  const points = orderedPoints(timelineStressPoints(16));
  for (const index of [0, 7, 15]) {
    const selected = points[index]?.id ?? null;
    const cards = pointStackCards(points, index, false);
    expect(cards).toHaveLength(points.length);
    expect(new Set(cards.map((point) => point.id))).toEqual(new Set(points.map((point) => point.id)));
    const depths = cards.map((point) => pointFoldDepth(points.indexOf(point) - index, points.length));
    expect(depths).toEqual(Array.from({ length: 16 }, (_, depth) => depth));
    const html = renderToStaticMarkup(<HistoricalPointStack points={points} selected={selected} />);
    expect(html.match(/class="tm-home-layer"/g)).toHaveLength(16);
    expect(html.match(/data-front="true"/g)).toHaveLength(1);
    expect(html.match(/class="tm-historical-home"/g)).toHaveLength(1);
    expect(html).toContain(`data-point-card="${selected}" data-depth="0" data-front="true"`);
  }
  expect(pointStackCards(points, 15, true)).toHaveLength(1);
  expect(pointStackCards(points, -1, false)).toEqual([]);
  expect(pointStackCards(timelineStressPoints(10_000), 9999, false)).toHaveLength(16);
});

test('virtual ruler range calculation bounds rows across scroll positions, endpoint jumps and larger measured sizes', () => {
  const points = timelineStressPoints(10_000);
  for (const size of [76, 160, 240]) {
    const offsets = timelineOffsets(points, new Map(), size);
    for (const index of [0, 1, 200, 5000, 9999, 5000, 199, 0, 9999]) {
      const position = offsets[index] ?? 0;
      const indices = timelineWindow(offsets, position, 640, [9999, 0]);
      expect(indices.length).toBeLessThanOrEqual(18);
      expect(indices).toContain(index);
      expect(indices).toContain(9999);
      expect(indices).toContain(0);
      expect(new Set(indices).size).toBe(indices.length);
      expect(timelineIndexAt(offsets, position)).toBe(index);
    }
    expect(timelineIndexAt(offsets, -20)).toBe(0);
    expect(timelineIndexAt(offsets, Number.MAX_SAFE_INTEGER)).toBe(9999);
  }
  const sizes = new Map(points.slice(0, 100).map((point, index) => [point.id, index % 2 ? 240 : 76]));
  const offsets = timelineOffsets(points, sizes);
  expect(offsets[100]).toBe(15_800);
  expect(timelineIndexAt(offsets, 15_799)).toBe(99);
  expect(timelineIndexAt(offsets, 15_800)).toBe(100);
  expect(timelineWindow([0], 0, 640)).toEqual([]);
  const ordered = orderedPoints(points);
  expect(timelineTarget(ordered, ordered[0]?.id ?? null, 'Home')).toBe(points[0]?.id ?? null);
  expect(timelineTarget(ordered, points[0]?.id ?? null, 'End')).toBe(ordered[0]?.id ?? null);
});
test('ten cards unfold from a compact plane into a bounded perspective fan at desktop and phone sizes', () => {
  for (const compact of [false, true]) {
    const frontInset = compact ? 116 : 190;
    let lastTop = Number.POSITIVE_INFINITY;
    for (let depth = 0; depth < 10; depth++) {
      const folded = pointCardPose(depth, 'folded', compact);
      const spread = pointCardPose(depth, 'spread', compact);
      const projectedTop = ((frontInset + spread.y) * 1200) / (1200 - spread.z);
      expect(projectedTop).toBeGreaterThanOrEqual(0);
      expect(projectedTop).toBeLessThan(lastTop);
      expect(spread.opacity).toBe(1);
      expect(spread.rotateX).toBe(0);
      expect(folded.rotateX).toBeLessThan(0);
      expect(Math.abs(folded.z - pointCardPose(0, 'folded', compact).z)).toBeLessThanOrEqual(27);
      if (depth > 0) expect(spread.z).toBeLessThan(folded.z);
      lastTop = projectedTop;
    }
    expect(pointCardPose(-1, 'spread', compact).z).toBeGreaterThan(0);
    expect(pointCardPose(-1, 'spread', compact).opacity).toBe(0);
    expect(pointCardPose(10, 'spread', compact).opacity).toBe(0);
    expect(pointCardPose(1000, 'spread', compact)).toEqual(pointCardPose(10, 'spread', compact));
    expect(pointCardPose(-1000, 'spread', compact)).toEqual(pointCardPose(-1, 'spread', compact));
  }
  expect(pointMotionSeconds.sceneExit).toBeGreaterThan(pointMotionSeconds.fold);
});
test('motion is optional for OS/app reduction and low effects while keeping the same settled geometry', () => {
  expect(pointMotionEnabled(false, false)).toBe(true);
  for (const [reduced, low] of [
    [true, false],
    [false, true],
    [true, true],
  ]) {
    expect(pointMotionEnabled(Boolean(reduced), Boolean(low))).toBe(false);
  }
  const settled = pointCardPose(0, 'spread');
  expect(settled).toEqual({ y: 0, z: 0, scale: 1, rotateX: 0, opacity: 1 });
});

test('rapid past, reversal and endpoint jumps admit only the current and immediately previous Home bodies', () => {
  const ids = Array.from({ length: 12 }, (_, index) => `point-${index}`);
  const selections = [0, 1, 2, 3, 4, 5, 6, 5, 4, 3, 0, 11, 0, 1, 0];
  let previous: string | null = null;
  for (const index of selections) {
    const current = ids[index];
    if (!current) throw new Error('Stress fixture selection missing');
    const admitted = ids.filter((id) => pointPreviewAdmitted(id, current, previous));
    expect(admitted.length).toBeLessThanOrEqual(2);
    expect(admitted).toContain(current);
    if (previous !== null) expect(admitted).toContain(previous);
    for (const id of ids) {
      if (id !== current && id !== previous) expect(pointPreviewAdmitted(id, current, previous)).toBe(false);
    }
    previous = current;
  }
  expect(pointPreviewAdmitted('point-1', null, null)).toBe(false);
});

test('mounted Time Machine polling serializes reads, recovers automatically and pauses without losing drafts', async () => {
  const child = Bun.spawn([process.execPath, new URL('./time-machine-poll.fixture.tsx', import.meta.url).pathname], {
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({
    mountedReact: true,
    maximumPollingReads: 1,
    automaticErrorRecovery: true,
    hiddenAndUnmountedPause: true,
    draftPreserved: true,
  });
});

test('an empty timeline uses the full scene body without mounting an empty date column', () => {
  const props = { selected: null, wallpaper: null, assetFailed: false, assetLoading: false, onSelect: () => undefined };
  const empty = renderToStaticMarkup(<HistoricalTimelineBody {...props} points={[]} />);
  expect(empty).toContain('class="tm-journey-layout" data-empty="true"');
  expect(empty).toContain('No saved points');
  expect(empty).not.toContain('class="tm-timeline"');
  expect(empty).not.toContain('aria-label="Saved dates"');
  const point = historicalPoint();
  const populated = renderToStaticMarkup(<HistoricalTimelineBody {...props} points={[point]} selected={point.id} />);
  expect(populated).toContain('data-empty="false"');
  expect(populated).toContain('aria-label="Saved dates"');
  expect(populated).not.toContain('No saved points');
});

test('wallpaper resolution does not restart a mounted card opening', async () => {
  const child = Bun.spawn([process.execPath, new URL('./time-machine-opening.fixture.tsx', import.meta.url).pathname], {
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(JSON.parse(stdout)).toEqual({
    wallpaperDoesNotRestart: true,
    closeRetargets: true,
    otherChangesRetarget: true,
    returningBackStartsBehind: true,
  });
});

test('generic entry chooses the newest point and Browse keeps its requested point', () => {
  const newer = historicalPoint();
  const older = { ...historicalPoint(), id: 'older', createdAt: newer.createdAt - 1000 };
  const points = [newer, older];
  let selection: string | null = older.id;
  let open = false;
  const choose = (id: string | null) => {
    selection = id;
  };
  const show = (value: boolean) => {
    open = value;
  };
  openTimelineAt(null, choose, show);
  expect(open).toBe(true);
  expect(selectedPointId(points, selection)).toBe(newer.id);
  open = false;
  openTimelineAt(older.id, choose, show);
  expect(open).toBe(true);
  expect(selectedPointId(points, selection)).toBe(older.id);
});

test('card travel coalesces repeated input and cancels pending input on close', () => {
  let clock = 0;
  let nextId = 0;
  const timers = new Map<number, { run: () => void; delay: number }>();
  const gate = createPointTravelGate(
    () => clock,
    (run, delay) => {
      timers.set(++nextId, { run, delay });
      return nextId as unknown as ReturnType<typeof setTimeout>;
    },
    (id) => {
      timers.delete(id as unknown as number);
    },
  );
  const selected: number[] = [];
  const select = (id: number) => {
    selected.push(id);
    gate.hold(pointMotionSeconds.travel);
  };
  gate.request(() => select(1));
  clock = 110;
  for (let repeat = 0; repeat < 80; repeat++) gate.request(() => select(2));
  expect(selected).toEqual([1]);
  expect(timers.size).toBe(1);
  expect(timers.get(1)?.delay).toBe(410);
  gate.request(() => select(0));
  clock = 520;
  timers.get(1)?.run();
  timers.delete(1);
  expect(selected).toEqual([1, 0]);
  clock = 600;
  gate.request(() => select(3));
  gate.reset();
  expect(timers.size).toBe(0);
  expect(selected).toEqual([1, 0]);
  gate.hold(pointMotionSeconds.unfold + 0.08);
  gate.request(() => select(4));
  expect([...timers.values()][0]?.delay).toBe(840);
  clock = 2000;
  gate.request(() => select(5));
  expect(timers.size).toBe(0);
  expect(selected).toEqual([1, 0, 5]);
});
