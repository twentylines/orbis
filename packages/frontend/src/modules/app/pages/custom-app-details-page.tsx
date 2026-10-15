import { useParams, useSearchParams } from 'react-router';
import { AppWorkspace } from '../containers/app-workspace/app-workspace';
import { CustomAppLogo } from '@/components/custom-app-logo/custom-app-logo';
import { useMutation, useSuspenseQuery } from '@tanstack/react-query';
import { getAppOptions, uploadAppImageMutation } from '@/api-client/@tanstack/react-query.gen';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import type { TranslatableError } from '@/types/error.types';
import { useState } from 'react';

export const CustomAppDetailsPage = () => {
  const params = useParams<{ appId: string }>();
  const { t } = useTranslation();

  const getApp = useSuspenseQuery({
    ...getAppOptions({ path: { urn: `${params.appId}:_user` } }),
  });

  const [searchParams] = useSearchParams();
  const [bust, setBust] = useState(searchParams.get('bust'));

  const { info, app, metadata } = getApp.data;

  const imageUrl = new URL(`/api/marketplace/apps/${params.appId}:_user/image`, window.location.origin);

  const uploadImage = useMutation({
    ...uploadAppImageMutation(),
    onSuccess: () => {
      setBust(Date.now().toString());
      fetch(imageUrl.toString(), { method: 'HEAD' });
      toast.success(t('CUSTOM_APP_UPLOAD_SUCCESS'));
    },
    onError: (error: TranslatableError) => {
      toast.error(t(error.message, error.intlParams));
    },
  });

  const handleImageUpload = (file: File) => {
    uploadImage.mutate({
      path: { urn: `${params.appId}:_user` },
      body: { image: file },
    });
  };

  if (bust) {
    imageUrl.searchParams.set('t', bust);
  }

  return (
    <AppWorkspace
      info={info}
      app={app}
      metadata={metadata}
      logo={
        <CustomAppLogo url={imageUrl.toString()} size={96} alt={info.name} onImageUpload={handleImageUpload} isUploading={uploadImage.isPending} />
      }
    />
  );
};

export default CustomAppDetailsPage;
