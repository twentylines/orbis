import { expect, test } from 'bun:test';
import { replayStartupChrome } from './dock-companion';

test('startup reveal replays the existing bar and dock entrance without touching other motion', () => {
  const bar = {
    animationName: 'orbis-chrome-enter',
    currentTime: 700,
    plays: 0,
    play() {
      this.plays++;
    },
  };
  const dock = {
    animationName: 'orbis-dock-enter',
    currentTime: 700,
    plays: 0,
    play() {
      this.plays++;
    },
  };
  const other = {
    animationName: 'other',
    currentTime: 42,
    plays: 0,
    play() {
      this.plays++;
    },
  };
  const root = {
    querySelector: (selector: string) => ({ getAnimations: () => (selector === '.desktop-system-bar' ? [bar, other] : [dock]) }),
  } as unknown as HTMLElement;
  replayStartupChrome(root, true);
  expect(bar.plays).toBe(0);
  expect(dock.plays).toBe(0);
  replayStartupChrome(root, false);
  expect([bar.currentTime, dock.currentTime, bar.plays, dock.plays]).toEqual([0, 0, 1, 1]);
  expect([other.currentTime, other.plays]).toEqual([42, 0]);
});
