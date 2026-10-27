'use client';

import * as Menu from '@radix-ui/react-dropdown-menu';
import type * as SelectPrimitive from '@radix-ui/react-select';
import { IconCheck } from '@tabler/icons-react';
import clsx from 'clsx';
import type * as React from 'react';
import { Children, createContext, forwardRef, isValidElement, useContext, useId, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { WrapWords } from '@/components/wrap-words/wrap-words';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '../DropdownMenu';
import '../dropdown.css';

type ItemProps = React.ComponentPropsWithoutRef<typeof Menu.RadioItem>;
type Option = { value: string; label: React.ReactNode; text: string; disabled?: boolean };
type SelectContextValue = {
  id: string;
  value: string;
  change: (value: string) => void;
  close: () => void;
  disabled?: boolean;
  invalid: boolean;
  options: Option[];
  trigger: React.RefObject<HTMLButtonElement | null>;
};
const SelectContext = createContext<SelectContextValue | null>(null);
function useSelect() {
  const context = useContext(SelectContext);
  if (!context) throw new Error('Select controls must be inside Select.');
  return context;
}
function textOf(node: React.ReactNode): string {
  return Children.toArray(node)
    .map((child) => {
      if (typeof child === 'string' || typeof child === 'number') return String(child);
      return isValidElement<{ children?: React.ReactNode }>(child) ? textOf(child.props.children) : '';
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function selectionModel(children: React.ReactNode): { options: Option[]; triggerId?: string } {
  const model: { options: Option[]; triggerId?: string } = { options: [] };
  Children.forEach(children, (child) => {
    if (!isValidElement<{ children?: React.ReactNode }>(child)) return;
    if (child.type === SelectItem) {
      const props = child.props as ItemProps;
      model.options.push({
        value: props.value,
        label: props.children,
        text: props.textValue || textOf(props.children) || props.value,
        disabled: props.disabled,
      });
      return;
    }
    if (child.type === SelectTrigger) model.triggerId = (child.props as TriggerProps).id;
    const nested = selectionModel(child.props.children);
    model.options.push(...nested.options);
    model.triggerId ??= nested.triggerId;
  });
  return model;
}

type SelectProps = React.ComponentPropsWithoutRef<typeof SelectPrimitive.Root> & { className?: string; label?: string; error?: string };
const Select = forwardRef<HTMLButtonElement, SelectProps>(
  (
    {
      children,
      value: supplied,
      defaultValue = '',
      onValueChange,
      disabled,
      required,
      name,
      form,
      autoComplete,
      dir,
      open,
      defaultOpen,
      onOpenChange,
    },
    ref,
  ) => {
    const [internal, setInternal] = useState(defaultValue);
    const [expanded, setExpanded] = useState(defaultOpen ?? false);
    const [invalid, setInvalid] = useState(false);
    const value = supplied ?? internal;
    const trigger = useRef<HTMLButtonElement>(null);
    useImperativeHandle(ref, () => trigger.current as HTMLButtonElement);
    const { options, triggerId } = useMemo(() => selectionModel(children), [children]);
    const generatedId = useId();
    const changeOpen = (next: boolean) => {
      if (open === undefined) setExpanded(next);
      onOpenChange?.(next);
    };
    const change = (next: string) => {
      if (disabled) return;
      if (supplied === undefined) setInternal(next);
      setInvalid(false);
      onValueChange?.(next);
    };
    return (
      <SelectContext.Provider
        value={{ id: triggerId ?? generatedId, value, change, close: () => changeOpen(false), disabled, invalid, options, trigger }}
      >
        <DropdownMenu dir={dir} open={disabled ? false : (open ?? expanded)} onOpenChange={changeOpen} modal={false}>
          {children}
        </DropdownMenu>
        {name || required ? (
          <select
            className="visually-hidden"
            aria-hidden="true"
            tabIndex={-1}
            name={name}
            form={form}
            autoComplete={autoComplete}
            required={required}
            disabled={disabled}
            value={value}
            onChange={(event) => change(event.target.value)}
            onInvalid={(event) => {
              event.preventDefault();
              setInvalid(true);
              trigger.current?.focus();
            }}
          >
            <option value="" />
            {options.map((option) => (
              <option key={option.value} value={option.value} disabled={option.disabled}>
                {option.text}
              </option>
            ))}
          </select>
        ) : null}
      </SelectContext.Provider>
    );
  },
);
Select.displayName = 'Select';

const SelectValue = ({ placeholder, children, ...props }: React.ComponentProps<'span'> & { placeholder?: React.ReactNode }) => {
  const context = useSelect();
  const selected = context.options.find((option) => option.value === context.value);
  return <span {...props}>{children ?? selected?.label ?? (context.value || placeholder)}</span>;
};

type TriggerProps = React.ComponentPropsWithoutRef<typeof Menu.Trigger> & {
  label?: React.ReactNode;
  error?: string;
  onClear?: () => void;
  fitContent?: boolean;
};
const SelectTrigger = ({ className, error, label, children, value: _value, onClear: _onClear, fitContent = false, ...props }: TriggerProps) => {
  const context = useSelect();
  const triggerId = context.id;
  const labelId = `${triggerId}-label`;
  const valueId = `${triggerId}-value`;
  const errorId = `${triggerId}-error`;
  const message = error || (context.invalid ? 'Choose an option.' : undefined);
  return (
    <label htmlFor={triggerId} className={clsx(!fitContent && 'w-100', className)}>
      {Boolean(label) && (
        <span id={labelId} className="form-label">
          {label}
        </span>
      )}
      <div className="position-relative">
        <DropdownMenuTrigger
          {...props}
          id={triggerId}
          ref={context.trigger}
          aria-labelledby={props['aria-labelledby'] ?? (label ? labelId : props['aria-label'] ? undefined : valueId)}
          aria-describedby={
            [props['aria-describedby'], label || props['aria-label'] ? valueId : null, message ? errorId : null].filter(Boolean).join(' ') ||
            undefined
          }
          aria-invalid={message ? true : undefined}
          className={clsx('d-flex align-items-center justify-content-between form-select', !fitContent && 'w-100', {
            'is-invalid is-invalid-lite': message,
            'text-muted': !context.value,
          })}
          disabled={context.disabled || props.disabled}
        >
          <span id={valueId} className="orbis-select-value">
            {children}
          </span>
        </DropdownMenuTrigger>
      </div>
      {message && (
        <div id={errorId} className="invalid-feedback d-block">
          {message}
        </div>
      )}
    </label>
  );
};

const SelectContent = ({ className, children, onKeyDownCapture, onCloseAutoFocus, ...props }: React.ComponentProps<typeof Menu.Content>) => {
  const context = useSelect();
  const tabbingAway = useRef(false);
  return (
    <DropdownMenuContent
      align="start"
      sideOffset={6}
      collisionPadding={16}
      style={{ zIndex: 2000 }}
      className={clsx('orbis-dropdown-menu orbis-select-content', className)}
      {...props}
      aria-labelledby={props['aria-labelledby'] ?? context.id}
      onKeyDownCapture={(event) => {
        onKeyDownCapture?.(event);
        if (event.key === 'Tab' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.defaultPrevented) {
          tabbingAway.current = true;
          event.stopPropagation();
          context.trigger.current?.focus({ preventScroll: true });
          context.close();
        }
      }}
      onCloseAutoFocus={(event) => {
        onCloseAutoFocus?.(event);
        if (tabbingAway.current) {
          tabbingAway.current = false;
          event.preventDefault();
        }
      }}
    >
      <Menu.RadioGroup className="orbis-select-viewport p-1" value={context.value} onValueChange={context.change}>
        {children}
      </Menu.RadioGroup>
    </DropdownMenuContent>
  );
};

const SelectItem = ({ className, children, textValue, ...props }: ItemProps) => {
  const text = typeof children === 'string' ? children : undefined;
  return (
    <Menu.RadioItem
      className={clsx('position-relative d-flex align-items-center dropdown-item orbis-select-item', className)}
      textValue={textValue || textOf(children) || props.value}
      {...props}
    >
      <span className="orbis-select-item-text" title={text}>
        {text ? <WrapWords text={text} /> : children}
      </span>
      <span className="orbis-select-item-indicator" aria-hidden="true">
        <Menu.ItemIndicator>
          <IconCheck size={20} />
        </Menu.ItemIndicator>
      </span>
    </Menu.RadioItem>
  );
};

export { Select, SelectValue, SelectTrigger, SelectContent, SelectItem };
