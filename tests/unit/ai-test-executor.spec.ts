import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { executeGeneratedTestPlan } from '../../evals/ai-test-executor.ts';
import { parseUserStory } from '../../evals/ai-testing.ts';

const storyInput: unknown = JSON.parse(readFileSync(
  new URL('../../examples/shopbot-user-story.json', import.meta.url),
  'utf8',
));
const plan: unknown = JSON.parse(readFileSync(
  new URL('../../examples/shopbot-test-plan.json', import.meta.url),
  'utf8',
));
const story = parseUserStory(storyInput);

test('requires explicit approval before executing generated cases', async () => {
  await expect(executeGeneratedTestPlan(story, plan, { approved: false }))
    .rejects.toThrow('pass --approve before execution');
});

test('requires a supported execution profile', async () => {
  const genericStory = parseUserStory({ ...story, executionProfile: undefined });
  await expect(executeGeneratedTestPlan(genericStory, plan, { approved: true }))
    .rejects.toThrow('executionProfile "shopbot"');
});

test('runs allowlisted cases offline and reports criterion coverage and evidence', async () => {
  const report = await executeGeneratedTestPlan(story, plan, { approved: true });

  expect(report).toMatchObject({
    storyId: 'shopbot-catalog-and-guardrails',
    executionProfile: 'shopbot',
    approved: true,
    status: 'passed',
    summary: {
      totalCases: 3,
      passedCases: 3,
      failedCases: 0,
      totalCriteria: 3,
      executedCriteria: 3,
      passedCriteria: 3,
      criteriaCoveragePercent: 100,
    },
  });
  expect(report.cases[0]).toMatchObject({
    scenarioId: 'catalog.aero14-price',
    status: 'passed',
    checks: [
      { kind: 'answer_contains', expected: '999 EUR', passed: true },
      { kind: 'source_includes', expected: 'p-aero14', passed: true },
    ],
    actual: { sources: expect.arrayContaining(['p-aero14']), refused: false },
  });
  expect(report.cases.slice(1).map((testCase) => testCase.actual.reason))
    .toEqual(['out_of_scope', 'prompt_injection']);
});
