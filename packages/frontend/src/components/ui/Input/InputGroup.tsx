import clsx from 'clsx';
import type * as React from 'react';
import { Fragment, useId } from 'react';
import './input.css';

interface IProps extends React.InputHTMLAttributes<HTMLInputElement> {
  error?: string;
  label?: string | React.ReactNode;
  isInvalid?: boolean;
  groupPrefix?: string | React.ReactNode;
  groupSuffix?: string | React.ReactNode;
  groupClassName?: string;
  ref?: React.Ref<HTMLInputElement>;
}

const TextAffix = ({ text }: { text: string }) => (
  <span className="input-group-text">
    {[...text.matchAll(/[^./:-]+[./:-]*|[./:-]+/g)].map((part) => (
      <Fragment key={part.index}>
        {part[0]}
        <wbr />
      </Fragment>
    ))}
  </span>
);

export const InputGroup = ({
  name,
  id: providedId,
  label,
  error,
  type = 'text',
  className,
  isInvalid,
  groupPrefix,
  groupSuffix,
  groupClassName,
  ...rest
}: IProps) => {
  const generatedId = useId();
  const controlId = providedId ?? name ?? generatedId;
  let prefix = groupPrefix;
  if (typeof groupPrefix === 'string') {
    prefix = <TextAffix text={groupPrefix} />;
  }
  let suffix = groupSuffix;
  if (typeof groupSuffix === 'string') {
    suffix = <TextAffix text={groupSuffix} />;
  }

  return (
    <div className={clsx('orbis-input-field', className)}>
      {label && (
        <label htmlFor={controlId} className="form-label">
          {label}
        </label>
      )}
      <div className={clsx('input-group orbis-input-group', groupClassName)}>
        {prefix}
        <input
          suppressHydrationWarning
          aria-label={label ? undefined : name}
          type={type}
          name={name}
          id={controlId}
          className={clsx('form-control', { 'is-invalid is-invalid-lite': error || isInvalid })}
          {...rest}
        />
        {suffix}
        {error && <div className="invalid-feedback">{error}</div>}
      </div>
    </div>
  );
};
