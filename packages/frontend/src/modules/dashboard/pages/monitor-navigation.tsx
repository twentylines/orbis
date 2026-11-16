import type { PropsWithChildren } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { IconActivity, IconCpu, IconDatabase, IconDeviceDesktopAnalytics, IconNetwork, IconTemperature } from '@tabler/icons-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { SelectionGroup } from '@/components/ui/SelectionGroup/SelectionGroup';

export const monitorSections = [
  { value: 'overview', label: 'Overview', Icon: IconDeviceDesktopAnalytics },
  { value: 'usage', label: 'Usage', Icon: IconActivity },
  { value: 'performance', label: 'Performance', Icon: IconCpu },
  { value: 'devices', label: 'Devices', Icon: IconNetwork },
  { value: 'drives', label: 'Drive health', Icon: IconDatabase },
  { value: 'sensors', label: 'Sensors', Icon: IconTemperature },
] as const;
export type MonitorSection = (typeof monitorSections)[number]['value'];

export function sectionForHash(hash: string): MonitorSection | null {
  if (hash === '#drive-health-title') return 'drives';
  if (['#telemetry-cpu-title', '#telemetry-memory-title'].includes(hash)) return 'performance';
  if (
    [
      '#host-storage-title',
      '#host-network-title',
      '#host-disk-activity-title',
      '#device-history',
      '#telemetry-disks-title',
      '#telemetry-network-title',
    ].includes(hash)
  )
    return 'devices';
  if (['#sensors', '#host-temperatures-title', '#host-fans-title', '#host-gpus-title'].includes(hash)) return 'sensors';
  if (['#containers', '#processes'].includes(hash)) return 'usage';
  return null;
}

export function monitorSection(requested: string | null, hash: string): MonitorSection {
  return sectionForHash(hash) ?? monitorSections.find(({ value }) => value === requested)?.value ?? 'overview';
}

export function MonitorWorkspace({
  section,
  onSection,
  children,
}: PropsWithChildren<{ section: MonitorSection; onSection: (value: string) => void }>) {
  return (
    <Tabs.Root className="monitor-sections" orientation="vertical" value={section} onValueChange={onSection}>
      <div className="monitor-section-navigation">
        <div className="monitor-section-compact">
          <Select value={section} onValueChange={onSection}>
            <SelectTrigger className="monitor-section-select" aria-label="Monitor section">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="monitor-section-menu">
              {monitorSections.map(({ value, label }) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Tabs.List className="monitor-section-tabs" aria-label="Monitor sections">
          <SelectionGroup className="monitor-section-tab-track">
            {monitorSections.map(({ value, label, Icon }) => (
              <Tabs.Trigger className="monitor-section-tab" key={value} value={value}>
                <Icon size={20} aria-hidden="true" />
                <span>{label}</span>
              </Tabs.Trigger>
            ))}
          </SelectionGroup>
        </Tabs.List>
      </div>
      <div className="monitor-section-panels">{children}</div>
    </Tabs.Root>
  );
}
