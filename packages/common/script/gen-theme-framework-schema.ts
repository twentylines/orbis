import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { themeFrameworkJsonSchema } from '../src/schemas/theme-framework-contract.js';

const output = new URL('../json-schemas/theme-framework-v1.json', import.meta.url);
const biome = createRequire(import.meta.url).resolve('@biomejs/biome/bin/biome');
const formatted = spawnSync(process.execPath, [biome, 'format', '--stdin-file-path', fileURLToPath(output)], {
  input: `${JSON.stringify(themeFrameworkJsonSchema(), null, 2)}\n`,
  encoding: 'utf8',
  maxBuffer: 2 * 1024 * 1024,
});
if (formatted.error || formatted.status !== 0 || !formatted.stdout) throw new Error('Theme framework schema formatting failed.');
const content = formatted.stdout;
if (process.argv.includes('--check')) {
  if ((await readFile(output, 'utf8')) !== content) throw new Error('Theme framework schema is stale.');
} else {
  await mkdir(fileURLToPath(new URL('../json-schemas/', import.meta.url)), { recursive: true });
  await writeFile(output, content);
}
