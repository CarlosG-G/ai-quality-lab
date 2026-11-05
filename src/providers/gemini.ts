import type { GenerateInput, LlmProvider } from '../types.ts';
import { renderContext, SYSTEM_PROMPT } from './prompt.ts';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

type Fetcher = (url: string, init: RequestInit) => Promise<FetchResponse>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Optional live provider for the fictional ShopBot; mock remains the default. */
export class GeminiProvider implements LlmProvider {
  readonly name: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetcher: Fetcher;

  constructor(
    apiKey: string,
    model = 'gemini-3.8-flash',
    fetcher: Fetcher = fetch,
  ) {
    if (!apiKey.trim()) throw new Error('GEMINI_API_KEY is required for the gemini provider');
    this.apiKey = apiKey;
    this.model = model;
    this.fetcher = fetcher;
    this.name = `gemini:${model}`;
  }

  async generate(input: GenerateInput): Promise<string> {
    const response = await this.fetcher(
      `${ENDPOINT}/${encodeURIComponent(this.model)}:generateContent`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{
            role: 'user',
            parts: [{ text: `CONTEXT:\n${renderContext(input)}\n\nQUESTION: ${input.question}` }],
          }],
          generationConfig: { temperature: 0 },
        }),
      },
    );
    if (!response.ok) throw new Error(`Gemini API returned HTTP ${response.status}`);

    const payload = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload.candidates)) {
      throw new Error('Gemini API returned an unexpected response');
    }
    const candidate = payload.candidates[0];
    if (!isRecord(candidate) || !isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) {
      throw new Error('Gemini API response is missing content parts');
    }
    const answer = candidate.content.parts
      .filter(isRecord)
      .map((part) => part.text)
      .filter((text): text is string => typeof text === 'string')
      .join('')
      .trim();
    if (!answer) throw new Error('Gemini API response is missing answer text');
    return answer;
  }
}
