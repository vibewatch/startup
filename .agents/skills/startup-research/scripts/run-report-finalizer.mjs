#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXIT,
  FINAL_ARTIFACTS,
  REPORT_META_FILE,
  isRunId,
  researchCacheDir,
} from './utils.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../../../..');
const contextScript = join(scriptDir, 'load-chapter-runtime-context.mjs');
const checkReportScript = join(scriptDir, 'check-report.mjs');

function usage(code = EXIT.ok) {
  console.error('Usage: run-report-finalizer.mjs --report-folder <path> [--timeout-seconds <60-3600>] [--copilot-bin <path>] [--dry-run] [--format json|text]');
  process.exit(code);
}

function parseArgs(argv) {
  const args = {
    reportFolder: '',
    timeoutSeconds: 900,
    copilotBin: process.env.COPILOT_BIN || 'copilot',
    dryRun: false,
    format: 'text',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--report-folder') args.reportFolder = argv[++index] ?? '';
    else if (arg === '--timeout-seconds') args.timeoutSeconds = Number(argv[++index] ?? 0);
    else if (arg === '--copilot-bin') args.copilotBin = argv[++index] ?? '';
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--format') args.format = argv[++index] ?? '';
    else if (arg === '--help' || arg === '-h') usage();
    else usage(EXIT.failure);
  }
  if (!args.reportFolder
      || !Number.isInteger(args.timeoutSeconds) || args.timeoutSeconds < 60 || args.timeoutSeconds > 3600
      || !args.copilotBin
      || !['json', 'text'].includes(args.format)) {
    usage(EXIT.failure);
  }
  return args;
}

