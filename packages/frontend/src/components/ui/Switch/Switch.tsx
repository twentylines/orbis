'use client';

import * as SwitchPrimitives from '@radix-ui/react-switch';
import clsx from 'clsx';
import type * as React from 'react';
import { useId } from 'react';
import './Switch.css';

type RootProps = typeof SwitchPrimitives.Root;

type SwitchProps = React.ComponentPropsWithoutRef<RootProps> & {
  label?: string | React.ReactNode;
  ref?: React.Ref<React.ElementRef<RootProps>>;
};

const Switch = ({ className, label, id, ...props }: SwitchProps) => {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const labelId = label == null ? undefined : `${controlId}-label`;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: The switch keeps native keyboard handling; hint clicks only suppress label activation.
    <label
      htmlFor={controlId}
      className={clsx('form-check form-switch form-check-sigle orbis-switch', className)}
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest('.form-help') && !event.target.closest('button,a')) event.preventDefault();
      }}
    >
      <SwitchPrimitives.Root id={controlId} aria-labelledby={labelId} className="switch-root" {...props}>
        <SwitchPrimitives.Thumb className="switch-thumb" />
      </SwitchPrimitives.Root>
      <span id={labelId} className="form-check-label text-muted">
        {label}
      </span>
    </label>
  );
};

export { Switch };
