'use client';

import * as SelectPrimitive from '@radix-ui/react-select';
import { IconCheck, IconChevronDown, IconChevronUp } from '@tabler/icons-react';
import clsx from 'clsx';
import type * as React from 'react';
import { useId } from 'react';
import { WrapWords } from '@/components/wrap-words/wrap-words';
import '../dropdown.css';

type TriggerProps = {
  label?: string | React.ReactNode;
  error?: string;
  onClear?: () => void;
};

const Select: React.FC<
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Root> & {
    label?: string;
    error?: string;
    className?: string;
    key?: string;
  }
> = ({ children, ...props }) => {
  return <SelectPrimitive.Root {...props}>{children}</SelectPrimitive.Root>;
};

const SelectValue = SelectPrimitive.Value;

// Button
const SelectTrigger = ({
  className,
  error,
  label,
  children,
  value,
  onClear,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & TriggerProps) => {
  const generatedId = useId();
  const triggerId = props.id ?? generatedId;
  const labelId = `${triggerId}-label`;
  return (
    <label htmlFor={triggerId} className={clsx('w-100', className)}>
      {Boolean(label) && (
        <span id={labelId} className="form-label">
          {label}
        </span>
      )}
      <div className="position-relative">
        <SelectPrimitive.Trigger
          id={triggerId}
          aria-labelledby={label ? labelId : undefined}
          className={clsx('d-flex w-100 align-items-center justify-content-between form-select', {
            'is-invalid is-invalid-lite': error,
            'text-muted': !value,
          })}
          {...props}
        >
          <span className="orbis-select-value">{children}</span>
        </SelectPrimitive.Trigger>
      </div>
      {error && <div className="invalid-feedback">{error}</div>}
    </label>
  );
};

const SelectContent = ({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Content>) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      position="popper"
      align="start"
      sideOffset={6}
      collisionPadding={16}
      style={{ zIndex: 2000 }}
      className={clsx('orbis-dropdown-menu orbis-select-content', className)}
      {...props}
    >
      <SelectPrimitive.ScrollUpButton className="orbis-select-scroll-button d-flex align-items-center justify-content-center">
        <IconChevronUp />
      </SelectPrimitive.ScrollUpButton>
      <SelectPrimitive.Viewport className="orbis-select-viewport p-1">{children}</SelectPrimitive.Viewport>
      <SelectPrimitive.ScrollDownButton className="orbis-select-scroll-button d-flex align-items-center justify-content-center">
        <IconChevronDown />
      </SelectPrimitive.ScrollDownButton>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
);

const SelectItem = ({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) => {
  const text = typeof children === 'string' ? children : undefined;
  return (
    <SelectPrimitive.Item
      className={clsx('position-relative d-flex align-items-center dropdown-item orbis-select-item', className)}
      aria-label={text}
      textValue={text}
      {...props}
    >
      <SelectPrimitive.ItemText asChild>
        <span className="orbis-select-item-text" title={text}>
          {text ? <WrapWords text={text} /> : children}
        </span>
      </SelectPrimitive.ItemText>
      <span className="orbis-select-item-indicator" aria-hidden="true">
        <SelectPrimitive.ItemIndicator>
          <IconCheck size={20} />
        </SelectPrimitive.ItemIndicator>
      </span>
    </SelectPrimitive.Item>
  );
};

export { Select, SelectValue, SelectTrigger, SelectContent, SelectItem };
