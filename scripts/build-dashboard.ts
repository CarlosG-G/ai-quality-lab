import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const reportPath = resolve(root, 'reports/evaluation.json');
const report: unknown = JSON.parse(readFileSync(reportPath, 'utf8'));
const chaosReportPath = resolve(root, 'reports/chaos-summary.json');
const chaosReport: unknown = existsSync(chaosReportPath)
  ? JSON.parse(readFileSync(chaosReportPath, 'utf8'))
  : {
    runs: 0,
    compilable: 0,
    detected: 0,
    survived: 0,
    invalid: 0,
    mutationScore: 0,
    meanDetectionMs: 0,
    healingRuns: 0,
    healedExact: 0,
    healedEquivalent: 0,
    partiallyHealed: 0,
    healingFailed: 0,
    meanHealingMs: 0,
    results: [],
  };
if (typeof report !== 'object' || report === null || Array.isArray(report)) {
  throw new Error('Evaluation report must be a JSON object; run "npm run eval" first');
}
if (typeof chaosReport !== 'object' || chaosReport === null || Array.isArray(chaosReport)) {
  throw new Error('Chaos report must be a JSON object');
}
const outputDir = resolve(root, 'site');
mkdirSync(outputDir, { recursive: true });
cpSync(resolve(root, 'dashboard/index.html'), resolve(outputDir, 'index.html'));
cpSync(resolve(root, 'dashboard/favicon.svg'), resolve(outputDir, 'favicon.svg'));
writeFileSync(resolve(outputDir, 'evaluation.json'), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(resolve(outputDir, 'chaos-summary.json'), `${JSON.stringify(chaosReport, null, 2)}\n`);
console.log(`Dashboard built at ${outputDir}`);
