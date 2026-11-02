import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { themeFrameworkJsonSchema } from '../src/schemas/theme-framework-contract.js';
import { themeFrameworkCatalogueJsonSchema } from '../src/schemas/theme-framework-catalogue.js';

const biome = createRequire(import.meta.url).resolve('@biomejs/biome/bin/biome');
const schemas = [
  ['theme-framework-v1.json', themeFrameworkJsonSchema],
  ['theme-framework-catalogue-v1.json', themeFrameworkCatalogueJsonSchema],
] as const;
for (const [name, schema] of schemas) {
  const output = new URL(`../json-schemas/${name}`, import.meta.url);
  const formatted = spawnSync(process.execPath, [biome, 'format', '--stdin-file-path', fileURLToPath(output)], {
    input: `${JSON.stringify(schema(), null, 2)}\n`,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  });
  if (formatted.error || formatted.status !== 0 || !formatted.stdout) throw new Error(`Theme schema formatting failed: ${name}`);
  if (process.argv.includes('--check')) {
    if ((await readFile(output, 'utf8')) !== formatted.stdout) throw new Error(`Theme schema is stale: ${name}`);
  } else {
    await mkdir(fileURLToPath(new URL('../json-schemas/', import.meta.url)), { recursive: true });
    await writeFile(output, formatted.stdout);
  }
}
