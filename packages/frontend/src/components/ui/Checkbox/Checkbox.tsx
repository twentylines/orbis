import './Checkbox.css';
import clsx from 'clsx';
import { useId, type ComponentProps, type ReactNode } from 'react';

type CheckboxProps = Omit<ComponentProps<'input'>, 'type' | 'onChange'> & {
  label?: ReactNode;
  onCheckedChange?: (checked: boolean) => void;
};

function Checkbox({ className, label, checked, onCheckedChange, 'aria-labelledby': labelledBy, ...props }: CheckboxProps) {
  const generatedId = useId();
  const baseId = props.name ? `${props.name}-${generatedId}` : generatedId;
  const inputId = props.id || baseId;
  const labelId = `${baseId}-label`;

  return (
    <label htmlFor={inputId} className={clsx('form-check orbis-checkbox', className)}>
      <input
        {...props}
        type="checkbox"
        className="form-check-input"
        checked={checked}
        onChange={(e) => onCheckedChange?.(e.target.checked)}
        name={props.name}
        id={inputId}
        aria-labelledby={labelledBy ?? (label != null ? labelId : undefined)}
      />
      {label != null ? (
        <span id={labelId} className="form-check-label text-muted">
          {label}
        </span>
      ) : null}
    </label>
  );
}

export { Checkbox };
