import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from 'react';

export function AppearanceRange({
  label,
  value,
  min = 0,
  max,
  unit = '%',
  onChange,
  disabled = false,
  onPreview,
}: {
  label: string;
  value: number;
  min?: number;
  max: number;
  unit?: string;
  onChange: (value: number) => void;
  disabled?: boolean;
  onPreview?: (value: number) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  const [dragging, setDragging] = useState(false);
  const current = useRef(value);
  const saved = useRef(value);
  const frame = useRef(0);
  useEffect(() => {
    setDraft(value);
    current.current = value;
    saved.current = value;
  }, [value]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const commit = useCallback(() => {
    setDragging(false);
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    if (onPreview && current.current !== saved.current) {
      saved.current = current.current;
      onChange(current.current);
    }
  }, [onChange, onPreview]);
  useEffect(() => {
    if (!dragging) return;
    window.addEventListener('pointerup', commit);
    window.addEventListener('pointercancel', commit);
    return () => {
      window.removeEventListener('pointerup', commit);
      window.removeEventListener('pointercancel', commit);
    };
  }, [dragging, commit]);
  return (
    <div
      className="appearance-range"
      data-dragging={dragging || undefined}
      style={{ '--range-fill': `${((draft - min) / (max - min)) * 100}%` } as CSSProperties}
    >
      <div>
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id}>
          {draft}
          {unit}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={1}
        value={draft}
        disabled={disabled}
        aria-valuetext={`${draft}${unit}`}
        onPointerDown={() => setDragging(true)}
        onPointerUp={commit}
        onPointerCancel={commit}
        onLostPointerCapture={commit}
        onKeyUp={commit}
        onBlur={commit}
        onChange={(event) => {
          const next = Number(event.target.value);
          current.current = next;
          setDraft(next);
          if (!onPreview) {
            onChange(next);
            return;
          }
          if (!frame.current)
            frame.current = requestAnimationFrame(() => {
              frame.current = 0;
              onPreview(current.current);
            });
        }}
      />
    </div>
  );
}
