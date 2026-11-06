import {
  isShopBotScenarioId,
  SHOPBOT_SCENARIO_IDS,
  SHOPBOT_SCENARIOS,
  type ShopBotScenarioId,
} from './ai-test-scenarios.ts';

export type TestCaseType = 'positive' | 'negative' | 'boundary';
export type FailureCategory = 'product_bug' | 'test_defect' | 'environment' | 'inconclusive';

export interface UserStory {
  id: string;
  title: string;
  asA: string;
  iWant: string;
  soThat: string;
  acceptanceCriteria: string[];
  executionProfile?: 'shopbot';
}

export interface FailureEvidence {
  id: string;
  text: string;
}

export interface FailureReport {
  id: string;
  testTitle: string;
  expected: string;
  actual: string;
  error: string;
  environment: string;
  evidence: FailureEvidence[];
}

export interface GeneratedTestCase {
  criterionIndex: number;
  type: TestCaseType;
  title: string;
  given: string;
  when: string;
  then: string;
  scenarioId?: ShopBotScenarioId;
}

export interface GeneratedTestPlan {
  cases: GeneratedTestCase[];
}

export interface FailureTriage {
  category: FailureCategory;
  confidence: number;
  summary: string;
  evidenceIds: string[];
  nextAction: string;
}

export interface StructuredGenerationRequest {
  systemInstruction: string;
  userText: string;
  responseSchema: Record<string, unknown>;
}

export interface StructuredGenerator {
  generate(request: StructuredGenerationRequest): Promise<StructuredGenerationResult>;
}

export interface StructuredGenerationResult {
  text: string;
  provider: string;
  model: string;
}

export interface AiTestingResult<T> {
  result: T;
  provider: string;
  model: string;
}

const TEST_CASE_TYPES: TestCaseType[] = ['positive', 'negative', 'boundary'];
const FAILURE_CATEGORIES: FailureCategory[] = [
  'product_bug',
  'test_defect',
  'environment',
  'inconclusive',
];

function testPlanSchema(executable: boolean): Record<string, unknown> {
  const caseProperties: Record<string, unknown> = {
    criterionIndex: { type: 'INTEGER' },
    type: { type: 'STRING', enum: TEST_CASE_TYPES },
    title: { type: 'STRING' },
    given: { type: 'STRING' },
    when: { type: 'STRING' },
    then: { type: 'STRING' },
  };
  const required = ['criterionIndex', 'type', 'title', 'given', 'when', 'then'];
  if (executable) {
    caseProperties.scenarioId = { type: 'STRING', enum: SHOPBOT_SCENARIO_IDS };
    required.push('scenarioId');
  }

  return {
    type: 'OBJECT',
    properties: {
      cases: {
        type: 'ARRAY',
        items: { type: 'OBJECT', properties: caseProperties, required },
      },
    },
    required: ['cases'],
  };
}

export const TEST_PLAN_SCHEMA = testPlanSchema(false);

export const FAILURE_TRIAGE_SCHEMA: Record<string, unknown> = {
  type: 'OBJECT',
  properties: {
    category: { type: 'STRING', enum: FAILURE_CATEGORIES },
    confidence: { type: 'NUMBER' },
    summary: { type: 'STRING' },
    evidenceIds: { type: 'ARRAY', items: { type: 'STRING' } },
    nextAction: { type: 'STRING' },
  },
  required: ['category', 'confidence', 'summary', 'evidenceIds', 'nextAction'],
};

const TEST_PLAN_INSTRUCTIONS = [
  'You are a senior software test analyst.',
  'Create concise test cases from the supplied user story; do not write test code.',
  'Use only facts in the story and acceptance criteria; do not invent product behavior.',
  'Cover every acceptance criterion at least once. Add a negative or boundary case only when supported by the criteria.',
  'Return JSON matching the supplied schema. criterionIndex is zero-based.',
].join(' ');

