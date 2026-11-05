import { expect, test } from '@playwright/test';
import {
  GeminiClient,
  GeminiError,
  geminiKeysFromEnv,
  geminiModelsFromEnv,
  type Fetcher,
} from '../../src/providers/gemini-client.ts';

interface Call {
  url: string;
  key: string;
  body: any;
}

function json(status: number, payload: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const ok = (text: string) => json(200, {
  candidates: [{ content: { parts: [{ text: 'hidden reasoning', thought: true }, { text }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
});

function scripted(responses: Response[]): { fetcher: Fetcher; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push({
      url,
      key: new Headers(init.headers).get('x-goog-api-key') ?? '',
      body: JSON.parse(String(init.body)),
    });
    const next = responses.shift();
    if (!next) throw new Error('No scripted response left');
    return next;
  };
  return { fetcher, calls };
}

function client(fetcher: Fetcher, apiKeys = ['key-one'], models = ['model-a']): GeminiClient {
  let clock = 1_000_000;
  return new GeminiClient({
    apiKeys,
    models,
    fetcher,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    log: () => {},
  });
}

const rateLimited = (retryDelay = '20s', quotaId = 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier') => json(429, {
  error: {
    status: 'RESOURCE_EXHAUSTED',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId }] },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay },
    ],
  },
});

const request = { systemInstruction: 'Be brief.', userText: 'Hello' };

test.describe('Gemini client resilience', () => {
  test('returns answer text without thought parts and reports token usage', async () => {
    const { fetcher, calls } = scripted([ok('Hi there')]);
    const result = await client(fetcher).generate(request);
    expect(result.text).toBe('Hi there');
    expect(result.usage).toMatchObject({ promptTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(calls[0]?.url).toContain('/models/model-a:generateContent');
    expect(calls[0]?.url).not.toContain('key-one');
    expect(calls[0]?.key).toBe('key-one');
  });

  test('retries transient 503 errors with backoff', async () => {
    const { fetcher, calls } = scripted([json(503, { error: { status: 'UNAVAILABLE' } }), ok('Recovered')]);
    const result = await client(fetcher).generate(request);
    expect(result.text).toBe('Recovered');
    expect(result.attempts).toBe(2);
    expect(calls).toHaveLength(2);
  });

  test('rotates to the next key when one key runs out of quota', async () => {
    const quota = json(429, { error: { status: 'RESOURCE_EXHAUSTED' } }, { 'Retry-After': '120' });
    const { fetcher, calls } = scripted([quota, ok('From second key'), ok('Still second key')]);
    const gemini = client(fetcher, ['key-one', 'key-two']);
    const result = await gemini.generate(request);
    expect(result.text).toBe('From second key');
    expect(result.keyIndex).toBe(1);
    expect(calls.map((call) => call.key)).toEqual(['key-one', 'key-two']);

    await gemini.generate(request);
    expect(calls[2]?.key).toBe('key-two');
  });

  test('falls back to the next model when a model does not exist', async () => {
    const { fetcher, calls } = scripted([json(404, { error: { status: 'NOT_FOUND' } }), ok('Backup model')]);
    const gemini = client(fetcher, ['key-one'], ['missing-model', 'backup-model']);
    const result = await gemini.generate(request);
    expect(result.model).toBe('backup-model');
    expect(gemini.model).toBe('backup-model');
    expect(calls[1]?.url).toContain('/models/backup-model:generateContent');
  });

  test('stops immediately when the answer is safety-blocked', async () => {
    const { fetcher, calls } = scripted([json(200, { candidates: [{ finishReason: 'SAFETY' }] })]);
    const error = await client(fetcher, ['key-one', 'key-two']).generate(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GeminiError);
    expect((error as GeminiError).failure).toBe('blocked');
    expect(calls).toHaveLength(1);
  });

  test('never exposes API keys in errors when every key fails', async () => {
    const denied = () => json(400, { error: { status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } });
    const { fetcher } = scripted([denied(), denied()]);
    const error = await client(fetcher, ['secret-one', 'secret-two']).generate(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GeminiError);
    expect((error as GeminiError).failure).toBe('auth');
    expect(String((error as Error).message)).not.toMatch(/secret-/);
    expect(String((error as Error).message)).toContain('key#2');
  });

  test('sends a response schema when structured output is requested', async () => {
    const { fetcher, calls } = scripted([ok('{"ok":true}')]);
    const schema = { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } } };
    await client(fetcher).generate({ ...request, responseSchema: schema });
    expect(calls[0]?.body.generationConfig).toMatchObject({ responseMimeType: 'application/json', responseSchema: schema });
  });

  test('waits for the RetryInfo delay when every key and model is rate limited', async () => {
    const { fetcher, calls } = scripted([rateLimited('20s'), ok('After waiting')]);
    const result = await client(fetcher).generate(request);
    expect(result.text).toBe('After waiting');
    expect(calls).toHaveLength(2);
  });

  test('skips a rate-limited model on later requests instead of hitting it again', async () => {
    const { fetcher, calls } = scripted([rateLimited('60s'), ok('Backup one'), ok('Backup two')]);
    const gemini = client(fetcher, ['key-one'], ['busy-model', 'backup-model']);
    await gemini.generate(request);
    await gemini.generate(request);
    expect(calls.map((call) => call.url.match(/models\/([^:]+)/)?.[1])).toEqual(['busy-model', 'backup-model', 'backup-model']);
  });

  test('does not wait for an exhausted daily quota', async () => {
    const { fetcher, calls } = scripted([rateLimited('5s', 'GenerateRequestsPerDayPerProjectPerModel-FreeTier')]);
    const error = await client(fetcher).generate(request).catch((e: unknown) => e);
    expect((error as GeminiError).failure).toBe('quota');
    expect(String((error as Error).message)).toContain('quota');
    expect(calls).toHaveLength(1);
  });

  test('reads key and model lists from the environment without duplicates', () => {
    expect(geminiKeysFromEnv({ GEMINI_API_KEYS: 'a, b,,a', GEMINI_API_KEY: 'b' })).toEqual(['a', 'b']);
    expect(geminiModelsFromEnv({ GEMINI_MODELS: 'x, y' }, 'GEMINI_MODELS', 'GEMINI_MODEL')).toEqual(['x', 'y']);
    expect(geminiModelsFromEnv({ GEMINI_MODEL: 'z' }, 'GEMINI_MODELS', 'GEMINI_MODEL')[0]).toBe('z');
  });
});
