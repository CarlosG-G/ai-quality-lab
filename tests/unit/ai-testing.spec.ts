import { expect, test } from '@playwright/test';
import {
  generateTestPlan,
  parseFailureReport,
  parseUserStory,
  triageFailure,
  validateFailureTriage,
  validateTestPlan,
  type StructuredGenerator,
  type UserStory,
} from '../../evals/ai-testing.ts';

const story: UserStory = {
  id: 'discount-code',
  title: 'Apply a discount code',
  asA: 'shopper',
  iWant: 'to apply a valid code',
  soThat: 'I can save money',
  acceptanceCriteria: [
    'A valid code reduces the eligible subtotal.',
    'An invalid code leaves the subtotal unchanged and shows a message.',
  ],
};

const generatedCases = {
  cases: [
    {
      criterionIndex: 0,
      type: 'positive',
      title: 'Apply a valid code',
      given: 'The cart has an eligible subtotal and an active code exists.',
      when: 'The shopper applies the code.',
      then: 'The eligible subtotal is reduced.',
    },
    {
      criterionIndex: 1,
      type: 'negative',
      title: 'Reject an invalid code',
      given: 'The shopper has an eligible cart.',
      when: 'The shopper applies an invalid code.',
      then: 'The subtotal is unchanged and an actionable message appears.',
    },
  ],
};

const failureReport = parseFailureReport({
  id: 'checkout-1',
  testTitle: 'applies a valid discount code once',
  expected: 'Subtotal is reduced by 10 EUR.',
  actual: 'Subtotal is reduced by 20 EUR.',
  error: 'Expected 90, received 80.',
  environment: 'CI, Node.js 24',
  evidence: [{ id: 'assertion', text: 'Expected 90, received 80.' }],
});

test('parses valid user story inputs', () => {
  expect(parseUserStory(story)).toEqual(story);
});

test('rejects a test plan that does not cover every acceptance criterion', () => {
  expect(() => validateTestPlan({
    cases: [generatedCases.cases[0], { ...generatedCases.cases[0], title: 'Duplicate criterion coverage' }],
  }, story))
    .toThrow('does not cover acceptance criteria');
});

test('rejects a generated case that references a missing criterion', () => {
  expect(() => validateTestPlan({
    cases: [{ ...generatedCases.cases[0], criterionIndex: 2 }, generatedCases.cases[1]],
  }, story)).toThrow('must reference an acceptance criterion');
});

test('generates a validated test plan and reports provider metadata', async () => {
  const generator: StructuredGenerator = {
    generate: async () => ({
      text: JSON.stringify(generatedCases),
      provider: 'gemini',
      model: 'test-model',
    }),
  };

  const response = await generateTestPlan(story, generator);

  expect(response).toMatchObject({
    provider: 'gemini',
    model: 'test-model',
    result: { cases: generatedCases.cases },
  });
});

test('rejects malformed model JSON instead of returning a success-shaped fallback', async () => {
  const generator: StructuredGenerator = {
    generate: async () => ({ text: '{not json}', provider: 'copilot', model: 'fusion' }),
  };

  await expect(generateTestPlan(story, generator)).rejects.toThrow('response was not valid JSON');
});

test('parses failure reports and keeps evidence identifiers unique', () => {
  expect(failureReport.evidence).toEqual([{ id: 'assertion', text: 'Expected 90, received 80.' }]);
  expect(() => parseFailureReport({
    id: 'duplicate-evidence',
    testTitle: 'test',
    expected: 'expected',
    actual: 'actual',
    error: 'error',
    environment: 'CI',
    evidence: [{ id: 'same', text: 'first' }, { id: 'same', text: 'second' }],
  })).toThrow('evidence IDs must be unique');
});

test('rejects triage evidence that is not present in the failure report', () => {
  expect(() => validateFailureTriage({
    category: 'product_bug',
    confidence: 0.9,
    summary: 'The total is doubled.',
    evidenceIds: ['missing'],
    nextAction: 'Inspect the discount calculation.',
  }, failureReport)).toThrow('referenced an evidence ID not present');
});

test('requires evidence for conclusive failure categories', () => {
  expect(() => validateFailureTriage({
    category: 'environment',
    confidence: 0.8,
    summary: 'The browser process failed.',
    evidenceIds: [],
    nextAction: 'Inspect the runner setup.',
  }, failureReport)).toThrow('must cite at least one evidence ID');
});

test('triages a failure with bounded confidence and cited evidence', async () => {
  const generator: StructuredGenerator = {
    generate: async () => ({
      text: JSON.stringify({
        category: 'product_bug',
        confidence: 0.91,
        summary: 'The applied discount amount exceeds the expected amount.',
        evidenceIds: ['assertion'],
        nextAction: 'Inspect the calculation that derives the discount amount.',
      }),
      provider: 'gemini',
      model: 'test-model',
    }),
  };

  const response = await triageFailure(failureReport, generator);

  expect(response.result.category).toBe('product_bug');
  expect(response.result.evidenceIds).toEqual(['assertion']);
  expect(response.result.confidence).toBe(0.91);
});
