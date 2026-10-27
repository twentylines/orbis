import { Button } from '@/components/ui/Button';

export function AppSettingsSaveButton({ formId, pending, header = false }: { formId: string; pending: boolean; header?: boolean }) {
  return (
    <Button
      className={header ? 'app-window-header-save' : undefined}
      type="submit"
      intent="primary"
      form={formId}
      disabled={pending}
      aria-busy={pending}
    >
      Save
    </Button>
  );
}
