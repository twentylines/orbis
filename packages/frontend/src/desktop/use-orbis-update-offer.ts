import { useQuery } from '@tanstack/react-query';
import { useAppContext } from '@/context/app-context';
import { installedOrbisBuildOptions, newerOrbisRelease, orbisUpdateNoticeOptions } from './orbis-release';
import { useCoreUpdateBusy, useHostUpdateWatch } from './host-update-watch';
import { orbisUpdateEligibilityOptions } from './core-update-api';
import { coreHostCanPlan } from './core-update-state';
import { useWindowVisible } from './window-visibility';
import { orbisReleaseChannelsOptions } from './release-channels';

export function useOrbisUpdateOffer(observeOnly = false) {
  const visible = useWindowVisible();
  const busy = useCoreUpdateBusy();
  const { user } = useAppContext();
  const { core: host, unavailable } = useHostUpdateWatch();
  const build = useQuery({ ...installedOrbisBuildOptions(), enabled: visible && !observeOnly });
  const channels = useQuery({ ...orbisReleaseChannelsOptions(), enabled: visible && !observeOnly });
  const releases = useQuery(orbisUpdateNoticeOptions(visible && !observeOnly && Boolean(channels.data) && !channels.isError, channels.data?.current));
  const latest = channels.isError || releases.isError ? undefined : releases.data?.[0];
  const installed = build.data?.version;
  const base = build.data?.runtipiCompatibility?.replace(/^v/, '') ?? '';
  const enabled = Boolean(
    visible &&
      !busy &&
      user.operator &&
      !build.isError &&
      !unavailable &&
      base &&
      coreHostCanPlan(host, installed) &&
      newerOrbisRelease(latest, installed),
  );
  const eligibility = useQuery({
    ...orbisUpdateEligibilityOptions(
      latest?.tag ?? '',
      user.id,
      installed ?? '',
      base,
      host?.capabilities?.includes('runtipi-412-update.v1') === true,
    ),
    enabled: enabled && !observeOnly,
  });
  return { busy, release: enabled && eligibility.isSuccess && eligibility.data.hostUpdateSupported ? latest : undefined, installed };
}
