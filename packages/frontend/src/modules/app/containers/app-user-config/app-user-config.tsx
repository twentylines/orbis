import { Button } from '@/components/ui/Button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { CodeEditor } from '@/components/code-editor/code-editor';
import { yaml } from '@codemirror/lang-yaml';
import { Alert, AlertDescription, AlertHeading, AlertIcon } from '@/components/ui/Alert/Alert';
import type { AppInfo } from '@/types/app.types';
import { IconAlertCircle } from '@tabler/icons-react';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { disableUserConfig, enableUserConfig, getUserConfig } from '@/api-client';
import { getUserConfigOptions, getUserConfigQueryKey, updateUserConfigMutation } from '@/api-client/@tanstack/react-query.gen';
import { AutosavedSettingSwitch } from '@/modules/settings/components/autosaved-setting-switch';
import { useAutosavedToggle } from '@/modules/settings/hooks/use-autosaved-toggle';
import toast from 'react-hot-toast';
import type { TranslatableError } from '@/types/error.types';
import './app-user-config.css';

interface AppUserConfigProps {
  info: AppInfo;
  initialDockerCompose?: string;
  initialAppEnv?: string;
  initialSourceCompose?: string;
  initialIsEnabled?: boolean;
}
const yamlExtensions = [yaml()];

export const AppUserConfig = (props: AppUserConfigProps) => {
  const { info } = props;

  const { data } = useSuspenseQuery({
    ...getUserConfigOptions({ path: { urn: info.urn } }),
  });

  return (
    <AppUserConfigEditors
      info={info}
      initialAppEnv={data.appEnv || ''}
      initialDockerCompose={data.dockerCompose || ''}
      initialSourceCompose={data.sourceCompose || ''}
      initialIsEnabled={data.isEnabled}
    />
  );
};

export const AppUserConfigEditors = ({ info, initialAppEnv, initialDockerCompose, initialSourceCompose, initialIsEnabled }: AppUserConfigProps) => {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [activeTab, setActiveTab] = useState('docker-compose');

  const [dockerCompose, setDockerCompose] = useState(initialDockerCompose ?? '');

  const placeholder = `# Add your docker-compose overrides here.
# For example, to add a new environment variable to the main service:
#
# services:
#   main:
#     environment:
#       - MY_VAR=my-value
#
# The overrides will be merged with the generated docker-compose.yml file.
`;

  const appEnv = initialAppEnv ?? '';

  const updateMutation = useMutation({
    ...updateUserConfigMutation(),
    onSuccess: () => {
      toast.success(t('USER_CONFIG_UPDATE_SUCCESS'));
    },
    onError: (e: TranslatableError) => {
      toast.error(t(e.message, e.intlParams));
    },
  });

  const overrides = useAutosavedToggle({
    id: `compose-overrides:${info.urn}`,
    scope: `compose-overrides:${info.urn}`,
    saved: initialIsEnabled ?? true,
    save: async (checked, signal) => {
      const path = { urn: info.urn };
      const change = checked ? enableUserConfig : disableUserConfig;
      try {
        await change({ path, signal, throwOnError: true });
        const { data } = await getUserConfig({ path, signal, cache: 'no-store', throwOnError: true });
        if (data?.isEnabled !== checked) throw new Error('The server did not confirm the compose override setting.');
        const queryKey = getUserConfigQueryKey({ path });
        await client.cancelQueries({ queryKey, exact: true });
        signal.throwIfAborted();
        client.setQueryData(queryKey, data);
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof Error && error.message === 'APP_ERROR_APP_NOT_FOUND') throw new Error(t(error.message, { id: info.urn }));
        throw new Error('The compose override setting could not be confirmed. Try again.');
      }
    },
  });

  const handleSave = () => {
    updateMutation.mutate({ path: { urn: info.urn }, body: { dockerCompose: dockerCompose.trimEnd(), appEnv: appEnv.trimEnd() } });
  };

  return (
    <div className="app-user-config">
      <Alert variant="warning">
        <AlertIcon>
          <IconAlertCircle stroke={2} />
        </AlertIcon>
        <div>
          <AlertHeading>{t('USER_CONFIG_WARNING_TITLE')}</AlertHeading>
          <AlertDescription>{t('USER_CONFIG_WARNING_DESCRIPTION')}</AlertDescription>
        </div>
      </Alert>
      <div>
        <Tabs className="app-user-config-tabs" value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="docker-compose">docker-compose.yml</TabsTrigger>
            <TabsTrigger value="overrides">{t('USER_CONFIG_OVERRIDES_TAB_TITLE')}</TabsTrigger>
          </TabsList>
          <TabsContent value="docker-compose">
            <CodeEditor label="Source Compose" readOnly value={initialSourceCompose} height="400px" extensions={yamlExtensions} />
            <div className="mt-2 text-muted small">{t('USER_CONFIG_SOURCE_COMPOSE_DESCRIPTION')}</div>
          </TabsContent>
          <TabsContent value="overrides">
            <div className="app-user-config-actions">
              <AutosavedSettingSwitch label={t('USER_CONFIG_ENABLE')} toggle={overrides} showStatus />
              <Button onClick={handleSave}>{t('SAVE')}</Button>
            </div>
            <CodeEditor
              label="Compose overrides"
              readOnly={!overrides.checked}
              value={dockerCompose || (overrides.checked ? placeholder : '')}
              height="400px"
              extensions={yamlExtensions}
              onChange={setDockerCompose}
            />
            <Trans
              t={t}
              i18nKey="USER_CONFIG_DOCKER_MERGE_DESCRIPTION"
              components={{
                // biome-ignore lint/a11y/useAnchorContent: not applicable
                a: <a target="_blank" rel="noopener" href="https://docs.docker.com/reference/compose-file/merge/" />,
                code: <code />,
              }}
              className="mt-2 d-block"
            />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
};