function testPlanInstructions(story: UserStory): string {
  if (story.executionProfile !== 'shopbot') return TEST_PLAN_INSTRUCTIONS;
  const scenarios = SHOPBOT_SCENARIO_IDS
    .map((id) => `- ${id}: ${SHOPBOT_SCENARIOS[id].description}`)
    .join('\n');
  return [
    TEST_PLAN_INSTRUCTIONS,
    'This story uses the ShopBot execution profile. Every case must select one supported scenarioId.',
    'Choose a scenario only when it directly checks the linked acceptance criterion. Never create code, inputs, assertions, or scenario IDs.',
    'Supported scenario IDs:',
    scenarios,
  ].join('\n');
}

const TRIAGE_INSTRUCTIONS = [
  'You are a software test failure triage assistant.',
  'Classify the failure as product_bug, test_defect, environment, or inconclusive.',
  'Use only the supplied failure report and evidence. Do not claim a root cause that the evidence cannot establish.',
  'Use evidenceIds only for supplied evidence IDs. Lower confidence and choose inconclusive when evidence is insufficient.',
  'Recommend one concrete next action. Do not claim that a bug is fixed or close an issue.',
  'Return JSON matching the supplied schema.',
].join(' ');

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, label: string, maxLength = 2_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`${label} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value.trim();
}

function textList(value: unknown, label: string, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxItems) {
    throw new Error(`${label} must contain between 1 and ${maxItems} items`);
  }
  return value.map((item, index) => requiredText(item, `${label}[${index}]`));
}

function isOneOf<T extends string>(value: unknown, choices: readonly T[]): value is T {
  return typeof value === 'string' && choices.some((choice) => choice === value);
}

export function parseUserStory(value: unknown): UserStory {
  const story = record(value, 'User story');
  if (story.executionProfile !== undefined && story.executionProfile !== 'shopbot') {
    throw new Error('User story executionProfile must be shopbot when provided');
  }
  const parsed: UserStory = {
    id: requiredText(story.id, 'User story id', 100),
    title: requiredText(story.title, 'User story title', 200),
    asA: requiredText(story.asA, 'User story asA', 500),
    iWant: requiredText(story.iWant, 'User story iWant', 500),
    soThat: requiredText(story.soThat, 'User story soThat', 500),
    acceptanceCriteria: textList(story.acceptanceCriteria, 'acceptanceCriteria', 20),
  };
  if (story.executionProfile === 'shopbot') parsed.executionProfile = 'shopbot';
  return parsed;
}

export function parseFailureReport(value: unknown): FailureReport {
  const report = record(value, 'Failure report');
  if (!Array.isArray(report.evidence) || report.evidence.length > 50) {
    throw new Error('evidence must be an array containing at most 50 items');
  }
  const evidence = report.evidence.map((entry, index) => {
    const item = record(entry, `evidence[${index}]`);
    return {
      id: requiredText(item.id, `evidence[${index}].id`, 100),
      text: requiredText(item.text, `evidence[${index}].text`, 4_000),
    };
  });
  if (new Set(evidence.map((item) => item.id)).size !== evidence.length) {
    throw new Error('evidence IDs must be unique');
  }
  return {
    id: requiredText(report.id, 'Failure report id', 100),
    testTitle: requiredText(report.testTitle, 'Failure report testTitle', 300),
    expected: requiredText(report.expected, 'Failure report expected', 2_000),
    actual: requiredText(report.actual, 'Failure report actual', 2_000),
    error: requiredText(report.error, 'Failure report error', 4_000),
    environment: requiredText(report.environment, 'Failure report environment', 1_000),
    evidence,
  };
}

function parseJsonResponse(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${label} response was not valid JSON`, { cause: error });
  }
}

