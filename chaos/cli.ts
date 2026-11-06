import { getChaosProjectRoot, runChaosCampaign, type ChaosMode } from './runner.ts';
import { healSandbox } from './healer.ts';

function parseArgs(args: string[]): { command: 'inject' | 'campaign'; seed: number; runs: number; mode: ChaosMode; keep: boolean; heal: boolean } {
  const command = args[0];
  if (command !== 'inject' && command !== 'campaign') throw new Error('Use "inject" or "campaign"');
  const options = { command, seed: 1, runs: command === 'inject' ? 1 : 10, mode: 'mixed' as ChaosMode, keep: false, heal: false };
  for (let index = 1; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--keep') {
      options.keep = true;
      continue;
    }
    if (argument === '--heal') {
      options.heal = true;
      continue;
    }
    if (argument !== '--seed' && argument !== '--runs' && argument !== '--mode') {
      throw new Error(`Unknown option "${argument}"`);
    }
    const value = args[++index];
    if (!value) throw new Error(`Missing value for ${argument}`);
    if (argument === '--seed') {
      options.seed = Number(value);
      if (!Number.isSafeInteger(options.seed)) throw new Error('--seed must be a safe integer');
    } else if (argument === '--runs') {
      options.runs = Number(value);
      if (!Number.isInteger(options.runs)) throw new Error('--runs must be an integer');
    } else {
      if (!['mutation', 'catalog', 'mixed'].includes(value)) throw new Error('--mode must be mutation, catalog or mixed');
      options.mode = value as ChaosMode;
    }
  }
  return options;
}

try {
  const options = parseArgs(process.argv.slice(2));
  const report = await runChaosCampaign({
    seed: options.seed,
    runs: options.runs,
    mode: options.mode,
    keepSandbox: options.keep,
    ...(options.heal ? { heal: (sandbox, run) => healSandbox(sandbox, getChaosProjectRoot(), run) } : {}),
    onProgress: (message) => console.log(message),
  });
  console.log([
    '',
    `Chaos campaign: ${report.detected}/${report.compilable} seeded faults detected (killed mutants)`,
    `Mutation score: ${(report.mutationScore * 100).toFixed(1)}%`,
    `Mean detection time: ${report.meanDetectionMs} ms`,
    `Autoheal: ${report.healedExact} exact, ${report.healedEquivalent} equivalent, ${report.partiallyHealed} partial, ${report.healingFailed} failed`,
    `Mean healing time: ${report.meanHealingMs} ms`,
    'Reports: reports/chaos-summary.json and reports/chaos.md',
  ].join('\n'));
  if (report.invalid) console.warn(`${report.invalid} invalid (non-compiling) mutant(s) excluded from the mutation score.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
