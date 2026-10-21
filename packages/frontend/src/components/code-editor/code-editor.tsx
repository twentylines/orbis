import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { search } from '@codemirror/search';
import { tags } from '@lezer/highlight';
import ReactCodeMirror, { EditorView, type ReactCodeMirrorProps } from '@uiw/react-codemirror';
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { useDesktopPreferences } from '@/desktop/preferences';
import './code-editor.css';

const highlighting = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [tags.comment, tags.meta], color: 'var(--desktop-code-muted)' },
    { tag: [tags.keyword, tags.operatorKeyword], color: 'var(--desktop-code-accent)' },
    { tag: [tags.string, tags.regexp, tags.inserted], color: 'var(--desktop-code-positive)' },
    { tag: [tags.propertyName, tags.attributeName, tags.typeName, tags.tagName], color: 'var(--desktop-code-info)' },
    { tag: [tags.number, tags.bool, tags.null, tags.constant(tags.name)], color: 'var(--desktop-code-warning)' },
    { tag: [tags.invalid, tags.deleted], color: 'var(--desktop-code-negative)' },
    { tag: tags.heading, color: 'var(--desktop-code-accent)', fontWeight: '650' },
    { tag: tags.strong, fontWeight: '700' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.link, color: 'var(--desktop-code-info)', textDecoration: 'underline' },
    { tag: tags.strikethrough, textDecoration: 'line-through' },
  ]),
);

const createTheme = (dark: boolean) => [
  EditorView.theme(
    {
      '&': { backgroundColor: 'var(--desktop-code-background)', color: 'var(--desktop-ink)', fontSize: '1rem' },
      '&.cm-focused': { outline: 'none' },
      '.cm-content': { padding: '12px 0', caretColor: 'var(--desktop-ink)' },
      '.cm-line': { padding: '0 16px' },
      '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', lineHeight: '1.65' },
      '.cm-gutters': {
        backgroundColor: 'var(--desktop-code-gutter)',
        color: 'var(--desktop-code-muted)',
        borderRight: '1px solid var(--desktop-line)',
      },
      '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px' },
      '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--desktop-code-active)' },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--desktop-code-selection)' },
      '.cm-content ::selection': { backgroundColor: 'var(--desktop-code-selection)' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--desktop-ink)' },
      '.cm-selectionMatch, .cm-matchingBracket': { backgroundColor: 'var(--desktop-code-selection)' },
      '.cm-searchMatch': { backgroundColor: 'var(--desktop-code-selection)' },
      '.cm-searchMatch-selected': {
        backgroundColor: 'var(--desktop-code-selection)',
        boxShadow: 'inset 0 -2px var(--desktop-code-accent)',
      },
      '.cm-placeholder': { color: 'var(--desktop-code-muted)' },
      '.cm-tooltip, .cm-panels': {
        backgroundColor: 'var(--desktop-surface)',
        color: 'var(--desktop-ink)',
        borderColor: 'var(--desktop-line)',
      },
      '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--desktop-code-selection)', color: 'var(--desktop-ink)' },
      '.cm-panel.cm-search': {
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '8px',
        padding: '12px',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        fontSize: '1rem',
        lineHeight: '1.5',
      },
      '.cm-panel.cm-search label': {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        minHeight: '40px',
        margin: '0',
        fontSize: 'inherit',
        whiteSpace: 'normal',
      },
      '.cm-textfield, .cm-button, .cm-search [name=close]': {
        minHeight: '40px',
        margin: '0',
        padding: '6px 10px',
        background: 'var(--desktop-code-gutter)',
        color: 'var(--desktop-ink)',
        border: '1px solid var(--desktop-line)',
        borderRadius: '12px',
        font: 'inherit',
      },
      '.cm-search .cm-textfield': { flex: '1 1 12rem', minWidth: '0', width: 'auto' },
      '.cm-search input[type=checkbox]': { width: '16px', height: '16px', margin: '0', accentColor: 'var(--desktop-action)' },
      '.cm-panel.cm-search [name=close]': {
        position: 'static',
        minWidth: '40px',
        minHeight: '40px',
        padding: '6px 10px',
        background: 'var(--desktop-code-gutter)',
        border: '1px solid var(--desktop-line)',
        font: 'inherit',
        marginInlineStart: 'auto',
      },
      '&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine': {
        backgroundColor: 'color-mix(in srgb, var(--desktop-code-positive) 10%, var(--desktop-code-background))',
      },
      '.cm-deletedChunk': { backgroundColor: 'color-mix(in srgb, var(--desktop-code-negative) 10%, var(--desktop-code-background))' },
      '&.cm-merge-b .cm-changedText': { background: 'color-mix(in srgb, var(--desktop-code-positive) 16%, transparent)' },
      '.cm-deletedChunk .cm-deletedText': { background: 'color-mix(in srgb, var(--desktop-code-negative) 16%, transparent)' },
      '.cm-changedLineGutter, .cm-inlineChangedLineGutter': { backgroundColor: 'var(--desktop-code-positive)' },
      '.cm-deletedLineGutter': { backgroundColor: 'var(--desktop-code-negative)' },
      '.cm-collapsedLines': { background: 'var(--desktop-code-gutter)', color: 'var(--desktop-code-muted)' },
    },
    { dark },
  ),
  highlighting,
];

const themes = { light: createTheme(false), dark: createTheme(true) };
const editorSearch = search();
const noExtensions: NonNullable<ReactCodeMirrorProps['extensions']> = [];
type Props = Omit<ReactCodeMirrorProps, 'theme'> & { label: string };

export function CodeEditor({ label, className, readOnly, onChange, extensions = noExtensions, ...props }: Props) {
  const { resolvedMode } = useDesktopPreferences();
  const change = useRef(onChange);
  useLayoutEffect(() => {
    change.current = onChange;
  }, [onChange]);
  const handleChange = useCallback<NonNullable<ReactCodeMirrorProps['onChange']>>((value, update) => change.current?.(value, update), []);
  const labelledExtensions = useMemo(
    () => [editorSearch, EditorView.contentAttributes.of({ 'aria-label': label, 'aria-readonly': String(Boolean(readOnly)) }), ...extensions],
    [extensions, label, readOnly],
  );
  return (
    <ReactCodeMirror
      {...props}
      readOnly={readOnly}
      onChange={onChange ? handleChange : undefined}
      className={['orbis-code-editor', className].filter(Boolean).join(' ')}
      theme={themes[resolvedMode]}
      extensions={labelledExtensions}
    />
  );
}
