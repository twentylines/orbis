import path from 'node:path';
import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

const alias = {
  '@': path.resolve(__dirname, './src'),
};
if (process.env.NODE_ENV === 'production') {
  // @ts-expect-error
  alias['react-dom/server'] = 'react-dom/server.node';
}

// https://vitejs.dev/config/
export default defineConfig(({ isSsrBuild }) => ({
  plugins: [reactRouter(), tsconfigPaths()],
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
