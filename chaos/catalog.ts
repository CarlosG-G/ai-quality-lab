import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface CatalogBug {
  id: string;
  file: string;
  find: string;
  replace: string;
  category: 'retrieval' | 'safety' | 'answer';
  description: string;
}

export const BUG_CATALOG: CatalogBug[] = [
  {
    id: 'accent-normalization',
    file: 'src/retriever.ts',
    find: ".normalize('NFD')",
    replace: ".normalize('NFC')",
    category: 'retrieval',
    description: 'Accent normalization no longer decomposes accented characters.',
  },
  {
    id: 'ascending-relevance',
    file: 'src/retriever.ts',
    find: '.sort((a, b) => b.score - a.score)',
    replace: '.sort((a, b) => a.score - b.score)',
    category: 'retrieval',
    description: 'Retrieved documents are ordered from least relevant to most relevant.',
  },
  {
    id: 'spanish-injection-guard',
    file: 'src/guardrails.ts',
    find: '/ignora (todas )?(las )?instrucciones/i',
    replace: '/ignora (todas )?(las )?instruccionesx/i',
    category: 'safety',
    description: 'The Spanish prompt-injection pattern misses its intended phrase.',
  },
  {
    id: 'question-length-boundary',
    file: 'src/guardrails.ts',
    find: 'MAX_QUESTION_LENGTH = 500',
    replace: 'MAX_QUESTION_LENGTH = 501',
    category: 'safety',
    description: 'The input guard accepts a question one character over the limit.',
  },
  {
    id: 'relevance-threshold',
    file: 'src/bot.ts',
    find: '(context[0]?.score ?? 0) < this.minScore',
    replace: '(context[0]?.score ?? 0) > this.minScore',
    category: 'retrieval',
    description: 'The relevance threshold rejects strong matches and accepts weak ones.',
  },
  {
    id: 'inverted-stock-answer',
    file: 'src/providers/mock.ts',
    find: "doc.inStock ? 'is in stock' : 'is currently out of stock'",
    replace: "doc.inStock ? 'is currently out of stock' : 'is in stock'",
    category: 'answer',
    description: 'The deterministic provider reports the opposite stock status.',
  },
  {
    id: 'missing-stopword-filter',
    file: 'src/retriever.ts',
    find: '!STOPWORDS.has(t)',
    replace: 'STOPWORDS.has(t)',
    category: 'retrieval',
    description: 'Tokenization keeps stopwords and discards meaningful terms.',
  },
  {
    id: 'off-by-one-top-k',
    file: 'src/retriever.ts',
    find: '.slice(0, k)',
    replace: '.slice(0, k - 1)',
    category: 'retrieval',
    description: 'Retrieval returns one fewer result than the requested limit.',
  },
];

export function applyCatalogBug(root: string, bug: CatalogBug): { before: string; after: string } {
  if (!bug.file.startsWith('src/')) {
    throw new Error(`Catalog entry "${bug.id}" must target src/**`);
  }
  const resolvedRoot = resolve(root);
  const filePath = resolve(resolvedRoot, bug.file);
  const sourceRoot = resolve(resolvedRoot, 'src');
  const relativePath = relative(sourceRoot, filePath);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Catalog entry "${bug.id}" escaped the sandbox source tree`);
  }
  const before = readFileSync(filePath, 'utf8');
  const occurrences = before.split(bug.find).length - 1;
  if (occurrences !== 1) {
    throw new Error(`Catalog entry "${bug.id}" expected one match in ${bug.file}, found ${occurrences}`);
  }
  const after = before.replace(bug.find, bug.replace);
  if (after === before) throw new Error(`Catalog entry "${bug.id}" did not change ${bug.file}`);
  writeFileSync(join(resolvedRoot, bug.file), after);
  return { before, after };
}
