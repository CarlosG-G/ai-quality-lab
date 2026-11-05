import { checkInput, REFUSALS } from './guardrails.ts';
import { loadKnowledgeBase, Retriever } from './retriever.ts';
import type { BotAnswer, LlmProvider } from './types.ts';

export interface ShopBotOptions {
  provider: LlmProvider;
  retriever?: Retriever;
  /** Minimum BM25 score of the best document; below it the question is treated as out of scope. */
  minScore?: number;
  topK?: number;
}

export class ShopBot {
  private readonly provider: LlmProvider;
  private readonly retriever: Retriever;
  private readonly minScore: number;
  private readonly topK: number;

  constructor({ provider, retriever, minScore = 1.5, topK = 3 }: ShopBotOptions) {
    this.provider = provider;
    this.retriever = retriever ?? new Retriever(loadKnowledgeBase());
    this.minScore = minScore;
    this.topK = topK;
  }

  get providerName(): string {
    return this.provider.name;
  }

  async ask(question: unknown): Promise<BotAnswer> {
    const started = performance.now();
    const done = (partial: Omit<BotAnswer, 'provider' | 'latencyMs'>): BotAnswer => ({
      ...partial,
      provider: this.provider.name,
      latencyMs: Math.round(performance.now() - started),
    });

    const blocked = checkInput(question);
    if (blocked) return done({ answer: REFUSALS[blocked], sources: [], refused: true, reason: blocked });

    const q = (question as string).trim();
    const context = this.retriever.search(q, this.topK);
    if (!context.length || (context[0]?.score ?? 0) < this.minScore) {
      return done({ answer: REFUSALS.out_of_scope, sources: [], refused: true, reason: 'out_of_scope' });
    }

    const answer = await this.provider.generate({ question: q, context });
    return done({ answer, sources: context.map((c) => c.doc.id), refused: false });
  }
}
