import { useEffect, useId, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { IconChevronDown, IconDownload } from '@tabler/icons-react';
import { Button } from '@/components/ui/Button';
import { InlineFeedback } from '@/components/ui/Alert/Alert';
import { useReducedMotion } from '@/desktop/motion-preferences';
import { readLocalCertificate } from '@/desktop/secure-access';
import { displayCertificateFingerprint, readSourceCertificate, type SourceCertificate } from './source-certificate';
import './source-certificate-picker.css';

export function SourceCertificateInfo() {
  const id = useId();
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [certificate, setCertificate] = useState<SourceCertificate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const toggle = () => {
    controller.current?.abort();
    setError(null);
    setCertificate(null);
    setOpen(!open);
    setBusy(!open);
    if (open) return;
    const request = new AbortController();
    controller.current = request;
    void readLocalCertificate(request.signal)
      .then(readSourceCertificate)
      .then((value) => {
        if (!request.signal.aborted) setCertificate(value);
      })
      .catch((reason) => {
        if (!request.signal.aborted) setError(reason instanceof Error ? reason.message : 'The public certificate could not be read.');
      })
      .finally(() => {
        if (!request.signal.aborted) setBusy(false);
      });
  };
  return (
    <div className="source-certificate-picker">
      <Button type="button" variant="outline" aria-expanded={open} aria-controls={`${id}-panel`} onClick={toggle}>
        Source certificate <IconChevronDown size={17} aria-hidden="true" />
      </Button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            id={`${id}-panel`}
            className="source-certificate-details"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: reduced ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="source-certificate-content">
              {busy ? <output aria-live="polite">Reading public certificate…</output> : null}
              {error ? <InlineFeedback>{error}</InlineFeedback> : null}
              {certificate ? (
                <>
                  <p>For a local certificate, compare this fingerprint on the destination. The destination still checks the HTTPS hostname.</p>
                  <div className="host-transfer-fingerprint">
                    <span>Certificate SHA-256</span>
                    <code>{displayCertificateFingerprint(certificate.sha256)}</code>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      const url = URL.createObjectURL(new Blob([certificate.pem], { type: 'application/x-pem-file' }));
                      const link = document.createElement('a');
                      link.href = url;
                      link.download = 'orbis-source-certificate.pem';
                      link.click();
                      setTimeout(() => URL.revokeObjectURL(url), 1000);
                    }}
                  >
                    <IconDownload size={18} aria-hidden="true" /> Download certificate
                  </Button>
                </>
              ) : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
