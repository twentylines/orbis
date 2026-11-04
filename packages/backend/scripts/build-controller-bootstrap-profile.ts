import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { assertNoPrivateBuildPaths } from './production-artifact-privacy';

if (Bun.version !== '1.3.0') throw new Error('Build the host probe with pinned Bun 1.3.0.');
const require = createRequire(import.meta.url);
const versions = { yaml: '2.8.2', dotenv: '17.2.3', validator: '13.15.20' };
const licenses: string[] = [];
for (const [name, version] of Object.entries(versions)) {
  const metadata = require.resolve(`${name}/package.json`);
  if (JSON.parse(await fs.readFile(metadata, 'utf8')).version !== version) throw new Error('The reviewed probe dependency changed.');
  let license: string | undefined;
  for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE-MIT']) {
    try {
      license = await fs.readFile(path.join(path.dirname(metadata), file), 'utf8');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (!license || license.includes('*/')) throw new Error('A host probe dependency license is unavailable.');
  licenses.push(`/* ${name} ${version}\n${license.trim()}\n*/`);
}

const result = await Bun.build({
  entrypoints: [path.join(import.meta.dir, 'controller-bootstrap-profile.ts')],
  target: 'node',
  format: 'esm',
  env: 'disable',
  sourcemap: 'none',
  minify: true,
  banner: `${licenses.join('\n')}\n`,
});
if (!result.success || result.outputs.length !== 1) throw new AggregateError(result.logs, 'Host bootstrap probe build failed.');
await assertNoPrivateBuildPaths(result.outputs);
const output = result.outputs[0];
if (!output) throw new Error('Host bootstrap probe output is missing.');
const body = await output.text();
if (Buffer.byteLength(body) > 512 * 1024) throw new Error('Host bootstrap probe exceeds its verified size limit.');
const destination = path.resolve(import.meta.dir, '../../../scripts/orbis-controller-bootstrap-profile.mjs');
if (process.argv.includes('--check')) {
  if ((await fs.readFile(destination, 'utf8')) !== body) throw new Error('The host bootstrap probe must be rebuilt.');
} else await fs.writeFile(destination, body);
