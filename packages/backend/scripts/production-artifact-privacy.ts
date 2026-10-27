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

export async function assertNoPrivateBuildPaths(artifacts: readonly Artifact[], privateRoots: readonly string[] = [homedir()]) {
  for (const artifact of artifacts) {
    if (hasPrivateBuildPath(Buffer.from(await artifact.arrayBuffer()), privateRoots))
      throw new Error(`Production artifact contains a private build path: ${basename(artifact.path)}`);
  }
}
