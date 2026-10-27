import { prefersReducedMotion } from '@/desktop/motion-setting';
import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type InputHTMLAttributes, type Ref } from 'react';
import './input.css';

type Field = Pick<HTMLInputElement, 'type' | 'value' | 'selectionStart' | 'selectionEnd'>;
export function characterEntry(input: Field, inserted?: string) {
  if (input.selectionStart !== input.selectionEnd) return null;
  const masked = input.type === 'password';
  const length = input.value.length;
  if (length > 4096) return null;
  const text = masked ? '•'.repeat(length) : input.value;
  const caret = input.selectionStart;
  const count = inserted && caret === input.selectionEnd ? (masked ? 1 : inserted.length) : 0;
  const start = caret === null ? 0 : Math.max(0, caret - count);
  return { before: text.slice(0, start), character: count ? text.slice(start, caret ?? start) : '', after: text.slice(caret ?? start), text };
}

type Model = NonNullable<ReturnType<typeof characterEntry>> & { sequence: number; clip: CSSProperties; run: CSSProperties };
const pixels = (value: number) => `${Math.round(value * 1000) / 1000}px`;
export function useCharacterMotion(enabled: boolean) {
  const root = useRef<HTMLDivElement>(null);
  const previous = useRef<Model | null>(null);
  const [model, setModel] = useState<Model | null>(null);
  const sequence = useRef(0);
  const composing = useRef(false);
  const sync = useCallback(
    (input: HTMLInputElement, event?: Event) => {
      if (composing.current || !enabled || !CSS.supports('-webkit-text-fill-color', 'transparent') || prefersReducedMotion()) {
        if (previous.current) {
          previous.current = null;
          setModel(null);
        }
        return;
      }
      const entry = event as InputEvent | undefined;
      const inserted = !entry?.isComposing && entry?.inputType === 'insertText' ? (entry.data ?? undefined) : undefined;
      const content = characterEntry(input, inserted);
      if (!content) {
        if (previous.current) {
          previous.current = null;
          setModel(null);
        }
        return;
      }
      const container = root.current;
      if (!container) return;
      const style = getComputedStyle(input);
      const box = input.getBoundingClientRect();
      const bounds = container.getBoundingClientRect();
      const line = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.4;
      const leftInset = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.borderLeftWidth);
      const rightInset = Number.parseFloat(style.paddingRight) + Number.parseFloat(style.borderRightWidth);
      const textWidth = Math.max(0, box.width - leftInset - rightInset);
      const unchanged = previous.current?.text === content.text;
      const run = {
        left: pixels(-input.scrollLeft),
        width: pixels(textWidth),
        textAlign: style.textAlign as CSSProperties['textAlign'],
        direction: style.direction as CSSProperties['direction'],
        fontVariantNumeric: style.fontVariantNumeric,
        top: pixels((box.height - line) / 2),
        color: style.color,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        fontStyle: style.fontStyle,
        fontStretch: style.fontStretch,
        lineHeight: pixels(line),
        letterSpacing: style.letterSpacing,
      };
      const clip = {
        left: pixels(box.x - bounds.x + leftInset),
        top: pixels(box.y - bounds.y),
        width: pixels(textWidth),
        height: pixels(box.height),
        borderRadius: style.borderRadius,
      };
      const next: Model = {
        ...(unchanged && previous.current
          ? { before: previous.current.before, character: previous.current.character, after: previous.current.after, text: content.text }
          : content),
        sequence: unchanged ? (previous.current?.sequence ?? 0) : ++sequence.current,
        clip,
        run,
      };
      if (JSON.stringify(next) !== JSON.stringify(previous.current)) {
        previous.current = next;
        setModel(next);
      }
    },
    [enabled],
  );
  useLayoutEffect(() => {
    const input = root.current?.querySelector('input');
    if (input) sync(input);
  });
  useLayoutEffect(() => {
    const input = root.current?.querySelector('input');
    if (!input || !enabled) return;
    const resize = new ResizeObserver(() => sync(input));
    resize.observe(input);
    const reset = () => queueMicrotask(() => sync(input));
    input.form?.addEventListener('reset', reset);
    return () => {
      resize.disconnect();
      input.form?.removeEventListener('reset', reset);
    };
  }, [enabled, sync]);
  const overlay = model ? (
    <span className="orbis-character-clip" aria-hidden="true" style={model.clip}>
      <span className="orbis-character-run" style={model.run}>
        {model.before}
        {model.character && (
          <span key={model.sequence} className="orbis-character-glyph">
            {model.character}
          </span>
        )}
        {model.after}
      </span>
    </span>
  ) : null;
  return {
    root,
    ready: Boolean(model),
    enter: sync,
    compositionStart: (input: HTMLInputElement) => {
      composing.current = true;
      sync(input);
    },
    compositionEnd: (input: HTMLInputElement) => {
      composing.current = false;
      sync(input);
    },
    overlay,
  };
}

export function CharacterInput({
  onInput,
  onSelect,
  onScroll,
  onCompositionStart,
  onCompositionEnd,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  const motion = useCharacterMotion(true);
  return (
    <div ref={motion.root} className="orbis-input-character-motion" data-character-ready={motion.ready}>
      <input
        {...props}
        onCompositionStart={(event) => {
          onCompositionStart?.(event);
          motion.compositionStart(event.currentTarget);
        }}
        onCompositionEnd={(event) => {
          onCompositionEnd?.(event);
          motion.compositionEnd(event.currentTarget);
        }}
        onInput={(event) => {
          onInput?.(event);
          motion.enter(event.currentTarget, event.nativeEvent);
        }}
        onSelect={(event) => {
          onSelect?.(event);
          motion.enter(event.currentTarget);
        }}
        onScroll={(event) => {
          onScroll?.(event);
          motion.enter(event.currentTarget);
        }}
      />
      {motion.overlay}
    </div>
  );
}
