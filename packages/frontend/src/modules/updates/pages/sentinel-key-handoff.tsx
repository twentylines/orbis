import { type FormEvent, useEffect, useId, useRef, useState } from 'react';

const fields = ['operationId', 'reviewSha256', 'planSha256', 'keyRevision', 'deliveryEpoch', 'handoff'] as const;
type Handoff = Record<(typeof fields)[number], string>;
const keyFormat = /^orbis-recovery-[A-Za-z0-9_-]{43}(?![\s\S])/;

export function parseSentinelKeyHandoff(source: string): Handoff {
  if (source.length > 1024) throw new Error('Enter the handoff from the host.');
  const value: unknown = JSON.parse(source);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length)
    throw new Error('Enter the handoff from the host.');
  const record = value as Record<string, unknown>;
  if (
    !fields.every((field) => {
      const entry = record[field];
      return typeof entry === 'string' && (field === 'handoff' ? /^[A-Za-z0-9_-]{43}(?![\s\S])/ : /^[a-f0-9]{64}(?![\s\S])/).test(entry);
    })
  )
    throw new Error('Enter the handoff from the host.');
  return record as Handoff;
}

async function send(action: 'save-key' | 'confirm-key', value: Handoff & { recoveryKey?: string }, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(`/api/system/sentinel/enrollment/${action}`, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
    signal: AbortSignal.any([signal, AbortSignal.timeout(9000)]),
  });
  if (!response.ok) throw new Error('The host could not verify this handoff.');
  return response.json();
}

function saveFile(key: string) {
  const url = URL.createObjectURL(new Blob([`${key}\n`], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'orbis-recovery-key.txt';
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function SentinelKeyHandoff({
  active = true,
  acknowledged,
  onConfirmed,
}: {
  active?: boolean;
  acknowledged: boolean;
  onConfirmed: () => void;
}) {
  const [working, setWorking] = useState(false);
  const [https, setHttps] = useState(false);
  const [saved, setSaved] = useState(false);
  const [message, setMessage] = useState('');
  const handoff = useRef<Handoff | null>(null);
  const operation = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const fileId = useId();
  useEffect(() => setHttps(window.location.protocol === 'https:'), []);
  useEffect(() => {
    if (!active || acknowledged) {
      operation.current?.abort();
      operation.current = null;
      handoff.current = null;
      if (input.current) input.current.value = '';
      if (file.current) file.current.value = '';
      setWorking(false);
      setSaved(false);
      setMessage('');
    }
  }, [active, acknowledged]);
  useEffect(() => {
    const clear = () => {
      operation.current?.abort();
      operation.current = null;
      handoff.current = null;
      if (input.current) input.current.value = '';
      if (file.current) file.current.value = '';
    };
    const hide = () => {
      clear();
      setWorking(false);
      setSaved(false);
      setMessage('');
    };
    window.addEventListener('pagehide', hide);
    return () => {
      window.removeEventListener('pagehide', hide);
      clear();
    };
  }, []);

  if (!active || !https || acknowledged) return null;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (operation.current) return;
    const attempt = new AbortController();
    operation.current = attempt;
    setWorking(true);
    setMessage('');
    try {
      const binding = parseSentinelKeyHandoff(input.current?.value ?? '');
      if (input.current) input.current.value = '';
      const value = await send('save-key', binding, attempt.signal);
      if (attempt.signal.aborted) return;
      if (
        !value ||
        typeof value !== 'object' ||
        !('recoveryKey' in value) ||
        typeof value.recoveryKey !== 'string' ||
        !keyFormat.test(value.recoveryKey)
      )
        throw new Error('The host returned an invalid response.');
      saveFile(value.recoveryKey);
      handoff.current = binding;
      setSaved(true);
      setMessage('Download requested. Move the saved key somewhere you can reach while Orbis is offline.');
    } catch {
      if (!attempt.signal.aborted) setMessage('The key could not be saved. Check the host handoff and try again.');
    } finally {
      if (operation.current === attempt) {
        operation.current = null;
        setWorking(false);
      }
    }
  };

  const confirm = async (event: FormEvent) => {
    event.preventDefault();
    const picked = file.current?.files?.[0];
    const binding = handoff.current;
    if (operation.current || !picked || !binding) return;
    const attempt = new AbortController();
    operation.current = attempt;
    setWorking(true);
    setMessage('');
    try {
      if (picked.size > 128) throw new Error('Choose the saved emergency key.');
      const recoveryKey = (await picked.text()).replace(/\r?\n$/, '');
      if (attempt.signal.aborted) return;
      if (!keyFormat.test(recoveryKey)) throw new Error('Choose the saved emergency key.');
      const value = await send('confirm-key', { ...binding, recoveryKey }, attempt.signal);
      if (attempt.signal.aborted) return;
      if (!value || typeof value !== 'object' || !('state' in value) || value.state !== 'acknowledged')
        throw new Error('The host did not confirm the saved key.');
      handoff.current = null;
      setSaved(false);
      setMessage('The host confirmed the saved key.');
      onConfirmed();
    } catch {
      if (!attempt.signal.aborted) setMessage('The host could not confirm that copy. Choose the saved key again and retry.');
    } finally {
      if (operation.current === attempt) {
        operation.current = null;
        if (file.current) file.current.value = '';
        setWorking(false);
      }
    }
  };

  return (
    <div className="desktop-sentinel-key-handoff">
      {saved ? (
        <form onSubmit={(event) => void confirm(event)}>
          <label htmlFor={fileId}>Choose the saved emergency key</label>
          <input id={fileId} ref={file} type="file" accept=".txt,text/plain" required disabled={working} />
          <button type="submit" className="desktop-update-action secondary" disabled={working}>
            Confirm saved key
          </button>
        </form>
      ) : (
        <form onSubmit={(event) => void save(event)}>
          <p>
            On the host, run <code>--bootstrap authorize-browser</code> for the reviewed setup. Paste its handoff here.
          </p>
          <label htmlFor={inputId}>Handoff from the host</label>
          <textarea id={inputId} ref={input} autoComplete="off" spellCheck={false} required maxLength={1024} disabled={working} />
          <button type="submit" className="desktop-update-action secondary" disabled={working}>
            Save emergency key
          </button>
        </form>
      )}
      <output aria-live="polite">{message}</output>
    </div>
  );
}
