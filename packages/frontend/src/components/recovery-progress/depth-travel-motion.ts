const MAX_DISTANCE = 1024;
const MAX_TRAVEL_MS = MAX_DISTANCE * 5200;
const MAX_PLANE_FRAMES = 16384;
const MAX_CAMERA_DEPTH = 20;
const CAMERA_TOLERANCE = 0.045;

function validDistance(value: number) {
  return Number.isFinite(value) && value >= 0 && value <= MAX_DISTANCE;
}

export function depthCameraZ(distance: number): number {
  if (!validDistance(distance)) throw new RangeError('Invalid depth distance');
  return (280 * distance) / (distance + 5);
}

export function depthCameraKeyframes(origin: number, target: number): Keyframe[] {
  if (!validDistance(origin) || !validDistance(target)) throw new RangeError('Invalid depth distance');
  const frames: Keyframe[] = [{ offset: 0, transform: `translateZ(${depthCameraZ(origin)}px)` }];
  const add = (a: number, za: number, b: number, zb: number, depth: number) => {
    const mid = (a + b) / 2;
    const zm = depthCameraZ(origin + (target - origin) * mid);
    if (Math.abs(zm - (za + zb) / 2) > CAMERA_TOLERANCE) {
      if (depth >= MAX_CAMERA_DEPTH) throw new RangeError('Camera keyframe limit exceeded');
      add(a, za, mid, zm, depth + 1);
      add(mid, zm, b, zb, depth + 1);
    } else {
      frames.push({ offset: b, transform: `translateZ(${zb}px)` });
    }
  };
  add(0, depthCameraZ(origin), 1, depthCameraZ(target), 0);
  return frames;
}

function planeFrame(phase: number, offset: number): Keyframe {
  const opacity = phase <= 0.15 ? (phase / 0.15) * 0.65 : phase <= 0.82 ? 0.65 + ((phase - 0.15) / 0.67) * 0.25 : ((1 - phase) / 0.18) * 0.9;
  return { offset, transform: `translateZ(${-900 + phase * 1320}px)`, opacity };
}

export function depthPlaneKeyframes(startMs: number, endMs: number, durationMs: number): Keyframe[] {
  if (
    ![startMs, endMs, durationMs].every(Number.isFinite) ||
    durationMs <= 0 ||
    Math.abs(endMs - startMs) > MAX_TRAVEL_MS ||
    Math.max(Math.abs(startMs), Math.abs(endMs)) > 1e12
  )
    throw new RangeError('Invalid depth plane time');
  const start = startMs / durationMs;
  const end = endMs / durationMs;
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    Math.abs(start) > 1e9 ||
    Math.abs(end) > 1e9 ||
    Math.abs(end - start) * 4 + 10 > MAX_PLANE_FRAMES
  )
    throw new RangeError('Depth plane keyframe limit exceeded');
  const direction = end >= start ? 1 : -1;
  const phase = (time: number) => time - Math.floor(time);
  const frames: Keyframe[] = [planeFrame(phase(start), 0)];
  if (start === end) return [...frames, planeFrame(phase(end), 1)];
  if (direction < 0 && Number.isInteger(start)) frames.push(planeFrame(1, 0));
  const knots: number[] = [];
  for (let cycle = Math.floor(Math.min(start, end)); cycle <= Math.floor(Math.max(start, end)); cycle++) {
    for (const point of [cycle, cycle + 0.15, cycle + 0.82]) {
      if (point > Math.min(start, end) && point < Math.max(start, end)) knots.push(point);
    }
  }
  knots.sort((a, b) => direction * (a - b));
  for (const knot of knots) {
    const offset = (knot - start) / (end - start);
    if (Number.isInteger(knot)) {
      frames.push(planeFrame(direction > 0 ? 1 : 0, offset), planeFrame(direction > 0 ? 0 : 1, offset));
    } else frames.push(planeFrame(phase(knot), offset));
  }
  if (direction > 0 && Number.isInteger(end)) frames.push(planeFrame(1, 1));
  frames.push(planeFrame(phase(end), 1));
  return frames;
}
