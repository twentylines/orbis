import clsx from 'clsx';
import type React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';

export const Markdown: React.FC<{ content: string; className: string; tabIndex?: number; label?: string }> = ({
  content,
  className,
  tabIndex,
  label,
}) => {
  const rendered = (
    <ReactMarkdown remarkPlugins={[remarkBreaks, remarkGfm]} rehypePlugins={[rehypeRaw, rehypeSanitize]}>
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
