import { acknowledgeWelcomeMutation } from '@/api-client/@tanstack/react-query.gen';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch';
import { AuthLayout } from '@/components/layouts/auth/layout';
import { IconBrandGithub, IconVersions } from '@tabler/icons-react';
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
        <p>When enabled, error reports go to Runtipi's Sentry service.</p>
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
          <h3>Project links</h3>
          <p>Source code, release notes and issue reports.</p>
          <div className="desktop-welcome-links">
            <Button onClick={() => openLink('https://github.com/twentylines/orbis')}>
              <IconBrandGithub aria-hidden="true" /> Source code
            </Button>
            <Button onClick={() => openLink('https://github.com/twentylines/orbis/releases')}>
              <IconVersions aria-hidden="true" /> Releases
            </Button>
          </div>
        </div>
      </section>
    </AuthLayout>
  );
};
