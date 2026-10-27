import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { IconX } from '@tabler/icons-react';
import { Button } from '../Button';
import { hexToHSV, hsvToHex, type HSV } from './colour';
import './ColourPicker.css';

export function ColourPicker({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  const id = useId();
  const opener = useRef<HTMLButtonElement>(null);
  const clickX = useRef<number | null>(null);
  const focused = useRef(false);
  const dismissedByScroll = useRef(false);
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const [hsv, setHSV] = useState(() => hexToHSV(value));
  const [hex, setHex] = useState(value);
  const valid = /^#[a-f0-9]{6}$/i.test(hex);
  const preview = hsvToHex(hsv);
  useLayoutEffect(() => {
    if (!open || !panel) return;
    let frame = 0;
    const place = () => {
      const anchor = opener.current?.getBoundingClientRect();
      if (!anchor) return;
      const viewport = window.visualViewport;
      const start = viewport?.offsetTop ?? 0;
      const end = start + (viewport?.height ?? innerHeight);
      const leftEdge = viewport?.offsetLeft ?? 0;
      const rightEdge = leftEdge + (viewport?.width ?? innerWidth);
      const below = anchor.bottom + 8;
      const top = end - below - 12 >= 160 ? below : start + 12;
      const next = {
        left: Math.max(leftEdge + 12, Math.min(clickX.current ?? anchor.left, rightEdge - panel.offsetWidth - 12)),
        top,
        maxHeight: end - top - 12,
      };
      setPosition((previous) =>
        previous?.left === next.left && previous.top === next.top && previous.maxHeight === next.maxHeight ? previous : next,
      );
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    const dismissOnPageScroll = (event: Event) => {
      if (event.target instanceof Node && panel.contains(event.target)) return;
      dismissedByScroll.current = true;
      setOpen(false);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(panel);
    if (opener.current) observer.observe(opener.current);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', dismissOnPageScroll, true);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    place();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', dismissOnPageScroll, true);
      window.visualViewport?.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('scroll', schedule);
    };
  }, [open, panel]);
  useLayoutEffect(() => {
    if (open && panel && position && !focused.current) {
      focused.current = true;
      panel.querySelector('input')?.focus({ preventScroll: true });
    }
  }, [open, panel, position]);
  const changeChannel = (channel: keyof HSV, next: number) => {
    const updated = { ...hsv, [channel]: next };
    setHSV(updated);
    setHex(hsvToHex(updated));
  };
  const channels = [
    { key: 'hue', label: 'Hue', max: 359, unit: '°', track: 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)' },
    {
      key: 'saturation',
      label: 'Saturation',
      max: 100,
      unit: '%',
      track: `linear-gradient(to right, ${hsvToHex({ ...hsv, saturation: 0 })}, ${hsvToHex({ ...hsv, saturation: 100 })})`,
    },
    {
      key: 'brightness',
      label: 'Brightness',
      max: 100,
      unit: '%',
      track: `linear-gradient(to right, #000, ${hsvToHex({ ...hsv, brightness: 100 })})`,
    },
  ] as const;
  return (
    <DialogPrimitive.Root
      modal={false}
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setHSV(hexToHSV(value));
          setHex(value);
          setPosition(null);
          focused.current = false;
          dismissedByScroll.current = false;
          const anchor = opener.current?.getBoundingClientRect();
          const viewport = window.visualViewport;
          const end = (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight);
          if (anchor && end - anchor.bottom < 240) opener.current?.scrollIntoView({ block: 'center', behavior: 'instant' });
        }
        setOpen(next);
      }}
    >
      <DialogPrimitive.Trigger asChild>
        <Button
          ref={opener}
          type="button"
          className="colour-picker-trigger"
          aria-label="Choose accent colour"
          onPointerDown={(event) => {
            clickX.current = event.clientX;
          }}
          onKeyDown={() => {
            clickX.current = null;
          }}
        >
          <span style={{ background: value }} aria-hidden="true" />
          Choose colour
        </Button>
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          ref={setPanel}
          className="colour-picker-popover"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => {
            if (dismissedByScroll.current) event.preventDefault();
          }}
          style={{ ...position, visibility: position ? 'visible' : 'hidden' }}
        >
          <header className="colour-picker-header">
            <DialogPrimitive.Title>Accent colour</DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <Button type="button" size="icon" aria-label="Close colour picker">
                <IconX size={18} aria-hidden="true" />
              </Button>
            </DialogPrimitive.Close>
          </header>
          <DialogPrimitive.Description className="visually-hidden">
            Adjust the colour sliders or enter a hex colour, then apply your choice.
          </DialogPrimitive.Description>
          <div className="colour-picker-body">
            <div className="colour-picker-preview">
              <span className="colour-picker-sample" style={{ background: preview }} aria-hidden="true" />
              <label htmlFor={`${id}-hex`}>
                <span className="visually-hidden">Hex colour</span>
                <input
                  id={`${id}-hex`}
                  value={hex}
                  maxLength={7}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={!valid}
                  aria-describedby={valid ? undefined : `${id}-error`}
                  onChange={(event) => {
                    const next = event.target.value;
                    setHex(next);
                    if (/^#[a-f0-9]{6}$/i.test(next)) {
                      const converted = hexToHSV(next);
                      setHSV({ ...converted, hue: converted.saturation ? converted.hue : hsv.hue });
                    }
                  }}
                />
              </label>
            </div>
            {valid ? null : (
              <output id={`${id}-error`} className="colour-picker-error">
                Enter # followed by six hexadecimal digits.
              </output>
            )}
            <div className="colour-picker-channels">
              {channels.map(({ key, label, max, unit, track }) => (
                <label className="colour-picker-channel" key={key} htmlFor={`${id}-${key}`}>
                  <span>{label}</span>
                  <input
                    id={`${id}-${key}`}
                    type="range"
                    min={0}
                    max={max}
                    value={Math.round(hsv[key])}
                    aria-valuetext={`${Math.round(hsv[key])}${unit}`}
                    style={{ '--colour-track': track, '--colour-thumb': preview } as CSSProperties}
                    onChange={(event) => changeChannel(key, Number(event.target.value))}
                  />
                  <output htmlFor={`${id}-${key}`}>
                    {Math.round(hsv[key])}
                    {unit}
                  </output>
                </label>
              ))}
            </div>
          </div>
          <footer className="colour-picker-footer">
            <Button type="button" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              intent="primary"
              aria-label="Apply colour"
              disabled={!valid}
              onClick={() => {
                onChange(hex);
                setOpen(false);
              }}
            >
              Apply
            </Button>
          </footer>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
