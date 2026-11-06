import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  generateTestPlan,
  parseFailureReport,
  parseUserStory,
  triageFailure,
} from './ai-testing.ts';
import { createAiTestingGenerator } from './ai-testing-client.ts';

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(resolve(path), 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Could not read valid JSON from "${path}"`, { cause: error });
  }
}

async function main(): Promise<void> {
  const [operation, inputPath] = process.argv.slice(2);
  if (!inputPath || (operation !== 'generate' && operation !== 'triage')) {
    throw new Error(
      'Usage: npm run ai:testing -- <generate|triage> <input.json>\n' +
      'Examples: npm run ai:testing -- generate examples/user-story.json',
    );
  }

  const input = readJson(inputPath);
  const generator = createAiTestingGenerator();
  const result = operation === 'generate'
    ? await generateTestPlan(parseUserStory(input), generator)
    : await triageFailure(parseFailureReport(input), generator);

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'AI test assistant failed unexpectedly.');
  process.exitCode = 1;
});
