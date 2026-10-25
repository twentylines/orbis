import { CodeEditor } from '@/components/code-editor/code-editor';
import { yaml } from '@codemirror/lang-yaml';
import { unifiedMergeView } from '@codemirror/merge';
import { useMemo } from 'react';

export function TemplateDiff({ label, original, template }: { label: string; original: string; template: string }) {
  const extensions = useMemo(() => [yaml(), unifiedMergeView({ original, mergeControls: false })], [original]);
  return <CodeEditor label={label} value={template} readOnly height="400px" extensions={extensions} />;
}
