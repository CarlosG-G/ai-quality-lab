import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript-api';
import { SeededRandom } from './rng.ts';
import { SOURCE_FILES_UNDER_TEST } from './targets.ts';

export interface MutationCandidate {
  file: string;
  start: number;
  length: number;
  original: string;
  replacement: string;
  operator: string;
}

const OPERATOR_MUTATIONS = new Map<ts.SyntaxKind, { replacement: ts.SyntaxKind; label: string }>([
  [ts.SyntaxKind.GreaterThanEqualsToken, { replacement: ts.SyntaxKind.GreaterThanToken, label: '>=' }],
  [ts.SyntaxKind.GreaterThanToken, { replacement: ts.SyntaxKind.GreaterThanEqualsToken, label: '>' }],
  [ts.SyntaxKind.LessThanEqualsToken, { replacement: ts.SyntaxKind.LessThanToken, label: '<=' }],
  [ts.SyntaxKind.LessThanToken, { replacement: ts.SyntaxKind.LessThanEqualsToken, label: '<' }],
  [ts.SyntaxKind.EqualsEqualsEqualsToken, { replacement: ts.SyntaxKind.ExclamationEqualsEqualsToken, label: '===' }],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, { replacement: ts.SyntaxKind.EqualsEqualsEqualsToken, label: '!==' }],
  [ts.SyntaxKind.AmpersandAmpersandToken, { replacement: ts.SyntaxKind.BarBarToken, label: '&&' }],
  [ts.SyntaxKind.BarBarToken, { replacement: ts.SyntaxKind.AmpersandAmpersandToken, label: '||' }],
  [ts.SyntaxKind.PlusToken, { replacement: ts.SyntaxKind.MinusToken, label: '+' }],
  [ts.SyntaxKind.MinusToken, { replacement: ts.SyntaxKind.PlusToken, label: '-' }],
  [ts.SyntaxKind.AsteriskToken, { replacement: ts.SyntaxKind.SlashToken, label: '*' }],
]);

function sourceFiles(root: string): string[] {
  return SOURCE_FILES_UNDER_TEST
    .map((file) => join(root, file))
    .filter((file) => {
      try {
        return existsSync(file) && statSync(file).isFile();
      } catch {
        return false;
      }
    });
}

/**
 * Constant-replacement mutants. Negative values are skipped because a literal such as
 * `x - 0` would become `x --1`, which does not compile and only creates invalid mutants.
 */
export function mutationOptionsForNumber(value: number): string[] {
  const candidates = [0, value + 1, value - 1].filter((candidate) => candidate >= 0 && candidate !== value);
  return [...new Set(candidates)].map(String);
}

export function collectMutations(root: string): MutationCandidate[] {
  const candidates: MutationCandidate[] = [];
  for (const absolutePath of sourceFiles(root)) {
    let text: string;
    try {
      text = readFileSync(absolutePath, 'utf8');
    } catch {
      continue;
    }
    const file = relative(root, absolutePath).replace(/\\/g, '/');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    const visit = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node)) {
        const change = OPERATOR_MUTATIONS.get(node.operatorToken.kind);
        if (change) {
          const replacement = ts.tokenToString(change.replacement);
          if (replacement) {
            candidates.push({
              file,
              start: node.operatorToken.getStart(source),
              length: node.operatorToken.getWidth(source),
              original: node.operatorToken.getText(source),
              replacement,
              operator: `operator:${change.label}`,
            });
          }
        }
      }
      if (ts.isNumericLiteral(node)) {
        const numeric = Number(node.text.replaceAll('_', ''));
        if (Number.isFinite(numeric)) {
          for (const replacement of mutationOptionsForNumber(numeric)) {
            candidates.push({
              file,
              start: node.getStart(source),
              length: node.getWidth(source),
              original: node.getText(source),
              replacement,
              operator: `constant:${node.text}`,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return candidates;
}

export function applyMutation(
  root: string,
  candidate: MutationCandidate,
): { before: string; after: string; candidate: MutationCandidate } {
  const filePath = join(root, candidate.file);
  const before = readFileSync(filePath, 'utf8');
  const current = before.slice(candidate.start, candidate.start + candidate.length);
  if (current !== candidate.original) throw new Error(`Mutation target changed before applying ${candidate.operator}`);
  const after = `${before.slice(0, candidate.start)}${candidate.replacement}${before.slice(candidate.start + candidate.length)}`;
  if (after === before) throw new Error('Mutation did not change the source');
  return { before, after, candidate };
}

export function chooseMutation(root: string, random: SeededRandom): MutationCandidate {
  const candidates = collectMutations(root);
  if (!candidates.length) throw new Error('No supported AST mutations found in the configured source files');
  return random.pick(candidates);
}
