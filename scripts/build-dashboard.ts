import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const reportPath = resolve(root, 'reports/evaluation.json');
const report: unknown = JSON.parse(readFileSync(reportPath, 'utf8'));
if (typeof report !== 'object' || report === null || Array.isArray(report)) {
  throw new Error('Evaluation report must be a JSON object; run "npm run eval" first');
}
const outputDir = resolve(root, 'site');
mkdirSync(outputDir, { recursive: true });
cpSync(resolve(root, 'dashboard/index.html'), resolve(outputDir, 'index.html'));
writeFileSync(resolve(outputDir, 'evaluation.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Dashboard built at ${outputDir}`);
