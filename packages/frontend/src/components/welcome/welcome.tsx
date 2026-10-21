import { acknowledgeWelcome } from '@/api-client';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { AuthLayout } from '@/components/layouts/auth/layout';
import { useDesktopPreferences } from '@/desktop/preferences';
import { IconDeviceDesktop, IconMoon, IconSun } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';

type Props = {
  allowErrorMonitoring: boolean;
};

export const Welcome = ({ allowErrorMonitoring }: Props) => {
  const { preferences, update, completeOnboarding, syncState } = useDesktopPreferences();
  const [name, setName] = useState(preferences.serverName);
  const [errorMonitoring, setErrorMonitoring] = useState(allowErrorMonitoring);
  const [pairNext, setPairNext] = useState(false);
  const navigate = useNavigate();
  const setup = useMutation({
    mutationFn: async () => {
      await acknowledgeWelcome({ body: { allowErrorMonitoring: errorMonitoring }, throwOnError: true });
      await completeOnboarding(name);
      if (pairNext) await navigate('/settings?tab=cluster');
    },
  });
  const nameValid = name.trim().length > 0 && name.trim().length <= 40;

  return (
    <AuthLayout busy={setup.isPending}>
      <form
        className="desktop-welcome"
        aria-labelledby="welcome-title"
        onSubmit={(event) => {
          event.preventDefault();
          if (nameValid && !setup.isPending) setup.mutate();
        }}
      >
        <div className="desktop-setup-intro">
          <h2 id="welcome-title" className="h2">
            Set up Orbis
          </h2>
          <p>Choose a server name and display mode. Your account and installed apps stay in place.</p>
        </div>
        <fieldset className="desktop-setup-fields" disabled={setup.isPending}>
          <Input
            label="Server name"
            name="setup-server-name"
            value={name}
            maxLength={40}
            required
            onChange={(event) => setName(event.target.value)}
          />
          <fieldset className="desktop-setup-modes">
            <legend>Display mode</legend>
            <div>
              {(
                [
                  ['light', 'Light', IconSun],
                  ['dark', 'Dark', IconMoon],
                  ['system', 'Automatic', IconDeviceDesktop],
                ] as const
              ).map(([mode, label, Icon]) => (
                <Button key={mode} type="button" variant="outline" aria-pressed={preferences.mode === mode} onClick={() => update({ mode })}>
                  <Icon size={18} aria-hidden="true" />
                  {label}
                </Button>
              ))}
            </div>
          </fieldset>
          <div className="desktop-setup-reporting">
            <Switch checked={errorMonitoring} onCheckedChange={setErrorMonitoring} label="Send error reports" />
            <p>Optional. Reports are sent to the upstream Sentry service.</p>
          </div>
          <Switch checked={pairNext} onCheckedChange={setPairNext} label="Pair another server after setup" />
        </fieldset>
        {setup.isError ? <p role="alert">Setup could not be saved. Check the connection and try again.</p> : null}
        {syncState === 'loading' ? <output>Loading server settings…</output> : null}
        <Button type="submit" intent="primary" loading={setup.isPending} disabled={!nameValid || setup.isPending || syncState === 'loading'}>
          Open dashboard
        </Button>
      </form>
    </AuthLayout>
  );
};
