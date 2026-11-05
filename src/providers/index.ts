import type { LlmProvider } from '../types.ts';
import { GitHubModelsProvider } from './github-models.ts';
import { MockProvider } from './mock.ts';

export function createProvider(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  const kind = (env.LLM_PROVIDER ?? 'mock').toLowerCase();
  if (kind === 'mock') return new MockProvider();
  if (kind === 'github-models') return new GitHubModelsProvider(env.GITHUB_TOKEN ?? '', env.GITHUB_MODELS_MODEL);
  throw new Error(`Unknown LLM_PROVIDER "${kind}". Use "mock" or "github-models".`);
}
