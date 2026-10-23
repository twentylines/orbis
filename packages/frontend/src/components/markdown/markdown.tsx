import clsx from 'clsx';
import type React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import './markdown.css';

const MarkdownTable = ({ children }: { children?: React.ReactNode }) => (
  // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need focus to scroll wide tables with arrow keys.
  <section className="orbis-markdown-table" aria-label="Table" tabIndex={0}>
    <table>{children}</table>
  </section>
);

export const Markdown: React.FC<{ content: string; className: string; tabIndex?: number; label?: string }> = ({
  content,
  className,
  tabIndex,
  label,
}) => {
  const rendered = (
    <ReactMarkdown remarkPlugins={[remarkBreaks, remarkGfm]} rehypePlugins={[rehypeRaw, rehypeSanitize]} components={{ table: MarkdownTable }}>
      {content}
    </ReactMarkdown>
  );
  if (label) {
    return (
      <section className={clsx('markdown', className)} tabIndex={tabIndex} aria-label={label}>
        {rendered}
      </section>
    );
  }
  return <div className={clsx('markdown', className)}>{rendered}</div>;
};
