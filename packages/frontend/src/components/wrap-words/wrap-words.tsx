import { Fragment } from 'react';
import './wrap-words.css';

// Keep names readable at word boundaries; a single oversized identifier has an ellipsis fallback.
export function WrapWords({ text }: { text: string }) {
  return text
    .trim()
    .split(/\s+/)
    .map((word, index) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: Stateless word fragments preserve the label's order, including repeated words.
      <Fragment key={`${word}-${index}`}>
        {index > 0 ? ' ' : null}
        <span className="orbis-whole-word">{word}</span>
      </Fragment>
    ));
}
