#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const [
  path,
  label,
  model,
  effort,
  processStatus,
  wallSeconds,
] = process.argv.slice(2);

if (!path || !label || !model || !effort || processStatus == null || !wallSeconds) {
  console.error('Usage: summarize-worker-benchmark.mjs <worker-results.json> <label> <model> <effort> <process-status> <wall-seconds>');
  process.exit(1);
}

const result = JSON.parse(readFileSync(path, 'utf8'));
const runs = result.workers ?? [];
const credits = runs.reduce((sum, run) => sum + (run.aiCredits ?? 0), 0);
const failures = (result.validations ?? []).filter((validation) => !validation.ok);
const failedDimensions = [...new Set(failures.flatMap((failure) => [
  ...(failure.failedDimensions ?? []),
  ...(failure.unackedWarningDimensions ?? []),
]))];

console.log(`### ${label}`);
console.log(`- route: ${model}/${effort}`);
console.log(`- process status: ${processStatus}`);
console.log(`- wall seconds: ${wallSeconds}`);
console.log(`- AI credits: ${credits.toFixed(2)}`);
console.log(`- strict passes: ${(result.validations ?? []).length - failures.length}/${(result.validations ?? []).length}`);
console.log(`- failed dimensions: ${failedDimensions.join(', ') || 'none'}`);
