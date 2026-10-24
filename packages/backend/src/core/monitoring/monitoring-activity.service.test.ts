import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MonitoringActivityService } from './monitoring-activity.service';

describe('visible browser monitoring demand', () => {
  let activity: MonitoringActivityService;
  let changes: boolean[];

  beforeEach(() => {
    vi.useFakeTimers();
    activity = new MonitoringActivityService();
    changes = [];
    activity.subscribe((active) => changes.push(active));
  });
  afterEach(() => {
    activity.onModuleDestroy();
    vi.useRealTimers();
  });

  it('starts idle with no timer and stops only after the final subscriber disconnects', () => {
    expect(changes).toEqual([false]);
    expect(vi.getTimerCount()).toBe(0);
    const first = activity.connect();
    const second = activity.connect();
    expect(changes).toEqual([false, true]);
    first();
    first();
    expect(changes).toEqual([false, true]);
    second();
    expect(changes).toEqual([false, true, false]);
    const resume = activity.connect();
    expect(changes).toEqual([false, true, false, true]);
    resume();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps one renewable peer lease and expires without a collector renewing it', async () => {
    activity.touchPeer();
    expect(changes).toEqual([false, true]);
    await vi.advanceTimersByTimeAsync(30_000);
    activity.touchPeer();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(44_999);
    expect(changes).toEqual([false, true]);
    await vi.advanceTimersByTimeAsync(1);
    expect(changes).toEqual([false, true, false]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains only valid peer demand after browser close and browser demand after peer expiry', async () => {
    const first = activity.connect();
    activity.touchPeer();
    first();
    expect(changes).toEqual([false, true]);
    const second = activity.connect();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(changes).toEqual([false, true]);
    second();
    expect(changes).toEqual([false, true, false]);
  });

  it('removes listeners and cancels the bounded lease on shutdown', () => {
    const values: boolean[] = [];
    const stop = activity.subscribe((active) => values.push(active));
    stop();
    activity.touchPeer();
    expect(values).toEqual([false]);
    activity.onModuleDestroy();
    expect(changes).toEqual([false, true, false]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('uses one renewable browser lease and starts the quiet period only after it expires', async () => {
    expect(activity.isIdleFor(600_000)).toBe(false);
    activity.touchBrowser();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    activity.touchBrowser();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(74_999);
    expect(activity.isIdleFor(0)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(activity.isIdleFor(600_000)).toBe(false);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(activity.isIdleFor(600_000)).toBe(true);
    expect(changes).toEqual([false, true, false]);
  });

  it('cannot become idle while another browser or peer is still connected', async () => {
    const disconnect = activity.connect();
    activity.touchBrowser();
    await vi.advanceTimersByTimeAsync(900_000);
    expect(activity.isIdleFor(600_000)).toBe(false);
    disconnect();
    await vi.advanceTimersByTimeAsync(599_999);
    expect(activity.isIdleFor(600_000)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(activity.isIdleFor(600_000)).toBe(true);
  });
});
