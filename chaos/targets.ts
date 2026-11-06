/**
 * Source files under test for Chaos Lab.
 * Faults are only seeded into these files and autoheal may only edit these files.
 */
export const SOURCE_FILES_UNDER_TEST = [
  'src/retriever.ts',
  'src/guardrails.ts',
  'src/bot.ts',
  'src/providers/mock.ts',
  'src/providers/prompt.ts',
] as const;

export type SourceFileUnderTest = (typeof SOURCE_FILES_UNDER_TEST)[number];

export function isSourceFileUnderTest(file: string): file is SourceFileUnderTest {
  return SOURCE_FILES_UNDER_TEST.some((candidate) => candidate === file);
}
