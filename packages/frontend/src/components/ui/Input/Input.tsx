import './input.css';
import clsx from 'clsx';
import { useId, type InputHTMLAttributes, type ReactNode, type Ref } from 'react';
import { useCharacterMotion } from './use-character-motion';

interface IProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: string;
  label?: string | ReactNode;
  isInvalid?: boolean;
  children?: ReactNode;
  ref?: Ref<HTMLInputElement>;
  animateCharacters?: boolean;
}

export const Input = ({
  name,
  id: providedId,
  label,
  error,
  type = 'text',
  className,
  isInvalid,
  animateCharacters = false,
  onInput,
  onSelect,
  onScroll,
  onCompositionStart,
  onCompositionEnd,
  children,
  'aria-describedby': describedBy,
  ...rest
}: IProps) => {
  const generatedId = useId();
  const motion = useCharacterMotion(animateCharacters);
  const id = providedId ?? name ?? generatedId;
  const hasError = Boolean(error || isInvalid);
  const errorId = error ? `${id}-error` : undefined;

  return (
    <div ref={motion.root} data-character-ready={motion.ready} className={clsx(className, animateCharacters && 'orbis-input-character-motion')}>
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
        onCompositionStart={(event) => {
          onCompositionStart?.(event);
          motion.compositionStart(event.currentTarget);
        }}
        onCompositionEnd={(event) => {
          onCompositionEnd?.(event);
          motion.compositionEnd(event.currentTarget);
        }}
        onInput={(event) => {
          onInput?.(event);
          motion.enter(event.currentTarget, event.nativeEvent);
        }}
        onSelect={(event) => {
          onSelect?.(event);
          motion.enter(event.currentTarget);
        }}
        onScroll={(event) => {
          onScroll?.(event);
          motion.enter(event.currentTarget);
        }}
      />
      {motion.overlay}
      {children}
      {error && (
        <div id={errorId} className="invalid-feedback" role="alert">
          {error}
        </div>
      )}
    </div>
  );
};
