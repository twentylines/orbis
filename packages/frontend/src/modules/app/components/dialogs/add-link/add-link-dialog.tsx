import { editLink, type GetLinksResponse } from '@/api-client';
import { createLinkMutation, editLinkMutation, getGuestLinksQueryKey, getLinksQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { useAppContext } from '@/context/app-context';
import { AutosavedSettingSwitch } from '@/modules/settings/components/autosaved-setting-switch';
import { useAutosavedToggle } from '@/modules/settings/hooks/use-autosaved-toggle';
import type { CustomLink } from '@/types/app.types';
import type { TranslatableError } from '@/types/error.types';
import { arktypeResolver } from '@hookform/resolvers/arktype';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type } from 'arktype';
import type React from 'react';
import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import './add-link-dialog.css';

type FormValues = {
  title: string;
  url: string;
  description: string;
  iconUrl: string;
};

type AddLinkDialogProps = {
  isOpen: boolean;
  onClose: () => void;
  link?: CustomLink;
};

export const AddLinkDialog: React.FC<AddLinkDialogProps> = ({ isOpen, onClose, link }) => {
  const { t } = useTranslation();
  const { userSettings } = useAppContext();
  const { guestDashboard } = userSettings;
  const queryClient = useQueryClient();
  const linksKey = getLinksQueryKey();
  const visibilityAvailable = queryClient.getQueryData<GetLinksResponse>(linksKey)?.editCapabilities?.includes('guest-visibility-patch.v1') ?? false;
  const opening = {
    open: isOpen,
    linkId: link?.id,
    autosaveVisibility: visibilityAvailable,
    visibilityChoice: link?.isVisibleOnGuestDashboard ?? false,
  };
  const [editor, setEditor] = useState(opening);
  // Keep the selected form contract for this opening, even when a refreshed
  // server response starts advertising support while a legacy draft is open.
  if (editor.open !== isOpen || editor.linkId !== link?.id) {
    setEditor(opening);
  }
  const autosaveVisibility = Boolean(link && editor.autosaveVisibility);

  const schema = type({
    title: 'string > 0 & string <= 20',
    description: 'string <= 50',
    url: 'string.url',
    iconUrl: type('string.url').or(type.unit('')),
  });

  const formId = useId();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: arktypeResolver(schema),
    defaultValues: {
      ...link,
      description: link?.description || '',
      iconUrl: link?.iconUrl || '',
    },
  });

  const addLink = useMutation({
    ...createLinkMutation(),
    onError: (e: TranslatableError) => {
      toast.error(t(e.message, e.intlParams));
    },
    onSuccess: () => {
      onClose();
      toast.success(t('LINKS_ADD_SUCCESS'));
    },
  });

  const saveLink = useMutation({
    ...editLinkMutation(),
    onError: (e: TranslatableError) => {
      toast.error(t(e.message, e.intlParams));
    },
    onSuccess: () => {
      onClose();
      toast.success(t('LINKS_EDIT_SUCCESS'));
    },
  });

  const mutationExecuting = addLink.isPending || saveLink.isPending;
  const visibility = useAutosavedToggle({
    id: `link-guest-visibility:${link?.id ?? 'new'}`,
    scope: `link:${link?.id ?? 'new'}`,
    saved: link?.isVisibleOnGuestDashboard ?? false,
    disabled: !autosaveVisibility || !guestDashboard || !isOpen || mutationExecuting,
    save: async (checked, signal) => {
      if (!link) return;
      try {
        const { data } = await editLink({ path: { id: link.id }, body: { isVisibleOnGuestDashboard: checked }, signal, throwOnError: true });
        if (
          !data ||
          typeof data !== 'object' ||
          !('id' in data && data.id === link.id) ||
          !('userId' in data && data.userId === link.userId) ||
          !('isVisibleOnGuestDashboard' in data && data.isVisibleOnGuestDashboard === checked)
        ) {
          throw new Error('The server did not confirm the change.');
        }
        await queryClient.cancelQueries({ queryKey: linksKey });
        signal.throwIfAborted();
        queryClient.setQueryData<GetLinksResponse>(
          linksKey,
          (current) =>
            current && {
              ...current,
              links: current.links.map((item) =>
                item.id === link.id && item.userId === link.userId ? { ...item, isVisibleOnGuestDashboard: checked } : item,
              ),
            },
        );
        void queryClient.invalidateQueries({ queryKey: getGuestLinksQueryKey() });
      } catch {
        signal.throwIfAborted();
        throw new Error('Guest dashboard visibility could not be saved.');
      }
    },
  });

  const onSubmit = (data: FormValues) => {
    const { title, url, description, iconUrl } = data;
    const metadata = { title, description, url, iconUrl };
    const fullForm = { ...metadata, isVisibleOnGuestDashboard: editor.visibilityChoice };
    if (link) {
      if (autosaveVisibility && visibility.pending) return;
      saveLink.mutate({ body: autosaveVisibility ? metadata : fullForm, path: { id: link.id } });
    } else {
      addLink.mutate({ body: fullForm });
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={mutationExecuting ? undefined : onClose}>
      <DialogContent size="sm" className="orbis-link-dialog">
        <DialogHeader>
          <DialogTitle>{link ? t('LINKS_EDIT_TITLE') : t('LINKS_ADD_TITLE')}</DialogTitle>
        </DialogHeader>
        <DialogDescription asChild>
          <form noValidate onSubmit={handleSubmit((values) => onSubmit(values))} id={formId}>
            <Input
              disabled={mutationExecuting}
              {...register('title')}
              maxLength={20}
              label={t('LINKS_FORM_LINK_TITLE')}
              placeholder="Orbis demo"
              error={errors.title?.message}
            />
            <Input
              disabled={mutationExecuting}
              type="text"
              {...register('description')}
              maxLength={50}
              className="mt-3"
              label={t('LINKS_FROM_LINK_DESCRIPTION')}
              placeholder="My super app"
              error={errors.description?.message}
            />
            <Input
              disabled={mutationExecuting}
              {...register('url')}
              className="mt-3"
              label={t('LINKS_FORM_LINK_URL')}
              placeholder="https://demo.runtipi.io"
              error={errors.url?.message}
            />

            <Input
              disabled={mutationExecuting}
              {...register('iconUrl')}
              className="mt-3"
              label={t('LINKS_FORM_ICON_URL')}
              placeholder={t('LINKS_FORM_ICON_PLACEHOLDER')}
              error={errors.iconUrl?.message}
            />
            {guestDashboard &&
              (autosaveVisibility ? (
                <AutosavedSettingSwitch className="mt-3" label={t('LINKS_FORM_VISIBLE_ON_GUEST_DASHBOARD')} toggle={visibility} showStatus />
              ) : (
                <Switch
                  disabled={mutationExecuting}
                  checked={editor.visibilityChoice}
                  onCheckedChange={(checked) => setEditor((current) => ({ ...current, visibilityChoice: checked }))}
                  className="mt-3"
                  label={t('LINKS_FORM_VISIBLE_ON_GUEST_DASHBOARD')}
                />
              ))}
          </form>
        </DialogDescription>
        <DialogFooter>
          <Button type="submit" intent="success" disabled={mutationExecuting || (autosaveVisibility && visibility.pending)} form={formId}>
            {link ? 'Save' : 'Add'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
