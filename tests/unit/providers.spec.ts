import { expect, test } from '@playwright/test';
import { createProvider } from '../../src/providers/index.ts';
import { GeminiProvider } from '../../src/providers/gemini.ts';

test.describe('Gemini app provider', () => {
  test('sends the API key in a header and returns generated answer text', async () => {
    let requestUrl = '';
    let requestKey = '';
    const fakeFetch: typeof fetch = async (url, init) => {
      requestUrl = String(url);
      requestKey = new Headers(init?.headers).get('x-goog-api-key') ?? '';
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'The return window is 30 days.' }] } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const provider = new GeminiProvider({ apiKeys: ['test-api-key'], models: ['gemini-test'], fetcher: fakeFetch });
    const answer = await provider.generate({ question: 'How long are returns?', context: [] });
    expect(answer).toBe('The return window is 30 days.');
    expect(provider.name).toBe('gemini:gemini-test');
    expect(requestUrl).toContain('/gemini-test:generateContent');
    expect(requestUrl).not.toContain('test-api-key');
    expect(requestKey).toBe('test-api-key');
  });

  test('requires an API key', () => {
    expect(() => new GeminiProvider({ apiKeys: [''] })).toThrow('GEMINI_API_KEY is required');
  });

  test('provider selection stays mock by default and supports Gemini explicitly', () => {
    expect(createProvider().name).toBe('mock');
    expect(createProvider({ LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'test-key' }).name).toBe('gemini:gemini-3.8-flash');
    expect(createProvider({
      LLM_PROVIDER: 'gemini',
      GEMINI_API_KEYS: 'key-a,key-b',
      GEMINI_MODELS: 'gemini-custom, gemini-backup',
    }).name).toBe('gemini:gemini-custom');
  });

  test('does not silently accept the retired GitHub Models provider', () => {
    expect(() => createProvider({ LLM_PROVIDER: 'github-models' })).toThrow('Use "mock" or "gemini"');
  });
});
