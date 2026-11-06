import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { applyCatalogBug, BUG_CATALOG, type CatalogBug } from './catalog.ts';
import { applyMutation, collectMutations, type MutationCandidate } from './mutators.ts';
import { createSandbox, removeSandbox } from './sandbox.ts';
import { SeededRandom } from './rng.ts';

export type ChaosMode = 'mutation' | 'catalog' | 'mixed';
export type ChaosStatus = 'detected' | 'survived' | 'invalid';

export interface ChaosCheck {
  name: 'typecheck' | 'unit' | 'eval';
  passed: boolean;
  exitCode: number | null;
  output: string;
}

export interface ChaosRunReport {
  id: string;
  seed: number;
  mode: ChaosMode;
  createdAt: string;
  durationMs: number;
  status: ChaosStatus;
  detectionMs?: number;
  bug: {
    id: string;
    file: string;
    category: string;
    description: string;
    original: string;
    mutated: string;
    patch: string;
  };
  checks: ChaosCheck[];
  healing?: HealingSummary;
  sandbox?: string;
}

export type HealingStatus = 'not-needed' | 'healed-exact' | 'healed-equivalent' | 'partial' | 'failed';

export interface HealingSummary {
  status: HealingStatus;
  provider: string;
  model?: string;
  rootCauseFile?: string;
  confidence?: number;
  attempts: number;
  tokens: number;
  durationMs: number;
  diagnosis: string[];
  failure?: string;
  patch: string;
}

export interface ChaosCampaignReport {
  generatedAt: string;
  seed: number;
  mode: ChaosMode;
  runs: number;
  compilable: number;
  detected: number;
  survived: number;
  invalid: number;
  /** Killed mutants / valid (compilable) mutants. */
  mutationScore: number;
  meanDetectionMs: number;
  healingRuns: number;
  healedExact: number;
  healedEquivalent: number;
  partiallyHealed: number;
  healingFailed: number;
  meanHealingMs: number;
  results: ChaosRunReport[];
}

interface CommandResult {
  passed: boolean;
  exitCode: number | null;
  output: string;
}

interface CampaignOptions {
  seed: number;
  runs: number;
  mode: ChaosMode;
  keepSandbox?: boolean;
  onProgress?: (message: string) => void;
  heal?: (sandbox: string, run: ChaosRunReport) => Promise<HealingSummary>;
}

const OUTPUT_LIMIT = 12_000;
const CHECK_TIMEOUT_MS = 180_000;
export const MAX_HEALING_RUNS = 5;
export function getChaosProjectRoot(): string {
  return resolve(import.meta.dirname, '..');
}

