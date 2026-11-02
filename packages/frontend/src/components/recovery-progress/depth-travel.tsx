import { useEffect, useRef, type CSSProperties } from 'react';
import { animate } from 'framer-motion';
import { useReducedMotion } from '@/desktop/motion-preferences';
import { useWindowVisible } from '@/desktop/window-visibility';
import './depth-travel.css';

export type DepthTravelVariant = 'timeline' | 'restore' | 'update' | 'downgrade' | 'onboarding';

const stars = Array.from({ length: 48 }, (_, index) => ({
  x: 2 + ((index * 373 + 71) % 960) / 10,
  y: 2 + ((index * 537 + 193) % 960) / 10,
  size: index % 13 === 0 ? 2.5 : index % 5 === 0 ? 1.5 : 1,
  bright: index % 13 === 0,
  opacity: 0.35 + ((index * 17) % 55) / 100,
}));

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
  useEffect(() => {
    const element = field.current;
    const target = Number.isFinite(distance) ? Math.max(0, Math.min(1024, distance)) : 0;
    if (!element || departing || !active || !visible || reduced || document.documentElement.dataset.orbisEffects === 'low') {
      shownDistance.current = target;
      element?.style.setProperty('--depth-camera-z', '0px');
      return;
    }
    const origin = shownDistance.current;
    if (origin === target) return;
    const animations = [...element.querySelectorAll('.depth-travel-plane')].flatMap((plane) =>
      typeof plane.getAnimations === 'function' ? plane.getAnimations() : [],
    );
    if (!animations.length) {
      shownDistance.current = target;
      return;
    }
    const displacement = Math.abs(target - origin) * 5200;
    element.dataset.travelling = 'true';
    const clocks = animations.map((animation) => {
      const duration = Number(animation.effect?.getTiming().duration) || 4800;
      const current = Number(animation.currentTime) || 0;
      const base = (((current % duration) + duration) % duration) + (Math.ceil(displacement / duration) + 2) * duration;
      animation.pause();
      animation.currentTime = base;
      return base;
    });
    const travel = animate(origin, target, {
      duration: 0.65,
      ease: [0.22, 0.72, 0.18, 1],
      onUpdate: (value) => {
        shownDistance.current = value;
        element.style.setProperty('--depth-camera-z', `${(280 * value) / (value + 5)}px`);
        animations.forEach((animation, index) => {
          animation.currentTime = (clocks[index] ?? 0) + (value - origin) * 5200;
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
    const animations = planes.flatMap((plane) => (typeof plane.getAnimations === 'function' ? plane.getAnimations() : []));
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
      {[0, 1, 2].map((layer) => (
        <div key={layer} className="depth-travel-plane" style={{ '--depth-layer': layer } as CSSProperties}>
          {stars.map((star) => (
            <i
              key={`${star.x}-${star.y}`}
              data-bright={star.bright || undefined}
              style={
                {
                  left: `${star.x}%`,
                  top: `${star.y}%`,
                  width: star.size,
                  height: star.size,
                  opacity: star.opacity,
                  '--star-angle': `${(Math.atan2(star.y - 50, star.x - 50) * 180) / Math.PI}deg`,
                } as CSSProperties
              }
            />
          ))}
        </div>
      ))}
    </div>
  );
}
