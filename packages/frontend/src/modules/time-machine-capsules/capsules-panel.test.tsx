import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CapsuleJob } from '@runtipi/common/schemas/time-machine-capsule';
import { CapsuleTransferList, TimeMachineFileToolbar } from './capsules-panel';

const noAction = () => undefined;
const job: CapsuleJob = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  capsuleId: null,
  kind: 'export',
  status: 'ready',
  createdAt: 1,
  completedBytes: 1024,
  totalBytes: 1024,
  bytes: 1024,
  sha256: 'a'.repeat(64),
  restoreSupported: false,
};

test('selected-point downloads require a sealed exportable format while Import and Files remain available for an empty timeline', () => {
  const render = (selected?: Parameters<typeof TimeMachineFileToolbar>[0]['selected']) =>
    renderToStaticMarkup(
      <TimeMachineFileToolbar selected={selected} disabled={false} onDownload={noAction} onImport={noAction} onFiles={noAction} />,
    );
  for (const selected of [undefined, { status: 'capturing' as const, metadata: null }, { status: 'sealed' as const, metadata: { version: 1 } }]) {
    const html = render(selected);
    expect(html).toContain('Download selected point');
    expect(html.match(/disabled=""/g)).toHaveLength(1);
    expect(html).toContain('>Import</button>');
    expect(html).toContain('>Files</button>');
  }
  for (const version of [2, 3]) expect(render({ status: 'sealed', metadata: { version } })).not.toContain('disabled=""');
});

test('file management keeps orphan exports and imported files without presenting a second timeline', () => {
  const html = renderToStaticMarkup(
    <CapsuleTransferList
      jobs={[job, { ...job, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', kind: 'import', status: 'verified' }]}
      busy={false}
      onAction={noAction}
    />,
  );
  expect(html).toContain('Download file');
  expect(html).toContain('>Download</button>');
  expect(html).toContain('Imported file');
  expect(html).toContain('Verification does not add this file to the timeline. File restoration is unavailable.');
  expect(html.match(/>Remove<\/button>/g)).toHaveLength(2);
  for (const text of ['Saved capture', 'Uploaded capture', '>Restore</button>', '>Browse</button>']) expect(html).not.toContain(text);
});

test('uploaded files retain verification and running jobs retain cancellation instead of a completed download', () => {
  const uploaded = renderToStaticMarkup(
    <CapsuleTransferList jobs={[{ ...job, kind: 'import', status: 'uploaded' }]} busy={false} onAction={noAction} />,
  );
  expect(uploaded).toContain('>Verify</button>');
  expect(uploaded).not.toContain('>Download</button>');
  const active = renderToStaticMarkup(
    <CapsuleTransferList jobs={[{ ...job, status: 'running', completedBytes: 512 }]} busy={false} onAction={noAction} />,
  );
  expect(active).toContain('>Cancel</button>');
  expect(active).not.toContain('>Remove</button>');
  expect(active).not.toContain('Ready to download');
});

test('busy transfers disable their actions and still report their server status', () => {
  const html = renderToStaticMarkup(<CapsuleTransferList jobs={[job]} busy onAction={noAction} />);
  expect(html.match(/disabled=""/g)).toHaveLength(2);
  expect(html).toContain('Ready to download');
});
