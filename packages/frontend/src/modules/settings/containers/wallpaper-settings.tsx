import { useDesktopPreferences } from '@/desktop/preferences';
import { themePresets, presetLabels, presetWallpaperPreviews } from '@/desktop/wallpaper-presets';
import { Switch } from '@/components/ui/Switch';
import { IconPhoto, IconUpload } from '@tabler/icons-react';
import { rememberBrowserWallpaper, forgetBrowserWallpaper } from '@/desktop/wallpaper-cache';
import { checkWallpaper, sendWallpaper, wallpaperRequestError } from '@/desktop/wallpaper-upload';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useWallpaperImage } from '@/desktop/wallpaper-layer';
import { AppearanceRange } from './appearance-controls';

export function WallpaperSettings() {
  const { preferences, update, updateAppearance, wallpaperRevision, refreshWallpaper } = useDesktopPreferences();
  const value = preferences.appearance;
  const [uploaded, setUploaded] = useState<string | null>(value.wallpaperImage);
  const [infoAttempt, setInfoAttempt] = useState(0);
  const [operation, setOperation] = useState<'checking' | 'uploading' | 'removing' | null>(null);
  const busy = operation !== null;
  const [progress, setProgress] = useState<number | null>(null);
  const [tone, setTone] = useState<'status' | 'error' | 'success'>('status');
  const [infoError, setInfoError] = useState('');
  const [message, setMessage] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const mutationRevision = useRef(0);
  const initialImage = useRef(value.wallpaperImage);

  const imageUnavailable = useCallback(() => {
    setTone('error');
    setMessage('Uploaded image is unavailable. Replace it or choose another wallpaper.');
  }, []);
  const uploadedPreview = useWallpaperImage(
    uploaded,
    preferences.wallpaperMode !== 'custom' || value.wallpaperImage !== uploaded,
    wallpaperRevision,
    imageUnavailable,
  );

  useEffect(() => {
    initialImage.current = value.wallpaperImage;
    if (value.wallpaperImage) setUploaded(value.wallpaperImage);
  }, [value.wallpaperImage]);
  useEffect(() => {
    const controller = new AbortController();
    const revision = mutationRevision.current;
    void fetch(`/api/desktop-preferences/wallpaper/info?refresh=${infoAttempt}`, {
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(wallpaperRequestError(response.status, await response.json().catch(() => null)));
        const info: unknown = await response.json();
        if (controller.signal.aborted || revision !== mutationRevision.current) return;
        if (info && typeof info === 'object' && 'available' in info && info.available === false) {
          setInfoError(initialImage.current ? 'The server copy of your wallpaper is unavailable. Upload it again to keep it on your account.' : '');
          return;
        }
        if (!info || typeof info !== 'object' || !('hash' in info) || typeof info.hash !== 'string' || !/^[a-f0-9]{64}$/.test(info.hash))
          throw new Error('The server returned invalid wallpaper information.');
        setUploaded(initialImage.current ?? info.hash);
        setInfoError('');
      })
      .catch((error) => {
        if (!controller.signal.aborted && revision === mutationRevision.current)
          setInfoError(error instanceof Error ? error.message : 'Uploaded wallpaper could not be loaded.');
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
    setOperation('checking');
    setProgress(null);
    setTone('status');
    setInfoError('');
    mutationRevision.current += 1;
    setMessage('Checking image…');
    const controller = new AbortController();
    request.current = controller;
    const timeout = window.setTimeout(() => controller.abort(new DOMException('Upload timed out', 'TimeoutError')), 120000);
    try {
      const mime = await checkWallpaper(file, controller.signal);
      setOperation('uploading');
      setMessage('Uploading image…');
      const hash = await sendWallpaper(file, controller.signal, setProgress);
      const remembered = await rememberBrowserWallpaper(hash, new Blob([file], { type: mime }));
      controller.signal.throwIfAborted();
      if (!mounted.current) return;
      setUploaded(hash);
      initialImage.current = hash;
      update({ wallpaperMode: 'custom' });
      updateAppearance({ wallpaperImage: hash });
      refreshWallpaper();
      setTone('success');
      setMessage(
        remembered
          ? 'Wallpaper uploaded. This browser will remember it for sign-in.'
          : 'Wallpaper uploaded. This browser could not remember it for sign-in.',
      );
    } catch (error) {
      if (mounted.current) {
        setTone('error');
        setMessage(
          controller.signal.reason?.name === 'TimeoutError'
            ? 'Upload timed out. Check the connection and try again.'
            : error instanceof Error && !['EncodingError', 'TypeError'].includes(error.name)
              ? error.message
              : 'This image could not be opened. Choose a readable PNG, JPEG or WebP image.',
        );
      }
    } finally {
      window.clearTimeout(timeout);
      if (mounted.current) setOperation(null);
      if (request.current === controller) request.current = null;
    }
  };

  const remove = async () => {
    if (busy || request.current) return;
    setOperation('removing');
    setTone('status');
    setMessage('Removing uploaded image…');
    setInfoError('');
    mutationRevision.current += 1;
    const controller = new AbortController();
    request.current = controller;
    const timeout = window.setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), 30000);
    try {
      const response = await fetch('/api/desktop-preferences/wallpaper', { method: 'DELETE', credentials: 'include', signal: controller.signal });
      if (!response.ok) throw new Error(wallpaperRequestError(response.status, await response.json().catch(() => null)));
      await forgetBrowserWallpaper();
      controller.signal.throwIfAborted();
      if (!mounted.current) return;
      setUploaded(null);
      initialImage.current = null;
      updateAppearance({ wallpaperImage: null });
      refreshWallpaper();
      setTone('success');
      setMessage('Uploaded wallpaper removed from this account and browser.');
    } catch (error) {
      if (mounted.current) {
        setTone('error');
        setMessage(
          controller.signal.reason?.name === 'TimeoutError'
            ? 'Removal timed out. Check the connection and try again.'
            : error instanceof TypeError
              ? 'Wallpaper could not be removed. Check the connection and try again.'
              : error instanceof Error
                ? error.message
                : 'Wallpaper could not be removed.',
        );
      }
    } finally {
      window.clearTimeout(timeout);
      if (mounted.current) setOperation(null);
      if (request.current === controller) request.current = null;
    }
  };

  return (
    <section className="appearance-section appearance-wallpaper-section" aria-labelledby="appearance-wallpaper">
      <div>
        <h2 id="appearance-wallpaper">Wallpaper</h2>
        <p>Images stay private on your server. This browser remembers the last wallpaper for sign-in and loading screens.</p>
      </div>
      <div className="appearance-wallpaper-settings">
        <Switch
          label="Match wallpaper to colour preset"
          checked={preferences.wallpaperMode === 'theme'}
          disabled={busy}
          onCheckedChange={(enabled) =>
            update({
              wallpaperMode: enabled ? 'theme' : 'custom',
              wallpaperPreset: preferences.wallpaperPreset ?? (!enabled && !value.wallpaperImage ? preferences.preset : null),
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
              aria-pressed={
                preferences.wallpaperMode === 'custom' &&
                !value.wallpaperImage &&
                (preferences.wallpaperPreset ?? ({ sandstone: 'stone', tidal: 'ocean', canopy: 'forest' } as const)[preferences.wallpaper]) === preset
              }
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
          {uploaded ? (
            <button
              type="button"
              className="appearance-wallpaper"
              disabled={busy}
              aria-pressed={preferences.wallpaperMode === 'custom' && value.wallpaperImage === uploaded}
              onClick={() => {
                update({ wallpaperMode: 'custom', appearance: { ...value, wallpaperImage: uploaded } });
                refreshWallpaper();
              }}
            >
              <span className="appearance-wallpaper-preview appearance-upload-preview">
                <IconPhoto size={24} aria-hidden="true" />
                {uploadedPreview.source ? (
                  <img key={uploadedPreview.source} src={uploadedPreview.source} alt="" onError={uploadedPreview.unavailable} />
                ) : null}
              </span>
              <strong>Uploaded image</strong>
            </button>
          ) : null}
        </div>
        <div className="appearance-actions">
          <button type="button" disabled={busy} aria-describedby="wallpaper-upload-status" onClick={() => input.current?.click()}>
            <IconUpload size={18} aria-hidden="true" />
            {operation === 'checking'
              ? 'Checking image…'
              : operation === 'uploading'
                ? `Uploading${progress === null ? '…' : ` ${progress}%`}`
                : uploaded
                  ? 'Replace image'
                  : 'Upload image'}
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
        <div className="appearance-upload-status" data-tone={tone} aria-busy={busy}>
          {busy ? (
            <progress
              max={100}
              value={operation === 'uploading' && progress !== null ? progress : undefined}
              aria-label={operation === 'removing' ? 'Removing wallpaper' : 'Uploading wallpaper'}
            />
          ) : null}
          <output id="wallpaper-upload-status" className="appearance-upload-message" aria-live="polite">
            {message || infoError}
          </output>
          {infoError && !busy ? (
            <button
              type="button"
              onClick={() => {
                setMessage('');
                setInfoAttempt((attempt) => attempt + 1);
              }}
            >
              Retry uploaded image
            </button>
          ) : null}
        </div>
        <p className="appearance-upload-help">PNG, JPEG or WebP · Up to 32 MB and 64 megapixels. Original image quality is preserved.</p>
        <fieldset className="appearance-wallpaper-controls" disabled={busy}>
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
      </div>
    </section>
  );
}
