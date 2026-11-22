import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import type { AppUrn } from '@runtipi/common/types';
import { stringify } from 'yaml';
import { translateUmbrelApp, UMBREL_ASSET_LIMIT, UMBREL_TEXT_LIMIT } from './umbrel-catalog';

// Repository definitions are data. Only regular, bounded files enter an installed package.
export async function readUmbrelFile(file: string, limit: number): Promise<Buffer> {
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('Umbrel package file exceeds its limit or is not a regular file.');
    const buffer = Buffer.alloc(Math.max(0, limit) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const result = buffer.subarray(0, length);
    if (result.length > limit) throw new Error('Umbrel package file exceeds its size limit.');
    return result;
  } finally {
    await handle.close();
  }
}

export async function loadUmbrelPackage(
  directory: string,
  urn: AppUrn,
  previous?: { catalog_revision?: string; tipi_version?: number },
  official = false,
) {
  if (!(await fs.promises.lstat(directory)).isDirectory()) throw new Error('Invalid Umbrel application directory.');
  const manifest = (await readUmbrelFile(path.join(directory, 'umbrel-app.yml'), UMBREL_TEXT_LIMIT)).toString('utf8');
  const compose = (await readUmbrelFile(path.join(directory, 'docker-compose.yml'), UMBREL_TEXT_LIMIT)).toString('utf8');
  const assets = new Map<string, Buffer>();
  const issues: string[] = [];
  const digest = crypto.createHash('sha256');
  let total = 0;
  let entries = 0;
  const walk = async (relative: string, depth: number) => {
    if (depth > 20) throw new Error('Umbrel package directory nesting exceeds its limit.');
    const names = (await fs.promises.readdir(path.join(directory, relative))).sort();
    for (const name of names) {
      if (++entries > 2000) throw new Error('Umbrel package has too many files.');
      if (/[\0\r\n]/.test(name)) throw new Error('Invalid Umbrel package filename.');
      const rel = path.join(relative, name);
      const absolute = path.join(directory, rel);
      const stat = await fs.promises.lstat(absolute);
      if (stat.isDirectory()) await walk(rel, depth + 1);
      else if (stat.isFile()) {
        if (name.endsWith('.template')) throw new Error('Umbrel data templates require platform integration.');
        const data = await readUmbrelFile(absolute, Math.min(4 * 1024 * 1024, UMBREL_ASSET_LIMIT - total));
        total += data.length;
        digest.update(rel).update('\0').update(data).update('\0');
        assets.set(rel, data);
      } else throw new Error('Umbrel package contains symbolic links or special files.');
    }
  };
  try {
    const top = await fs.promises.readdir(directory);
    if (top.some((name) => name === 'exports.sh' || name === 'hooks' || name.endsWith('.sh')))
      issues.push('Umbrel lifecycle hooks or dependency exports require platform integration.');
    if (top.includes('data')) {
      if (!(await fs.promises.lstat(path.join(directory, 'data'))).isDirectory()) throw new Error('Invalid Umbrel data directory.');
      await walk('data', 0);
    }
    for (const icon of ['icon.svg', 'icon.png', 'icon.jpg'])
      if (top.includes(icon)) {
        const bytes = await readUmbrelFile(path.join(directory, icon), 1024 * 1024);
        digest.update(icon).update('\0').update(bytes);
        assets.set(icon, bytes);
      }
  } catch (error) {
    issues.push(error instanceof Error ? error.message : 'Invalid Umbrel package assets.');
  }
  const translated = translateUmbrelApp({ manifest, compose, urn, revision: digest.digest('hex'), previous, packageIssues: issues });
  // Relative gallery names belong to the official asset repository only for the official catalog.
  if (!official)
    translated.info.gallery = translated.info.gallery?.filter(
      (item) => !item.startsWith('https://raw.githubusercontent.com/getumbrel/umbrel-apps-gallery/'),
    );
  return { ...translated, assets };
}

export async function materializeUmbrelPackage(target: string, app: Awaited<ReturnType<typeof loadUmbrelPackage>>) {
  if (!app.info.available || !app.compose) throw new Error(app.info.compatibility?.reasons.join(' ') || 'Unsupported Umbrel application.');
  await fs.promises.mkdir(path.join(target, 'metadata'), { recursive: true });
  await fs.promises.writeFile(path.join(target, 'config.json'), `${JSON.stringify(app.info, null, 2)}\n`);
  await fs.promises.writeFile(path.join(target, 'docker-compose.yml'), stringify(app.compose));
  await fs.promises.writeFile(path.join(target, 'metadata', 'description.md'), app.info.description);
  for (const [relative, bytes] of app.assets) {
    const destination = path.join(target, relative.startsWith('icon.') ? path.join('metadata', relative) : relative);
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await fs.promises.writeFile(destination, bytes);
  }
}
