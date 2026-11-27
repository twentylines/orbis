import { IconAlertTriangle, IconCircleCheck, IconPlayerStop, IconRefresh } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useAppContext } from '@/context/app-context';
import { AppLogo } from '@/components/app-logo/app-logo';
import { SystemHealthAttention } from './system-health-attention';
import { useSystemHealth } from './use-system-health';
import './home-attention.css';

type AttentionApp = { urn: string; id: string; name: string; stopped: boolean };
type Props = { apps: AttentionApp[]; unhealthy: number; loading: boolean; unavailable: boolean; healthUnavailable: boolean; healthPending?: boolean };

export function HomeAttention(props: Props) {
  const health = useSystemHealth();
  const { user } = useAppContext();
  return (
    <HomeAttentionContent
      {...props}
      canUpdate={user.operator === true}
      hasSystemAlert={Object.values(health).some((condition) => condition.active)}
      systemAlerts={<SystemHealthAttention />}
    />
  );
}

export function HomeAttentionContent({
  apps,
  unhealthy,
  loading,
  unavailable,
  healthUnavailable,
  healthPending = false,
  hasSystemAlert,
  systemAlerts,
  canUpdate = false,
}: Props & { hasSystemAlert: boolean; systemAlerts?: ReactNode; canUpdate?: boolean }) {
  const hasAttention = apps.length > 0 || unhealthy > 0 || hasSystemAlert;
  const statusUnknown = loading || unavailable || healthUnavailable || healthPending;
  return (
    <section className="workspace-attention home-attention" aria-labelledby="workspace-attention-title" data-attention={hasAttention}>
      <div className="home-attention-heading">
        <span className="home-attention-symbol" aria-hidden="true">
          {hasAttention || statusUnknown ? <IconAlertTriangle size={22} /> : <IconCircleCheck size={22} />}
        </span>
        <div>
          <h2 id="workspace-attention-title">Needs attention</h2>
          <p>
            {hasAttention
              ? 'Review your server and apps'
              : unavailable || healthUnavailable
                ? 'Some readings are unavailable'
                : statusUnknown
                  ? 'Checking your server and apps'
                  : 'No alerts to review'}
          </p>
        </div>
      </div>
      {systemAlerts}
      {unhealthy > 0 ? (
        <Link className="home-attention-health" to="/monitor?section=usage&health=attention#containers">
          <IconAlertTriangle size={19} aria-hidden="true" />
          <span>
            <strong>
              {unhealthy} {unhealthy === 1 ? 'app needs' : 'apps need'} a health check
            </strong>
            <small>Inspect containers</small>
          </span>
        </Link>
      ) : null}
      {loading ? (
        <output className="home-attention-note">Loading application status…</output>
      ) : unavailable ? (
        <output className="home-attention-note">Application status is unavailable.</output>
      ) : null}
      {healthUnavailable ? <p className="home-attention-note">Container health is unavailable.</p> : null}
      {apps.length > 0 ? (
        <ul className="home-attention-list">
          {apps.slice(0, 6).map((app) => (
            <li key={app.urn}>
              <Link
                to={`/apps/${encodeURIComponent(app.urn.split(':')[1] ?? '')}/${encodeURIComponent(app.id)}${app.stopped || !canUpdate ? '' : '/update'}`}
                state={app.stopped || !canUpdate ? undefined : { from: '/dashboard' }}
              >
                <AppLogo urn={app.urn} size={34} alt="" loading="lazy" startupOptional />
                <span className="home-attention-app">
                  <strong>{app.name}</strong>
                  <small>
                    {app.stopped ? <IconPlayerStop size={13} aria-hidden="true" /> : <IconRefresh size={13} aria-hidden="true" />}
                    {app.stopped ? 'Stopped' : 'Update available'}
                  </small>
                </span>
                <span className="home-attention-action">{app.stopped ? 'Manage' : canUpdate ? 'Update' : 'Review'}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {apps.length > 6 ? (
        <Link className="home-attention-more" to="/apps">
          View all {apps.length} applications
        </Link>
      ) : null}
    </section>
  );
}
