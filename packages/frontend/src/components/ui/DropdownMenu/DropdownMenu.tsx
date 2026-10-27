'use client';

import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { IconChevronRight } from '@tabler/icons-react';
import clsx from 'clsx';
import type * as React from 'react';
import { Children, createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from 'react';
import '../dropdown.css';
import { dropdownBoundaryOptions } from './dropdown-boundary';

const MenuOpenContext = createContext(false);
const MenuBoundaryContext = createContext<HTMLElement | null>(null);

export function DropdownMenuBoundary({ container, children }: React.PropsWithChildren<{ container: HTMLElement | null }>) {
  return <MenuBoundaryContext.Provider value={container}>{children}</MenuBoundaryContext.Provider>;
}
const DropdownMenu = ({
  modal = false,
  open,
  defaultOpen = false,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) => {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const expanded = open ?? internalOpen;
  return (
    <MenuOpenContext.Provider value={expanded}>
      <DropdownMenuPrimitive.Root
        {...props}
        modal={modal}
        open={expanded}
        onOpenChange={(next) => {
          if (open === undefined) setInternalOpen(next);
          onOpenChange?.(next);
        }}
      />
    </MenuOpenContext.Provider>
  );
};

const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

const DropdownMenuGroup = DropdownMenuPrimitive.Group;

const DropdownMenuSubTrigger = ({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & {
  inset?: boolean;
}) => (
  <DropdownMenuPrimitive.SubTrigger className={clsx('', inset && 'ps-8', className)} {...props}>
    {children}
    <IconChevronRight className="" />
  </DropdownMenuPrimitive.SubTrigger>
);

const DropdownMenuSubContent = ({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) => (
  <DropdownMenuPrimitive.SubContent className={clsx('', className)} {...props} />
);

const menuTrigger = (menu: HTMLDivElement | null) => {
  const id = menu?.getAttribute('aria-labelledby');
  return id ? document.getElementById(id) : null;
};

const DropdownMenuContent = ({
  className,
  sideOffset = 4,
  onInteractOutside,
  onEscapeKeyDown,
  ref,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) => {
  const content = useRef<HTMLDivElement | null>(null);
  const open = useContext(MenuOpenContext);
  const boundary = dropdownBoundaryOptions(useContext(MenuBoundaryContext));
  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      content.current = node;
      const cleanup = typeof ref === 'function' ? ref(node) : undefined;
      if (ref && typeof ref !== 'function') ref.current = node;
      return () => {
        content.current = null;
        if (typeof cleanup === 'function') cleanup();
        else if (typeof ref === 'function') ref(null);
        else if (ref) ref.current = null;
      };
    },
    [ref],
  );
  useLayoutEffect(() => {
    const menu = content.current;
    if (open && document.activeElement === menuTrigger(menu)) menu?.focus({ preventScroll: true });
  }, [open]);
  return (
    <DropdownMenuPrimitive.Portal {...boundary.portal}>
      <DropdownMenuPrimitive.Content
        {...boundary.content}
        sideOffset={sideOffset}
        className={clsx('orbis-dropdown-menu d-block position-relative', className)}
        {...props}
        ref={attach}
        onInteractOutside={(event) => {
          onInteractOutside?.(event);
          const trigger = menuTrigger(content.current);
          if (event.target instanceof Node && trigger?.contains(event.target)) event.preventDefault();
        }}
        onEscapeKeyDown={(event) => {
          onEscapeKeyDown?.(event);
          if (!event.defaultPrevented) menuTrigger(content.current)?.focus({ preventScroll: true });
        }}
      />
    </DropdownMenuPrimitive.Portal>
  );
};

const DropdownMenuItem = ({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  inset?: boolean;
}) => (
  <DropdownMenuPrimitive.Item className={clsx('dropdown-item orbis-menu-item cursor-pointer', inset && 'ps-1', className)} {...props}>
    {Children.map(children, (child) => (typeof child === 'string' || typeof child === 'number' ? <span>{child}</span> : child))}
  </DropdownMenuPrimitive.Item>
);

const DropdownMenuLabel = ({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & {
  inset?: boolean;
}) => <DropdownMenuPrimitive.Label className={clsx('dropdown-header', inset && 'pl-8', className)} {...props} />;

const DropdownMenuSeparator = ({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) => (
  <DropdownMenuPrimitive.Separator className={clsx('dropdown-divider', className)} {...props} />
);

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuSubTrigger,
  DropdownMenuContent,
  DropdownMenuSubContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuGroup,
  DropdownMenuSeparator,
};
