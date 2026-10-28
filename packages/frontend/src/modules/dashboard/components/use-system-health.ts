import { queryOptions } from '@tanstack/react-query';
import type { HostSensors } from '@runtipi/common/schemas';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { HealthSamples, SystemHealth } from './system-health';
import { sensorRefreshInterval } from './system-readings';
import { useAppContext } from '@/context/app-context';
import { useWindowVisible } from '@/desktop/window-visibility';
import { sessionSystemHealth } from './system-health-store';

export function sensorOptions(visible: boolean, path = '/api/system/host-sensors') {
  return queryOptions<HostSensors>({
    queryKey: ['host-sensors', path],
    queryFn: async ({ signal }) => {
      const response = await fetch(path, { credentials: 'include', signal });
      if (!response.ok) throw new Error('Hardware readings are unavailable');
      return response.json();
    },
    enabled: visible,
    refetchInterval: (query) => sensorRefreshInterval(query.state.data),
    refetchIntervalInBackground: false,
  });
}

const emptyHealth: SystemHealth = {};

function useSystemHealthStore(source: string) {
  const context = useAppContext();
  return sessionSystemHealth(context.sessionIdentity, context.user.id, source);
}

// Authenticated-route gives each provider lifetime a separate health session.
export function useObserveSystemHealth(samples: HealthSamples, source = '/api/system/telemetry') {
  const store = useSystemHealthStore(source);
  const visible = useWindowVisible();
  const { telemetry, sensors, telemetryError, sensorsError } = samples;
  useEffect(
    () => store.observe({ telemetry, sensors, telemetryError, sensorsError }, visible),
    [store, telemetry, sensors, telemetryError, sensorsError, visible],
  );
  return store;
}

export function useSystemHealth(source = '/api/system/telemetry') {
  const store = useSystemHealthStore(source);
  const visible = useWindowVisible();
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener, visible), [store, visible]);
  return useSyncExternalStore(subscribe, store.getSnapshot, () => emptyHealth);
}
