import { useId } from 'react';

export function AppearanceRange({
  label,
  value,
  min = 0,
  max,
  unit = '%',
  onChange,
  disabled = false,
}: {
  label: string;
  value: number;
  min?: number;
  max: number;
  unit?: string;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="appearance-range">
      <div>
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id}>
          {value}
          {unit}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        disabled={disabled}
        aria-valuetext={`${value}${unit}`}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}
