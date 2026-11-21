import { useState, type KeyboardEventHandler } from 'react';
import { useUserContext } from '@/context/user-context';
import { useDesktopPreferences } from './preferences';
import { searchSettingChoices } from './search-setting-choices';

export function SearchSettingChoices({ settingId, onKeyDown }: { settingId: string; onKeyDown: KeyboardEventHandler<HTMLButtonElement> }) {
  const { preferences, update, commit, syncState, requiresOnboarding, onboardingGeneration } = useDesktopPreferences();
  const { isLoggedIn, sessionAbortSignal } = useUserContext();
  const [attempt, setAttempt] = useState<{ value: string; session: AbortSignal; generation: string | null } | null>(null);
  const choices = searchSettingChoices(settingId, preferences);
  if (!choices.length) return null;
  const allowed = isLoggedIn && !sessionAbortSignal.aborted && !requiresOnboarding && syncState !== 'loading' && syncState !== 'local';
  const current =
    attempt?.session === sessionAbortSignal &&
    attempt.generation === onboardingGeneration &&
    choices.some((choice) => choice.value === attempt.value && choice.selected)
      ? attempt
      : null;
  const failed = allowed && current && syncState === 'error';
  return (
    <fieldset className="desktop-search-setting-choices" aria-label={`${settingId} choices`}>
      {choices.map((choice) => (
        <button
          key={choice.value}
          type="button"
          data-search-result
          aria-label={choice.label}
          aria-pressed={choice.selected}
          disabled={!allowed}
          onKeyDown={onKeyDown}
          onClick={() => {
            if (!allowed || sessionAbortSignal.aborted) return;
            setAttempt({ value: choice.value, session: sessionAbortSignal, generation: onboardingGeneration });
            update(choice.patch);
          }}
        >
          {choice.label}
        </button>
      ))}
      {failed ? (
        <p role="alert">
          This change could not be saved.{' '}
          <button
            type="button"
            onClick={() => {
              const choice = choices.find(({ value }) => value === current.value);
              if (choice && allowed && !sessionAbortSignal.aborted) void commit(choice.patch).catch(() => undefined);
            }}
          >
            Retry
          </button>
        </p>
      ) : null}
    </fieldset>
  );
}
