import type { ShopBot } from '../src/bot.ts';
import type { RefusalReason } from '../src/types.ts';

/**
 * Golden-dataset evaluation logic, kept free of I/O so it can be unit tested.
 * ISTQB terms: each dataset entry is a test case, the expected values are the test oracle,
 * and the thresholds are the exit criteria (quality gates) that CI enforces.
 */

export interface AnswerCheck {
  id: string;
  anyOf: string[];
}

export interface EvalCase {
  id: string;
  question: string;
  expectedSource?: string;
  answerChecks?: AnswerCheck[];
  expectedRefusal?: RefusalReason;
}

export interface Thresholds {
  minOverallPassRate: number;
  minSourceAccuracy: number;
  minAnswerFactRate: number;
  minRefusalAccuracy: number;
  minJudgePassRate: number;
}

export type BotAnswer = Awaited<ReturnType<ShopBot['ask']>>;

export interface CaseResult {
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

export interface Metric {
  passed: number;
  total: number;
  rate: number;
}

export interface Gate {
  actual: number;
  minimum: number;
  passed: boolean;
}

export type GateName = 'overallPassRate' | 'sourceAccuracy' | 'answerFactRate' | 'refusalAccuracy';

export interface EvalReport {
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
  gates: Record<GateName, Gate>;
  cases: CaseResult[];
}

/** A metric with no applicable cases counts as 100%: nothing in scope failed. */
export function metric(passed: number, total: number): Metric {
  return { passed, total, rate: total ? passed / total : 1 };
}

function mentionsAny(answer: string, alternatives: string[]): boolean {
  const normalized = answer.toLowerCase();
  return alternatives.some((text) => normalized.includes(text.toLowerCase()));
}

/** Compares one actual answer with the test oracle and lists every deviation found. */
export function evaluateCase(testCase: EvalCase, result: BotAnswer): CaseResult {
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
        if (mentionsAny(result.answer, check.anyOf)) answerFactsPassed++;
        else failures.push(`answer missed fact "${check.id}"`);
      }
    }
  }

  return {
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
  };
}

function percentile95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function gate(actual: number, minimum: number): Gate {
  return { actual, minimum, passed: actual >= minimum };
}

export function buildReport(
  results: CaseResult[],
  thresholds: Thresholds,
  provider: string,
  generatedAt = new Date().toISOString(),
): EvalReport {
  const sourceCases = results.filter((result) => result.expectedSource !== undefined);
  const refusalCases = results.filter((result) => result.expectedRefusal !== undefined);
  const sum = (pick: (result: CaseResult) => number | undefined): number =>
    results.reduce((total, result) => total + (pick(result) ?? 0), 0);

  const overall = metric(results.filter((result) => result.passed).length, results.length);
  const sourceAccuracy = metric(sourceCases.filter((result) => result.sourceHit).length, sourceCases.length);
  const answerFactRate = metric(sum((result) => result.answerFactsPassed), sum((result) => result.answerFactsTotal));
  const refusalAccuracy = metric(refusalCases.filter((result) => result.passed).length, refusalCases.length);

  return {
    generatedAt,
    provider,
    summary: {
      passed: overall.passed,
      total: overall.total,
      passRate: overall.rate,
      sourceAccuracy,
      answerFactRate,
      refusalAccuracy,
      p95LatencyMs: percentile95(results.map((result) => result.latencyMs)),
    },
    thresholds,
    gates: {
      overallPassRate: gate(overall.rate, thresholds.minOverallPassRate),
      sourceAccuracy: gate(sourceAccuracy.rate, thresholds.minSourceAccuracy),
      answerFactRate: gate(answerFactRate.rate, thresholds.minAnswerFactRate),
      refusalAccuracy: gate(refusalAccuracy.rate, thresholds.minRefusalAccuracy),
    },
    cases: results,
  };
}

export const GATE_LABELS: Record<GateName, string> = {
  overallPassRate: 'Overall pass rate',
  sourceAccuracy: 'Source accuracy',
  answerFactRate: 'Answer fact rate',
  refusalAccuracy: 'Refusal accuracy',
};

export function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function exitCriteriaMet(report: EvalReport): boolean {
  return Object.values(report.gates).every((item) => item.passed);
}

export function renderMarkdown(report: EvalReport): string {
  const gateRows = (Object.keys(report.gates) as GateName[]).map((name) => {
    const item = report.gates[name];
    return `| ${GATE_LABELS[name]} | ${percent(item.actual)} | ${percent(item.minimum)} | ${item.passed ? 'PASS' : 'FAIL'} |`;
  });
  return [
    '# ShopBot evaluation report',
    '',
    `- Generated: ${report.generatedAt}`,
    `- Provider: \`${report.provider}\``,
    `- Test cases passed: **${report.summary.passed}/${report.summary.total}**`,
    `- Exit criteria: **${exitCriteriaMet(report) ? 'met' : 'not met'}**`,
    '',
    '| Quality gate | Result | CI minimum | Status |',
    '|---|---:|---:|---|',
    ...gateRows,
    `| p95 latency | ${report.summary.p95LatencyMs} ms | informational | INFO |`,
    '',
    '| Test case | Result | Sources | Failures |',
    '|---|---|---|---|',
    ...report.cases.map((result) =>
      `| ${result.id} | ${result.passed ? 'PASS' : 'FAIL'} | ${result.actualSources.join(', ') || '—'} | ${result.failures.join('; ') || '—'} |`,
    ),
    '',
    'Answer excerpts are available in `evaluation.json`.',
    '',
  ].join('\n');
}
