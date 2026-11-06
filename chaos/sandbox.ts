import { cpSync, existsSync, lstatSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

const SANDBOX_PREFIX = 'ai-quality-lab-chaos-';
const COPY_PATHS = [
  'chaos',
  'src',
  'tests/unit',
  'evals',
  'package.json',
  'tsconfig.json',
  'playwright.config.ts',
];

function isWithin(parent: string, target: string): boolean {
  const rel = relative(parent, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export function createSandbox(repoRoot: string): string {
  const realRepo = realpathSync(repoRoot);
  const systemTemp = realpathSync(tmpdir());
  const sandbox = mkdtempSync(join(systemTemp, SANDBOX_PREFIX));
  const realSandbox = realpathSync(sandbox);
  if (!isWithin(systemTemp, realSandbox) || realSandbox === realRepo || isWithin(realSandbox, realRepo)) {
    rmSync(sandbox, { recursive: true, force: true });
    throw new Error('Refusing to create a chaos sandbox that overlaps the repository');
  }

  try {
    for (const item of COPY_PATHS) {
      const source = join(realRepo, item);
      if (!existsSync(source)) throw new Error(`Required sandbox input is missing: ${item}`);
      cpSync(source, join(realSandbox, item), { recursive: true, dereference: true });
    }

    const modules = join(realRepo, 'node_modules');
    if (!existsSync(modules)) throw new Error('Install project dependencies before running Chaos Lab');
    symlinkSync(realpathSync(modules), join(realSandbox, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    return realSandbox;
  } catch (error) {
    rmSync(realSandbox, { recursive: true, force: true });
    throw error;
  }
}

export function removeSandbox(sandbox: string): void {
  const systemTemp = realpathSync(tmpdir());
  const target = resolve(sandbox);
  if (!basename(target).startsWith(SANDBOX_PREFIX) || !isWithin(systemTemp, target) || target === systemTemp) {
    throw new Error('Refusing to remove a path that is not an owned Chaos Lab sandbox');
  }
  const metadata = lstatSync(target);
  if (metadata.isSymbolicLink()) throw new Error('Refusing to remove a symbolic-link sandbox');
  rmSync(target, { recursive: true, force: true });
}
