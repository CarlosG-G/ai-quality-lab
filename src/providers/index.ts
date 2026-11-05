import type { LlmProvider } from '../types.ts';
import { GeminiProvider } from './gemini.ts';
import { geminiKeysFromEnv, geminiModelsFromEnv } from './gemini-client.ts';
import { MockProvider } from './mock.ts';

export function createProvider(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  const kind = (env.LLM_PROVIDER ?? 'mock').toLowerCase();
  if (kind === 'mock') return new MockProvider();
  if (kind === 'gemini') {
    return new GeminiProvider({
      apiKeys: geminiKeysFromEnv(env),
      models: geminiModelsFromEnv(env, 'GEMINI_MODELS', 'GEMINI_MODEL'),
    });
  }
  throw new Error(`Unknown LLM_PROVIDER "${kind}". Use "mock" or "gemini".`);
}
