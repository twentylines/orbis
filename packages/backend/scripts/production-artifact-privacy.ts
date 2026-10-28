import { homedir } from 'node:os';
import { basename } from 'node:path';

type Artifact = { path: string; arrayBuffer: () => Promise<ArrayBuffer> };

export function hasPrivateBuildPath(content: Uint8Array, privateRoots: readonly string[] = [homedir()]) {
  const prefixes = privateRoots.flatMap((root) => {
    const normalized = root.replace(/[\\/]+$/, '');
    if (!normalized || normalized === '.') throw new Error('Private build path must identify a directory');
    const windows = /^[a-z]:[\\/]/i.test(normalized) || normalized.startsWith('\\\\');
    const paths = windows ? [`${normalized.replace(/\\/g, '/')}/`, `${normalized.replace(/\//g, '\\')}\\`] : [`${normalized}/`];
    return [...new Set(paths.flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]))].map((value) => Buffer.from(value));
  });
  const bytes = Buffer.from(content);
  return prefixes.some((prefix) => bytes.includes(prefix));
}

const canonicalSourcePrefixes = ['../src/', '../../common/dist/'] as const;

const hasControlCharacter = (value: string) =>
  value.split('').some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });

const safePathSuffix = (suffix: string) => {
  if (!suffix || suffix.includes('%') || suffix.includes('?') || suffix.includes('#')) return false;
  return suffix.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
};

const isCanonicalBunDependencySource = (source: string) => {
  const prefix = '../../../node_modules/.bun/';
  if (!source.startsWith(prefix)) return false;

  const suffix = source.slice(prefix.length);
  if (!safePathSuffix(suffix)) return false;

  const [storeEntry, nodeModules, ...packagePath] = suffix.split('/');
  if (!storeEntry || !/^[A-Za-z0-9@+._-]+$/.test(storeEntry) || nodeModules !== 'node_modules') return false;
  if (packagePath.length === 0) return false;
  if (packagePath[0]?.startsWith('@') && packagePath.length < 2) return false;
  return true;
};

const isCanonicalSource = (source: string) => {
  if (!source || hasControlCharacter(source) || source.includes('\\') || source.startsWith('/') || /^[A-Za-z]:/.test(source)) return false;

  if (source.startsWith('bun:')) return /^bun:[A-Za-z][A-Za-z0-9._-]*$/.test(source);
  if (isCanonicalBunDependencySource(source)) return true;

  const prefix = canonicalSourcePrefixes.find((candidate) => source.startsWith(candidate));
  return prefix !== undefined && safePathSuffix(source.slice(prefix.length));
};

const assertCanonicalSourceMap = (path: string, bytes: Uint8Array) => {
  const name = basename(path);
  let map: unknown;
  try {
    map = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new Error(`Production source map is invalid: ${name}`);
  }

  if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error(`Production source map is invalid: ${name}`);
  const sourceMap = map as { sourceRoot?: unknown; sources?: unknown };
  if (sourceMap.sourceRoot !== undefined && sourceMap.sourceRoot !== '')
    throw new Error(`Production source map contains a noncanonical source root: ${name}`);
  if (!Array.isArray(sourceMap.sources) || sourceMap.sources.length === 0 || sourceMap.sources.some((source) => typeof source !== 'string'))
    throw new Error(`Production source map is invalid: ${name}`);
  if (sourceMap.sources.some((source) => !isCanonicalSource(source as string)))
    throw new Error(`Production source map contains a noncanonical source path: ${name}`);
};

export async function assertNoPrivateBuildPaths(artifacts: readonly Artifact[], privateRoots: readonly string[] = [homedir()]) {
  for (const artifact of artifacts) {
    const bytes = Buffer.from(await artifact.arrayBuffer());
    if (hasPrivateBuildPath(bytes, privateRoots)) throw new Error(`Production artifact contains a private build path: ${basename(artifact.path)}`);
    if (artifact.path.toLowerCase().endsWith('.map')) assertCanonicalSourceMap(artifact.path, bytes);
  }
}
