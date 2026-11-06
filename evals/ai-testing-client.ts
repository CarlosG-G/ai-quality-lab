import { tmpdir } from 'node:os';
import { invokeCopilot } from './judge.ts';
import type { StructuredGenerationRequest, StructuredGenerationResult, StructuredGenerator } from './ai-testing.ts';
import {
  GeminiClient,
  geminiKeysFromEnv,
  geminiModelsFromEnv,
} from '../src/providers/gemini-client.ts';

type ProviderMode = 'auto' | 'copilot' | 'gemini';

function providerMode(env: NodeJS.ProcessEnv): ProviderMode {
  const mode = (env.TESTING_AI_PROVIDER ?? 'auto').toLowerCase();
  if (mode === 'auto' || mode === 'copilot' || mode === 'gemini') return mode;
  throw new Error(`Unknown TESTING_AI_PROVIDER "${mode}". Use "auto", "copilot" or "gemini".`);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error('Unknown provider failure');
}

export function createAiTestingGenerator(env: NodeJS.ProcessEnv = process.env): StructuredGenerator {
  const mode = providerMode(env);
  const apiKeys = geminiKeysFromEnv(env);
  const gemini = apiKeys.length
    ? new GeminiClient({
      apiKeys,
      models: geminiModelsFromEnv(env, 'GEMINI_TESTING_MODELS'),
      maxRetries: 1,
      maxRetryAfterMs: 30_000,
    })
    : undefined;
  const copilotModel = env.COPILOT_TESTING_MODEL ?? env.COPILOT_JUDGE_MODEL ?? 'fusion';

  const generateWithCopilot = async (request: StructuredGenerationRequest): Promise<StructuredGenerationResult> => {
    const prompt = [
      request.systemInstruction,
      'Return only valid JSON matching this schema:',
      JSON.stringify(request.responseSchema),
      'Input:',
      request.userText,
    ].join('\n\n');
    const text = await invokeCopilot(prompt, copilotModel, { cwd: tmpdir(), noTools: true });
    return { text, provider: 'copilot', model: copilotModel };
  };

  const generateWithGemini = async (request: StructuredGenerationRequest): Promise<StructuredGenerationResult> => {
    if (!gemini) throw new Error('Gemini is unavailable; configure GEMINI_API_KEY or GEMINI_API_KEYS.');
    const response = await gemini.generate({
      systemInstruction: request.systemInstruction,
      userText: request.userText,
      responseSchema: request.responseSchema,
      timeoutMs: 90_000,
    });
    return { text: response.text, provider: 'gemini', model: response.model };
  };

  return {
    async generate(request) {
      if (mode === 'copilot') return generateWithCopilot(request);
      if (mode === 'gemini') return generateWithGemini(request);

      try {
        return await generateWithCopilot(request);
      } catch (copilotFailure) {
        if (!gemini) {
          throw new Error('Copilot CLI failed and no Gemini API key is configured for fallback.', {
            cause: asError(copilotFailure),
          });
        }
        console.warn('Copilot CLI unavailable; falling back to Gemini for AI test assistance.');
        try {
          return await generateWithGemini(request);
        } catch (geminiFailure) {
          throw new AggregateError(
            [asError(copilotFailure), asError(geminiFailure)],
            'Both Copilot CLI and Gemini failed to generate the requested test assistance.',
          );
        }
      }
    },
  };
}
