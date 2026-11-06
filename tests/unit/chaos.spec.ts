import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript-api';
import { applyCatalogBug, BUG_CATALOG } from '../../chaos/catalog.ts';
import { applyMutation, collectMutations } from '../../chaos/mutators.ts';
import { createSandbox, removeSandbox } from '../../chaos/sandbox.ts';
import { SeededRandom } from '../../chaos/rng.ts';

const repoRoot = resolve(import.meta.dirname, '../..');

test.describe('Chaos Lab foundations', () => {
  test('seeded RNG produces repeatable sequences and bounded indices', () => {
    const first = new SeededRandom(42);
    const second = new SeededRandom(42);
    expect(Array.from({ length: 10 }, () => first.next())).toEqual(
      Array.from({ length: 10 }, () => second.next()),
    );
    expect(new SeededRandom(7).integer(1)).toBe(0);
  });

  test('catalog entries still point to exactly one current source expression', () => {
    for (const bug of BUG_CATALOG) {
      const source = readFileSync(resolve(repoRoot, bug.file), 'utf8');
      expect(source.split(bug.find).length - 1, bug.id).toBe(1);
    }
  });

  test('AST mutations target parseable TypeScript source without writing it', () => {
    const candidates = collectMutations(repoRoot);
    expect(candidates.length).toBeGreaterThan(0);
    const candidate = new SeededRandom(42).pick(candidates);
    expect(new SeededRandom(42).pick(candidates)).toEqual(candidate);
    const { after } = applyMutation(repoRoot, candidate);
    const result = ts.transpileModule(after, {
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.Latest },
    });
    expect(result.diagnostics).toHaveLength(0);
    expect(readFileSync(resolve(repoRoot, candidate.file), 'utf8')).toContain(candidate.original);
  });

  test('catalog injection only changes its isolated sandbox copy', () => {
    const sandbox = createSandbox(repoRoot);
    const original = readFileSync(resolve(repoRoot, BUG_CATALOG[0]!.file), 'utf8');
    try {
      const { after } = applyCatalogBug(sandbox, BUG_CATALOG[0]!);
      expect(after).not.toBe(original);
      expect(readFileSync(resolve(repoRoot, BUG_CATALOG[0]!.file), 'utf8')).toBe(original);
      expect(existsSync(resolve(sandbox, 'node_modules'))).toBe(true);
      expect(() => applyCatalogBug(sandbox, { ...BUG_CATALOG[0]!, file: '../README.md' }))
        .toThrow('must target src/**');
      expect(() => applyCatalogBug(sandbox, { ...BUG_CATALOG[0]!, file: 'src/../README.md' }))
        .toThrow('escaped the sandbox source tree');
    } finally {
      removeSandbox(sandbox);
    }
    expect(existsSync(sandbox)).toBe(false);
  });
});
