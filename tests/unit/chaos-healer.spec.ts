import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BUG_CATALOG, applyCatalogBug } from '../../chaos/catalog.ts';
import { applyRepairEdits, healSandbox, parseRepairProposal } from '../../chaos/healer.ts';
import type { ChaosCheck, ChaosRunReport } from '../../chaos/runner.ts';
import { createSandbox, removeSandbox } from '../../chaos/sandbox.ts';

const repoRoot = resolve(import.meta.dirname, '../..');

function detectedRun(): ChaosRunReport {
  return {
    id: 'test-run',
    seed: 42,
    mode: 'catalog',
    createdAt: new Date(0).toISOString(),
    durationMs: 1,
    status: 'detected',
    bug: {
      id: 'withheld-from-healer',
      file: 'src/retriever.ts',
      category: 'retrieval',
      description: 'Withheld from the agent.',
      original: 'Withheld from the agent.',
      mutated: 'Withheld from the agent.',
      patch: 'Withheld from the agent.',
    },
    checks: [{ name: 'unit', passed: false, exitCode: 1, output: 'tokenizer test failed' }],
  };
}

const passingChecks: ChaosCheck[] = [
  { name: 'typecheck', passed: true, exitCode: 0, output: '' },
  { name: 'unit', passed: true, exitCode: 0, output: '' },
  { name: 'eval', passed: true, exitCode: 0, output: '' },
];

test.describe('Chaos autoheal safeguards', () => {
  test('parses a structured repair proposal and rejects invalid output', () => {
    const proposal = parseRepairProposal(JSON.stringify({
      diagnosis: 'Normalize accents before removing diacritics.',
      rootCauseFile: 'src/retriever.ts',
      confidence: 0.9,
      edits: [{ file: 'src/retriever.ts', find: '.normalize("NFC")', replace: '.normalize("NFD")' }],
    }));
    expect(proposal.confidence).toBe(0.9);
    expect(() => parseRepairProposal('not json')).toThrow('not valid JSON');
    expect(() => parseRepairProposal(JSON.stringify({
      diagnosis: 'unsafe',
      rootCauseFile: '../README.md',
      confidence: 1,
      edits: [{ file: 'tests/unit/shopbot.spec.ts', find: 'x', replace: 'y' }],
    }))).toThrow('outside the editable source allowlist');
  });

  test('rejects edits outside src and labels a blind, validated repair healed-exact', async () => {
    const sandbox = createSandbox(repoRoot);
    try {
      applyCatalogBug(sandbox, BUG_CATALOG[0]!);
      const before = readFileSync(resolve(sandbox, 'tests/unit/shopbot.spec.ts'), 'utf8');
      expect(() => applyRepairEdits(sandbox, [{
        file: 'tests/unit/shopbot.spec.ts',
        find: 'const retriever',
        replace: 'const broken',
      }])).toThrow('not in the src/** allowlist');
      expect(readFileSync(resolve(sandbox, 'tests/unit/shopbot.spec.ts'), 'utf8')).toBe(before);

      let prompt = '';
      const result = await healSandbox(sandbox, repoRoot, detectedRun(), {
        provider: 'copilot',
        generate: async (repairPrompt) => {
          prompt = repairPrompt;
          return {
            provider: 'fake Copilot',
            model: 'fusion',
            tokens: 0,
            proposal: {
              diagnosis: 'Restore decomposed Unicode normalization before stripping marks.',
              rootCauseFile: 'src/retriever.ts',
              confidence: 0.95,
              edits: [{
                file: 'src/retriever.ts',
                find: ".normalize('NFC')",
                replace: ".normalize('NFD')",
              }],
            },
          };
        },
        validate: () => passingChecks,
      });

      expect(result.status).toBe('healed-exact');
      expect(result.attempts).toBe(1);
      expect(result.patch).toContain(".normalize('NFC')");
      expect(prompt).not.toContain('withheld-from-healer');
      expect(prompt).not.toContain('--- a/');
    } finally {
      removeSandbox(sandbox);
    }
  });

  test('refuses ambiguous search text before changing any source', () => {
    const sandbox = createSandbox(repoRoot);
    try {
      const source = readFileSync(resolve(sandbox, 'src/retriever.ts'), 'utf8');
      expect(() => applyRepairEdits(sandbox, [{
        file: 'src/retriever.ts',
        find: 'return',
        replace: 'throw new Error()',
      }])).toThrow('occurs');
      expect(readFileSync(resolve(sandbox, 'src/retriever.ts'), 'utf8')).toBe(source);
    } finally {
      removeSandbox(sandbox);
    }
  });

  test('does not repeat a failed Copilot CLI request', async () => {
    const sandbox = createSandbox(repoRoot);
    let attempts = 0;
    try {
      const result = await healSandbox(sandbox, repoRoot, detectedRun(), {
        provider: 'copilot',
        generate: async () => {
          attempts++;
          throw new Error('Copilot CLI failed (1): authentication unavailable');
        },
      });

      expect(attempts).toBe(1);
      expect(result.attempts).toBe(1);
      expect(result.failure).toContain('authentication unavailable');
    } finally {
      removeSandbox(sandbox);
    }
  });
});
