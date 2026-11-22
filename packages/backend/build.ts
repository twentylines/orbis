import path from 'node:path';
import { writeCoreRestoreRuntimeManifest } from './scripts/core-restore-runtime-manifest';
import { runtimeDependencies } from './scripts/package-runtime-dependencies';
import { assertNoPrivateBuildPaths } from './scripts/production-artifact-privacy';
import { productionHealthAssets } from './scripts/production-health-assets';

const healthAssets = await productionHealthAssets('./dist');
const productionExternals = [
  ...runtimeDependencies,
  'cpu-features',
  '@nestjs/typeorm',
  '@nestjs/mongoose',
  '@nestjs/sequelize',
  '@mikro-orm/core',
  '@fastify/static',
  '@nestjs/microservices',
  '@nestjs/websockets',
];

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
  external: productionExternals,
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

// This probe is intentionally built separately without the application banner or imports.
const retainedCapability = await Bun.build({
  entrypoints: ['./src/retained-worker-capability.ts'],
  outdir: './dist',
  format: 'esm',
  target: 'node',
  env: 'disable',
  sourcemap: false,
});
if (!retainedCapability.success) throw new AggregateError(retainedCapability.logs, 'Retained worker capability build failed');
await assertNoPrivateBuildPaths(retainedCapability.outputs);

const captureEntrypoints = [
  './src/core-capture-publication.ts',
  './src/core-capture-seal.ts',
  './src/core-capture-catalog.ts',
  './src/components-capture-catalog.ts',
  './src/core-capture-image-inventory.ts',
  './src/core-portable-worker.ts',
  './src/core-inspection-worker.ts',
  './src/core-source-configuration-worker.ts',
  './src/core-clean-target-worker.ts',
  './src/core-clean-target-bootstrap-worker.ts',
  './src/core-restoration-worker.ts',
  './src/core-live-reconciliation-worker.ts',
];
const capturePublication = await Bun.build({
  entrypoints: captureEntrypoints,
  outdir: './dist',
  format: 'esm',
  splitting: true,
  naming: { entry: '[name].js', chunk: 'core-publication-[hash].mjs' },
  target: 'node',
  env: 'disable',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  plugins: [healthAssets.plugin],
  banner: healthAssets.banner,
  sourcemap: false,
  minify: true,
  external: productionExternals,
});
if (!capturePublication.success) throw new AggregateError(capturePublication.logs, 'Core capture publication verifier build failed');
const captureOutputs = new Set(capturePublication.outputs.map((output) => output.path));
for (const entrypoint of captureEntrypoints) {
  const filename = path.basename(entrypoint).replace(/\.ts$/, '.js');
  if (!captureOutputs.has(path.resolve('dist', filename))) throw new Error(`Core capture worker output is missing: ${filename}`);
}
await assertNoPrivateBuildPaths(capturePublication.outputs);
await writeCoreRestoreRuntimeManifest({
  dist: './dist',
  migrations: './src/core/database/drizzle',
  captureOutputs: capturePublication.outputs.map((output) => output.path),
});

const recoveryAuthentication = await Bun.build({
  entrypoints: ['./src/sentinel-recovery-auth.ts'],
  outdir: './dist',
  naming: { entry: '[name].mjs' },
  format: 'esm',
  target: 'node',
  env: 'disable',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  sourcemap: true,
  minify: true,
  external: productionExternals,
});
if (!recoveryAuthentication.success) throw new AggregateError(recoveryAuthentication.logs, 'Recovery authentication worker build failed');
await assertNoPrivateBuildPaths(recoveryAuthentication.outputs);

const recoverySource = await Bun.build({
  entrypoints: ['./src/sentinel-recovery-source.ts'],
  outdir: './dist',
  naming: { entry: '[name].mjs' },
  format: 'esm',
  target: 'node',
  env: 'disable',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  sourcemap: true,
  minify: true,
  external: productionExternals,
});
if (!recoverySource.success) throw new AggregateError(recoverySource.logs, 'Recovery source exporter build failed');
await assertNoPrivateBuildPaths(recoverySource.outputs);
