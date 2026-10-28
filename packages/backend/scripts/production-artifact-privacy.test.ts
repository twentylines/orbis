import { describe, expect, it } from 'bun:test';
import { assertNoPrivateBuildPaths } from './production-artifact-privacy';

const artifact = (path: string, content: string | Uint8Array) => ({
  path,
  arrayBuffer: async () => Uint8Array.from(typeof content === 'string' ? Buffer.from(content) : content).buffer,
});

describe('production artifact privacy', () => {
  it('rejects a home path in bundled JavaScript without reporting the path', async () => {
    await expect(
      assertNoPrivateBuildPaths([artifact('main.js', 'const directory="/home/operator/project/dependency"')], ['/home/operator']),
    ).rejects.toThrow('Production artifact contains a private build path: main.js');
  });

  it('checks binary artifacts as well as text', async () => {
    const content = Buffer.concat([Buffer.from([0, 255]), Buffer.from('/home/operator/build/source.cc'), Buffer.from([0])]);
    await expect(assertNoPrivateBuildPaths([artifact('binding.node', content)], ['/home/operator'])).rejects.toThrow('binding.node');
  });

  it('checks escaped Windows paths in source maps', async () => {
    await expect(
      assertNoPrivateBuildPaths(
        [artifact('main.js.map', JSON.stringify({ source: 'C:\\Users\\operator\\project\\source.ts' }))],
        ['C:\\Users\\operator'],
      ),
    ).rejects.toThrow('main.js.map');
  });

  it('accepts canonical project, generated common, Bun dependency, and synthetic source paths', async () => {
    const sourceMap = {
      version: 3,
      sources: [
        '../src/main.ts',
        '../../common/dist/schemas/app-launch.js',
        '../../../node_modules/.bun/@nestjs+common@11.1.8+49878eb8929adfee/node_modules/@nestjs/common/index.js',
        'bun:wrap',
      ],
    };
    await expect(assertNoPrivateBuildPaths([artifact('main.js.map', JSON.stringify(sourceMap))], ['/home/operator'])).resolves.toBeUndefined();
  });

  it('rejects relative source paths that escape through an alternate checkout', async () => {
    const sourceMap = {
      version: 3,
      sources: ['../../../../external-checkout/node_modules/.bun/example@1.0.0/node_modules/example/index.js'],
    };
    await expect(assertNoPrivateBuildPaths([artifact('main.js.map', JSON.stringify(sourceMap))], ['/home/operator'])).rejects.toThrow(
      'Production source map contains a noncanonical source path: main.js.map',
    );
  });

  it.each([
    ['suffix traversal', '../src/../../external/main.ts'],
    ['backslashes', '..\\src\\main.ts'],
    ['absolute sources', '/project/packages/backend/src/main.ts'],
    ['control characters', '../src/main.ts\n'],
    ['nonempty source root', '../src/main.ts'],
  ])('rejects unsafe source-map paths or roots (%s)', async (caseName, source) => {
    const sourceMap = caseName === 'nonempty source root' ? { sourceRoot: '../external-checkout', sources: [source] } : { sources: [source] };
    await expect(assertNoPrivateBuildPaths([artifact('restore-worker.js.map', JSON.stringify(sourceMap))], ['/home/operator'])).rejects.toThrow(
      caseName === 'nonempty source root'
        ? 'Production source map contains a noncanonical source root: restore-worker.js.map'
        : 'Production source map contains a noncanonical source path: restore-worker.js.map',
    );
  });

  it('checks every supplied private directory', async () => {
    await expect(
      assertNoPrivateBuildPaths([artifact('main.js', '/private-build/work/source')], ['/home/operator', '/private-build']),
    ).rejects.toThrow();
  });

  it('does not confuse another directory with the private root', async () => {
    await expect(assertNoPrivateBuildPaths([artifact('main.js', '/home/operator-tools/runtime')], ['/home/operator'])).resolves.toBeUndefined();
  });

  it('does not treat an escaped quote after a relative module name as a Windows separator', async () => {
    await expect(
      assertNoPrivateBuildPaths(
        [artifact('main.js.map', JSON.stringify({ sources: ['../src/main.ts'], sourcesContent: ['const Root = require("./root");'] }))],
        ['/root'],
      ),
    ).resolves.toBeUndefined();
  });

  it('accepts portable artifacts and empty files', async () => {
    await expect(
      assertNoPrivateBuildPaths([artifact('main.js', 'import "./binding.node"'), artifact('empty', '')], ['/home/operator']),
    ).resolves.toBeUndefined();
  });
});
