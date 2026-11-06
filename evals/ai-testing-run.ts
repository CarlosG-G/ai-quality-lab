import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  generateTestPlan,
  parseFailureReport,
  parseUserStory,
  triageFailure,
} from './ai-testing.ts';
import { createAiTestingGenerator } from './ai-testing-client.ts';
import { executeGeneratedTestPlan } from './ai-test-executor.ts';

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(resolve(path), 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Could not read valid JSON from "${path}"`, { cause: error });
  }
}

async function main(): Promise<void> {
  const [operation, ...args] = process.argv.slice(2);
  if (operation === 'execute') {
    const [storyPath, planPath, ...flags] = args;
    if (!storyPath || !planPath || flags.some((flag) => flag !== '--approve')) {
      throw new Error(
        'Usage: npm run ai:testing -- execute <story.json> <plan.json> --approve\n' +
        'Review the generated plan before approving execution.',
      );
    }
    const story = parseUserStory(readJson(storyPath));
    const savedOutput = readJson(planPath);
    const planValue = typeof savedOutput === 'object' && savedOutput !== null && 'result' in savedOutput
      ? savedOutput.result
      : savedOutput;
    const report = await executeGeneratedTestPlan(story, planValue, { approved: flags.includes('--approve') });
    console.log(JSON.stringify(report, null, 2));
    if (report.summary.failedCases > 0) {
      process.exitCode = 1;
      console.error(`Execution failed: ${report.summary.failedCases} test case(s) failed.`);
    }
    return;
  }

  const [inputPath] = args;
  if (!inputPath || (operation !== 'generate' && operation !== 'triage')) {
    throw new Error(
      'Usage: npm run ai:testing -- <generate|triage> <input.json>\n' +
      '       npm run ai:testing -- execute <story.json> <plan.json> --approve\n' +
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
