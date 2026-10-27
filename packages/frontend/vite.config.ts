import path from 'node:path';
import { reactRouter } from '@react-router/dev/vite';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import { defineConfig, type PluginOption } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

const alias = {
  '@': path.resolve(__dirname, './src'),
};
const plugins: PluginOption[] = [reactRouter(), tsconfigPaths()];

const { NODE_ENV, SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT } = process.env;
if (NODE_ENV === 'production') {
  // @ts-expect-error
  alias['react-dom/server'] = 'react-dom/server.node';
  if (SENTRY_AUTH_TOKEN && SENTRY_ORG && SENTRY_PROJECT)
    plugins.push(
      sentryVitePlugin({
        authToken: SENTRY_AUTH_TOKEN,
        telemetry: false,
        release: {
          name: process.env.TIPI_VERSION,
        },
        org: SENTRY_ORG,
        project: SENTRY_PROJECT,
      }) as PluginOption,
    );
}

// https://vitejs.dev/config/
export default defineConfig(({ isSsrBuild }) => ({
  plugins,
  resolve: {
    alias,
  },
  server: {
    host: '127.0.0.1',
    port: 8080,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
    allowedHosts: true,
  },
  build: {
    sourcemap: false,
    rollupOptions: isSsrBuild
      ? undefined
      : {
          output: {
            // Keep configuration ahead of schema modules instead of merging it into the root chunk.
            manualChunks: (id) => (id === path.resolve(__dirname, './src/lib/validation-runtime.ts') ? 'validation-runtime' : undefined),
          },
        },
  },
}));
