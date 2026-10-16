import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const runtimeDependencies = ['argon2', 'class-transformer'] as const;

type Package = {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};
type Entry = { path: string; name: string; version: string; link?: string };

const inside = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};
const readPackage = (root: string): Package => {
  const value: Package = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (typeof value.name !== 'string' || typeof value.version !== 'string') throw new Error('Runtime package lacks its name or version');
  return value;
};
const packageRoot = (name: string, from: string, installRoot: string) => {
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error(`Invalid runtime package name: ${name}`);
  for (const lookup of createRequire(join(from, 'package.json')).resolve.paths(name) ?? []) {
    const candidate = join(lookup, name);
    if (existsSync(join(candidate, 'package.json'))) {
      const root = realpathSync(candidate);
      if (!inside(installRoot, root)) continue;
      if (readPackage(root).name !== name) throw new Error(`Runtime package name differs from its resolved dependency: ${name}`);
      return root;
    }
  }
  return null;
};

export function packageRuntimeDependencies(workspace: string, output: string, lockfile: string, names: readonly string[] = runtimeDependencies) {
  const source = realpathSync(workspace);
  const target = resolve(output);
  const installRoot = dirname(realpathSync(lockfile));
  if (!inside(installRoot, source)) throw new Error('Runtime workspace is outside its lockfile installation');
  if (existsSync(target) || inside(source, target) || inside(target, source)) throw new Error('Runtime output must be new and outside its workspace');
  const lockfileSha256 = createHash('sha256').update(readFileSync(lockfile)).digest('hex');
  const roots = names.map((name) => {
    const root = packageRoot(name, source, installRoot);
    if (!root) throw new Error(`Missing installed runtime dependency: ${name}`);
    if (inside(root, target) || inside(target, root)) throw new Error('Runtime output overlaps an installed dependency');
    return { name, root };
  });
  mkdirSync(dirname(target), { recursive: true });
  const stage = mkdtempSync(join(dirname(target), '.orbis-runtime-'));
  const packages: Entry[] = [];
  const copy = (root: string, destination: string, ancestors: Map<string, string>) => {
    const metadata = readPackage(root);
    const path = relative(stage, destination).split(sep).join('/');
    mkdirSync(dirname(destination), { recursive: true });
    const ancestor = ancestors.get(root);
    if (ancestor) {
      const link = relative(dirname(destination), ancestor);
      symlinkSync(link, destination, 'dir');
      packages.push({ path, name: metadata.name, version: metadata.version, link });
      return;
    }
    cpSync(root, destination, {
      recursive: true,
      dereference: true,
      filter: (file) => {
        if (relative(root, file).split(sep)[0] === 'node_modules') return false;
        if (lstatSync(file).isSymbolicLink() && !inside(root, realpathSync(file))) throw new Error('Runtime package contains an escaping symlink');
        return true;
      },
    });
    packages.push({ path, name: metadata.name, version: metadata.version });
    const lineage = new Map(ancestors).set(root, destination);
    const dependencies = { ...metadata.peerDependencies, ...metadata.dependencies, ...metadata.optionalDependencies };
    for (const name of Object.keys(dependencies).sort()) {
      const dependency = packageRoot(name, root, installRoot);
      if (!dependency) {
        if (Object.hasOwn(metadata.optionalDependencies ?? {}, name) || metadata.peerDependenciesMeta?.[name]?.optional) continue;
        throw new Error(`Missing installed runtime dependency: ${metadata.name} → ${name}`);
      }
      copy(dependency, join(destination, 'node_modules', name), lineage);
    }
  };
  try {
    for (const { name, root } of roots) copy(root, join(stage, name), new Map());
    const manifest = { schema: 'orbis.runtime-dependencies.v1', lockfileSha256, packages: packages.sort((a, b) => a.path.localeCompare(b.path)) };
    writeFileSync(join(stage, '.orbis-runtime-dependencies.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    if (existsSync(target)) throw new Error('Runtime output appeared during packaging');
    renameSync(stage, target);
    return manifest;
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.main) {
  const [workspace, output, lockfile] = process.argv.slice(2);
  if (!workspace || !output || !lockfile) throw new Error('Usage: package-runtime-dependencies WORKSPACE OUTPUT LOCKFILE');
  const result = packageRuntimeDependencies(workspace, output, lockfile);
  process.stdout.write(`${JSON.stringify({ lockfileSha256: result.lockfileSha256, packages: result.packages.length })}\n`);
}
