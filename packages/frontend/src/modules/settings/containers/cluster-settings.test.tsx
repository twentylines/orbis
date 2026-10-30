import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Dialog, retainDialogChildren } from '@/components/ui/Dialog/Dialog';
import type { ReactNode } from 'react';
import { clusterInvitationContents, ClusterPairingCertificate } from './cluster-settings';
const props = {
  mode: 'peer' as const,
  https: true,
  busy: false,
  certificate: { pem: 'PUBLIC-PEM-NEVER-RENDER', sha256: 'a'.repeat(64), confirmed: false },
  fileName: 'peer.crt',
  confirmed: false,
  onMode: () => {},
  onFile: () => {},
  onConfirm: () => {},
};
test('certificate review renders unconfirmed fingerprint and shared Orbis controls without PEM', () => {
  const markup = renderToStaticMarkup(<ClusterPairingCertificate {...props} />);
  expect(markup).toContain('Other server');
  expect(markup).toContain('AA:AA:AA:AA');
  expect(markup).toContain('compare');
  expect(markup).toContain('type="checkbox"');
  expect(markup).not.toContain(' checked=""');
  expect(markup).not.toContain('PUBLIC-PEM-NEVER-RENDER');
  expect(markup).not.toContain('<select');
});
test('normal trust renders no hidden certificate upload or approval control', () => {
  const markup = renderToStaticMarkup(<ClusterPairingCertificate {...props} mode="system" />);
  expect(markup).not.toContain('type="file"');
  expect(markup).not.toContain('type="checkbox"');
  expect(markup).not.toContain('AA:AA:AA');
});
test('HTTP and pending pairing cannot upload or approve a certificate', async () => {
  for (const state of [
    { https: false, busy: false },
    { https: true, busy: true },
  ]) {
    const markup = renderToStaticMarkup(<ClusterPairingCertificate {...props} {...state} />);
    const disabled: boolean[] = [];
    await new HTMLRewriter()
      .on('input', {
        element: (element) => {
          disabled.push(element.hasAttribute('disabled'));
        },
      })
      .transform(new Response(markup))
      .text();
    expect(disabled).toEqual([true, true]);
    expect(markup).not.toContain('<select');
  }
});

test('basic invitation confirmation has no password or MFA fields and explains where access is approved', () => {
  const markup = renderToStaticMarkup(
    <Dialog open>{clusterInvitationContents({ busy: false, error: '', onClose: () => {}, onGenerate: () => {} })}</Dialog>,
  );
  expect(markup).toContain('Creating a code gives it no access.');
  expect(markup).toContain('five minutes');
  expect(markup).toContain('confirm this server’s account');
  expect(markup).toContain('>Cancel</button>');
  expect(markup).toContain('>Generate code</button>');
  expect(markup).not.toContain('<input');
  expect(markup).not.toContain('type="password"');
  expect(markup).not.toContain('one-time-code');
});

test('Cancel retains the populated invitation dialog and its error throughout the shared exit', () => {
  const snapshot = { current: null as ReactNode };
  const contents = clusterInvitationContents({ busy: false, error: 'Code could not be created.', onClose: () => {}, onGenerate: () => {} });
  retainDialogChildren(snapshot, true, contents);
  const closing = retainDialogChildren(snapshot, false, null);
  const markup = renderToStaticMarkup(<Dialog open={false}>{closing}</Dialog>);
  expect(markup).toContain('five minutes');
  expect(markup).toContain('Code could not be created.');
  expect(markup).toContain('>Cancel</button>');
  const busy = renderToStaticMarkup(
    <Dialog open>{clusterInvitationContents({ busy: true, error: '', onClose: () => {}, onGenerate: () => {} })}</Dialog>,
  );
  expect(busy.match(/disabled=""/g)).toHaveLength(2);
  expect(busy).toContain('aria-busy="true"');
});
