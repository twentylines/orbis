import { useLocalStorage } from '@uidotdev/usehooks';
import clsx from 'clsx';
import DOMPurify from 'dompurify';
import { useEffect, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { WrapWords } from '@/components/wrap-words/wrap-words';
import './logs-terminal.css';

type Props = {
  logs: { id: number; text: string }[];
  maxLines: number;
  onMaxLinesChange: (lines: number) => void;
};

export const LogsTerminal = (props: Props) => {
  const { t } = useTranslation();

  const { logs, onMaxLinesChange, maxLines } = props;
  const id = useId();
  const [follow, setFollow] = useLocalStorage<boolean>('logs-follow', true);
  const [wrapLines, setWrapLines] = useLocalStorage<boolean>('logs-wraplines', false);
  const ref = useRef<HTMLPreElement>(null);

  const lastLogId = logs.length > 0 ? logs.at(-1)?.id : null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: necessary to update the scroll when a new log is added
  useEffect(() => {
    if (ref.current && follow) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [lastLogId, follow]);

  const updateMaxLines = (lines: number) => {
    const linesToKeep = Math.min(1000, Math.max(1, Number.isFinite(lines) ? Math.floor(lines) : 300));
    onMaxLinesChange(linesToKeep);
  };

  return (
    <div className="log-terminal-shell">
      <div className="log-terminal-controls">
        <label className="form-check form-switch log-terminal-toggle" htmlFor={`${id}-follow`}>
          <input id={`${id}-follow`} className="form-check-input" type="checkbox" checked={follow} onChange={() => setFollow(!follow)} />
          <span className="form-check-label">
            <WrapWords text={t('APP_LOGS_TAB_FOLLOW')} />
          </span>
        </label>
        <label className="form-check form-switch log-terminal-toggle" htmlFor={`${id}-wrap`}>
          <input id={`${id}-wrap`} className="form-check-input" type="checkbox" checked={wrapLines} onChange={() => setWrapLines(!wrapLines)} />
          <span className="form-check-label">
            <WrapWords text={t('APP_LOGS_TAB_WRAP_LINES')} />
          </span>
        </label>
        <label className="log-terminal-limit" htmlFor={`${id}-max-lines`}>
          <span>
            <WrapWords text={t('APP_LOGS_TAB_MAX_LINES')} />
          </span>
          <input
            id={`${id}-max-lines`}
            aria-label={t('APP_LOGS_TAB_MAX_LINES')}
            min={1}
            max={1000}
            type="number"
            className="form-control"
            value={maxLines}
            onChange={(e) => updateMaxLines(Number.parseInt(e.target.value, 10))}
          />
        </label>
      </div>
      <pre
        id="log-terminal"
        className={clsx('mt-2 log-terminal', {
          'wrap-lines': wrapLines,
        })}
        ref={ref}
        role="log"
        aria-label="Live log output"
        aria-live="off"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The log has its own scroll region and supports native keyboard scrolling.
        tabIndex={0}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: safe to use because the content is sanitized
        dangerouslySetInnerHTML={{ __html: logs.map((log) => DOMPurify.sanitize(log.text)).join('<br />') }}
      />
    </div>
  );
};
