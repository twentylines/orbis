'use client';

import * as TabsPrimitive from '@radix-ui/react-tabs';
import clsx from 'clsx';
import type * as React from 'react';
import { SelectionGroup } from '../SelectionGroup/SelectionGroup';
import './tabs.css';

const Tabs = ({ className, children, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) => (
  <TabsPrimitive.Root className={clsx('card', className)} {...props}>
    {children}
  </TabsPrimitive.Root>
);

const TabsList = ({ className, children, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) => (
  <TabsPrimitive.List className={clsx('', className)} {...props}>
    <div className="card-header">
      <SelectionGroup className="nav nav-tabs card-header-tabs">{children}</SelectionGroup>
    </div>
  </TabsPrimitive.List>
);

const TabsTrigger = ({ className, children, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) => {
  return (
    <TabsPrimitive.Trigger className={clsx('trigger nav-link', className)} {...props}>
      {children}
    </TabsPrimitive.Trigger>
  );
};

const TabsContent = ({ className, children, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) => (
  <TabsPrimitive.Content className={clsx('', className)} {...props}>
    <div className="card-body">{children}</div>
  </TabsPrimitive.Content>
);

export { Tabs, TabsList, TabsTrigger, TabsContent };