function executeNode(sandbox: string, args: string[], timeout = CHECK_TIMEOUT_MS): CommandResult {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: '', LLM_PROVIDER: 'mock', EVAL_PROVIDER: 'mock' };
  delete env.GEMINI_API_KEY;
  delete env.GEMINI_API_KEYS;
  delete env.GEMINI_PAID_API_KEY;
  try {
    const output = execFileSync(process.execPath, args, {
      cwd: sandbox,
      env,
      encoding: 'utf8',
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { passed: true, exitCode: 0, output: output.slice(-OUTPUT_LIMIT) };
  } catch (error) {
    const result = error as NodeJS.ErrnoException & {
      status?: number | null;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    const stdout = typeof result.stdout === 'string' ? result.stdout : result.stdout?.toString('utf8') ?? '';
    const stderr = typeof result.stderr === 'string' ? result.stderr : result.stderr?.toString('utf8') ?? '';
    const message = result.code === 'ETIMEDOUT' ? '\nCommand timed out.' : '';
    return {
      passed: false,
      exitCode: result.status ?? null,
      output: `${stdout}\n${stderr}${message}`.slice(-OUTPUT_LIMIT),
    };
  }
}

function runTypecheck(sandbox: string): CommandResult {
  return executeNode(sandbox, [join(sandbox, 'node_modules/typescript/bin/tsc'), '--noEmit']);
}

function runUnitTests(sandbox: string): CommandResult {
  return executeNode(sandbox, [
    join(sandbox, 'node_modules/@playwright/test/cli.js'),
    'test',
    '--config=chaos/playwright.config.ts',
    '--project=unit',
  ]);
}

function runEvaluation(sandbox: string): CommandResult {
  return executeNode(sandbox, ['--env-file-if-exists=.env', 'evals/run.ts']);
}

export function runSandboxChecks(sandbox: string, includeTypecheck = true): ChaosCheck[] {
  const checks: ChaosCheck[] = [];
  if (includeTypecheck) {
    const check = runTypecheck(sandbox);
    checks.push({ name: 'typecheck', ...check });
  }
  const unit = runUnitTests(sandbox);
  checks.push({ name: 'unit', ...unit });
  const evaluation = runEvaluation(sandbox);
  checks.push({ name: 'eval', ...evaluation });
  return checks;
}

function restoreSource(repo: string, sandbox: string): void {
  rmSync(join(sandbox, 'src'), { recursive: true, force: true });
  cpSync(join(repo, 'src'), join(sandbox, 'src'), { recursive: true, dereference: true });
}

export function makePatch(file: string, before: string, after: string): string {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  let first = 0;
  while (first < beforeLines.length && beforeLines[first] === afterLines[first]) first++;
  let lastBefore = beforeLines.length - 1;
  let lastAfter = afterLines.length - 1;
  while (lastBefore > first && lastAfter > first && beforeLines[lastBefore] === afterLines[lastAfter]) {
    lastBefore--;
    lastAfter--;
  }
  const start = Math.max(0, first - 2);
  const endBefore = Math.min(beforeLines.length, lastBefore + 3);
  const endAfter = Math.min(afterLines.length, lastAfter + 3);
  const contextBefore = beforeLines.slice(start, first);
  const contextAfter = beforeLines.slice(lastBefore + 1, endBefore);
  const removed = beforeLines.slice(first, lastBefore + 1);
  const added = afterLines.slice(first, lastAfter + 1);
  return [
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${start + 1},${endBefore - start} +${start + 1},${endAfter - start} @@`,
    ...contextBefore.map((line) => ` ${line}`),
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    ...contextAfter.map((line) => ` ${line}`),
  ].join('\n');
}

function chooseCatalogBug(random: SeededRandom): CatalogBug {
  return random.pick(BUG_CATALOG);
}

function chooseMutationCandidate(
  repo: string,
  sandbox: string,
  random: SeededRandom,
): { candidate: MutationCandidate; before: string; after: string } | undefined {
  const candidates = random.shuffle(collectMutations(sandbox)).slice(0, 40);
  for (const candidate of candidates) {
    const { before, after } = applyMutation(sandbox, candidate);
    writeFileSync(join(sandbox, candidate.file), after);
    const typecheck = runTypecheck(sandbox);
    if (typecheck.passed) return { candidate, before, after };
    writeFileSync(join(sandbox, candidate.file), before);
  }
  restoreSource(repo, sandbox);
  return undefined;
}

/** A seeded fault: the defect deliberately introduced into one source file. */
interface SeededFault {
  mode: Exclude<ChaosMode, 'mixed'>;
  id: string;
  file: string;
  category: string;
  description: string;
  before: string;
  after: string;
}

function injectFault(
  repo: string,
  sandbox: string,
  random: SeededRandom,
  requestedMode: ChaosMode,
): SeededFault | undefined {
  const mode = requestedMode === 'mixed' ? random.pick(['catalog', 'mutation'] as const) : requestedMode;
  if (mode === 'catalog') {
    const bug = chooseCatalogBug(random);
    const { before, after } = applyCatalogBug(sandbox, bug);
    return { mode, ...bug, before, after };
  }

  const result = chooseMutationCandidate(repo, sandbox, random);
  if (!result) return undefined;
  return {
    mode,
    id: result.candidate.operator,
    file: result.candidate.file,
    category: 'mutation',
    description: `Changed ${result.candidate.original} to ${result.candidate.replacement} using an AST mutation.`,
    before: result.before,
    after: result.after,
  };
}

const NO_COMPILABLE_MUTATION: ChaosRunReport['bug'] = {
  id: 'no-compilable-mutation',
  file: '',
  category: 'mutation',
  description: 'No compilable AST mutation was found after 40 candidates.',
  original: '',
  mutated: '',
  patch: '',
};

function describeFault(fault: SeededFault): ChaosRunReport['bug'] {
  return {
    id: fault.id,
    file: fault.file,
    category: fault.category,
    description: fault.description,
    original: fault.before,
    mutated: fault.after,
    patch: makePatch(fault.file, fault.before, fault.after),
  };
}

function failedCheckNames(checks: ChaosCheck[]): string[] {
  return checks.filter((check) => !check.passed).map((check) => check.name);
}

function writeCampaignReports(repo: string, report: ChaosCampaignReport): void {
  const reportsDir = join(repo, 'reports', 'chaos');
  mkdirSync(reportsDir, { recursive: true });
  for (const result of report.results) {
    const { sandbox: _sandbox, ...persisted } = result;
    writeFileSync(join(reportsDir, `${result.id}.json`), `${JSON.stringify(persisted, null, 2)}\n`);
  }
  const persistedReport = {
    ...report,
    results: report.results.map(({ sandbox: _sandbox, ...result }) => result),
  };
  writeFileSync(join(repo, 'reports', 'chaos-summary.json'), `${JSON.stringify(persistedReport, null, 2)}\n`);
  const rows = report.results.map((result) =>
    `| ${result.seed} | ${result.bug.id} | ${result.bug.file} | ${result.status} | ${result.checks.filter((check) => !check.passed).map((check) => check.name).join(', ') || '—'} | ${result.healing?.status ?? '—'} |`,
  );
  const markdown = [
    '# Chaos Lab report',
    '',
    `- Seed: ${report.seed}`,
    `- Mode: ${report.mode}`,
    `- Runs: ${report.runs} (${report.compilable} compilable; ${report.invalid} invalid)`,
    `- Mutation score: ${(report.mutationScore * 100).toFixed(1)}%`,
    `- Mean detection time: ${report.meanDetectionMs} ms`,
    '',
    `- Healed: ${report.healedExact + report.healedEquivalent}/${report.healingRuns}`,
    `- Mean healing time: ${report.meanHealingMs} ms`,
    '',
    '| Seed | Bug | File | Result | Failed checks | Autoheal |',
    '|---:|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
  writeFileSync(join(repo, 'reports', 'chaos.md'), markdown);
}

function validateCampaignOptions(options: CampaignOptions): void {
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 100) {
    throw new Error('--runs must be an integer between 1 and 100');
  }
  if (options.heal && options.runs > MAX_HEALING_RUNS) {
    throw new Error(`--heal is limited to ${MAX_HEALING_RUNS} runs per campaign`);
  }
}

/** Entry criterion: the unmodified sandbox must pass every check before faults are seeded. */
function assertCleanBaseline(sandbox: string): void {
  const failed = runSandboxChecks(sandbox).filter((check) => !check.passed);
  if (failed.length) {
    throw new Error(`Clean sandbox baseline failed: ${failed.map((check) => check.name).join(', ')}\n${failed[0]?.output}`);
  }
}

interface RunContext {
  repo: string;
  sandbox: string;
  id: string;
  seed: number;
  mode: ChaosMode;
  keepSandbox?: boolean;
}

/** Seeds one fault, then runs the test suite as the oracle: any failing check kills the mutant. */
function runSingleFault(context: RunContext): ChaosRunReport {
  const started = Date.now();
  const base = { id: context.id, seed: context.seed, mode: context.mode, createdAt: new Date().toISOString() };
  const fault = injectFault(context.repo, context.sandbox, new SeededRandom(context.seed), context.mode);
  if (!fault) {
    return { ...base, durationMs: Date.now() - started, status: 'invalid', bug: NO_COMPILABLE_MUTATION, checks: [] };
  }

  const typecheck: ChaosCheck = { name: 'typecheck', ...runTypecheck(context.sandbox) };
  if (!typecheck.passed) {
    return { ...base, durationMs: Date.now() - started, status: 'invalid', bug: describeFault(fault), checks: [typecheck] };
  }

  const checks = [typecheck, ...runSandboxChecks(context.sandbox, false)];
  const durationMs = Date.now() - started;
  const detected = failedCheckNames(checks).length > 0;
  return {
    ...base,
    durationMs,
    status: detected ? 'detected' : 'survived',
    ...(detected ? { detectionMs: durationMs } : {}),
    bug: describeFault(fault),
    checks,
    ...(context.keepSandbox ? { sandbox: context.sandbox } : {}),
  };
}

async function healRun(
  heal: NonNullable<CampaignOptions['heal']>,
  sandbox: string,
  run: ChaosRunReport,
): Promise<HealingSummary> {
  try {
    return await heal(sandbox, run);
  } catch (error) {
    return {
      status: 'failed',
      provider: 'unavailable',
      attempts: 0,
      tokens: 0,
      durationMs: 0,
      diagnosis: [],
      failure: error instanceof Error ? error.message : 'Autoheal failed',
      patch: '',
    };
  }
}

function mean(values: number[]): number {
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
}

/**
 * Aggregates run results. Mutation score (ISTQB) = killed mutants / valid mutants,
 * where invalid (non-compiling) mutants are excluded from the denominator.
 */
export function summarizeCampaign(
  seed: number,
  mode: ChaosMode,
  results: ChaosRunReport[],
): ChaosCampaignReport {
  const compilable = results.filter((result) => result.status !== 'invalid');
  const detected = results.filter((result) => result.status === 'detected');
  const healing = results.flatMap((result) => result.healing ? [result.healing] : []);
  const countHealing = (status: HealingStatus): number => healing.filter((item) => item.status === status).length;
  return {
    generatedAt: new Date().toISOString(),
    seed,
    mode,
    runs: results.length,
    compilable: compilable.length,
    detected: detected.length,
    survived: results.filter((result) => result.status === 'survived').length,
    invalid: results.length - compilable.length,
    mutationScore: compilable.length ? detected.length / compilable.length : 0,
    meanDetectionMs: mean(detected.map((result) => result.detectionMs ?? 0)),
    healingRuns: healing.filter((item) => item.status !== 'not-needed').length,
    healedExact: countHealing('healed-exact'),
    healedEquivalent: countHealing('healed-equivalent'),
    partiallyHealed: countHealing('partial'),
    healingFailed: countHealing('failed'),
    meanHealingMs: mean(healing.map((item) => item.durationMs)),
    results,
  };
}

export async function runChaosCampaign(options: CampaignOptions): Promise<ChaosCampaignReport> {
  validateCampaignOptions(options);
  const repo = getChaosProjectRoot();
  const sandbox = createSandbox(repo);
  const campaignId = `chaos-${Date.now()}-${process.pid}`;
  const results: ChaosRunReport[] = [];
  const progress = options.onProgress ?? (() => undefined);

  try {
    progress('Checking clean sandbox baseline...');
    assertCleanBaseline(sandbox);

    for (let index = 0; index < options.runs; index++) {
      restoreSource(repo, sandbox);
      const seed = options.seed + index;
      progress(`Seeding fault ${index + 1}/${options.runs} (seed ${seed})...`);
      const run = runSingleFault({
        repo,
        sandbox,
        id: `${campaignId}-${index + 1}`,
        seed,
        mode: options.mode,
        keepSandbox: options.keepSandbox,
      });
      const failed = failedCheckNames(run.checks);
      progress(`Fault ${run.bug.id}: ${run.status} (${failed.join(', ') || 'all checks passed'})`);

      if (options.heal && run.status === 'detected') {
        run.healing = await healRun(options.heal, sandbox, run);
        progress(`Autoheal: ${run.healing.status} after ${run.healing.attempts} attempt(s)${run.healing.failure ? ` - ${run.healing.failure}` : ''}.`);
      }
      results.push(run);
    }
  } finally {
    if (!options.keepSandbox) removeSandbox(sandbox);
  }

  const report = summarizeCampaign(options.seed, options.mode, results);
  writeCampaignReports(repo, report);
  return report;
}
