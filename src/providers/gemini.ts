import type { GenerateInput, LlmProvider } from '../types.ts';
import { GeminiClient, type Fetcher, type GeminiUsage } from './gemini-client.ts';
import { renderContext, SYSTEM_PROMPT } from './prompt.ts';

export interface GeminiProviderOptions {
  apiKeys: string[];
  models?: string[];
  fetcher?: Fetcher;
  client?: GeminiClient;
}

/** Optional live provider for the fictional ShopBot; mock remains the default. */
export class GeminiProvider implements LlmProvider {
  private readonly client: GeminiClient;
  private usage: GeminiUsage = { promptTokens: 0, outputTokens: 0, totalTokens: 0 };

  constructor(options: GeminiProviderOptions) {
    this.client = options.client ?? new GeminiClient({
      apiKeys: options.apiKeys,
      ...(options.models ? { models: options.models } : {}),
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    });
  }

  get name(): string {
    return `gemini:${this.client.model}`;
  }

  /** Accumulated token usage since the provider was created. */
  get totalUsage(): GeminiUsage {
    return { ...this.usage };
  }

  async generate(input: GenerateInput): Promise<string> {
    const result = await this.client.generate({
      systemInstruction: SYSTEM_PROMPT,
      userText: `CONTEXT:\n${renderContext(input)}\n\nQUESTION: ${input.question}`,
      timeoutMs: 30_000,
    });
    this.usage = {
      promptTokens: this.usage.promptTokens + result.usage.promptTokens,
      outputTokens: this.usage.outputTokens + result.usage.outputTokens,
      totalTokens: this.usage.totalTokens + result.usage.totalTokens,
    };
    return result.text;
  }
}
