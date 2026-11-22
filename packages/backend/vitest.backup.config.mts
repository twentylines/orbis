import swc from 'unplugin-swc';
import viteTsconfigPaths from 'vite-tsconfig-paths';
import { type Plugin, defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite(), viteTsconfigPaths() as unknown] as Plugin[],
  test: {
    maxWorkers: 1,
    include: [
      'src/core/local-tls/__tests__/*.files.test.ts',
      'src/common/helpers/__tests__/permissions-helpers.files.test.ts',
      'src/common/helpers/__tests__/spawn-processes.files.test.ts',
      'src/modules/apps/__tests__/app-data-permissions.files.test.ts',
      'src/modules/apps/__tests__/app-migrations.files.test.ts',
      'src/modules/app-stores/__tests__/*.files.test.ts',
      'src/modules/auth/*.files.test.ts',
      'src/modules/auth/__tests__/passkey.controller.test.ts',
      'src/modules/auth/__tests__/passkey.service.test.ts',
      'src/modules/backups/__tests__/*.files.test.ts',
      'src/modules/system-backups/*.files.test.ts',
      'src/modules/system-reset/*.files.test.ts',
      'src/modules/time-machine-capsules/*.files.test.ts',
      'src/modules/system/sentinel.service.files.test.ts',
      'src/modules/sentinel-recovery/*.files.test.ts',
      'src/modules/host-updates/*.files.test.ts',
      'src/modules/system-backups/time-machine-core-recovery.test.ts',
    ],
    reporters: ['default'],
  },
});
