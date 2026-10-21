import { acknowledgeWelcomeMutation } from '@/api-client/@tanstack/react-query.gen';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch';
import { AuthLayout } from '@/components/layouts/auth/layout';
import { IconBrandDiscord, IconBrandGithub } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';

type Props = {
  allowErrorMonitoring: boolean;
};

export const Welcome = ({ allowErrorMonitoring }: Props) => {
  const [errorMonitoring, setErrorMonitoring] = useState(allowErrorMonitoring);

  const openLink = (url: string) => {
    window.open(url, '_blank', 'noopener noreferrer');
  };

  const acknowledge = useMutation({
    ...acknowledgeWelcomeMutation(),
  });

  return (
    <AuthLayout>
      <section className="desktop-welcome" aria-labelledby="welcome-title">
        <h2 id="welcome-title" className="h2">
          Before you start
        </h2>
        <p>Optional error reports use the inherited Runtipi integration and may be sent to its upstream service.</p>
        <Switch checked={errorMonitoring} onCheckedChange={setErrorMonitoring} label="Enable error reporting" />
        <Button
          intent="primary"
          onClick={() => acknowledge.mutate({ body: { allowErrorMonitoring: errorMonitoring } })}
          loading={acknowledge.isPending}
          disabled={acknowledge.isPending}
        >
          Save and open dashboard
        </Button>
        <div className="desktop-welcome-community">
          <h3>Runtipi community</h3>
          <p>
            Support the upstream maintainers by{' '}
            <a target="_blank" href="https://github.com/runtipi/runtipi?sponsor=1" rel="noreferrer">
              donating
            </a>{' '}
            or by{' '}
            <a target="_blank" rel="noreferrer" href="https://github.com/runtipi/runtipi">
              contributing to the codebase
            </a>
            .
          </p>
          <div className="desktop-welcome-links">
            <Button onClick={() => openLink('https://github.com/runtipi/runtipi/discussions')}>
              <IconBrandGithub aria-hidden="true" /> GitHub
            </Button>
            <Button onClick={() => openLink('https://discord.gg/WGW7YP7E5j')}>
              <IconBrandDiscord aria-hidden="true" />
              Discord
            </Button>
          </div>
        </div>
      </section>
    </AuthLayout>
  );
};
