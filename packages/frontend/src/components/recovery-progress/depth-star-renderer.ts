import { depthStarMarks } from './depth-star-data';

const starPlanes = [0, 1, 2].map((layer) => {
  const marks = depthStarMarks(layer);
  let minimum = Number.POSITIVE_INFINITY;
  let maximumRadius = 0;
  for (const [index, mark] of marks.entries()) {
    maximumRadius = Math.max(maximumRadius, mark.radius);
    for (let other = index + 1; other < marks.length; other++) {
      const next = marks[other];
      if (next) minimum = Math.min(minimum, Math.hypot(mark.x - next.x, mark.y - next.y));
    }
  }
  return { marks, gap: minimum - 2 * maximumRadius };
});

export function depthStarProjection(width: number, height: number, ox: number, oy: number, perspective: number, z: number) {
  const scale = perspective / (perspective - z);
  const planeWidth = width * 1.9;
  const planeHeight = height * 1.9;
  const side = Math.max(planeWidth, planeHeight);
  const left = ox + (-width * 0.45 - ox) * scale;
  const top = oy + (-height * 0.45 - oy) * scale;
  return {
    left,
    top,
    width: planeWidth * scale,
    height: planeHeight * scale,
    factor: (side / 1000) * scale,
    trailLeft: left + ((planeWidth - side) * scale) / 2,
    trailTop: top + ((planeHeight - side) * scale) / 2,
  };
}

