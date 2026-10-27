import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { TimeField, useTimeField } from './TimeField';
import type { TimeFormat } from './time-field';

function Example({ value, format = '12h', disabled = false }: { value: string | null; format?: TimeFormat; disabled?: boolean }) {
  const control = useTimeField({ value, format, onChange: () => undefined });
  return <TimeField control={control} label="Update time" id="example-time" name="daily-time" disabled={disabled} describedBy="server-zone" />;
}

test('shared clock has actual editable hour/minute fields, preserved labels and a canonical form value', () => {
  const html = renderToStaticMarkup(<Example value="15:00" />);
  expect(html).toContain('<legend>Update time</legend>');
  expect(html).toContain('id="example-time-hour"');
  expect(html).toContain('id="example-time-minute"');
  expect(html).toContain('aria-label="Update time hour, 1 to 12"');
  expect(html).toContain('aria-label="Update time minute, 00 to 59"');
  expect(html.match(/type="text"/g)).toHaveLength(2);
  expect(html).toContain('aria-label="Update time AM or PM"');
  expect(html).toContain('name="daily-time"');
  expect(html).toContain('value="15:00"');
  expect(html).not.toContain('type="time"');
});

test('24-hour display removes only the AM/PM control, keeping editable fields and format choice', () => {
  const html = renderToStaticMarkup(<Example value="15:00" format="24h" />);
  expect(html).toContain('value="15"');
  expect(html).not.toContain('aria-label="Update time AM or PM"');
  expect(html).toContain('Time format');
  expect(html.match(/type="text"/g)).toHaveLength(2);
});

test('disabled state reaches both editable fields and the shared format and AM/PM controls', () => {
  const html = renderToStaticMarkup(<Example value="09:00" disabled />);
  expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(5);
});

test('an invalid controlled draft cannot be submitted as an old valid hidden value', () => {
  const html = renderToStaticMarkup(<Example value={null} />);
  expect(html).not.toContain('value="03:00"');
  expect(html).toContain('type="hidden" name="daily-time" value=""');
});
