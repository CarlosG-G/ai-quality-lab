import { expect, test } from '@playwright/test';
import {
  CopilotCliJudge,
  CopilotFirstJudge,
  GeminiApiJudge,
  parseJudgeResponse,
  type JudgeClient,
  type JudgeItem,
} from '../../evals/judge.ts';

const item: JudgeItem = {
  id: 'returns-window',
  question: 'How long do I have to return an item?',
  answer: 'You can return an item within 30 days for a full refund.',
  expectedSource: 'pol-returns',
  actualSources: ['pol-returns'],
  evidence: [{ id: 'pol-returns', title: 'Returns', text: 'Returns are accepted within 30 days for a full refund.' }],
  expectedFacts: [{ id: 'return-window', anyOf: ['30 days'] }],
};

const judgment = {
  id: 'returns-window',
  correctness: 5,
  groundedness: 5,
  relevance: 5,
  helpfulness: 4,
  reason: 'The answer matches the return policy and is supported by the source.',
};

test.describe('LLM judge response validation', () => {
  test('parses valid JSON and calculates the pass decision locally', () => {
    const result = parseJudgeResponse(JSON.stringify({ judgments: [judgment] }), ['returns-window']);
    expect(result).toEqual([{ ...judgment, passed: true }]);
  });

  test('rejects missing and duplicate case ids', () => {
    expect(() => parseJudgeResponse(JSON.stringify({ judgments: [] }), ['returns-window']))
      .toThrow('case count');
    expect(() => parseJudgeResponse(JSON.stringify({ judgments: [judgment, judgment] }), ['returns-window']))
      .toThrow('case count');
  });

  test('rejects invalid scores and out-of-dataset ids', () => {
    expect(() => parseJudgeResponse(JSON.stringify({ judgments: [{ ...judgment, correctness: 6 }] }), ['returns-window']))
      .toThrow('invalid "correctness" score');
    expect(() => parseJudgeResponse(JSON.stringify({ judgments: [{ ...judgment, id: 'unknown' }] }), ['returns-window']))
      .toThrow('unknown or duplicate');
  });

  test('blocks a low-quality judgment even if the model response is otherwise valid', () => {
    const result = parseJudgeResponse(
      JSON.stringify({ judgments: [{ ...judgment, groundedness: 2 }] }),
      ['returns-window'],
    );
    expect(result[0]?.passed).toBe(false);
  });
});

test.describe('Copilot and Gemini judge providers', () => {
  test('calls Copilot with the selected model and only returns the final answer', async () => {
    let prompt = '';
    let model = '';
    const copilot = new CopilotCliJudge('fusion', async (input, selectedModel) => {
      prompt = input;
      model = selectedModel;
      return `\`\`\`json\n${JSON.stringify({ judgments: [judgment] })}\n\`\`\``;
    });
    const result = await copilot.evaluate([item]);
    expect(result[0]?.id).toBe('returns-window');
    expect(model).toBe('fusion');
    expect(prompt).toContain('"id":"returns-window"');
  });

  test('sends the Gemini key in a header and requests schema-constrained JSON', async () => {
    let endpoint = '';
    let apiKey = '';
    let body: Record<string, any> = {};
    const fakeFetch: typeof fetch = async (url, init) => {
      endpoint = String(url);
      apiKey = new Headers(init?.headers).get('x-goog-api-key') ?? '';
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ judgments: [judgment] }) }] } }],
        usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 40, totalTokenCount: 160 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const judge = new GeminiApiJudge({ apiKeys: ['secret-test-key'], models: ['gemini-test-model'], fetcher: fakeFetch });
    const result = await judge.evaluate([item]);
    expect(result[0]?.id).toBe('returns-window');
    expect(endpoint).toContain('/gemini-test-model:generateContent');
    expect(endpoint).not.toContain('secret-test-key');
    expect(apiKey).toBe('secret-test-key');
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseSchema.properties.judgments).toBeTruthy();
    expect(judge.model).toBe('gemini-test-model');
    expect(judge.usage?.totalTokens).toBe(160);
  });

  test('fails explicitly without the Gemini fallback key', () => {
    expect(() => new GeminiApiJudge({ apiKeys: [''] })).toThrow('GEMINI_API_KEY is required');
  });

  test('falls back to Gemini when Copilot is unavailable and records the provider', async () => {
    const copilot: JudgeClient = {
      provider: 'GitHub Copilot CLI',
      model: 'fusion',
      evaluate: async () => { throw new Error('not authenticated'); },
    };
    const gemini: JudgeClient = {
      provider: 'Gemini API',
      model: 'gemini-3.8-flash',
      evaluate: async () => [{ ...judgment, passed: true }],
    };
    const messages: string[] = [];
    const judge = new CopilotFirstJudge(copilot, gemini, (message) => messages.push(message));
    const result = await judge.evaluate([item]);
    expect(result[0]?.passed).toBe(true);
    expect(judge.provider).toBe('Gemini API');
    expect(judge.model).toBe('gemini-3.8-flash');
    expect(messages[0]).toContain('falling back to Gemini API');
  });

  test('fails clearly when Copilot is unavailable and no Gemini key is configured', async () => {
    const copilot: JudgeClient = {
      provider: 'GitHub Copilot CLI',
      model: 'fusion',
      evaluate: async () => { throw new Error('not authenticated'); },
    };
    await expect(new CopilotFirstJudge(copilot).evaluate([item]))
      .rejects.toThrow('configure GEMINI_API_KEY');
  });
});
