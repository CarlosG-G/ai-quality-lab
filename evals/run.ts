import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ShopBot } from '../src/bot.ts';
import { createProvider } from '../src/providers/index.ts';
import type { RefusalReason } from '../src/types.ts';

interface AnswerCheck {
  id: string;
  anyOf: string[];
}

interface EvalCase {
  id: string;
  question: string;
  expectedSource?: string;
  answerChecks?: AnswerCheck[];
  expectedRefusal?: RefusalReason;
}

interface Thresholds {
  minOverallPassRate: number;
  minSourceAccuracy: number;
  minAnswerFactRate: number;
  minRefusalAccuracy: number;
  minJudgePassRate: number;
}

interface CaseResult {
  id: string;
  passed: boolean;
  expectedSource?: string;
  actualSources: string[];
  sourceHit?: boolean;
  answerFactsPassed?: number;
  answerFactsTotal?: number;
  answer: string;
  expectedRefusal?: RefusalReason;
  actualRefusal?: RefusalReason;
  latencyMs: number;
  failures: string[];
}

interface Metric {
  passed: number;
  total: number;
  rate: number;
}

interface EvalReport {
  generatedAt: string;
  provider: string;
  summary: {
    passed: number;
    total: number;
    passRate: number;
    sourceAccuracy: Metric;
    answerFactRate: Metric;
    refusalAccuracy: Metric;
    p95LatencyMs: number;
  };
  thresholds: Thresholds;
  gates: Record<string, { actual: number; minimum: number; passed: boolean }>;
  cases: CaseResult[];
}

const root = resolve(import.meta.dirname, '..');
const dataset = JSON.parse(readFileSync(resolve(root, 'evals/dataset.json'), 'utf8')) as EvalCase[];
const thresholds = JSON.parse(readFileSync(resolve(root, 'evals/thresholds.json'), 'utf8')) as Thresholds;
const providerName = process.env.EVAL_PROVIDER ?? process.env.LLM_PROVIDER ?? 'mock';
const provider = createProvider({ ...process.env, LLM_PROVIDER: providerName });
const bot = new ShopBot({ provider });

function rate(passed: number, total: number): Metric {
  return { passed, total, rate: total ? passed / total : 1 };
}

function matchesAny(answer: string, alternatives: string[]): boolean {
  const normalized = answer.toLowerCase();
  return alternatives.some((text) => normalized.includes(text.toLowerCase()));
}

const results: CaseResult[] = [];
for (const testCase of dataset) {
  let result: Awaited<ReturnType<typeof bot.ask>>;
  try {
    result = await bot.ask(testCase.question);
  } catch (error) {
    // Provider outages are not quality findings: stop without overwriting the last good report.
    console.error(`Provider "${provider.name}" failed on case "${testCase.id}": ${error instanceof Error ? error.message : error}`);
    process.exit(2);
  }
  const failures: string[] = [];
  let sourceHit: boolean | undefined;
  let answerFactsPassed: number | undefined;

  if (testCase.expectedRefusal) {
    if (!result.refused || result.reason !== testCase.expectedRefusal) {
      failures.push(`expected refusal "${testCase.expectedRefusal}", got "${result.reason ?? 'answered'}"`);
    }
  } else {
    if (result.refused) failures.push(`unexpected refusal "${result.reason}"`);
    if (testCase.expectedSource) {
      sourceHit = result.sources[0] === testCase.expectedSource;
      if (!sourceHit) failures.push(`expected top source "${testCase.expectedSource}", got "${result.sources[0] ?? 'none'}"`);
    }
    if (testCase.answerChecks) {
      answerFactsPassed = 0;
      for (const check of testCase.answerChecks) {
        if (matchesAny(result.answer, check.anyOf)) answerFactsPassed++;
        else failures.push(`answer missed fact "${check.id}"`);
      }
    }
  }

  results.push({
    id: testCase.id,
    passed: failures.length === 0,
    ...(testCase.expectedSource ? { expectedSource: testCase.expectedSource, sourceHit } : {}),
    actualSources: result.sources,
    ...(answerFactsPassed !== undefined
      ? { answerFactsPassed, answerFactsTotal: testCase.answerChecks?.length ?? 0 }
      : {}),
    answer: result.answer,
    ...(testCase.expectedRefusal ? { expectedRefusal: testCase.expectedRefusal } : {}),
    ...(result.reason ? { actualRefusal: result.reason } : {}),
    latencyMs: result.latencyMs,
    failures,
  });
}

