import path from 'node:path';
import swc from 'unplugin-swc';
import viteTsconfigPaths from 'vite-tsconfig-paths';
import { type Plugin, defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite(), viteTsconfigPaths({ projects: [path.join(import.meta.dirname, 'tsconfig.json')] }) as unknown] as Plugin[],
  cacheDir: path.join(process.env.ORBIS_MIGRATION_TEST_ROOT ?? path.join(import.meta.dirname, 'node_modules'), '.vite-engine'),
  test: {
    maxWorkers: 1,
    fileParallelism: false,
    include: ['src/modules/backups/__tests__/app-migration-engine.linux.spec.ts'],
    reporters: ['default'],
  },
});
