import { expect } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';

const firstPath = './cluster.tsx?refresh-one';
const secondPath = './cluster.tsx?refresh-two';
const first = await import(firstPath);
const second = await import(secondPath);
expect(first.ClusterProvider).not.toBe(second.ClusterProvider);
function Consumer() {
  const cluster = second.useCluster();
  return <output>{cluster.selectedId || 'local'}</output>;
}
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const rendered = renderToStaticMarkup(
  <QueryClientProvider client={client}>
    <MemoryRouter>
      <first.ClusterProvider>
        <Consumer />
      </first.ClusterProvider>
    </MemoryRouter>
  </QueryClientProvider>,
);
expect(rendered).toContain('<output>local</output>');
expect(() => renderToStaticMarkup(<Consumer />)).toThrow('ClusterProvider is missing');
process.stdout.write(JSON.stringify({ separateModuleVersions: true, providerShared: true, missingProviderStillThrows: true }));
