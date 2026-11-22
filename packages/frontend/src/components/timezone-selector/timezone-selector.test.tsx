import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { TimeZoneSelector } from './timezone-selector';

test.each([undefined, '', 'not-a-zone', 'UTC', 'Asia/Singapore', 'America/New_York'])(
  'renders a selected timezone without changing the setting during render: %s',
  (timeZone) => {
    const changes: string[] = [];
    const html = renderToStaticMarkup(<TimeZoneSelector timeZone={timeZone} onChange={(value) => changes.push(value)} />);
    const trigger = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/)?.[0];
    expect(trigger).toBeDefined();
    expect(trigger).toContain('GMT');
    expect(trigger).not.toContain('TIMEZONE_SELECTOR_PLACEHOLDER');
    expect(changes).toEqual([]);
  },
);
