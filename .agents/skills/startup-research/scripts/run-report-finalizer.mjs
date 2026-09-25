#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPrefetchedSourceQuotes } from './source-quote-checks.mjs';
import { checkSearchQueryProvenance, executedSearchQueries } from './search-query-checks.mjs';
import {
  EXIT,
  FINAL_ARTIFACTS,
  REPORT_META_FILE,
  getAnalysisArtifacts,
  isRunId,
  loadWorkflowConfig,
  readYaml,
  researchCacheDir,
} from './utils.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../../../..');
const contextScript = join(scriptDir, 'load-chapter-runtime-context.mjs');
const checkReportScript = join(scriptDir, 'check-report.mjs');

function usage(code = EXIT.ok) {
  console.error('Usage: run-report-finalizer.mjs --report-folder <path> [--review-findings <run-cache-json>] [--timeout-seconds <60-3600>] [--copilot-bin <path>] [--model-override <model> --effort-override <effort>] [--disable-escalation] [--dry-run] [--format json|text]');
  process.exit(code);
}

function parseArgs(argv) {
  const args = {
    reportFolder: '',
    reviewFindings: '',
    timeoutSeconds: 900,
    copilotBin: process.env.COPILOT_BIN || 'copilot',
    modelOverride: '',
    effortOverride: '',
    disableEscalation: false,
    dryRun: false,
    format: 'text',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--report-folder') args.reportFolder = argv[++index] ?? '';
    else if (arg === '--review-findings') {
      args.reviewFindings = argv[++index] ?? '';
      if (!args.reviewFindings) usage(EXIT.failure);
    }
    else if (arg === '--timeout-seconds') args.timeoutSeconds = Number(argv[++index] ?? 0);
    else if (arg === '--copilot-bin') args.copilotBin = argv[++index] ?? '';
    else if (arg === '--model-override') args.modelOverride = argv[++index] ?? '';
    else if (arg === '--effort-override') args.effortOverride = argv[++index] ?? '';
    else if (arg === '--disable-escalation') args.disableEscalation = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--format') args.format = argv[++index] ?? '';
    else if (arg === '--help' || arg === '-h') usage();
    else usage(EXIT.failure);
  }
  if (!args.reportFolder
      || !Number.isInteger(args.timeoutSeconds) || args.timeoutSeconds < 60 || args.timeoutSeconds > 3600
      || !args.copilotBin
      || Boolean(args.modelOverride) !== Boolean(args.effortOverride)
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

function finalizerPrompt({ reportFolder, runId, resultsPath, fetchLogPath, reviewFindings }) {
  return `Use the startup-research skill to converge and finalize the existing report at ${reportFolder}. Work directly; do not launch subagents or background agents.

Inputs:
- worker results: ${resultsPath}
- shared search bundle: ${join(researchCacheDir(runId), 'search-bundle.json')}
- fetch trail: ${fetchLogPath}

Read references/rules.md and the report-meta section of references/contracts.md. Inspect worker-results.json. Every worker process has already finished, so never rerun a passing worker or the whole worker command.

Binding sequence:
1. Walk chapters in configured order and run normal then strict validation.
2. For a timed-out/failed worker or a missing chapter, complete only that chapter directly from its worker-input context and pool. For completed workers, repair only named validator failures in worker-results.json or subsequent checks${reviewFindings ? ' and the source-review findings below' : ''}; never rewrite unrelated passing content. Enforce each chapter's convergence retry budget.
3. Fast chapters may use only successful prefetched URLs in that chapter's worker-input pool. Never borrow a URL from a sibling pool even if it appears in search-bundle fetchedSources. Do not search, fetch, use curl, add a URL, or write to the fetch trail. Keep fetched text read-only; keyQuote must contain literal, ordered excerpts, not paraphrases or reviewer commentary.
   Search logs must match actual search-bundle.json searches: literal query, response.provider, and response.results.length. retainedSourceRefs may name only chapter source URLs returned by that execution. Repair fabricated logs from the immutable execution records, not by changing the bundle or inventing new searches.
4. Author report-meta.yaml only after every chapter passes strict, validate it, then run finalize-report.mjs.${reviewFindings ? ' Preserve existing metadata except where a named finding or a corrected supporting claim requires an update.' : ''}
5. Fix only concrete validator findings${reviewFindings ? ' or the supplied source-review findings' : ''} with already-prefetched evidence. Never invent a replacement source or fact to satisfy a gate. Do not inspect historical reports, modify repository code/config/docs, or use git.
${reviewFindings ? `
Source-review findings (human/agent review, not automated validator output):
${JSON.stringify(reviewFindings, null, 2)}

Resolve every listed issue against the original fetched text, including its linked claims, tables, figures, cover facts, and metadata. Preserve date, unit, metric denominator, and attribution. If the available evidence does not support a metric, remove the unsupported precision and document the gap; do not invent a midpoint or relabel an assumption as reported. Preserve valid historical comparisons by dating them explicitly. Do not edit the review-findings input. In your final response, account for every finding and state any unresolved blocker. A schema pass alone does not establish factual accuracy.
` : ''}

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
const config = loadWorkflowConfig({ reportFolder });
let reviewFindings = null;
const reviewFindingsPath = args.reviewFindings ? resolve(args.reviewFindings) : null;
if (reviewFindingsPath) {
  try {
    if (!reviewFindingsPath.startsWith(`${cacheDir}${sep}`)) {
      throw new Error(`review findings must live under ${cacheDir}`);
    }
    reviewFindings = JSON.parse(readFileSync(reviewFindingsPath, 'utf8'));
    const authoredFiles = new Set([
      REPORT_META_FILE,
      ...getAnalysisArtifacts(config).map((chapter) => chapter.file),
    ]);
    if (reviewFindings?.runId !== runId
        || !Array.isArray(reviewFindings.issues) || reviewFindings.issues.length === 0
        || reviewFindings.issues.some((issue) => (
          !issue || !['path', 'message', 'fix'].every((key) => typeof issue[key] === 'string' && issue[key].trim())
          || !authoredFiles.has(issue.path.split(':')[0])
        ))) {
      throw new Error('expected this runId and nonempty issues with authored-file path, message, and fix');
    }
  } catch (error) {
    console.error(`[run-report-finalizer] invalid review findings: ${error.message}`);
    process.exit(EXIT.failure);
  }
}
const resultsPath = join(cacheDir, 'worker-results.json');
const bundlePath = join(cacheDir, 'search-bundle.json');
if (!existsSync(resultsPath) || !existsSync(bundlePath)) {
  console.error(`[run-report-finalizer] missing worker results or search bundle under ${cacheDir}`);
  process.exit(EXIT.notFound);
}
const context = runJson(contextScript, ['--order', '1', '--report-folder', reportFolder]);
const route = args.modelOverride
  ? {
      ...context.policy.finalizerRouting,
      model: args.modelOverride,
      reasoningEffort: args.effortOverride,
      escalateTo: null,
    }
  : context.policy.finalizerRouting;
const fetchLogPath = resolve(
  process.env.STARTUP_FETCH_LOG_PATH || join(cacheDir, '_fetch-log.jsonl'),
);
const plan = {
  schemaVersion: 'report-finalizer-run-v1',
  reportFolder,
  runId,
  timeoutSeconds: args.timeoutSeconds,
  modelOverride: args.modelOverride || null,
  effortOverride: args.effortOverride || null,
  escalationEnabled: !args.disableEscalation,
  model: route.model,
  reasoningEffort: route.reasoningEffort,
  escalateTo: route.escalateTo,
  escalationReasoningEffort: 'xhigh',
  resultsPath,
  bundlePath,
  fetchLogPath,
  reviewFindingsPath,
  reviewFindingCount: reviewFindings?.issues.length ?? 0,
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
const startedAt = new Date();
if (args.format === 'text') {
  console.log(`[run-report-finalizer] starting (${route.model}/${route.reasoningEffort}, timeout=${args.timeoutSeconds}s)`);
}
const capture = (chunk) => {
  log.write(chunk);
  tail = `${tail}${chunk}`.slice(-32768);
};
let activeChild = null;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (activeChild) terminate(activeChild);
    setTimeout(() => process.exit(signal === 'SIGINT' ? 130 : 143), 6000).unref();
  });
}

async function runAttempt(attemptRoute, attemptNumber) {
  const attemptStartedAt = new Date();
  let attemptTail = '';
  let timedOut = false;
  capture(`\n[run-report-finalizer] attempt ${attemptNumber}: ${attemptRoute.model}/${attemptRoute.reasoningEffort}\n`);
  const copilotArgs = [
    '--yolo',
    '--autopilot',
    '--excluded-tools', 'web_fetch',
    '--model', attemptRoute.model,
    '-p', finalizerPrompt({ reportFolder, runId, resultsPath, fetchLogPath, reviewFindings }),
  ];
  if (attemptRoute.reasoningEffort !== 'default') {
    copilotArgs.splice(copilotArgs.indexOf('-p'), 0, '--effort', attemptRoute.reasoningEffort);
  }
  const child = spawn(args.copilotBin, copilotArgs, {
    cwd: repoRoot,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      STARTUP_FETCH_LOG_PATH: fetchLogPath,
      COPILOT_TASK_WAIT_TIMEOUT_SECONDS: String(args.timeoutSeconds),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeChild = child;
  const captureAttempt = (chunk) => {
    capture(chunk);
    attemptTail = `${attemptTail}${chunk}`.slice(-32768);
  };
  child.stdout.on('data', captureAttempt);
  child.stderr.on('data', captureAttempt);
  child.on('error', (error) => captureAttempt(`\n[run-report-finalizer] spawn error: ${error.message}\n`));
  const timer = setTimeout(() => {
    timedOut = true;
    captureAttempt(`\n[run-report-finalizer] timeout after ${args.timeoutSeconds}s\n`);
    terminate(child);
  }, args.timeoutSeconds * 1000);
  const processResult = await new Promise((resolveResult) => {
    child.on('close', (code, signal) => resolveResult({ code, signal }));
  });
  clearTimeout(timer);
  activeChild = null;
  const completedAt = new Date();
  return {
    model: attemptRoute.model,
    reasoningEffort: attemptRoute.reasoningEffort,
    exitCode: processResult.code,
    signal: processResult.signal,
    timedOut,
    startedAt: attemptStartedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationSeconds: Number(((completedAt - attemptStartedAt) / 1000).toFixed(2)),
    aiCredits: Number(attemptTail.match(/AI Credits\s+([\d.]+)/i)?.[1] ?? 0) || null,
    tokenLine: attemptTail.match(/^Tokens\s+.+$/im)?.[0] ?? null,
  };
}

const attempts = [await runAttempt(route, 1)];
let processResult = attempts[0];
const requiredFiles = [
  REPORT_META_FILE,
  FINAL_ARTIFACTS.evidence.file,
  FINAL_ARTIFACTS.fullReport.file,
  FINAL_ARTIFACTS.summaryCard.file,
];
function inspectFinalReport() {
  const missingFiles = requiredFiles.filter((file) => !existsSync(join(reportFolder, file)));
  if (missingFiles.length > 0) {
    return {
      missingFiles,
      reportCheck: { ok: false, exitCode: null, error: '' },
    };
  }
  const check = spawnSync(process.execPath, [
    checkReportScript,
    reportFolder,
    '--format', 'json',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, STARTUP_FETCH_LOG_PATH: fetchLogPath },
  });
  const quoteIssues = [];
  const queryIssues = [];
  if (check.status === 0 && config.activeResearchProfile === 'fast') {
    const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
    const queries = executedSearchQueries(bundle);
    for (const file of [...getAnalysisArtifacts(config).map((chapter) => chapter.file), FINAL_ARTIFACTS.evidence.file]) {
      const document = readYaml(join(reportFolder, file));
      if (file !== FINAL_ARTIFACTS.evidence.file) {
        queryIssues.push(...checkSearchQueryProvenance(document.localEvidence, queries, file));
      }
      quoteIssues.push(...checkPrefetchedSourceQuotes(
        file === FINAL_ARTIFACTS.evidence.file ? document.sources ?? [] : document.localEvidence?.sources ?? [],
        bundle.fetchedSources ?? [],
        file,
      ));
    }
  }
  return {
    missingFiles,
    reportCheck: {
      ok: check.status === 0 && quoteIssues.length === 0 && queryIssues.length === 0,
      exitCode: check.status,
      error: check.status === 0
        ? [...quoteIssues, ...queryIssues].map((issue) => `${issue.path}: ${issue.code}: ${issue.message}`).join('\n')
        : (check.stderr || check.stdout),
      quoteIssues,
      queryIssues,
    },
  };
}

let finalReport = inspectFinalReport();
if ((processResult.timedOut || processResult.exitCode !== 0
      || finalReport.missingFiles.length > 0 || !finalReport.reportCheck.ok)
    && !args.disableEscalation
    && route.escalateTo && route.escalateTo !== route.model) {
  if (args.format === 'text') {
    console.log(`[run-report-finalizer] escalating failed finalizer to ${route.escalateTo}/xhigh`);
  }
  attempts.push(await runAttempt({
    model: route.escalateTo,
    reasoningEffort: 'xhigh',
  }, 2));
  processResult = attempts[1];
  finalReport = inspectFinalReport();
}
log.end();
const completedAt = new Date();
const { missingFiles, reportCheck } = finalReport;
const output = {
  ...plan,
  dryRun: false,
  status: !processResult.timedOut && processResult.exitCode === 0 && missingFiles.length === 0 && reportCheck.ok
    ? 'completed'
    : 'failed',
  exitCode: processResult.exitCode,
  signal: processResult.signal,
  timedOut: processResult.timedOut,
  startedAt: startedAt.toISOString(),
  completedAt: completedAt.toISOString(),
  durationSeconds: Number(((completedAt - startedAt) / 1000).toFixed(2)),
  aiCredits: attempts.reduce((total, attempt) => total + (attempt.aiCredits || 0), 0) || null,
  tokenLine: attempts.at(-1)?.tokenLine ?? null,
  attempts,
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
