import { readFileSync } from 'node:fs';
import type { Doc, Retrieved } from './types.ts';

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'do', 'does', 'you', 'your', 'i', 'my', 'me', 'it', 'of', 'for', 'to',
  'in', 'on', 'and', 'or', 'with', 'what', 'how', 'can', 'which', 'there', 'this', 'that', 'have', 'has',
  'much', 'many', 'any', 'be', 'about', 'tell', 'please', 'want', 'need', 'from', 'at', 'by',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

// Tiny suffix stripper so "laptops" matches "laptop" and "returns" matches "return".
function stem(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

export function loadKnowledgeBase(): Doc[] {
  const url = new URL('./knowledge-base.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as Doc[];
}

function expandIntent(query: string): string[] {
  const normalized = query.toLowerCase();
  const terms: string[] = [];
  if (/\b(open|opening|hours?|available|availability)\b/.test(normalized) &&
      /\b(support|help|contact|service)\b/.test(normalized)) {
    terms.push('customer support hours weekdays business');
  }
  if (/\b(broke|broken|break|damaged|damage|defect|faulty|repair|warranty|guarantee)\b/.test(normalized)) {
    terms.push('warranty repair defect guarantee');
  }
  return terms;
}

/** Okapi BM25 over title + tags + text. Small, dependency-free and deterministic. */
export class Retriever {
  private readonly docs: Doc[];
  private readonly tokens: string[][];
  private readonly idf = new Map<string, number>();
  private readonly avgLen: number;
  private readonly k1 = 1.4;
  private readonly b = 0.75;

  constructor(docs: Doc[]) {
    this.docs = docs;
    // Title and tags are repeated to weigh them above the free-text description.
    this.tokens = docs.map((d) => tokenize(`${d.title} ${d.title} ${d.tags.join(' ')} ${d.tags.join(' ')} ${d.text}`));
    this.avgLen = this.tokens.reduce((sum, t) => sum + t.length, 0) / Math.max(docs.length, 1);
    const df = new Map<string, number>();
    for (const toks of this.tokens) for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
    for (const [t, n] of df) this.idf.set(t, Math.log(1 + (docs.length - n + 0.5) / (n + 0.5)));
  }

  search(query: string, k = 3): Retrieved[] {
    const expandedQuery = [query, ...expandIntent(query)].join(' ');
    const q = [...new Set(tokenize(expandedQuery))];
    return this.docs
      .map((doc, i) => {
        const toks = this.tokens[i] ?? [];
        let score = 0;
        for (const term of q) {
          const tf = toks.filter((t) => t === term).length;
          if (!tf) continue;
          const idf = this.idf.get(term) ?? 0;
          score += idf * ((tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + (this.b * toks.length) / this.avgLen)));
        }
        return { doc, score: Number(score.toFixed(4)) };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}
