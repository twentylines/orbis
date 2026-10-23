/* biome-ignore-all lint/a11y/noNoninteractiveTabindex: The named log scrolls independently and must support keyboard scrolling. */
import { useLayoutEffect, useRef, useState } from 'react';
import './update-terminal.css';

type Output = { text: string; bytes: number; truncated: boolean; updatedAt: number | null };

export function UpdateTerminal({ output, state }: { output?: Output; state: string }) {
  const terminal = useRef<HTMLPreElement>(null);
  const [following, setFollowing] = useState(true);
  const live = state === 'queued' || state === 'running';
  const text = output?.text ?? '';
  useLayoutEffect(() => {
    if (text && following && terminal.current) terminal.current.scrollTop = terminal.current.scrollHeight;
  }, [text, following]);
  return (
    <section className="desktop-update-terminal" aria-label="System update output" data-state={state}>
      <header>
        <div>
          <span className="desktop-terminal-status" aria-hidden="true" />
          <strong>{live ? 'Live output' : 'Update output'}</strong>
        </div>
        <span>{output?.updatedAt ? new Date(output.updatedAt * 1000).toLocaleTimeString() : 'Waiting for APT'}</span>
      </header>
      <pre
        ref={terminal}
        role="log"
        aria-label="APT terminal output"
        aria-live="off"
        tabIndex={0}
        onScroll={(event) => {
          const element = event.currentTarget;
          setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 32);
        }}
      >
        {text || (live ? 'Waiting for package output…' : 'No package output was recorded.')}
      </pre>
      <footer>
        <span>
          {output?.truncated
            ? 'Showing the latest output'
            : state === 'complete'
              ? 'Update completed'
              : state === 'failed' || state === 'interrupted'
                ? 'Update needs attention'
                : 'Updates continue when this page is closed'}
        </span>
        {following ? null : (
          <button type="button" onClick={() => setFollowing(true)}>
            Follow output
          </button>
        )}
      </footer>
    </section>
  );
}
