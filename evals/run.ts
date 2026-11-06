import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ShopBot } from '../src/bot.ts';
import { createProvider } from '../src/providers/index.ts';
import {
  buildReport,
  evaluateCase,
  exitCriteriaMet,
  GATE_LABELS,
  percent,
  renderMarkdown,
  type CaseResult,
  type EvalCase,
  type GateName,
  type Thresholds,
} from './evaluation.ts';

const root = resolve(import.meta.dirname, '..');
const readJson = <T>(path: string): T => JSON.parse(readFileSync(resolve(root, path), 'utf8')) as T;
const dataset = readJson<EvalCase[]>('evals/dataset.json');
const thresholds = readJson<Thresholds>('evals/thresholds.json');
const providerName = process.env.EVAL_PROVIDER ?? process.env.LLM_PROVIDER ?? 'mock';
const provider = createProvider({ ...process.env, LLM_PROVIDER: providerName });
const bot = new ShopBot({ provider });

const results: CaseResult[] = [];
for (const testCase of dataset) {
  try {
    results.push(evaluateCase(testCase, await bot.ask(testCase.question)));
  } catch (error) {
    // A provider outage is an environment failure, not a defect: keep the last good report.
    console.error(`Provider "${provider.name}" failed on case "${testCase.id}": ${error instanceof Error ? error.message : error}`);
    process.exit(2);
  }
}

const report = buildReport(results, thresholds, provider.name);
const reportDir = resolve(root, 'reports');
mkdirSync(reportDir, { recursive: true });
writeFileSync(resolve(reportDir, 'evaluation.json'), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(resolve(reportDir, 'evaluation.md'), renderMarkdown(report));

console.log(`\nShopBot eval — provider: ${report.provider}`);
console.log(`Test cases: ${report.summary.passed}/${report.summary.total} (${percent(report.summary.passRate)})`);
for (const name of Object.keys(report.gates) as GateName[]) {
  const gate = report.gates[name];
  console.log(`${gate.passed ? 'PASS' : 'FAIL'} ${GATE_LABELS[name].padEnd(20)} ${percent(gate.actual).padEnd(10)} (minimum: ${percent(gate.minimum)})`);
}
console.log(`INFO ${'p95 latency'.padEnd(20)} ${report.summary.p95LatencyMs} ms`);
for (const result of results.filter((item) => !item.passed)) {
  console.error(`FAIL ${result.id}: ${result.failures.join('; ')}`);
}
console.log('\nReports: reports/evaluation.md and reports/evaluation.json');

if (!exitCriteriaMet(report)) process.exitCode = 1;
