import { useDesktopPreferences, type DesktopPreferences } from '@/desktop/preferences';
import { themePresets, presetLabels, presetWallpaperPreviews } from '@/desktop/wallpaper-presets';
import { Switch } from '@/components/ui/Switch';
import { wallpaperUrl } from '@/desktop/wallpaper';
import { IconPhoto, IconUpload } from '@tabler/icons-react';
import { imageDimensionsFromData } from 'image-dimensions';
import { useEffect, useRef, useState } from 'react';
import { AppearanceRange } from './appearance-controls';

const wallpapers: { value: DesktopPreferences['wallpaper']; title: string }[] = [
  { value: 'sandstone', title: 'Sandstone' },
  { value: 'tidal', title: 'Tidal' },
  { value: 'canopy', title: 'Canopy' },
];

async function requestError(response: Response) {
  if (response.status === 401) return 'Session expired. Sign in again.';
  const value: unknown = await response.json().catch(() => null);
  return response.status < 500 &&
    value &&
    typeof value === 'object' &&
    'message' in value &&
    typeof value.message === 'string' &&
    value.message.length <= 200
    ? value.message
    : 'The wallpaper could not be saved. Check the connection and try again.';
}

export function WallpaperSettings() {
  const { preferences, update, updateAppearance, wallpaperRevision, refreshWallpaper } = useDesktopPreferences();
  const value = preferences.appearance;
  const [uploaded, setUploaded] = useState<string | null>(value.wallpaperImage);
  const [infoAttempt, setInfoAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const mutationRevision = useRef(0);
  const initialImage = useRef(value.wallpaperImage);

  useEffect(() => {
    const controller = new AbortController();
    const revision = mutationRevision.current;
    void fetch(`/api/desktop-preferences/wallpaper/info?refresh=${infoAttempt}`, {
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Uploaded wallpaper could not be loaded.');
        const info: unknown = await response.json();
        if (controller.signal.aborted || revision !== mutationRevision.current) return;
        if (info && typeof info === 'object' && 'hash' in info && typeof info.hash === 'string' && /^[a-f0-9]{64}$/.test(info.hash))
          setUploaded(initialImage.current ?? info.hash);
      })
      .catch(() => {
        if (!controller.signal.aborted) setMessage('Uploaded wallpaper could not be loaded.');
      });
    return () => {
      controller.abort();
    };
  }, [infoAttempt]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
    };
  }, []);

  const upload = async (file?: File) => {
    if (!file || busy || request.current) return;
    if (file.size > 8 * 1024 * 1024 || !file.size) {
      setMessage('Choose an image up to 8 MB.');
      return;
    }
    if (file.type && !['image/png', 'image/jpeg', 'image/webp', 'application/octet-stream'].includes(file.type)) {
      setMessage('Choose a PNG, JPEG or WebP image.');
      return;
    }
    setBusy(true);
    mutationRevision.current += 1;
    setMessage('Checking image…');
    const controller = new AbortController();
    request.current = controller;
    const timeout = window.setTimeout(() => controller.abort(new DOMException('Upload timed out', 'TimeoutError')), 120000);
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    try {
      const dimensions = imageDimensionsFromData(new Uint8Array(await file.arrayBuffer()));
      if (!dimensions || !['png', 'jpeg', 'webp'].includes(dimensions.type)) throw new Error('Choose a readable PNG, JPEG or WebP image.');
      if (dimensions.width > 16384 || dimensions.height > 16384 || dimensions.width * dimensions.height > 32_000_000) {
        throw new Error('Use an image up to 32 megapixels, with neither side larger than 16,384 pixels.');
      }
      image.src = objectUrl;
      await image.decode();
      if (
        !image.naturalWidth ||
        !image.naturalHeight ||
        image.naturalWidth > 16384 ||
        image.naturalHeight > 16384 ||
        image.naturalWidth * image.naturalHeight > 32_000_000
      ) {
        throw new Error('Use an image up to 32 megapixels, with neither side larger than 16,384 pixels.');
      }
      controller.signal.throwIfAborted();
      setMessage('Uploading image…');
      const form = new FormData();
      form.append('image', file);
      const response = await fetch('/api/desktop-preferences/wallpaper', {
        method: 'POST',
        credentials: 'include',
        body: form,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(await requestError(response));
      const info: unknown = await response.json().catch(() => null);
      if (!info || typeof info !== 'object' || !('hash' in info) || typeof info.hash !== 'string' || !/^[a-f0-9]{64}$/.test(info.hash))
        throw new Error('The server returned an invalid wallpaper.');
      setUploaded(info.hash);
      initialImage.current = info.hash;
      update({ wallpaperMode: 'custom' });
      updateAppearance({ wallpaperImage: info.hash });
      refreshWallpaper();
      setMessage('Wallpaper uploaded.');
    } catch (error) {
      if (mounted.current) {
        setMessage(
          controller.signal.reason?.name === 'TimeoutError'
            ? 'Upload timed out. Check the connection and try again.'
            : error instanceof TypeError
              ? 'The wallpaper could not be saved. Check the connection and try again.'
              : error instanceof Error && error.name !== 'EncodingError'
                ? error.message
                : 'This image could not be opened. Choose another file.',
        );
        setInfoAttempt((value) => value + 1);
      }
    } finally {
      window.clearTimeout(timeout);
      image.src = '';
      URL.revokeObjectURL(objectUrl);
      if (mounted.current) setBusy(false);
      if (request.current === controller) request.current = null;
    }
  };

  const remove = async () => {
    if (busy || request.current) return;
    setBusy(true);
    mutationRevision.current += 1;
    const controller = new AbortController();
    request.current = controller;
    const timeout = window.setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), 30000);
    try {
      const response = await fetch('/api/desktop-preferences/wallpaper', { method: 'DELETE', credentials: 'include', signal: controller.signal });
      if (!response.ok) throw new Error(await requestError(response));
      setUploaded(null);
      initialImage.current = null;
      updateAppearance({ wallpaperImage: null });
      refreshWallpaper();
      setMessage('Uploaded wallpaper removed.');
    } catch (error) {
      if (mounted.current) {
        setMessage(
          controller.signal.reason?.name === 'TimeoutError'
            ? 'Removal timed out. Check the connection and try again.'
            : error instanceof TypeError
              ? 'Wallpaper could not be removed. Check the connection and try again.'
              : error instanceof Error
                ? error.message
                : 'Wallpaper could not be removed.',
        );
        setInfoAttempt((value) => value + 1);
      }
    } finally {
      window.clearTimeout(timeout);
      if (mounted.current) setBusy(false);
      if (request.current === controller) request.current = null;
    }
  };

  return (
    <section className="appearance-section" aria-labelledby="appearance-wallpaper">
      <div>
        <h2 id="appearance-wallpaper">Wallpaper</h2>
        <p>Uploaded images are private to your account and appear after sign-in.</p>
      </div>
      <div className="appearance-wallpaper-settings" aria-busy={busy}>
        <Switch
          label="Match wallpaper to colour preset"
          checked={preferences.wallpaperMode === 'theme'}
          disabled={busy}
          onCheckedChange={(enabled) =>
            update({
              wallpaperMode: enabled ? 'theme' : 'custom',
              wallpaperPreset: enabled ? preferences.wallpaperPreset : preferences.preset,
              appearance: { ...value, wallpaperImage: null },
            })
          }
        />
        <div className="appearance-wallpapers">
          {themePresets.map((preset) => (
            <button
              key={preset}
              type="button"
              className="appearance-wallpaper"
              disabled={busy}
              aria-pressed={preferences.wallpaperMode === 'custom' && !value.wallpaperImage && preferences.wallpaperPreset === preset}
              onClick={() => update({ wallpaperMode: 'custom', wallpaperPreset: preset, appearance: { ...value, wallpaperImage: null } })}
            >
              <span className="appearance-wallpaper-preview" aria-hidden="true">
                <img
                  src={presetWallpaperPreviews[preset]}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', borderRadius: 'inherit' }}
                />
              </span>
              <strong>{presetLabels[preset]}</strong>
            </button>
          ))}
          {wallpapers.map(({ value: choice, title }) => (
            <button
              key={choice}
              type="button"
              className="appearance-wallpaper"
              disabled={busy}
              aria-pressed={
                preferences.wallpaperMode === 'custom' && !preferences.wallpaperPreset && !value.wallpaperImage && preferences.wallpaper === choice
              }
              onClick={() => {
                update({ wallpaper: choice, wallpaperMode: 'custom', wallpaperPreset: null, appearance: { ...value, wallpaperImage: null } });
              }}
            >
              <span className={`appearance-wallpaper-preview appearance-wallpaper-${choice}`} aria-hidden="true" />
              <strong>{title}</strong>
            </button>
          ))}
          {uploaded ? (
            <button
              type="button"
              className="appearance-wallpaper"
              disabled={busy}
              aria-pressed={value.wallpaperImage === uploaded}
              onClick={() => {
                update({ wallpaperMode: 'custom', appearance: { ...value, wallpaperImage: uploaded } });
                refreshWallpaper();
              }}
            >
              <span className="appearance-wallpaper-preview appearance-upload-preview">
                <IconPhoto size={24} aria-hidden="true" />
                <img
                  key={`${uploaded}:${wallpaperRevision}`}
                  src={wallpaperUrl(uploaded, wallpaperRevision)}
                  alt=""
                  onError={(event) => {
                    event.currentTarget.style.display = 'none';
                    setMessage('Uploaded image is unavailable. Replace it or choose another wallpaper.');
                  }}
                />
              </span>
              <strong>Uploaded image</strong>
            </button>
          ) : null}
        </div>
        <div className="appearance-actions">
          <button type="button" disabled={busy} onClick={() => input.current?.click()}>
            <IconUpload size={18} aria-hidden="true" />
            {uploaded ? 'Replace image' : 'Upload image'}
          </button>
          {uploaded || value.wallpaperImage ? (
            <button type="button" disabled={busy} onClick={() => void remove()}>
              <IconPhoto size={18} aria-hidden="true" />
              Remove uploaded image
            </button>
          ) : null}
          <input
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            aria-label="Upload wallpaper image"
            hidden
            onChange={(event) => {
              void upload(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
        </div>
        <p className="appearance-upload-help">PNG, JPEG or WebP · Up to 8 MB and 32 megapixels</p>
        <fieldset className="appearance-wallpaper-controls">
          <legend>Image layout</legend>
          <div className="appearance-choice">
            <button type="button" aria-pressed={value.wallpaperFit === 'cover'} onClick={() => updateAppearance({ wallpaperFit: 'cover' })}>
              Fill screen
            </button>
            <button type="button" aria-pressed={value.wallpaperFit === 'contain'} onClick={() => updateAppearance({ wallpaperFit: 'contain' })}>
              Fit whole image
            </button>
          </div>
          <div className="appearance-range-grid">
            <AppearanceRange
              label="Horizontal position"
              value={value.wallpaperX}
              max={100}
              onChange={(wallpaperX) => updateAppearance({ wallpaperX })}
            />
            <AppearanceRange
              label="Vertical position"
              value={value.wallpaperY}
              max={100}
              onChange={(wallpaperY) => updateAppearance({ wallpaperY })}
            />
            <AppearanceRange
              label="Dim wallpaper"
              value={value.wallpaperDim}
              max={70}
              onChange={(wallpaperDim) => updateAppearance({ wallpaperDim })}
            />
            <AppearanceRange
              label="Wallpaper blur"
              value={value.wallpaperBlur}
              max={24}
              unit="px"
              onChange={(wallpaperBlur) => updateAppearance({ wallpaperBlur })}
            />
          </div>
          <button
            type="button"
            onClick={() => updateAppearance({ wallpaperFit: 'cover', wallpaperX: 50, wallpaperY: 0, wallpaperDim: 0, wallpaperBlur: 0 })}
          >
            Reset image layout
          </button>
        </fieldset>
        <output className="appearance-upload-message" aria-live="polite">
          {message}
        </output>
      </div>
    </section>
  );
}
