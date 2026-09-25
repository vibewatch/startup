#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPrefetchedSourceQuotes } from './source-quote-checks.mjs';
import { checkSearchQueryProvenance, executedSearchQueries } from './search-query-checks.mjs';
import {
  EXIT,
  canonicalSourceUrl,
  isRunId,
  isSelfPublishedReportUrl,
  researchCacheDir,
  tryReadYaml,
} from './utils.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../../../..');
const contextScript = join(scriptDir, 'load-chapter-runtime-context.mjs');
const checkChapterScript = join(scriptDir, 'check-chapter.mjs');
const activeChildren = new Set();

function usage(code = EXIT.ok) {
  console.error('Usage: run-chapter-workers.mjs --report-folder <path> [--concurrency <1-8>] [--timeout-seconds <60-3600>] [--copilot-bin <path>] [--model-override <model> --effort-override <effort>] [--disable-escalation] [--dry-run] [--format json|text]');
  process.exit(code);
}

function parseArgs(argv) {
  const args = {
    reportFolder: '',
    concurrency: 8,
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
    else if (arg === '--concurrency') args.concurrency = Number(argv[++index] ?? 0);
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
      || !Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 8
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

function safeName(value) {
  return String(value).replace(/[^a-z0-9-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

function workerPrompt({ reportFolder, contextPath, poolPath, fetchLogPath }) {
  return `Use the startup-research skill to author exactly one analysis chapter as a direct worker process. Do not launch subagents or background agents.

Inputs:
- report folder: ${reportFolder}
- runtime context: ${contextPath}
- assigned search pool: ${poolPath}
- fetch trail: ${fetchLogPath}

Read references/rules.md and only the analysis-chapter section of references/contracts.md, then read the runtime context and assigned pool. Write only the chapter file named by runtimeContext.chapter.file. Scratch may be written only under runtimeContext.runCache.cacheDir.

Binding constraints:
- Use only successful prefetched URLs in the assigned pool file. Do not open or inspect search-bundle.json, because it contains URLs reserved for sibling chapters. Do not search, fetch, use curl, add a URL, or write to the fetch trail.
- Copy localEvidence.searchQueries from the pool's executedSearchQueries (query, engine, hits). Map retainedSourceRefs only to your source IDs whose URLs appear in that record's resultUrls; an empty retainedSourceRefs is valid. Do not copy resultUrls into the chapter, invent query strings, substitute Google/Bing for the recorded provider, or estimate hit counts.
- Keep fetched source files read-only. Each keyQuote is checked against its original fetched text: copy literal excerpts in their original order, using ellipses only for omissions; never substitute a paraphrase or your own analysis.
- Classify independence by the content's issuer and relationship, not its hosting domain: syndicated company releases, supplier listings, and company job reposts are still company-issued; competitor comparisons are not independent benchmarks.
- Preserve source attribution, metric names, periods, denominators and uncertainty in every claim and exhibit. Revenue is not ARR, accounting loss is not cash burn, funding raised is not cash available, and absence of a recorded incident is not proof of absence. Mark unsupported quantities as gaps rather than inventing precise values.
- Retain at least runtimeContext.chapter.gate.minNetNewSources relevant allocation:net-new sources and the relevant allocation:independent-candidate sources.
- Obey every fast cap, the exact chapter schema, source/claim IDs, and runtimeContext.policy.retryPolicy.
- Run check-chapter normal and strict. The initial run plus at most maxChapterRetries repair attempts is a hard limit; stop with a failure result if the budget is exhausted or failures do not strictly decrease.
- Do not inspect historical reports, edit sibling chapters, author report-meta or assembled artifacts, or use git.

Return a compact final line containing chapter.file, normalStatus, normalRetries, strictStatus, strictRetries, and survivingFailureDimensions.`;
}

function terminate(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill('SIGTERM');
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      for (const child of activeChildren) terminate(child);
      setTimeout(() => process.exit(signal === 'SIGINT' ? 130 : 143), 6000).unref();
    });
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

function runWorker(task, args, fetchLogPath, logsDir, routeOverride = null) {
  return new Promise((resolveWorker) => {
    const startedAt = new Date();
    const route = routeOverride ?? task.context.policy.workerRouting;
    const routeSuffix = routeOverride ? '-escalation' : '';
    const logPath = join(logsDir, `${String(task.context.chapter.order).padStart(2, '0')}-${safeName(task.context.chapter.key)}${routeSuffix}.log`);
    const log = createWriteStream(logPath, { flags: 'w' });
    let tail = '';
    let timedOut = false;
    const copilotArgs = [
      '--yolo',
      '--autopilot',
      '--excluded-tools', 'web_fetch',
      '--model', route.model,
      '-p', workerPrompt({
        reportFolder: task.reportFolder,
        contextPath: task.contextPath,
        poolPath: task.poolPath,
        fetchLogPath,
      }),
    ];
    if (route.reasoningEffort !== 'default') {
      copilotArgs.splice(copilotArgs.indexOf('-p'), 0, '--effort', route.reasoningEffort);
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
    activeChildren.add(child);
    const capture = (chunk) => {
      log.write(chunk);
      tail = `${tail}${chunk}`.slice(-32768);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', (error) => {
      capture(`\n[run-chapter-workers] spawn error: ${error.message}\n`);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      capture(`\n[run-chapter-workers] timeout after ${args.timeoutSeconds}s\n`);
      terminate(child);
    }, args.timeoutSeconds * 1000);
    child.on('close', (code, signal) => {
      activeChildren.delete(child);
      clearTimeout(timer);
      log.end();
      const completedAt = new Date();
      const credits = tail.match(/AI Credits\s+([\d.]+)/i)?.[1] ?? null;
      const tokenLine = tail.match(/^Tokens\s+.+$/im)?.[0] ?? null;
      resolveWorker({
        chapter: task.context.chapter.key,
        file: task.context.chapter.file,
        model: route.model,
        reasoningEffort: route.reasoningEffort,
        status: !timedOut && code === 0 ? 'completed' : 'failed',
        exitCode: code,
        signal,
        timedOut,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationSeconds: Number(((completedAt - startedAt) / 1000).toFixed(2)),
        aiCredits: credits === null ? null : Number(credits),
        tokenLine,
        logPath,
        tail: !timedOut && code === 0 ? undefined : tail.slice(-6000),
      });
    });
  });
}

async function runPool(tasks, concurrency, worker) {
  const results = new Array(tasks.length);
  let cursor = 0;
  async function consume() {
    while (cursor < tasks.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(tasks[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, consume));
  return results;
}

function validateChapters(tasks, reportFolder, fetchLogPath) {
  return tasks.map((task) => {
    const chapterPath = join(reportFolder, task.context.chapter.file);
    if (!existsSync(chapterPath)) {
      return {
        chapter: task.context.chapter.key,
        file: task.context.chapter.file,
        ok: false,
        error: 'worker exited without creating the chapter file',
      };
    }
    const chapter = tryReadYaml(chapterPath);
    if (!chapter.ok) {
      return {
        chapter: task.context.chapter.key,
        file: task.context.chapter.file,
        ok: false,
        error: chapter.error,
      };
    }
    const allowedUrls = new Set(
      [...(task.pool.recommended ?? []), ...(task.pool.reserve ?? [])]
        .filter((candidate) => candidate.fetch?.ok)
        .map((candidate) => canonicalSourceUrl(candidate.url))
        .filter(Boolean),
    );
    const outsidePool = (chapter.value?.localEvidence?.sources ?? [])
      .filter((source) => !allowedUrls.has(canonicalSourceUrl(source?.url)))
      .map((source) => `${source?.id ?? '?'} ${source?.url ?? '?'}`);
    if (outsidePool.length > 0) {
      return {
        chapter: task.context.chapter.key,
        file: task.context.chapter.file,
        ok: false,
        failedDimensions: ['assignedSourcePool'],
        unackedWarningDimensions: [],
        retryOrder: ['assignedSourcePool'],
        error: `chapter cited source(s) outside its successful assigned pool: ${outsidePool.join('; ')}`,
      };
    }
    const quoteIssues = checkPrefetchedSourceQuotes(
      chapter.value?.localEvidence?.sources ?? [],
      [...(task.pool.recommended ?? []), ...(task.pool.reserve ?? [])]
        .map((candidate) => ({ ...candidate.fetch, url: candidate.url })),
      task.context.chapter.file,
    );
    if (quoteIssues.length > 0) {
      return {
        chapter: task.context.chapter.key,
        file: task.context.chapter.file,
        ok: false,
        failedDimensions: ['sourceQuote'],
        unackedWarningDimensions: [],
        retryOrder: ['sourceQuote'],
        issues: quoteIssues,
        error: quoteIssues.map((issue) => `${issue.path}: ${issue.code}: ${issue.message}`).join('; '),
      };
    }
    const queryIssues = checkSearchQueryProvenance(
      chapter.value?.localEvidence, task.pool.executedSearchQueries, task.context.chapter.file,
    );
    if (queryIssues.length > 0) {
      return {
        chapter: task.context.chapter.key,
        file: task.context.chapter.file,
        ok: false,
        failedDimensions: ['searchQueryProvenance'],
        unackedWarningDimensions: [],
        retryOrder: ['searchQueryProvenance'],
        issues: queryIssues,
        error: queryIssues.map((issue) => `${issue.path}: ${issue.code}: ${issue.message}`).join('; '),
      };
    }
    const result = spawnSync(process.execPath, [
      checkChapterScript,
      reportFolder,
      task.context.chapter.file,
      '--strict',
      '--format', 'json',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, STARTUP_FETCH_LOG_PATH: fetchLogPath },
    });
    let envelope = null;
    try {
      envelope = JSON.parse(result.stdout);
    } catch {
      // Preserve raw output below when a validator crashes before JSON output.
    }
    return {
      chapter: task.context.chapter.key,
      file: task.context.chapter.file,
      ok: result.status === 0,
      exitCode: result.status,
      failedDimensions: envelope?.summary?.failedDimensions ?? [],
      unackedWarningDimensions: envelope?.summary?.unackedWarningDimensions ?? [],
      retryOrder: envelope?.retryOrder ?? [],
      error: result.status === 0 ? undefined : (result.stderr || result.stdout),
    };
  });
}

const args = parseArgs(process.argv.slice(2));
const reportFolder = resolve(args.reportFolder);
const runId = basename(reportFolder);
if (!existsSync(reportFolder) || !isRunId(runId)) {
  console.error(`[run-chapter-workers] invalid report folder: ${reportFolder}`);
  process.exit(EXIT.notFound);
}

const cacheDir = researchCacheDir(runId);
const bundlePath = join(cacheDir, 'search-bundle.json');
if (!existsSync(bundlePath)) {
  console.error(`[run-chapter-workers] missing search bundle: ${bundlePath}`);
  process.exit(EXIT.notFound);
}
const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
const selfPublishedFetches = new Set((bundle.fetchedSources ?? [])
  .filter((entry) => isSelfPublishedReportUrl(entry.url) || isSelfPublishedReportUrl(entry.finalUrl))
  .map((entry) => canonicalSourceUrl(entry.url)));
const poolByKey = new Map((bundle.chapterPools ?? []).map((pool) => [pool.key, pool]));
const roster = runJson(contextScript, ['--list', '--report-folder', reportFolder]);
const inputsDir = join(cacheDir, 'worker-inputs');
const logsDir = join(cacheDir, 'worker-logs');
mkdirSync(inputsDir, { recursive: true });
mkdirSync(logsDir, { recursive: true });

const fetchLogPath = resolve(
  process.env.STARTUP_FETCH_LOG_PATH || join(cacheDir, '_fetch-log.jsonl'),
);
function successfulWorkerPool(pool) {
  const circular = [...(pool.recommended ?? []), ...(pool.reserve ?? [])]
    .filter((candidate) => candidate.fetch?.ok && (
      isSelfPublishedReportUrl(candidate.url)
      || isSelfPublishedReportUrl(candidate.fetch.finalUrl)
      || selfPublishedFetches.has(canonicalSourceUrl(candidate.url))
    ));
  if (circular.length) {
    throw new Error(`chapter ${pool.key} has self-published report evidence in its cached pool: ${circular.map((entry) => entry.url).join(', ')}; rerun research:bootstrap before starting workers`);
  }
  return {
    ...pool,
    executedSearchQueries: executedSearchQueries(bundle, pool),
    recommended: (pool.recommended ?? []).filter((candidate) => candidate.fetch?.ok),
    reserve: (pool.reserve ?? []).filter((candidate) => candidate.fetch?.ok),
  };
}

const tasks = roster.chapters.map((chapter) => {
  const context = runJson(contextScript, [
    '--order', String(chapter.order),
    '--report-folder', reportFolder,
  ]);
  if (args.modelOverride) {
    context.policy.workerRouting = {
      ...context.policy.workerRouting,
      model: args.modelOverride,
      reasoningEffort: args.effortOverride,
      escalateTo: null,
    };
  }
  const sourcePool = poolByKey.get(chapter.key);
  if (!sourcePool) throw new Error(`search bundle is missing chapter pool ${chapter.key}`);
  const pool = successfulWorkerPool(sourcePool);
  if (pool.executedSearchQueries.length === 0) {
    throw new Error(`search bundle has no successful executed queries for chapter ${chapter.key}; restore the original discovery records before starting workers`);
  }
  const contextPath = join(inputsDir, `${String(chapter.order).padStart(2, '0')}-${chapter.key}-context.json`);
  const poolPath = join(inputsDir, `${String(chapter.order).padStart(2, '0')}-${chapter.key}-pool.json`);
  writeFileSync(contextPath, `${JSON.stringify(context, null, 2)}\n`);
  writeFileSync(poolPath, `${JSON.stringify(pool, null, 2)}\n`);
  return { reportFolder, context, pool, contextPath, poolPath };
});

const plan = {
  schemaVersion: 'chapter-worker-run-v1',
  reportFolder,
  runId,
  concurrency: args.concurrency,
  timeoutSeconds: args.timeoutSeconds,
  modelOverride: args.modelOverride || null,
  effortOverride: args.effortOverride || null,
  escalationEnabled: !args.disableEscalation,
  fetchLogPath,
  workers: tasks.map((task) => ({
    chapter: task.context.chapter.key,
    file: task.context.chapter.file,
    model: task.context.policy.workerRouting.model,
    reasoningEffort: task.context.policy.workerRouting.reasoningEffort,
    escalateTo: task.context.policy.workerRouting.escalateTo,
    contextPath: task.contextPath,
    poolPath: task.poolPath,
  })),
};

if (args.dryRun) {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(EXIT.ok);
}
if (!existsSync(fetchLogPath)) {
  console.error(`[run-chapter-workers] fetch trail does not exist: ${fetchLogPath}`);
  process.exit(EXIT.notFound);
}

if (args.format === 'text') {
  console.log(`[run-chapter-workers] starting ${tasks.length} workers (concurrency=${args.concurrency}, timeout=${args.timeoutSeconds}s)`);
}
const startedAt = new Date();
const workers = await runPool(tasks, args.concurrency, async (task) => {
  if (args.format === 'text') {
    console.log(`[run-chapter-workers] -> ${task.context.chapter.key} (${task.context.policy.workerRouting.model}/${task.context.policy.workerRouting.reasoningEffort})`);
  }
  const result = await runWorker(task, args, fetchLogPath, logsDir);
  if (args.format === 'text') {
    console.log(`[run-chapter-workers] <- ${result.chapter}: ${result.status} in ${result.durationSeconds}s`);
  }
  return result;
});
let validations = validateChapters(tasks, reportFolder, fetchLogPath);
const escalationTasks = tasks.filter((task) => {
  const validation = validations.find((entry) => entry.chapter === task.context.chapter.key);
  const route = task.context.policy.workerRouting;
  return !args.disableEscalation
    && validation?.ok === false
    && route.escalateTo
    && route.escalateTo !== route.model;
});
let escalations = [];
if (escalationTasks.length > 0) {
  if (args.format === 'text') {
    console.log(`[run-chapter-workers] escalating ${escalationTasks.length} failed chapter(s)`);
  }
  escalations = await runPool(escalationTasks, args.concurrency, async (task) => {
    const route = {
      model: task.context.policy.workerRouting.escalateTo,
      reasoningEffort: 'xhigh',
    };
    if (args.format === 'text') {
      console.log(`[run-chapter-workers] -> ${task.context.chapter.key} escalation (${route.model}/${route.reasoningEffort})`);
    }
    const result = await runWorker(task, args, fetchLogPath, logsDir, route);
    if (args.format === 'text') {
      console.log(`[run-chapter-workers] <- ${result.chapter} escalation: ${result.status} in ${result.durationSeconds}s`);
    }
    return result;
  });
  validations = validateChapters(tasks, reportFolder, fetchLogPath);
}
const completedAt = new Date();
const output = {
  ...plan,
  dryRun: false,
  startedAt: startedAt.toISOString(),
  completedAt: completedAt.toISOString(),
  durationSeconds: Number(((completedAt - startedAt) / 1000).toFixed(2)),
  workers,
  escalations,
  validations,
  ok: validations.every((validation) => validation.ok),
};
const resultPath = join(cacheDir, 'worker-results.json');
writeFileSync(resultPath, `${JSON.stringify(output, null, 2)}\n`);

if (args.format === 'json') {
  console.log(JSON.stringify(output, null, 2));
} else {
  console.log(`[run-chapter-workers] results: ${resultPath}`);
  for (const validation of validations.filter((entry) => !entry.ok)) {
    console.error(`[run-chapter-workers] validation failed: ${validation.file} (${[...validation.failedDimensions, ...validation.unackedWarningDimensions].join(', ') || 'unknown'})`);
  }
}
process.exit(output.ok ? EXIT.ok : EXIT.failure);
