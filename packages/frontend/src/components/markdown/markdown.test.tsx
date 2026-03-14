import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from './markdown';

describe('Markdown', () => {
  it('renders raw html as text instead of live elements', () => {
    const html = renderToStaticMarkup(<Markdown content={'Before <button>Click me</button> After'} className="markdown" />);

    expect(html).not.toContain('<button>Click me</button>');
    expect(html).toContain('&lt;button&gt;Click me&lt;/button&gt;');
  });
});
