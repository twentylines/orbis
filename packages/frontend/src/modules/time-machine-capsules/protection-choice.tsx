import { Button } from '@/components/ui/Button';
import { SelectionGroup } from '@/components/ui/SelectionGroup/SelectionGroup';
import type { TimeMachinePreferences } from '@runtipi/common/schemas/time-machine';
import { readTimeMachinePreferences, saveTimeMachinePreferences } from '@/modules/time-machine/time-machine-api';

/** Controls only the supported manual-capture preference; it does not create or schedule a backup. */
export function ProtectionChoice({
  enabled,
  onChange,
  disabled = false,
}: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <SelectionGroup role="group" aria-label="Time Machine">
      <Button type="button" variant="outline" aria-pressed={enabled} disabled={disabled} onClick={() => onChange(true)}>
        Enable
      </Button>
      <Button type="button" variant="outline" aria-pressed={!enabled} disabled={disabled} onClick={() => onChange(false)}>
        Later
      </Button>
    </SelectionGroup>
  );
}
export function manualProtectionUpdate(current: TimeMachinePreferences, enabled: boolean) {
  const { version: _version, revision, ...value } = current;
  return { ...value, enabled, expectedRevision: revision };
}
export async function readManualProtection(signal: AbortSignal): Promise<TimeMachinePreferences> {
  return readTimeMachinePreferences(signal);
}
export async function saveManualProtection(enabled: boolean, signal: AbortSignal) {
  const current = await readManualProtection(signal);
  return saveTimeMachinePreferences(manualProtectionUpdate(current, enabled), signal);
}
