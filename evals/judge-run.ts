import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { docFacts } from '../src/providers/prompt.ts';
import { loadKnowledgeBase } from '../src/retriever.ts';
import { createJudge, PASS_CRITERIA, summarizeJudgments, type JudgeItem } from './judge.ts';

interface DatasetCase {
  id: string;
  question: string;
  expectedSource?: string;
  answerChecks?: { id: string; anyOf: string[] }[];
  expectedRefusal?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string, context: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`Invalid "${key}" in ${context}`);
  return value;
}

function parseDataset(value: unknown): DatasetCase[] {
  if (!Array.isArray(value)) throw new Error('Eval dataset must be an array');
  return value.map((raw): DatasetCase => {
    if (!isRecord(raw)) throw new Error('Eval dataset contains an invalid case');
    const item: DatasetCase = {
      id: requiredString(raw, 'id', 'dataset case'),
      question: requiredString(raw, 'question', 'dataset case'),
    };
    if (typeof raw.expectedSource === 'string') item.expectedSource = raw.expectedSource;
    if (typeof raw.expectedRefusal === 'string') item.expectedRefusal = raw.expectedRefusal;
    if (Array.isArray(raw.answerChecks)) {
      item.answerChecks = raw.answerChecks.map((check) => {
        if (!isRecord(check) || typeof check.id !== 'string' ||
            !Array.isArray(check.anyOf) || !check.anyOf.every((entry) => typeof entry === 'string')) {
          throw new Error(`Invalid answer check in dataset case "${item.id}"`);
        }
        return { id: check.id, anyOf: check.anyOf };
      });
    }
    return item;
  });
}

function parseReportCase(value: unknown): Record<string, unknown> & {
  id: string;
  answer: string;
  actualSources: string[];
} {
  if (!isRecord(value) || typeof value.id !== 'string' ||
      typeof value.answer !== 'string' ||
      !Array.isArray(value.actualSources) ||
      !value.actualSources.every((source) => typeof source === 'string')) {
    throw new Error('Existing evaluation report contains an invalid case');
  }
  return { ...value, id: value.id, answer: value.answer, actualSources: value.actualSources };
}

const root = resolve(import.meta.dirname, '..');
const reportPath = resolve(root, 'reports/evaluation.json');
const reportValue: unknown = JSON.parse(readFileSync(reportPath, 'utf8'));
if (!isRecord(reportValue) || !isRecord(reportValue.summary) ||
    !isRecord(reportValue.thresholds) || !isRecord(reportValue.gates) ||
    !Array.isArray(reportValue.cases)) {
  throw new Error('Run "npm run eval" before running the AI judge');
}
const reportCases = reportValue.cases.map(parseReportCase);
const dataset = parseDataset(JSON.parse(readFileSync(resolve(root, 'evals/dataset.json'), 'utf8')));
const minJudgePassRate = reportValue.thresholds.minJudgePassRate;
if (typeof minJudgePassRate !== 'number' || minJudgePassRate < 0 || minJudgePassRate > 1) {
  throw new Error('evals/thresholds.json must define minJudgePassRate between 0 and 1');
}

const reportById = new Map(reportCases.map((item) => [item.id, item]));
const datasetById = new Map(dataset.map((item) => [item.id, item]));
if (reportById.size !== datasetById.size || [...datasetById.keys()].some((id) => !reportById.has(id))) {
  throw new Error('Evaluation report cases do not match evals/dataset.json; rerun "npm run eval"');
}
const docsById = new Map(loadKnowledgeBase().map((doc) => [doc.id, doc]));

