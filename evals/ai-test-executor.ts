import { ShopBot } from '../src/bot.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { loadKnowledgeBase, Retriever } from '../src/retriever.ts';
import type { BotAnswer } from '../src/types.ts';
import {
  validateTestPlan,
  type GeneratedTestCase,
  type UserStory,
} from './ai-testing.ts';
import {
  SHOPBOT_SCENARIOS,
  type ScenarioCheck,
  type ShopBotScenarioId,
} from './ai-test-scenarios.ts';

export interface ExecutedCheck {
  kind: ScenarioCheck['kind'];
  expected: string;
  passed: boolean;
}

export interface ExecutedTestCase {
  caseIndex: number;
  criterionIndex: number;
  criterion: string;
  title: string;
  scenarioId: ShopBotScenarioId;
  status: 'passed' | 'failed';
  checks: ExecutedCheck[];
  actual: {
    answer: string;
    sources: string[];
    refused: boolean;
    reason: string | null;
  };
}

export interface ExecutedCriterion {
  criterionIndex: number;
  criterion: string;
  caseCount: number;
  status: 'passed' | 'failed';
}

export interface TestExecutionReport {
  storyId: string;
  executionProfile: 'shopbot';
  approved: true;
  status: 'passed' | 'failed';
  summary: {
    totalCases: number;
    passedCases: number;
    failedCases: number;
    totalCriteria: number;
    executedCriteria: number;
    passedCriteria: number;
    criteriaCoveragePercent: number;
  };
  criteria: ExecutedCriterion[];
  cases: ExecutedTestCase[];
}

export interface ExecuteTestPlanOptions {
  approved: boolean;
}

function checkScenarioExpectation(answer: BotAnswer, check: ScenarioCheck): boolean {
  switch (check.kind) {
    case 'answer_contains':
      return !answer.refused && answer.answer.toLowerCase().includes(check.value.toLowerCase());
    case 'source_includes':
      return answer.sources.includes(check.value);
    case 'refusal_reason':
      return answer.refused && answer.reason === check.value;
  }
}

async function executeCase(
  bot: ShopBot,
  testCase: GeneratedTestCase,
  caseIndex: number,
  story: UserStory,
): Promise<ExecutedTestCase> {
  const scenarioId = testCase.scenarioId;
  if (!scenarioId) throw new Error(`cases[${caseIndex}].scenarioId is required for execution`);

  const scenario = SHOPBOT_SCENARIOS[scenarioId];
  const answer = await bot.ask(scenario.question);
  const checks = scenario.expected.map((check) => ({
    kind: check.kind,
    expected: check.value,
    passed: checkScenarioExpectation(answer, check),
  }));
  const criterion = story.acceptanceCriteria[testCase.criterionIndex];
  if (criterion === undefined) {
    throw new Error(`cases[${caseIndex}].criterionIndex does not reference an acceptance criterion`);
  }

  return {
    caseIndex,
    criterionIndex: testCase.criterionIndex,
    criterion,
    title: testCase.title,
    scenarioId,
    status: checks.every((check) => check.passed) ? 'passed' : 'failed',
    checks,
    actual: {
      answer: answer.answer,
      sources: answer.sources,
      refused: answer.refused,
      reason: answer.reason ?? null,
    },
  };
}

export async function executeGeneratedTestPlan(
  story: UserStory,
  planValue: unknown,
  options: ExecuteTestPlanOptions,
): Promise<TestExecutionReport> {
  if (!options.approved) {
    throw new Error('Review the generated test plan and pass --approve before execution');
  }
  if (story.executionProfile !== 'shopbot') {
    throw new Error('Execution requires a user story with executionProfile "shopbot"');
  }

  const plan = validateTestPlan(planValue, story);
  const bot = new ShopBot({
    provider: new MockProvider(),
    retriever: new Retriever(loadKnowledgeBase()),
  });
  const cases: ExecutedTestCase[] = [];
  for (const [caseIndex, testCase] of plan.cases.entries()) {
    cases.push(await executeCase(bot, testCase, caseIndex, story));
  }

  const criteria = story.acceptanceCriteria.map((criterion, criterionIndex): ExecutedCriterion => {
    const related = cases.filter((testCase) => testCase.criterionIndex === criterionIndex);
    return {
      criterionIndex,
      criterion,
      caseCount: related.length,
      status: related.length > 0 && related.every((testCase) => testCase.status === 'passed')
        ? 'passed'
        : 'failed',
    };
  });
  const passedCases = cases.filter((testCase) => testCase.status === 'passed').length;
  const failedCases = cases.length - passedCases;
  const executedCriteria = criteria.filter((criterion) => criterion.caseCount > 0).length;
  const passedCriteria = criteria.filter((criterion) => criterion.status === 'passed').length;
  const totalCriteria = criteria.length;

  return {
    storyId: story.id,
    executionProfile: 'shopbot',
    approved: true,
    status: failedCases === 0 ? 'passed' : 'failed',
    summary: {
      totalCases: cases.length,
      passedCases,
      failedCases,
      totalCriteria,
      executedCriteria,
      passedCriteria,
      criteriaCoveragePercent: totalCriteria === 0 ? 0 : Math.round((executedCriteria / totalCriteria) * 100),
    },
    criteria,
    cases,
  };
}
