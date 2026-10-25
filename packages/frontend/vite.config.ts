import path from 'node:path';
import { reactRouter } from '@react-router/dev/vite';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import { defineConfig, type PluginOption } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

const alias = {
  '@': path.resolve(__dirname, './src'),
};
const plugins: PluginOption[] = [reactRouter(), tsconfigPaths()];

const { NODE_ENV } = process.env;
if (NODE_ENV === 'production') {
  // @ts-expect-error
  alias['react-dom/server'] = 'react-dom/server.node';
  plugins.push(
    sentryVitePlugin({
      authToken: process.env.SENTRY_AUTH_TOKEN,
      release: {
        name: process.env.TIPI_VERSION,
      },
      org: 'runtipi',
      project: 'runtipi-frontend',
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