export function createDepthStarRenderer(root: HTMLElement): (() => void) | null {
  if (root.hasAttribute('data-depth-stars')) return null;
  const planes = [...root.querySelectorAll<HTMLElement>(':scope > .depth-travel-plane')];
  if (planes.length !== 3) return null;
  let dispose: (() => void) | undefined;
  try {
    const canvas = document.createElement('canvas');
    const layer = document.createElement('canvas');
    const trails = document.createElement('canvas');
    layer.width = layer.height = 0;
    trails.width = trails.height = 0;
    const out = canvas.getContext('2d');
    const planeContext = layer.getContext('2d');
    const trailContext = trails.getContext('2d');
    if (!out || !planeContext || !trailContext) return null;
    const surfaces = [canvas, layer, trails];
    canvas.className = 'depth-travel-stars';
    canvas.setAttribute('aria-hidden', 'true');
    let frame = 0;
    let disposed = false;
    let ownsMarker = false;
    let settleUntil = 0;
    let backingWidth = 0;
    let backingHeight = 0;
    let resize: ResizeObserver | undefined;
    let changes: MutationObserver | undefined;
    const reducedMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
    const unmark = () => {
      if (ownsMarker && root.dataset.depthStars === 'canvas') delete root.dataset.depthStars;
      ownsMarker = false;
    };
    const clear = (context: CanvasRenderingContext2D) => {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.globalAlpha = 1;
      context.clearRect(0, 0, backingWidth, backingHeight);
    };
    const position = (value: string, extent: number) => (value.endsWith('%') ? (Number.parseFloat(value) * extent) / 100 : Number.parseFloat(value));
    const draw = () => {
      frame = 0;
      if (disposed || document.hidden) return;
      try {
        const computed = getComputedStyle(root);
        const number = (name: keyof CSSStyleDeclaration) => Number.parseFloat(String(computed[name])) || 0;
        const width =
          number('width') +
          (computed.boxSizing === 'border-box'
            ? -number('borderLeftWidth') - number('borderRightWidth')
            : number('paddingLeft') + number('paddingRight'));
        const height =
          number('height') +
          (computed.boxSizing === 'border-box'
            ? -number('borderTopWidth') - number('borderBottomWidth')
            : number('paddingTop') + number('paddingBottom'));
        if (!(width > 0 && height > 0)) {
          unmark();
          return;
        }
        const dpr = window.devicePixelRatio || 1;
        const bw = Math.max(1, Math.round(width * dpr));
        const bh = Math.max(1, Math.round(height * dpr));
        if (bw !== backingWidth || bh !== backingHeight) {
          backingWidth = bw;
          backingHeight = bh;
          canvas.width = bw;
          canvas.height = bh;
        }
        const sx = bw / width;
        const sy = bh / height;
        const [xOrigin = '', yOrigin = ''] = computed.perspectiveOrigin.split(/\s+/);
        const ox = position(xOrigin, width);
        const oy = position(yOrigin, height);
        const perspective = Number.parseFloat(computed.perspective);
        if (![ox, oy, perspective].every(Number.isFinite) || perspective <= 0) throw new Error('Invalid perspective');
        clear(out);
        for (let index = 0; index < planes.length; index++) {
          const plane = planes[index];
          const starPlane = starPlanes[index];
          if (!plane || !starPlane) throw new Error('Missing star plane');
          const { marks: stars, gap } = starPlane;
          const state = getComputedStyle(plane);
          if (state.display === 'none' || state.visibility === 'hidden') continue;
          const alpha = Number(state.opacity);
          if (!(alpha > 0)) continue;
          const matrix = state.transform === 'none' ? new DOMMatrixReadOnly() : new DOMMatrixReadOnly(state.transform);
          const geometry = depthStarProjection(width, height, ox, oy, perspective, matrix.m43);
          if (!Object.values(geometry).every(Number.isFinite) || geometry.factor <= 0) throw new Error('Invalid star projection');
          const fringe = Math.max(1 / sx, 1 / sy);
          const intersects = (left: number, top: number, right: number, bottom: number) =>
            right >= -fringe && bottom >= -fringe && left <= width + fringe && top <= height + fringe;
          const trailOpacity = Number(getComputedStyle(plane, '::after').opacity);
          const direct = trailOpacity === 0 && gap * geometry.factor * Math.min(sx, sy) > 2 * Math.SQRT2;
          const starsContext = direct ? out : planeContext;
          const sizeScratch = (surface: HTMLCanvasElement) => {
            if (surface.width !== bw || surface.height !== bh) {
              surface.width = bw;
              surface.height = bh;
            }
          };
          if (!direct) {
            sizeScratch(layer);
            clear(planeContext);
          }
          if (trailOpacity > 0) {
            sizeScratch(trails);
            clear(trailContext);
          }
          for (const context of trailOpacity > 0 ? [starsContext, trailContext] : [starsContext]) {
            context.save();
            context.setTransform(sx, 0, 0, sy, 0, 0);
            context.beginPath();
            context.rect(geometry.left, geometry.top, geometry.width, geometry.height);
            context.clip();
          }
          starsContext.setTransform(sx * geometry.factor, 0, 0, sy * geometry.factor, sx * geometry.left, sy * geometry.top);
          for (const mark of stars) {
            const x = geometry.left + mark.x * geometry.factor;
            const y = geometry.top + mark.y * geometry.factor;
            const radius = mark.radius * geometry.factor;
            // Keep the antialiased edge; off-canvas paths cannot contribute pixels.
            if (!intersects(x - radius, y - radius, x + radius, y + radius)) continue;
            starsContext.globalAlpha = mark.opacity * (direct ? alpha : 1);
            starsContext.fillStyle = mark.colour;
            starsContext.beginPath();
            starsContext.arc(mark.x, mark.y, mark.radius, 0, Math.PI * 2);
            starsContext.fill();
          }
          starsContext.restore();
          if (trailOpacity > 0) {
            trailContext.setTransform(sx * geometry.factor, 0, 0, sy * geometry.factor, sx * geometry.trailLeft, sy * geometry.trailTop);
            for (const mark of stars) {
              const x = geometry.trailLeft + mark.x * geometry.factor;
              const y = geometry.trailTop + mark.y * geometry.factor;
              const endX = x + Number(mark.dx) * geometry.factor;
              const endY = y + Number(mark.dy) * geometry.factor;
              const radius = mark.radius * 0.325 * geometry.factor;
              if (!intersects(Math.min(x, endX) - radius, Math.min(y, endY) - radius, Math.max(x, endX) + radius, Math.max(y, endY) + radius))
                continue;
              trailContext.globalAlpha = mark.opacity * 0.5;
              trailContext.strokeStyle = mark.colour;
              trailContext.lineWidth = mark.radius * 0.65;
              trailContext.lineCap = 'butt';
              trailContext.beginPath();
              trailContext.moveTo(mark.x, mark.y);
              trailContext.lineTo(mark.x + Number(mark.dx), mark.y + Number(mark.dy));
              trailContext.stroke();
            }
            trailContext.restore();
            planeContext.setTransform(1, 0, 0, 1, 0, 0);
            planeContext.globalAlpha = trailOpacity;
            planeContext.drawImage(trails, 0, 0);
          }
          if (!direct) {
            out.globalAlpha = alpha;
            out.drawImage(layer, 0, 0);
          }
        }
        out.globalAlpha = 1;
        if (!ownsMarker) {
          root.dataset.depthStars = 'canvas';
          ownsMarker = true;
        }
        const active =
          root.dataset.active === 'true' &&
          root.dataset.reduced !== 'true' &&
          document.documentElement.dataset.orbisEffects !== 'low' &&
          !reducedMedia.matches;
        if (active || performance.now() < settleUntil) frame = requestAnimationFrame(draw);
      } catch {
        dispose?.();
      }
    };
    const wake = () => {
      if (disposed) return;
      settleUntil = performance.now() + 350;
      if (!frame && !document.hidden) frame = requestAnimationFrame(draw);
    };
    const visibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(frame);
        frame = 0;
      } else wake();
    };
    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(frame);
      resize?.disconnect();
      changes?.disconnect();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('resize', wake);
      reducedMedia.removeEventListener('change', wake);
      for (const surface of surfaces) {
        surface.removeEventListener('contextlost', cleanup);
        surface.width = 0;
        surface.height = 0;
      }
      canvas.remove();
      unmark();
    };
    dispose = cleanup;
    for (const surface of surfaces) surface.addEventListener('contextlost', cleanup);
    root.append(canvas);
    resize = new ResizeObserver(wake);
    resize.observe(root);
    changes = new MutationObserver(wake);
    changes.observe(root, { attributes: true, attributeFilter: ['data-active', 'data-reduced', 'data-departing', 'data-travelling'] });
    changes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-orbis-effects'] });
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('resize', wake);
    reducedMedia.addEventListener('change', wake);
    draw();
    return disposed ? null : dispose;
  } catch {
    dispose?.();
    return null;
  }
}