const sourceCases = results.filter((r) => r.expectedSource !== undefined);
const answerCases = results.filter((r) => r.answerFactsTotal !== undefined);
const refusalCases = results.filter((r) => r.expectedRefusal !== undefined);
const sourceMetric = rate(sourceCases.filter((r) => r.sourceHit).length, sourceCases.length);
const answerFactTotal = answerCases.reduce((sum, r) => sum + (r.answerFactsTotal ?? 0), 0);
const answerFactPasses = answerCases.reduce((sum, r) => sum + (r.answerFactsPassed ?? 0), 0);
const refusalMetric = rate(refusalCases.filter((r) => r.passed).length, refusalCases.length);
const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
const p95Index = Math.max(0, Math.ceil(latencies.length * 0.95) - 1);
const passedCases = results.filter((r) => r.passed).length;
const report: EvalReport = {
  generatedAt: new Date().toISOString(),
  provider: provider.name,
  summary: {
    passed: passedCases,
    total: results.length,
    passRate: passedCases / results.length,
    sourceAccuracy: sourceMetric,
    answerFactRate: rate(answerFactPasses, answerFactTotal),
    refusalAccuracy: refusalMetric,
    p95LatencyMs: latencies[p95Index] ?? 0,
  },
  thresholds,
  gates: {
    overallPassRate: {
      actual: passedCases / results.length,
      minimum: thresholds.minOverallPassRate,
      passed: passedCases / results.length >= thresholds.minOverallPassRate,
    },
    sourceAccuracy: {
      actual: sourceMetric.rate,
      minimum: thresholds.minSourceAccuracy,
      passed: sourceMetric.rate >= thresholds.minSourceAccuracy,
    },
    answerFactRate: {
      actual: answerFactTotal ? answerFactPasses / answerFactTotal : 1,
      minimum: thresholds.minAnswerFactRate,
      passed: (answerFactTotal ? answerFactPasses / answerFactTotal : 1) >= thresholds.minAnswerFactRate,
    },
    refusalAccuracy: {
      actual: refusalMetric.rate,
      minimum: thresholds.minRefusalAccuracy,
      passed: refusalMetric.rate >= thresholds.minRefusalAccuracy,
    },
  },
  cases: results,
};

const reportDir = resolve(root, 'reports');
mkdirSync(reportDir, { recursive: true });
writeFileSync(resolve(reportDir, 'evaluation.json'), `${JSON.stringify(report, null, 2)}\n`);

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const rows = [
  ['Overall pass rate', pct(report.summary.passRate), pct(thresholds.minOverallPassRate)],
  ['Source accuracy', pct(sourceMetric.rate), pct(thresholds.minSourceAccuracy)],
  ['Answer fact rate', pct(report.summary.answerFactRate.rate), pct(thresholds.minAnswerFactRate)],
  ['Refusal accuracy', pct(refusalMetric.rate), pct(thresholds.minRefusalAccuracy)],
  ['p95 latency', `${report.summary.p95LatencyMs} ms`, 'informational'],
];
const markdown = [
  '# ShopBot evaluation report',
  '',
  `- Generated: ${report.generatedAt}`,
  `- Provider: \`${report.provider}\``,
  `- Cases passed: **${passedCases}/${results.length}**`,
  '',
  '| Metric | Result | CI minimum |',
  '|---|---:|---:|',
  ...rows.map(([name, actual, minimum]) => `| ${name} | ${actual} | ${minimum} |`),
  '',
  '| Case | Result | Sources | Failures |',
  '|---|---|---|---|',
  ...results.map((r) =>
    `| ${r.id} | ${r.passed ? 'PASS' : 'FAIL'} | ${r.actualSources.join(', ') || '—'} | ${r.failures.join('; ') || '—'} |`,
  ),
  '',
  'Answer excerpts are available in `evaluation.json`.',
  '',
].join('\n');
writeFileSync(resolve(reportDir, 'evaluation.md'), markdown);

console.log(`\nShopBot eval — provider: ${report.provider}`);
console.log(`Cases: ${passedCases}/${results.length} (${pct(report.summary.passRate)})`);
for (const [name, actual, minimum] of rows) {
  const gate = name === 'p95 latency' ? 'INFO' : Object.values(report.gates)[rows.findIndex((r) => r[0] === name)]?.passed ? 'PASS' : 'FAIL';
  console.log(`${gate.padEnd(4)} ${name.padEnd(20)} ${actual.padEnd(10)} (minimum: ${minimum})`);
}
for (const result of results.filter((r) => !r.passed)) {
  console.error(`FAIL ${result.id}: ${result.failures.join('; ')}`);
}
console.log(`\nReports: reports/evaluation.md and reports/evaluation.json`);

if (Object.values(report.gates).some((gate) => !gate.passed)) process.exitCode = 1;
