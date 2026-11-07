import { useEffect, useRef, type CSSProperties } from 'react';
import { animate } from 'framer-motion';
import { useReducedMotion } from '@/desktop/motion-preferences';
import { useWindowVisible } from '@/desktop/window-visibility';
import { loadCloudMask } from './depth-cloud-mask';
import { depthCameraKeyframes, depthCameraZ, depthPlaneKeyframes } from './depth-travel-motion';
import './depth-travel.css';

export type DepthTravelVariant = 'timeline' | 'restore' | 'update' | 'downgrade' | 'onboarding';

function starTexture(layer: number, trails: boolean) {
  const marks = Array.from({ length: 80 }, (_, index) => {
    const seed = index + layer * 89;
    const x = 20 + ((seed * 373 + 71) % 960);
    const y = 20 + ((seed * 537 + 193) % 960);
    const size = index % 17 === 0 ? 1.4 : index % 5 === 0 ? 0.85 : 0.55;
    const opacity = 0.32 + ((seed * 17) % 55) / 100;
    const colour = index % 23 === 11 ? '#e3d3b5' : index % 9 === 4 ? '#c9d9e8' : '#d9e3eb';
    if (!trails) return `<circle cx="${x}" cy="${y}" r="${size}" fill="${colour}" opacity="${opacity}"/>`;
    const radius = Math.hypot(x - 500, y - 500) || 1;
    const length = 3 + (radius / 700) * 8;
    return `<path d="M${x},${y}l${(((500 - x) / radius) * length).toFixed(2)},${(((500 - y) / radius) * length).toFixed(2)}" stroke="${colour}" stroke-width="${size * 0.65}" opacity="${opacity * 0.5}"/>`;
  }).join('');
  return `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid slice">${marks}</svg>`)}")`;
}

// Three cached textures move as layers; individual stars never need DOM updates.
const starPlanes = [0, 1, 2].map((layer) => (
  <div
    key={layer}
    className="depth-travel-plane"
    style={{ '--depth-layer': layer, '--depth-stars': starTexture(layer, false), '--depth-trails': starTexture(layer, true) } as CSSProperties}
  />
));

