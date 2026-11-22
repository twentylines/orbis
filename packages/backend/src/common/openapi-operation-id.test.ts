import { expect, it } from 'vitest';
import { normalizeOpenApiOperationIds } from './openapi-operation-id';

it('preserves existing client names while separating new generic controller methods', () => {
  const document = {
    paths: {
      '/api/app-lifecycle/start-all': { post: { operationId: 'startAllApps', tags: ['AppLifecycle'], responses: {} } },
      '/api/debug/start-all-apps': { post: { operationId: 'startAllApps', tags: ['Debug'], responses: {} } },
      '/api/app-lifecycle/{urn}/job': { get: { operationId: 'getAppJob', tags: ['AppLifecycle'], responses: {} } },
      '/api/example/one': { get: { operationId: 'options', tags: ['Example'], responses: {} } },
      '/api/other/one': { get: { operationId: 'options', tags: ['Other'], responses: {} } },
    },
  };
  normalizeOpenApiOperationIds(document);
  expect(document.paths['/api/app-lifecycle/start-all'].post.operationId).toBe('startAllApps');
  expect(document.paths['/api/debug/start-all-apps'].post.operationId).toBe('startAllApps2');
  expect(document.paths['/api/app-lifecycle/{urn}/job'].get.operationId).toBe('getAppJob');
  expect(document.paths['/api/example/one'].get.operationId).toBe('exampleOptions');
  expect(document.paths['/api/other/one'].get.operationId).toBe('otherOptions');
  const before = JSON.stringify(document);
  normalizeOpenApiOperationIds(document);
  expect(JSON.stringify(document)).toBe(before);
});
