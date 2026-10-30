import { useEffect, useId, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { IconChevronDown, IconUpload, IconTrash } from '@tabler/icons-react';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import { InlineFeedback } from '@/components/ui/Alert/Alert';
import { useReducedMotion } from '@/desktop/motion-preferences';
import { displayCertificateFingerprint, readSourceCertificate, type SourceCertificate } from './source-certificate';
import './source-certificate-picker.css';

type Props = { disabled: boolean; value: SourceCertificate | null; onChange: (value: SourceCertificate | null) => void };

export function SourceCertificatePicker({ disabled, value, onChange }: Props) {
  const id = useId();
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const clear = () => {
    generation.current++;
    setReading(false);
    setError(null);
    onChange(null);
  };
  return (
    <div className="source-certificate-picker">
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        onClick={() => {
          if (open) clear();
          setOpen(!open);
        }}
      >
        Local certificate <IconChevronDown size={17} aria-hidden="true" />
      </Button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="certificate"
            id={`${id}-panel`}
            className="source-certificate-details"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: reduced ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="source-certificate-content">
              <p>For a locally signed source, choose its public certificate or local CA root. Its HTTPS address must match the certificate.</p>
              <input
                ref={input}
                type="file"
                accept=".pem,.crt,application/x-pem-file,application/x-x509-ca-cert"
                className="visually-hidden"
                tabIndex={-1}
                disabled={disabled || reading}
                aria-label="Choose source certificate"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  event.currentTarget.value = '';
                  if (!file) return;
                  const attempt = ++generation.current;
                  setReading(true);
                  setError(null);
                  onChange(null);
                  try {
                    const certificate = await readSourceCertificate(file);
                    if (attempt === generation.current) onChange(certificate);
                  } catch (reason) {
                    if (attempt === generation.current) setError(reason instanceof Error ? reason.message : 'The certificate could not be read.');
                  } finally {
                    if (attempt === generation.current) setReading(false);
                  }
                }}
              />
              <div className="source-certificate-actions">
                <Button type="button" variant="outline" disabled={disabled || reading} onClick={() => input.current?.click()}>
                  <IconUpload size={18} aria-hidden="true" /> {reading ? 'Reading…' : value ? 'Choose another certificate' : 'Choose certificate'}
                </Button>
                {value ? (
                  <Button type="button" variant="outline" disabled={disabled} onClick={clear}>
                    <IconTrash className="orbis-remove-icon" size={18} aria-hidden="true" /> Remove
                  </Button>
                ) : null}
              </div>
              {error ? <InlineFeedback>{error}</InlineFeedback> : null}
              {value ? (
                <>
                  <div className="host-transfer-fingerprint">
                    <span>Certificate SHA-256</span>
                    <code>{displayCertificateFingerprint(value.sha256)}</code>
                  </div>
                  <Checkbox
                    className="host-transfer-confirm"
                    id={`${id}-confirm-certificate`}
                    checked={value.confirmed}
                    required
                    disabled={disabled}
                    onCheckedChange={(confirmed) => onChange({ ...value, confirmed })}
                    label="I compared this certificate fingerprint on the source server."
                  />
                </>
              ) : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