const items: JudgeItem[] = dataset.map((testCase) => {
  const evaluated = reportById.get(testCase.id);
  if (!evaluated) throw new Error(`Evaluation report is missing case "${testCase.id}"`);
  const evidence = evaluated.actualSources.map((id) => {
    const doc = docsById.get(id);
    if (!doc) throw new Error(`Evaluation report references unknown source "${id}"`);
    return { id: doc.id, title: doc.title, text: docFacts(doc) };
  });
  return {
    id: testCase.id,
    question: testCase.question,
    answer: evaluated.answer,
    ...(testCase.expectedSource ? { expectedSource: testCase.expectedSource } : {}),
    actualSources: evaluated.actualSources,
    evidence,
    expectedFacts: (testCase.answerChecks ?? []).map((check) => ({ id: check.id, anyOf: check.anyOf })),
    ...(testCase.expectedRefusal ? { expectedRefusal: testCase.expectedRefusal } : {}),
    ...(typeof evaluated.actualRefusal === 'string' ? { actualRefusal: evaluated.actualRefusal } : {}),
  };
});

const judge = createJudge(process.env);
const judgments = await judge.evaluate(items);
const { passed, total, passRate, averageScores } = summarizeJudgments(judgments);
const judgeReport = {
  provider: judge.provider,
  model: judge.model,
  evaluatedAt: new Date().toISOString(),
  passed,
  total,
  passRate,
  minimumPassRate: minJudgePassRate,
  passedGate: passRate >= minJudgePassRate,
  passCriteria: PASS_CRITERIA,
  averageScores,
  ...(judge.usage ? { usage: judge.usage } : {}),
  cases: judgments,
};

const updatedCases = reportCases.map((item) => {
  const evaluation = judgments.find((judgment) => judgment.id === item.id);
  if (!evaluation) throw new Error(`Judge response omitted case "${item.id}"`);
  return { ...item, judge: evaluation };
});
const report = {
  ...reportValue,
  summary: { ...reportValue.summary, judgePassRate: passRate },
  gates: {
    ...reportValue.gates,
    judgePassRate: { actual: passRate, minimum: minJudgePassRate, passed: passRate >= minJudgePassRate },
  },
  judge: judgeReport,
  cases: updatedCases,
};
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

const reportDir = resolve(root, 'reports');
mkdirSync(reportDir, { recursive: true });
const rows = judgments.map((item) =>
  `| ${item.id} | ${item.passed ? 'PASS' : 'FAIL'} | ${item.correctness}/5 | ${item.groundedness}/5 | ${item.relevance}/5 | ${item.helpfulness}/5 | ${item.reason.replace(/\|/g, '\\|')} |`,
);
const markdown = [
  '# AI judge report',
  '',
  `- Provider: ${judge.provider} (\`${judge.model}\`)`,
  `- Evaluated: ${judgeReport.evaluatedAt}`,
  `- Passed: **${passed}/${total} (${(passRate * 100).toFixed(1)}%)**`,
  `- CI minimum: ${(minJudgePassRate * 100).toFixed(1)}%`,
  `- Gate: **${judgeReport.passedGate ? 'PASS' : 'FAIL'}**`,
  `- Pass rule: ${judgeReport.passCriteria}`,
  '',
  '| Case | Result | Correctness | Groundedness | Relevance | Helpfulness | Rationale |',
  '|---|---|---:|---:|---:|---:|---|',
  ...rows,
  '',
  'LLM judge scores are a second opinion, not ground truth. The deterministic golden checks remain the primary correctness gate.',
  '',
].join('\n');
writeFileSync(resolve(reportDir, 'ai-judge.md'), markdown);

console.log(`\nAI judge — ${judge.provider} (${judge.model})`);
console.log(`Cases passed: ${passed}/${total} (${(passRate * 100).toFixed(1)}%)`);
console.log('Average scores (1-5):', averageScores);
if (judge.usage) console.log(`Tokens: ${judge.usage.promptTokens} in / ${judge.usage.outputTokens} out`);
console.log(`Gate: ${judgeReport.passedGate ? 'PASS' : 'FAIL'} (minimum ${(minJudgePassRate * 100).toFixed(1)}%)`);
console.log('Reports: reports/ai-judge.md and reports/evaluation.json');

if (!judgeReport.passedGate) process.exitCode = 1;
