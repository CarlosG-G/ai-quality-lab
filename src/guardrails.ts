import type { RefusalReason } from './types.ts';

const INJECTION_PATTERNS: RegExp[] = [
  /ignore (all |any |the )?(previous|prior|above|earlier) (instructions|rules|prompts?)/i,
  /disregard (all |any |the )?(previous|prior|above|your) (instructions|rules)/i,
  /(reveal|show|print|repeat|leak).{0,30}(system prompt|instructions|hidden prompt|api key|secret)/i,
  /\b(system prompt|developer mode|jailbreak|dan mode)\b/i,
  /you are (now|no longer)\b/i,
  /pretend (to be|you are)/i,
  /olvida (todas )?(las )?instrucciones/i,
  /ignora (todas )?(las )?instrucciones/i,
];

export const MAX_QUESTION_LENGTH = 500;

export function checkInput(question: unknown): RefusalReason | null {
  if (typeof question !== 'string') return 'invalid_input';
  const q = question.trim();
  if (!q || q.length > MAX_QUESTION_LENGTH) return 'invalid_input';
  if (INJECTION_PATTERNS.some((p) => p.test(q))) return 'prompt_injection';
  return null;
}

export const REFUSALS: Record<RefusalReason, string> = {
  prompt_injection: "I can't help with that. I can only answer questions about Nimbus products, orders and store policies.",
  out_of_scope: "I'm not sure about that. I can only help with Nimbus products, shipping, returns, warranty, payments and support.",
  invalid_input: `Please send a question between 1 and ${MAX_QUESTION_LENGTH} characters.`,
};
