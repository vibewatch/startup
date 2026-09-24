#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const runId = `20990101000000-profile-check-${process.pid}`;
const folder = resolve('.research-cache', runId);

function run(script, args) {
  const result = spawnSync(process.execPath, [join(here, script), ...args], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${script} exited ${result.status}`);
  }
  return result.stdout;
}

try {
  mkdirSync(folder, { recursive: true });
  run('apply-research-profile.mjs', [
    '--report-folder', folder,
    '--profile', 'fast',
  ]);
  const context = JSON.parse(run('load-chapter-runtime-context.mjs', [
    '--order', '1',
    '--report-folder', folder,
  ]));
  const expectedSource = join(folder, '.workflow-snapshot.yaml');
  const checks = [
    [context.generatedFrom === expectedSource, 'runtime context did not load the report snapshot'],
    [context.chapter.plannedTables.length === 3, 'fast profile did not trim planned tables to 3'],
    [context.chapter.plannedFigures.length === 1, 'fast profile did not trim planned figures to 1'],
    [context.chapter.gate.maxTables === 3, 'fast profile maxTables cap is not 3'],
    [context.chapter.gate.maxFigures === 1, 'fast profile maxFigures cap is not 1'],
    [context.chapter.gate.maxResearchQuestions === 10, 'fast profile question cap is not 10'],
    [context.chapter.gate.maxLocalSources === 12, 'fast profile source cap is not 12'],
    [context.chapter.gate.maxLocalClaims === 16, 'fast profile claim cap is not 16'],
    [context.chapter.gate.minNetNewSources === 2, 'fast profile net-new source floor is not 2'],
    [context.policy?.workerRouting?.profile === 'chapter-synthesis-fast', 'fast profile did not select the fast worker route'],
    [context.policy?.workerRouting?.model === 'gpt-5.4-mini', 'fast worker model is not gpt-5.4-mini'],
    [context.policy?.workerRouting?.reasoningEffort === 'medium', 'fast worker reasoning effort is not medium'],
  ];
  const failures = checks.filter(([ok]) => !ok).map(([, message]) => message);
  if (failures.length) throw new Error(failures.join('; '));
  console.log(`[check-research-profile] ✓ fast snapshot loaded by runtime context (${basename(folder)})`);
} catch (error) {
  console.error(`[check-research-profile] ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(folder, { recursive: true, force: true });
}
