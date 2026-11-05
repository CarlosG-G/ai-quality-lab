import type { GenerateInput, LlmProvider } from '../types.ts';
import { renderContext, SYSTEM_PROMPT } from './prompt.ts';

const ENDPOINT = 'https://models.github.ai/inference/chat/completions';

/** Real LLM through GitHub Models. Free tier works with a GITHUB_TOKEN that has `models: read`. */
export class GitHubModelsProvider implements LlmProvider {
  readonly name: string;
  private readonly token: string;
  private readonly model: string;

  constructor(token: string, model = 'openai/gpt-4.1-mini') {
    if (!token) throw new Error('GITHUB_TOKEN is required for the github-models provider');
    this.token = token;
    this.model = model;
    this.name = `github-models:${model}`;
  }

  async generate(input: GenerateInput): Promise<string> {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `CONTEXT:\n${renderContext(input)}\n\nQUESTION: ${input.question}` },
        ],
      }),
    });
    if (!res.ok) throw new Error(`GitHub Models returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content?.trim() || "I'm not sure about that.";
  }
}
