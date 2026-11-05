import type { Doc, GenerateInput, LlmProvider } from '../types.ts';

/**
 * Deterministic, offline "LLM": composes an extractive answer from the top retrieved document.
 * It lets the whole quality pipeline (E2E, API tests, evals) run in CI with zero cost and zero flakiness.
 */
export class MockProvider implements LlmProvider {
  readonly name = 'mock';

  async generate({ question, context }: GenerateInput): Promise<string> {
    const top = context[0]?.doc;
    if (!top) return "I'm not sure about that.";
    return top.type === 'policy' ? top.text : describeProduct(top, question.toLowerCase());
  }
}

function describeProduct(doc: Doc, q: string): string {
  const parts: string[] = [];
  const stock = doc.inStock ? 'is in stock' : 'is currently out of stock';
  if (/price|cost|how much|expensive|cheap|eur|€/.test(q)) parts.push(`The ${doc.title} costs ${doc.price} EUR.`);
  if (/stock|available|availability/.test(q)) parts.push(`The ${doc.title} ${stock}.`);
  if (/warranty|guarantee/.test(q)) parts.push(`The ${doc.title} comes with a ${doc.warrantyYears}-year warranty.`);
  if (parts.length) return parts.join(' ');
  return `${doc.title}: ${doc.text} It costs ${doc.price} EUR and ${stock}.`;
}
