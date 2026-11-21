import type { HTMLAttributes } from 'react';
import clsx from 'clsx';
import './selection-group.css';

export function SelectionGroup({ as = 'div', className, children, ...props }: HTMLAttributes<HTMLElement> & { as?: 'div' | 'fieldset' }) {
  const attributes = { ...props, className: clsx('orbis-selection-group', className) };
  return as === 'fieldset' ? <fieldset {...attributes}>{children}</fieldset> : <div {...attributes}>{children}</div>;
}
