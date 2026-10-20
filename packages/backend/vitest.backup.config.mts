import swc from 'unplugin-swc';
import viteTsconfigPaths from 'vite-tsconfig-paths';
import { type Plugin, defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite(), viteTsconfigPaths() as unknown] as Plugin[],
  test: {
    maxWorkers: 1,
    include: ['src/modules/backups/__tests__/*.files.test.ts'],
    reporters: ['default'],
  },
});
