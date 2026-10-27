import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Fragment, type ComponentProps } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './Select';

async function controls(markup: string) {
  const selects: Array<Record<string, string | null>> = [];
  const buttons: Array<Record<string, string | null>> = [];
  const options: Array<Record<string, string | null>> = [];
  const attributes = (element: { getAttribute: (name: string) => string | null; hasAttribute: (name: string) => boolean }, names: string[]) =>
    Object.fromEntries(names.map((name) => [name, element.hasAttribute(name) ? (element.getAttribute(name) ?? '') : null]));
  const rewrite = new HTMLRewriter()
    .on('select', {
      element: (element) => {
        selects.push(attributes(element, ['name', 'form', 'required', 'disabled', 'aria-hidden', 'tabindex']));
      },
    })
    .on('button', {
      element: (element) => {
        buttons.push(attributes(element, ['id', 'disabled', 'aria-haspopup', 'aria-labelledby', 'aria-describedby', 'aria-invalid']));
      },
    })
    .on('option', {
      element: (element) => {
        options.push(attributes(element, ['value', 'disabled', 'selected']));
      },
    });
  await rewrite.transform(new Response(markup)).text();
  return { selects, buttons, options };
}

function field(props: ComponentProps<typeof Select> = {}, trigger: ComponentProps<typeof SelectTrigger> = {}) {
  return renderToStaticMarkup(
    <Select {...props}>
      <SelectTrigger label="Display mode" {...trigger}>
        <SelectValue placeholder="Choose a mode" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="automatic">Automatic</SelectItem>
        <Fragment key="nested">
          <SelectItem value="window">
            <span>
              <svg aria-hidden="true" />
              Orbis windows
            </span>
          </SelectItem>
          <SelectItem value="tab" disabled>
            New tabs
          </SelectItem>
        </Fragment>
      </SelectContent>
    </Select>,
  );
}

describe('shared selection field contracts', () => {
  it('keeps a named controlled value available to native form submission', async () => {
    const result = await controls(field({ value: 'window', name: 'opening', form: 'settings' }));
    expect(result.selects).toMatchObject([{ name: 'opening', form: 'settings', 'aria-hidden': 'true', tabindex: '-1' }]);
    expect(result.options.find((option) => option.selected !== null)?.value).toBe('window');
    expect(result.buttons).toHaveLength(1);
    expect(result.buttons[0]?.['aria-haspopup']).toBe('menu');
  });
  it('retains uncontrolled defaults and labels from nested icon options', async () => {
    const markup = field({ defaultValue: 'window', name: 'opening' });
    const result = await controls(markup);
    expect(result.options.find((option) => option.selected !== null)?.value).toBe('window');
    expect(markup).toContain('Orbis windows');
    expect(markup).not.toContain('>window<');
  });
  it('keeps the placeholder empty for required native validation', async () => {
    const result = await controls(field({ required: true, name: 'opening' }));
    expect(result.selects[0]?.required).not.toBeNull();
    expect(result.options.find((option) => option.selected !== null)?.value).toBe('');
    expect(field({ required: true })).toContain('Choose a mode');
  });
  it('disables both interaction and native submission together', async () => {
    const result = await controls(field({ value: 'window', name: 'opening', disabled: true }));
    expect(result.selects[0]?.disabled).not.toBeNull();
    expect(result.buttons[0]?.disabled).not.toBeNull();
    expect(result.options.find((option) => option.value === 'tab')?.disabled).not.toBeNull();
  });
  it('exposes validation text and the current value to assistive technology', async () => {
    const markup = field({ value: 'window' }, { id: 'opening', error: 'Choose an available mode.', 'aria-describedby': 'opening-help' });
    const result = await controls(markup);
    expect(result.buttons[0]).toMatchObject({
      'aria-labelledby': 'opening-label',
      'aria-describedby': 'opening-help opening-value opening-error',
      'aria-invalid': 'true',
    });
    expect(markup).toContain('invalid-feedback d-block');
    expect(markup).toContain('Choose an available mode.');
  });
  it('does not add an unnamed hidden field to filter menus', async () => {
    expect((await controls(field({ value: 'automatic' }))).selects).toHaveLength(0);
  });
  it('gives an unlabelled filter button an explicit name from its displayed value', async () => {
    const result = await controls(field({ value: 'window' }, { id: 'filter', label: undefined }));
    expect(result.buttons[0]?.['aria-labelledby']).toBe('filter-value');
  });
});
