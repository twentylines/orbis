import { runtimeDependencies } from './scripts/package-runtime-dependencies';
import { assertNoPrivateBuildPaths } from './scripts/production-artifact-privacy';
import { productionHealthAssets } from './scripts/production-health-assets';

const healthAssets = await productionHealthAssets('./dist');

const result = await Bun.build({
  entrypoints: ['./src/main.ts', './src/restore-worker.ts'],
  outdir: './dist',
  format: 'esm',
  target: 'node',
  env: 'disable',
  plugins: [healthAssets.plugin],
  banner: healthAssets.banner,
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  sourcemap: true,
  minify: {
    keepNames: true,
    whitespace: true,
    identifiers: true,
    syntax: true,
  },
  external: [
    ...runtimeDependencies,
    'cpu-features',
    '@nestjs/typeorm',
    '@nestjs/mongoose',
    '@nestjs/sequelize',
    '@mikro-orm/core',
    '@fastify/static',
    '@nestjs/microservices',
    '@nestjs/websockets',
  ],
});

if (!result.success) throw new AggregateError(result.logs, 'Production server build failed');
await assertNoPrivateBuildPaths(result.outputs);
const sourceMaps = result.outputs.filter((output) => output.path.endsWith('.map'));
if (sourceMaps.length !== 2) throw new Error('Production server or restore worker source map is missing');
for (const sourceMap of sourceMaps) {
  const { sources } = JSON.parse(await sourceMap.text());
  if (!Array.isArray(sources) || sources.length === 0 || sources.some((source) => typeof source !== 'string'))
    throw new Error('Production server source map is invalid');
  if (sources.some((source: string) => /(?:^|\/)@faker-js\/|(?:^|\/)src\/(?:tests|modules\/debug)(?:\/|$)/.test(source)))
    throw new Error('Production server includes development-only modules');
}
