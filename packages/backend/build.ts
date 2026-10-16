import { runtimeDependencies } from './scripts/package-runtime-dependencies';

await Bun.build({
  entrypoints: ['./src/main.ts'],
  outdir: './dist',
  format: 'esm',
  target: 'node',
  env: 'disable',
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
