import swc from 'unplugin-swc';
import viteTsconfigPaths from 'vite-tsconfig-paths';
import { type Plugin, defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite(), viteTsconfigPaths() as unknown] as Plugin[],
  test: {
    // Each worker boots Nest; cap parallel copies on small development hosts.
    maxWorkers: 2,
    setupFiles: ['./src/tests/vite.setup.ts'],
    include: ['src/**/*.test.ts'],
    exclude: [
      '**/integration/**',
      '**/core/local-tls/__tests__/*.files.test.ts',
      '**/common/helpers/__tests__/permissions-helpers.files.test.ts',
      '**/common/helpers/__tests__/spawn-processes.files.test.ts',
      '**/apps/__tests__/app-data-permissions.files.test.ts',
      '**/apps/__tests__/app-migrations.files.test.ts',
      '**/app-stores/__tests__/*.files.test.ts',
      '**/.internal/**',
      '**/auth/*.files.test.ts',
      '**/auth/__tests__/passkey.controller.test.ts',
      '**/auth/__tests__/passkey.service.test.ts',
      '**/backups/__tests__/*.files.test.ts',
      '**/system-backups/*.files.test.ts',
      '**/system-reset/*.files.test.ts',
      '**/time-machine-capsules/*.files.test.ts',
      '**/system/sentinel.service.files.test.ts',
      '**/sentinel-recovery/*.files.test.ts',
      '**/host-updates/*.files.test.ts',
      '**/system-backups/time-machine-core-recovery.test.ts',
    ],
    coverage: { reporter: ['lcov', 'text-summary'] },
    reporters: ['default'],
    env: {
      NODE_OPTIONS: '--experimental-sqlite',
    },
  },
  resolve: {},
});
