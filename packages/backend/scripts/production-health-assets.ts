import { readFile, mkdir, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { BunPlugin } from 'bun';

export async function productionHealthAssets(outdir: string) {
  const require = createRequire(import.meta.url);
  const root = path.dirname(require.resolve('@nestjs/terminus/package.json'));
  const module = path.join(root, 'dist/health-indicator/microservice/grpc.health.js');
  const source = await readFile(module, 'utf8');
  if (!source.startsWith('"use strict";') || !source.includes("(0, path_1.join)(__dirname, './protos/health.proto')"))
    throw new Error('The installed health protocol module requires an asset-layout review');
  const target = path.join(outdir, 'assets', 'health');
  await mkdir(path.join(target, 'protos'), { recursive: true });
  await Promise.all([
    copyFile(path.join(root, 'dist/health-indicator/microservice/protos/health.proto'), path.join(target, 'protos/health.proto')),
    copyFile(path.join(root, 'LICENSE'), path.join(target, 'LICENSE')),
  ]);
  const plugin: BunPlugin = {
    name: 'portable-health-assets',
    setup(build) {
      build.onLoad({ filter: /[/\\]grpc\.health\.js$/ }, (args) => {
        if (args.path !== module) return;
        return {
          loader: 'js',
          contents: source.replace('"use strict";', '"use strict";\nvar __dirname = __orbis_health_assets;'),
        };
      });
    },
  };
  const banner =
    'import { fileURLToPath as __orbis_file_path } from "node:url";\nconst __orbis_health_assets = __orbis_file_path(new URL("./assets/health/", import.meta.url));';
  return { plugin, banner };
}
