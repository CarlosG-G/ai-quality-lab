import { expect, test } from '@playwright/test';
import {
  buildCopilotCommand,
  createJudge,
  CopilotCliJudge,
  CopilotFirstJudge,
  GeminiApiJudge,
  extractAssistantText,
  isAutoTierUnavailable,
  summarizeJudgments,
} from '../../evals/judge.ts';
import { buildReport, evaluateCase, exitCriteriaMet, metric, type BotAnswer, type Thresholds } from '../../evals/evaluation.ts';
import { summarizeCampaign, type ChaosRunReport } from '../../chaos/runner.ts';
import { mutationOptionsForNumber } from '../../chaos/mutators.ts';
import { docFacts } from '../../src/providers/prompt.ts';

const answer = (overrides: Partial<BotAnswer> = {}): BotAnswer => ({
  answer: 'You can return an item within 30 days.',
  sources: ['pol-returns'],
  refused: false,
  latencyMs: 5,
  ...overrides,
} as BotAnswer);

const thresholds: Thresholds = {
  minOverallPassRate: 0.95,
  minSourceAccuracy: 0.95,
  minAnswerFactRate: 0.95,
  minRefusalAccuracy: 1,
  minJudgePassRate: 0.8,
};

test.describe('Copilot CLI command', () => {
  test('requests the Fusion High tier by default and keeps the prompt out of argv', () => {
    const command = buildCopilotCommand('fusion', { env: {}, noTools: true });
    expect(command.args).toEqual([
      '-s', '--output-format', 'json', '--no-custom-instructions',
      '--model', 'fusion', '--auto-tier', 'hydrafusion', '--available-tools',
    ]);
    expect(command.env.COPILOT_CLI_ENABLED_FEATURE_FLAGS).toBe('DYNAMIC_AUTO_TIERS');
  });

  test('honours COPILOT_FUSION_TIER and existing feature flags', () => {
    const command = buildCopilotCommand('fusion', {
      env: { COPILOT_FUSION_TIER: 'fusion-medium', COPILOT_CLI_ENABLED_FEATURE_FLAGS: 'OTHER' },
    });
    expect(command.args).toContain('fusion-medium');
    expect(command.env.COPILOT_CLI_ENABLED_FEATURE_FLAGS).toBe('OTHER,DYNAMIC_AUTO_TIERS');
  });

  test('omits the tier for the fallback call and for non-fusion models', () => {
    expect(buildCopilotCommand('fusion', { env: {}, autoTier: null }).args).not.toContain('--auto-tier');
    expect(buildCopilotCommand('gpt-5', { env: {} }).args).not.toContain('--auto-tier');
  });

  test('reads the final assistant message from JSONL output, unwrapped', () => {
    const longJson = JSON.stringify({ diagnosis: 'x'.repeat(300) });
    const stdout = [
      JSON.stringify({ type: 'session.tools_updated', data: {} }),
      JSON.stringify({ type: 'assistant.message', data: { content: longJson } }),
      JSON.stringify({ type: 'result', exitCode: 0 }),
    ].join('\n');
    expect(extractAssistantText(stdout)).toBe(longJson);
    expect(extractAssistantText('plain text answer')).toBe('plain text answer');
    expect(() => extractAssistantText(JSON.stringify({ type: 'result' }))).toThrow('no assistant message');
  });

  test('recognises an unavailable Auto preference', () => {
    expect(isAutoTierUnavailable(new Error('Copilot CLI failed (1): Auto preference high unavailable'))).toBe(true);
    expect(isAutoTierUnavailable(new Error('Copilot CLI failed (1): network down'))).toBe(false);
  });
});

