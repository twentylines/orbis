import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ResetAccountChoices } from './system-reset';
test('account choice asks the end user and neither security option is preselected', () => {
  const html = renderToStaticMarkup(<ResetAccountChoices value={null} onChange={() => undefined} />);
  expect(html).toContain('Keep accounts');
  expect(html).toContain('Remove accounts');
  expect(html.match(/type="radio"/g)).toHaveLength(2);
  expect(html).not.toContain('checked=""');
  expect(html).toContain('passwords, passkeys and two-factor authentication');
});