export function validateTestPlan(value: unknown, story: UserStory): GeneratedTestPlan {
  const plan = record(value, 'Generated test plan');
  if (!Array.isArray(plan.cases) || plan.cases.length < story.acceptanceCriteria.length || plan.cases.length > 40) {
    throw new Error(`Generated test plan must contain ${story.acceptanceCriteria.length} to 40 cases`);
  }
  const covered = new Set<number>();
  const cases = plan.cases.map((entry, index): GeneratedTestCase => {
    const item = record(entry, `cases[${index}]`);
    const criterionIndex = item.criterionIndex;
    if (typeof criterionIndex !== 'number' || !Number.isInteger(criterionIndex) ||
      criterionIndex < 0 || criterionIndex >= story.acceptanceCriteria.length) {
      throw new Error(`cases[${index}].criterionIndex must reference an acceptance criterion`);
    }
    if (!isOneOf(item.type, TEST_CASE_TYPES)) {
      throw new Error(`cases[${index}].type must be positive, negative, or boundary`);
    }
    let scenarioId: ShopBotScenarioId | undefined;
    if (story.executionProfile === 'shopbot') {
      if (!isShopBotScenarioId(item.scenarioId)) {
        throw new Error(`cases[${index}].scenarioId must be a supported ShopBot scenario`);
      }
      scenarioId = item.scenarioId;
    } else if (item.scenarioId !== undefined) {
      throw new Error(`cases[${index}].scenarioId requires the ShopBot execution profile`);
    }
    covered.add(criterionIndex);
    return {
      criterionIndex,
      type: item.type,
      title: requiredText(item.title, `cases[${index}].title`, 200),
      given: requiredText(item.given, `cases[${index}].given`, 1_000),
      when: requiredText(item.when, `cases[${index}].when`, 1_000),
      then: requiredText(item.then, `cases[${index}].then`, 1_000),
      ...(scenarioId ? { scenarioId } : {}),
    };
  });
  const missing = story.acceptanceCriteria
    .map((_, index) => index)
    .filter((index) => !covered.has(index));
  if (missing.length) {
    throw new Error(`Generated test plan does not cover acceptance criteria: ${missing.join(', ')}`);
  }
  return { cases };
}

export function validateFailureTriage(value: unknown, report: FailureReport): FailureTriage {
  const triage = record(value, 'Failure triage');
  if (!isOneOf(triage.category, FAILURE_CATEGORIES)) {
    throw new Error(`Failure triage category must be one of: ${FAILURE_CATEGORIES.join(', ')}`);
  }
  if (typeof triage.confidence !== 'number' || !Number.isFinite(triage.confidence) ||
    triage.confidence < 0 || triage.confidence > 1) {
    throw new Error('Failure triage confidence must be a number from 0 to 1');
  }
  if (!Array.isArray(triage.evidenceIds) || triage.evidenceIds.some((id) => typeof id !== 'string')) {
    throw new Error('Failure triage evidenceIds must be an array of evidence IDs');
  }
  const evidenceIds = triage.evidenceIds as string[];
  const knownIds = new Set(report.evidence.map((item) => item.id));
  if (evidenceIds.some((id) => !knownIds.has(id))) {
    throw new Error('Failure triage referenced an evidence ID not present in the report');
  }
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    throw new Error('Failure triage evidenceIds must be unique');
  }
  if (triage.category !== 'inconclusive' && !evidenceIds.length) {
    throw new Error('A conclusive failure category must cite at least one evidence ID');
  }
  return {
    category: triage.category,
    confidence: triage.confidence,
    summary: requiredText(triage.summary, 'Failure triage summary', 1_000),
    evidenceIds,
    nextAction: requiredText(triage.nextAction, 'Failure triage nextAction', 1_000),
  };
}

export async function generateTestPlan(
  story: UserStory,
  generator: StructuredGenerator,
): Promise<AiTestingResult<GeneratedTestPlan>> {
  const response = await generator.generate({
    systemInstruction: testPlanInstructions(story),
    userText: JSON.stringify(story),
    responseSchema: testPlanSchema(story.executionProfile === 'shopbot'),
  });
  return {
    result: validateTestPlan(parseJsonResponse(response.text, 'Test generation'), story),
    provider: response.provider,
    model: response.model,
  };
}

export async function triageFailure(
  report: FailureReport,
  generator: StructuredGenerator,
): Promise<AiTestingResult<FailureTriage>> {
  const response = await generator.generate({
    systemInstruction: TRIAGE_INSTRUCTIONS,
    userText: JSON.stringify(report),
    responseSchema: FAILURE_TRIAGE_SCHEMA,
  });
  return {
    result: validateFailureTriage(parseJsonResponse(response.text, 'Failure triage'), report),
    provider: response.provider,
    model: response.model,
  };
}