function runJson(script, argv) {
  const result = spawnSync(process.execPath, [script, ...argv], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${basename(script)} exited ${result.status}`);
  }
  return JSON.parse(result.stdout);
}

function finalizerPrompt({ reportFolder, runId, resultsPath, fetchLogPath }) {
  return `Use the startup-research skill to converge and finalize the existing report at ${reportFolder}. Work directly; do not launch subagents or background agents.

Inputs:
- worker results: ${resultsPath}
- shared search bundle: ${join(researchCacheDir(runId), 'search-bundle.json')}
- fetch trail: ${fetchLogPath}

Read references/rules.md and the report-meta section of references/contracts.md. Inspect worker-results.json. Every worker process has already finished, so never rerun a passing worker or the whole worker command.

Binding sequence:
1. Walk chapters in configured order and run normal then strict validation.
2. For a timed-out/failed worker or a missing chapter, complete only that chapter directly from its worker-input context and pool. For completed workers, repair only the named normal, strict, or convergence validation failures in worker-results.json; never rewrite a chapter whose validation passed. Enforce each chapter's convergence retry budget.
3. Fast chapters may use only successful prefetched URLs in that chapter's worker-input pool. Never borrow a URL from a sibling pool even if it appears in search-bundle fetchedSources. Do not search, fetch, use curl, add a URL, or write to the fetch trail.
4. Author report-meta.yaml only after every chapter passes strict, validate it, then run finalize-report.mjs.
5. Fix only concrete validator findings with already-prefetched evidence. Do not inspect historical reports, modify repository code/config/docs, or use git.

Do not report success unless summary-card.yaml, evidence.yaml, full-report.yaml, and report-meta.yaml exist and finalize-report prints its pipeline-complete line.`;
}

function terminate(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill('SIGTERM');
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  setTimeout(() => {
    if (child.exitCode !== null) return;
    try {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }, 5000).unref();
}

const args = parseArgs(process.argv.slice(2));
const reportFolder = resolve(args.reportFolder);
const runId = basename(reportFolder);
if (!existsSync(reportFolder) || !isRunId(runId)) {
  console.error(`[run-report-finalizer] invalid report folder: ${reportFolder}`);
  process.exit(EXIT.notFound);
}
const cacheDir = researchCacheDir(runId);
const resultsPath = join(cacheDir, 'worker-results.json');
const bundlePath = join(cacheDir, 'search-bundle.json');
if (!existsSync(resultsPath) || !existsSync(bundlePath)) {
  console.error(`[run-report-finalizer] missing worker results or search bundle under ${cacheDir}`);
  process.exit(EXIT.notFound);
}
const context = runJson(contextScript, ['--order', '1', '--report-folder', reportFolder]);
const route = context.policy.workerRouting;
const fetchLogPath = resolve(
  process.env.STARTUP_FETCH_LOG_PATH || join(cacheDir, '_fetch-log.jsonl'),
);
const plan = {
  schemaVersion: 'report-finalizer-run-v1',
  reportFolder,
  runId,
  timeoutSeconds: args.timeoutSeconds,
  model: route.model,
  reasoningEffort: route.reasoningEffort,
  resultsPath,
  bundlePath,
  fetchLogPath,
};
if (args.dryRun) {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(EXIT.ok);
}
if (!existsSync(fetchLogPath)) {
  console.error(`[run-report-finalizer] fetch trail does not exist: ${fetchLogPath}`);
  process.exit(EXIT.notFound);
}

const logPath = join(cacheDir, 'finalizer.log');
const log = createWriteStream(logPath, { flags: 'w' });
let tail = '';
let timedOut = false;
const startedAt = new Date();
if (args.format === 'text') {
  console.log(`[run-report-finalizer] starting (${route.model}/${route.reasoningEffort}, timeout=${args.timeoutSeconds}s)`);
}
const child = spawn(args.copilotBin, [
  '--yolo',
  '--autopilot',
  '--excluded-tools', 'web_fetch',
  '--model', route.model,
  '--effort', route.reasoningEffort,
  '-p', finalizerPrompt({ reportFolder, runId, resultsPath, fetchLogPath }),
], {
  cwd: repoRoot,
  detached: process.platform !== 'win32',
  env: {
    ...process.env,
    STARTUP_FETCH_LOG_PATH: fetchLogPath,
    COPILOT_TASK_WAIT_TIMEOUT_SECONDS: String(args.timeoutSeconds),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const capture = (chunk) => {
  log.write(chunk);
  tail = `${tail}${chunk}`.slice(-32768);
};
child.stdout.on('data', capture);
child.stderr.on('data', capture);
child.on('error', (error) => capture(`\n[run-report-finalizer] spawn error: ${error.message}\n`));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    terminate(child);
    setTimeout(() => process.exit(signal === 'SIGINT' ? 130 : 143), 6000).unref();
  });
}
const timer = setTimeout(() => {
  timedOut = true;
  capture(`\n[run-report-finalizer] timeout after ${args.timeoutSeconds}s\n`);
  terminate(child);
}, args.timeoutSeconds * 1000);

const processResult = await new Promise((resolveResult) => {
  child.on('close', (code, signal) => resolveResult({ code, signal }));
});
clearTimeout(timer);
log.end();
const completedAt = new Date();
const requiredFiles = [
  REPORT_META_FILE,
  FINAL_ARTIFACTS.evidence.file,
  FINAL_ARTIFACTS.fullReport.file,
  FINAL_ARTIFACTS.summaryCard.file,
];
const missingFiles = requiredFiles.filter((file) => !existsSync(join(reportFolder, file)));
let reportCheck = { ok: false, exitCode: null, error: '' };
if (missingFiles.length === 0) {
  const check = spawnSync(process.execPath, [
    checkReportScript,
    reportFolder,
    '--format', 'json',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, STARTUP_FETCH_LOG_PATH: fetchLogPath },
  });
  reportCheck = {
    ok: check.status === 0,
    exitCode: check.status,
    error: check.status === 0 ? '' : (check.stderr || check.stdout),
  };
}
const output = {
  ...plan,
  dryRun: false,
  status: !timedOut && processResult.code === 0 && missingFiles.length === 0 && reportCheck.ok
    ? 'completed'
    : 'failed',
  exitCode: processResult.code,
  signal: processResult.signal,
  timedOut,
  startedAt: startedAt.toISOString(),
  completedAt: completedAt.toISOString(),
  durationSeconds: Number(((completedAt - startedAt) / 1000).toFixed(2)),
  aiCredits: Number(tail.match(/AI Credits\s+([\d.]+)/i)?.[1] ?? 0) || null,
  tokenLine: tail.match(/^Tokens\s+.+$/im)?.[0] ?? null,
  missingFiles,
  reportCheck,
  logPath,
  tail: missingFiles.length === 0 && reportCheck.ok ? undefined : tail.slice(-6000),
};
const outputPath = join(cacheDir, 'finalizer-result.json');
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
if (args.format === 'json') console.log(JSON.stringify(output, null, 2));
else {
  console.log(`[run-report-finalizer] ${output.status} in ${output.durationSeconds}s; result: ${outputPath}`);
  if (missingFiles.length) console.error(`[run-report-finalizer] missing artifacts: ${missingFiles.join(', ')}`);
  if (!reportCheck.ok && reportCheck.error) console.error(reportCheck.error);
  if (output.status === 'failed' && output.tail) {
    console.error('[run-report-finalizer] finalizer tail:');
    console.error(output.tail);
  }
}
process.exit(output.status === 'completed' ? EXIT.ok : EXIT.failure);
