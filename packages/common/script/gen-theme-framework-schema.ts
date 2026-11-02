import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { themeFrameworkJsonSchema } from '../src/schemas/theme-framework-contract.js';

const output = new URL('../json-schemas/theme-framework-v1.json', import.meta.url);
const content = `${JSON.stringify(themeFrameworkJsonSchema(), null, 2)}\n`;
if (process.argv.includes('--check')) {
  if ((await readFile(output, 'utf8')) !== content) throw new Error('Theme framework schema is stale.');
} else {
  await mkdir(fileURLToPath(new URL('../json-schemas/', import.meta.url)), { recursive: true });
  await writeFile(output, content);
}
