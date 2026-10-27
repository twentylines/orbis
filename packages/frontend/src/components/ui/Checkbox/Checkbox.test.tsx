import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Checkbox } from './Checkbox';

async function input(markup: string) {
  const attributes: Record<string, string> = {};
  await new HTMLRewriter()
    .on('input', {
      element: (element) => {
        for (const [key, value] of element.attributes) attributes[key] = value;
      },
    })
    .transform(new Response(markup))
    .text();
  return attributes;
}

describe('native checkbox form and accessibility contracts', () => {
  it('retains disabled, required and native form submission attributes', async () => {
    const attributes = await input(renderToStaticMarkup(<Checkbox name="readOnly" form="storage" value="yes" checked disabled required />));
    expect(attributes).toMatchObject({ type: 'checkbox', name: 'readOnly', form: 'storage', value: 'yes', checked: '', disabled: '', required: '' });
  });
  it('uses a supplied accessible name without an empty label taking precedence', async () => {
    const attributes = await input(renderToStaticMarkup(<Checkbox aria-label="Read-only mapping 2" aria-describedby="mapping-help" />));
    expect(attributes['aria-label']).toBe('Read-only mapping 2');
    expect(attributes['aria-describedby']).toBe('mapping-help');
    expect(attributes['aria-labelledby']).toBeUndefined();
  });
  it('associates its visible label and supports an explicit labelled-by override', async () => {
    const markup = renderToStaticMarkup(<Checkbox label="Read-only" id="mapping-read-only" />);
    const attributes = await input(markup);
    expect(markup).toContain('for="mapping-read-only"');
    expect(markup).toContain(`id="${attributes['aria-labelledby']}"`);
    expect(markup).toContain('Read-only');
    expect((await input(renderToStaticMarkup(<Checkbox label="Read-only" aria-labelledby="storage-heading" />)))['aria-labelledby']).toBe(
      'storage-heading',
    );
  });
});