export function DepthTravel({
  active = true,
  className = '',
  mode = 'travel',
  departing = false,
  distance = 0,
  variant = 'restore',
}: {
  active?: boolean;
  className?: string;
  mode?: 'ambient' | 'travel';
  departing?: boolean;
  distance?: number;
  variant?: DepthTravelVariant;
}) {
  const reduced = useReducedMotion();
  const visible = useWindowVisible();
  const field = useRef<HTMLDivElement>(null);
  const shownDistance = useRef(0);
  const decodedMask = loadCloudMask.peek();
  useEffect(() => {
    let mounted = true;
    void loadCloudMask().then((image) => {
      if (mounted && image) field.current?.style.setProperty('--depth-cloud-mask', `url("${image.src}")`);
    });
    return () => {
      mounted = false;
    };
  }, []);
  useEffect(() => {
    const element = field.current;
    const camera = element?.querySelector<HTMLElement>('.depth-travel-camera');
    const target = Number.isFinite(distance) ? Math.max(0, Math.min(1024, distance)) : 0;
    if (!element || departing || !active || !visible || reduced || document.documentElement.dataset.orbisEffects === 'low') {
      shownDistance.current = target;
      camera?.style.setProperty('--depth-camera-z', '0px');
      return;
    }
    const origin = shownDistance.current;
    if (origin === target) return;
    const planes = [...element.querySelectorAll<HTMLElement>('.depth-travel-plane')];
    const clocks = planes.flatMap((plane) =>
      typeof plane.getAnimations === 'function'
        ? plane
            .getAnimations()
            .filter((animation) => 'animationName' in animation && animation.animationName === 'depth-travel-forward')
            .map((animation) => ({ plane, animation }))
        : [],
    );
    const animations = clocks.map(({ animation }) => animation);
    if (!animations.length) {
      shownDistance.current = target;
      return;
    }
    const displacement = Math.abs(target - origin) * 5200;
    element.dataset.travelling = 'true';
    const bases = animations.map((animation) => {
      const duration = Number(animation.effect?.getTiming().duration) || 4800;
      const current = Number(animation.currentTime) || 0;
      const base = (((current % duration) + duration) % duration) + (Math.ceil(displacement / duration) + 2) * duration;
      animation.pause();
      animation.currentTime = base;
      return base;
    });
    if (camera && typeof camera.animate === 'function' && planes.every((plane) => typeof plane.animate === 'function')) {
      const effects: Animation[] = [];
      try {
        const timing = { duration: 650, easing: 'cubic-bezier(0.22, 0.72, 0.18, 1)', fill: 'both' as const };
        const cameraMotion = camera.animate(depthCameraKeyframes(origin, target), timing);
        cameraMotion.id = 'orbis-depth-camera-travel';
        effects.push(cameraMotion);
        clocks.forEach(({ plane, animation }, index) => {
          const baseTiming = animation.effect?.getTiming();
          const duration = Number(baseTiming?.duration) || 4800;
          const start = (bases[index] ?? 0) - (Number(baseTiming?.delay) || 0);
          const effect = plane.animate(depthPlaneKeyframes(start, start + (target - origin) * 5200, duration), timing);
          effect.id = 'orbis-depth-plane-travel';
          effects.push(effect);
        });
        const startTime = document.timeline.currentTime;
        if (typeof startTime === 'number') for (const effect of effects) effect.startTime = startTime;
        let settled = false;
        const settle = (complete: boolean) => {
          if (settled) return;
          settled = true;
          const progress = complete ? 1 : Math.max(0, Math.min(1, cameraMotion.effect?.getComputedTiming().progress ?? 0));
          const distance = origin + (target - origin) * progress;
          shownDistance.current = distance;
          camera.style.setProperty('--depth-camera-z', `${depthCameraZ(distance)}px`);
          animations.forEach((animation, index) => {
            if (animation.playState !== 'idle') animation.currentTime = (bases[index] ?? 0) + (distance - origin) * 5200;
          });
          for (const effect of effects) effect.cancel();
          delete element.dataset.travelling;
          if (element.isConnected) for (const animation of animations) if (animation.playState !== 'idle') animation.play();
        };
        void cameraMotion.finished.then(
          () => settle(true),
          () => undefined,
        );
        return () => settle(false);
      } catch {
        for (const effect of effects) effect.cancel();
      }
    }
    const travel = animate(origin, target, {
      duration: 0.65,
      ease: [0.22, 0.72, 0.18, 1],
      onUpdate: (value) => {
        shownDistance.current = value;
        camera?.style.setProperty('--depth-camera-z', `${(280 * value) / (value + 5)}px`);
        animations.forEach((animation, index) => {
          animation.currentTime = (bases[index] ?? 0) + (value - origin) * 5200;
        });
      },
      onComplete: () => {
        delete element.dataset.travelling;
        if (element.isConnected) {
          for (const animation of animations) {
            if (animation.playState !== 'idle') animation.play();
          }
        }
      },
    });
    return () => {
      delete element.dataset.travelling;
      travel.stop();
      if (element.isConnected) {
        for (const animation of animations) {
          if (animation.playState !== 'idle') animation.play();
        }
      }
    };
  }, [active, departing, distance, reduced, visible]);
  useEffect(() => {
    const element = field.current;
    if (!element || !departing || !active || !visible || reduced || document.documentElement.dataset.orbisEffects === 'low') return;
    const planes = [...element.querySelectorAll('.depth-travel-plane')];
    const animations = planes.flatMap((plane) =>
      typeof plane.getAnimations === 'function'
        ? plane.getAnimations().filter((animation) => 'animationName' in animation && animation.animationName === 'depth-travel-forward')
        : [],
    );
    if (!animations.length) return;
    const rates = animations.map((animation) => animation.playbackRate);
    let acceleration: ReturnType<typeof animate> | undefined;
    acceleration = animate(1, 9, {
      duration: 1,
      ease: [0.6, 0, 1, 1],
      onUpdate: (rate) => {
        if (!element.isConnected || document.visibilityState === 'hidden' || document.documentElement.dataset.orbisEffects === 'low') {
          acceleration?.stop();
          return;
        }
        for (const animation of animations) {
          if (typeof animation.updatePlaybackRate === 'function') animation.updatePlaybackRate(rate);
          else animation.playbackRate = rate;
        }
      },
    });
    return () => {
      acceleration?.stop();
      animations.forEach((animation, index) => {
        const rate = rates[index] ?? 1;
        if (typeof animation.updatePlaybackRate === 'function') animation.updatePlaybackRate(rate);
        else animation.playbackRate = rate;
      });
    };
  }, [active, departing, reduced, visible]);
  return (
    <div
      ref={field}
      className={`depth-travel ${className}`}
      style={decodedMask ? ({ '--depth-cloud-mask': `url("${decodedMask.src}")` } as CSSProperties) : undefined}
      aria-hidden="true"
      data-active={active && visible}
      data-reduced={Boolean(reduced)}
      data-mode={mode}
      data-departing={departing || undefined}
      data-distance={distance}
      data-variant={variant}
    >
      <div className="depth-travel-distant-stars" />
      <div className="depth-travel-camera">
        <div className="depth-travel-horizon">
          <div className="depth-travel-cloud depth-travel-cloud-far" />
          <div className="depth-travel-cloud depth-travel-cloud-near" />
        </div>
      </div>
      {starPlanes}
    </div>
  );
}
