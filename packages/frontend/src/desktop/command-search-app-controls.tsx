import { IconDots, IconPlayerPlay, IconPlayerStop, IconRefresh } from '@tabler/icons-react';
import {
  DropdownMenu,
  DropdownMenuBoundary,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu/DropdownMenu';
import { useEffect, useRef, useState, type KeyboardEventHandler } from 'react';
import type { SearchAppAction } from './command-search-app-action';

const commandsByAction = {
  start: { label: 'Start', Icon: IconPlayerPlay },
  stop: { label: 'Stop', Icon: IconPlayerStop },
  restart: { label: 'Restart', Icon: IconRefresh },
};

export function SearchAppCommandControls({
  commands,
  onCommand,
  onKeyDown,
  menuContainer,
}: {
  commands: readonly SearchAppAction[];
  onCommand: (command: SearchAppAction) => void;
  onKeyDown: KeyboardEventHandler<HTMLButtonElement>;
  menuContainer: HTMLElement | null;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const trigger = menuTrigger.current;
    if (!menuOpen || !trigger) return;
    const observer = new ResizeObserver(() => {
      if (!trigger.getClientRects().length) setMenuOpen(false);
    });
    observer.observe(trigger);
    return () => observer.disconnect();
  }, [menuOpen]);

  return (
    <>
      <fieldset className="desktop-search-app-commands">
        <legend className="visually-hidden">{commands[0]?.name ?? 'App'} actions</legend>
        {commands.map((command) => {
          const { label, Icon } = commandsByAction[command.action];
          return (
            <button
              type="button"
              key={command.action}
              data-search-result
              data-app-command={command.action}
              className="desktop-search-result-manage"
              aria-label={`${label} ${command.name}`}
              onKeyDown={onKeyDown}
              onClick={() => onCommand(command)}
            >
              <Icon size={20} aria-hidden="true" />
            </button>
          );
        })}
      </fieldset>
      <DropdownMenuBoundary container={menuContainer}>
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger
            ref={menuTrigger}
            type="button"
            className="desktop-search-result-manage desktop-search-app-menu-trigger"
            aria-label={`${commands[0]?.name ?? 'App'} actions`}
            data-search-result
            onKeyDown={(event) => {
              if (event.key !== 'ArrowDown') onKeyDown(event);
            }}
          >
            <IconDots size={20} aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="desktop-search-app-menu"
            onCloseAutoFocus={(event) => {
              const trigger = menuTrigger.current;
              if (!trigger?.isConnected || trigger.getClientRects().length) return;
              event.preventDefault();
              trigger.closest('[data-app-commands]')?.querySelector<HTMLButtonElement>('[data-search-result]')?.focus({ preventScroll: true });
            }}
          >
            {commands.map((command) => {
              const { label, Icon } = commandsByAction[command.action];
              return (
                <DropdownMenuItem key={command.action} data-app-command={command.action} onSelect={() => onCommand(command)}>
                  <Icon size={18} aria-hidden="true" />
                  {label}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </DropdownMenuBoundary>
    </>
  );
}
