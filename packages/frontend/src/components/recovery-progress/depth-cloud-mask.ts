type MaskImage = Pick<HTMLImageElement, 'src' | 'decoding' | 'decode'>;

export function createCloudMaskLoader(createImage: () => MaskImage, source: string) {
  let pending: Promise<MaskImage | null> | undefined;
  let decoded: MaskImage | null = null;
  const load = () => {
    pending ??= Promise.resolve()
      .then(async () => {
        const image = createImage();
        image.decoding = 'async';
        image.src = source;
        await image.decode();
        decoded = image;
        return image;
      })
      .catch(() => null);
    return pending;
  };
  return Object.assign(load, { peek: () => decoded });
}

export const loadCloudMask = createCloudMaskLoader(() => new Image(), '/assets/depth-cloud-mask-2f997bef.webp');

if (typeof Image !== 'undefined') void loadCloudMask();
