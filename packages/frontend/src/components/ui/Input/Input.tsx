import './input.css';
import clsx from 'clsx';
import { useId, type InputHTMLAttributes, type ReactNode, type Ref } from 'react';

interface IProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: string;
  label?: string | ReactNode;
  isInvalid?: boolean;
  children?: ReactNode;
  ref?: Ref<HTMLInputElement>;
}

export const Input = ({
  name,
  id: providedId,
  label,
  error,
  type = 'text',
  className,
  isInvalid,
  children,
  'aria-describedby': describedBy,
  ...rest
}: IProps) => {
  const generatedId = useId();
  const id = providedId ?? name ?? generatedId;
  const hasError = Boolean(error || isInvalid);
  const errorId = hasError ? `${id}-error` : undefined;

  return (
    <div className={clsx(className)}>
      {label && (
        <label htmlFor={id} className="form-label">
          {label}
        </label>
      )}
      <input
        suppressHydrationWarning
        aria-label={label ? undefined : name}
        aria-invalid={hasError}
        aria-describedby={[describedBy, errorId].filter(Boolean).join(' ') || undefined}
        type={type}
        name={name}
        id={id}
        className={clsx('form-control', {
          'is-invalid': hasError,
        })}
        {...rest}
      />
      {children}
      {error && (
        <div id={errorId} className="invalid-feedback" role="alert">
          {error}
        </div>
      )}
    </div>
  );
};
