type MaskImage = Pick<HTMLImageElement, 'src' | 'decoding' | 'decode'>;

export function createCloudMaskLoader(createImage: () => MaskImage, source: string) {
  let pending: Promise<MaskImage | null> | undefined;
  return () => {
    pending ??= Promise.resolve()
      .then(async () => {
        const image = createImage();
        image.decoding = 'async';
        image.src = source;
        await image.decode();
        return image;
      })
      .catch(() => null);
    return pending;
  };
}

export const loadCloudMask = createCloudMaskLoader(() => new Image(), '/assets/depth-cloud-mask-2f997bef.webp');
