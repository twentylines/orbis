import { IconPlayerPlay, IconPlayerStop, IconRefresh } from '@tabler/icons-react';
import type { KeyboardEventHandler } from 'react';
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
}: {
  commands: readonly SearchAppAction[];
  onCommand: (command: SearchAppAction) => void;
  onKeyDown: KeyboardEventHandler<HTMLButtonElement>;
}) {
  return (
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
            title={label}
            onKeyDown={onKeyDown}
            onClick={() => onCommand(command)}
          >
            <Icon size={20} aria-hidden="true" />
          </button>
        );
      })}
    </fieldset>
  );
}