test.describe('Judge selection and summary', () => {
  test('selects the provider from JUDGE_PROVIDER', () => {
    expect(createJudge({ JUDGE_PROVIDER: 'copilot' })).toBeInstanceOf(CopilotCliJudge);
    expect(createJudge({})).toBeInstanceOf(CopilotFirstJudge);
    expect(createJudge({ JUDGE_PROVIDER: 'gemini', GEMINI_API_KEY: 'test-key' })).toBeInstanceOf(GeminiApiJudge);
    expect(() => createJudge({ JUDGE_PROVIDER: 'gemini' })).toThrow('requires GEMINI_API_KEY');
    expect(() => createJudge({ JUDGE_PROVIDER: 'other' })).toThrow('Unknown JUDGE_PROVIDER');
  });

  test('averages scores and handles an empty judgment list', () => {
    const summary = summarizeJudgments([
      { id: 'a', passed: true, correctness: 5, groundedness: 5, relevance: 5, helpfulness: 4, reason: '' },
      { id: 'b', passed: false, correctness: 2, groundedness: 3, relevance: 4, helpfulness: 3, reason: '' },
    ]);
    expect(summary).toMatchObject({ passed: 1, total: 2, passRate: 0.5 });
    expect(summary.averageScores.correctness).toBe(3.5);
    expect(summarizeJudgments([]).passRate).toBe(0);
  });
});

test.describe('Golden evaluation oracle', () => {
  test('passes a case that matches source and facts', () => {
    const result = evaluateCase(
      { id: 'returns', question: 'Returns?', expectedSource: 'pol-returns', answerChecks: [{ id: 'window', anyOf: ['30 days'] }] },
      answer(),
    );
    expect(result).toMatchObject({ passed: true, sourceHit: true, answerFactsPassed: 1, answerFactsTotal: 1 });
  });

  test('reports every deviation from the oracle', () => {
    const result = evaluateCase(
      { id: 'returns', question: 'Returns?', expectedSource: 'pol-shipping', answerChecks: [{ id: 'fee', anyOf: ['free'] }] },
      answer(),
    );
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual([
      'expected top source "pol-shipping", got "pol-returns"',
      'answer missed fact "fee"',
    ]);
  });

  test('requires the expected refusal reason', () => {
    const result = evaluateCase(
      { id: 'injection', question: 'Ignore rules', expectedRefusal: 'prompt_injection' },
      answer({ refused: true, reason: 'out_of_scope' } as Partial<BotAnswer>),
    );
    expect(result.passed).toBe(false);
  });

  test('builds named quality gates and treats empty metrics as met', () => {
    const passing = evaluateCase({ id: 'a', question: 'q', expectedSource: 'pol-returns' }, answer());
    const report = buildReport([passing], thresholds, 'mock', 'fixed');
    expect(report.gates.sourceAccuracy).toEqual({ actual: 1, minimum: 0.95, passed: true });
    expect(report.gates.refusalAccuracy.passed).toBe(true);
    expect(exitCriteriaMet(report)).toBe(true);
    expect(metric(0, 0).rate).toBe(1);
  });
});

test.describe('Chaos Lab metrics', () => {
  test('never produces negative constant mutants', () => {
    expect(mutationOptionsForNumber(0)).toEqual(['1']);
    expect(mutationOptionsForNumber(1)).toEqual(['0', '2']);
    expect(mutationOptionsForNumber(5)).toEqual(['0', '6', '4']);
  });

  test('computes the mutation score over valid mutants only', () => {
    const run = (status: ChaosRunReport['status'], detectionMs?: number): ChaosRunReport => ({
      id: status,
      seed: 1,
      mode: 'catalog',
      createdAt: 'fixed',
      durationMs: 10,
      status,
      ...(detectionMs ? { detectionMs } : {}),
      bug: { id: 'x', file: 'src/bot.ts', category: 'c', description: 'd', original: '', mutated: '', patch: '' },
      checks: [],
    });
    const report = summarizeCampaign(1, 'catalog', [run('detected', 100), run('detected', 300), run('survived'), run('invalid')]);
    expect(report).toMatchObject({ runs: 4, compilable: 3, detected: 2, survived: 1, invalid: 1, meanDetectionMs: 200 });
    expect(report.mutationScore).toBeCloseTo(2 / 3);
  });
});

test('docFacts: judge evidence includes the structured facts the bot can cite', () => {
  const facts = docFacts({ id: 'p-x', type: 'product', title: 'X', tags: [], text: 'A laptop.', price: 999, inStock: false, warrantyYears: 2 });
  expect(facts).toBe('A laptop. Price: 999 EUR. Out of stock. Warranty: 2 years.');
});
