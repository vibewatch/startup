#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkSearchQueryProvenance, executedSearchQueries } from './search-query-checks.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const runId = `20990101000000-worker-check-${process.pid}`;
const folder = resolve('.research-cache', runId);
const bundlePath = join(folder, 'search-bundle.json');

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
  const roster = JSON.parse(run('load-chapter-runtime-context.mjs', [
    '--list',
    '--report-folder', folder,
  ]));
  const queryRecord = {
    query: 'Acme company profile',
    engine: 'anysearch',
    hits: roster.totalChapters,
    retainedSourceRefs: [],
  };
  writeFileSync(bundlePath, `${JSON.stringify({
    schemaVersion: 'search-bundle-v1',
    searches: [{
      scope: 'global',
      query: queryRecord.query,
      response: {
        query: queryRecord.query,
        provider: queryRecord.engine,
        results: roster.chapters.map((chapter) => ({ url: `https://${chapter.key}.example/success` })),
      },
    }],
    chapterPools: roster.chapters.map((chapter) => ({
      key: chapter.key,
      recommended: [
        { url: `https://${chapter.key}.example/success`, fetch: { ok: true } },
        { url: `https://${chapter.key}.example/failure`, fetch: { ok: false } },
      ],
      reserve: [
        { url: `https://${chapter.key}.example/unfetched` },
      ],
    })),
    fetchedSources: [],
  }, null, 2)}\n`);
  const plan = JSON.parse(run('run-chapter-workers.mjs', [
    '--report-folder', folder,
    '--dry-run',
    '--format', 'json',
  ]));
  const benchmarkPlan = JSON.parse(run('run-chapter-workers.mjs', [
    '--report-folder', folder,
    '--model-override', 'gemini-3.8-flash',
    '--effort-override', 'default',
    '--disable-escalation',
    '--dry-run',
    '--format', 'json',
  ]));
  const workerPools = plan.workers.map((worker) => (
    JSON.parse(readFileSync(worker.poolPath, 'utf8'))
  ));
  for (const pool of workerPools) {
    assert.deepEqual(pool.executedSearchQueries, [{
      query: queryRecord.query,
      engine: queryRecord.engine,
      hits: roster.totalChapters,
      resultUrls: [pool.recommended[0].url],
    }], 'worker query projection changed hit counts or exposed sibling URLs');
  }
  const records = executedSearchQueries(JSON.parse(readFileSync(bundlePath, 'utf8')));
  const queryEvidence = {
    searchQueries: [{ ...queryRecord, retainedSourceRefs: ['SO001'] }],
    sources: [{ id: 'SO001', url: `${workerPools[0].recommended[0].url}?utm_source=alias` }],
  };
  assert.deepEqual(checkSearchQueryProvenance(queryEvidence, records, 'chapter.yaml'), []);
  for (const [patch, code] of [
    [{ query: 'Acme invented lookup 2099' }, 'searchQueryNotExecuted'],
    [{ engine: 'google' }, 'searchQueryMetadataMismatch'],
    [{ hits: 999 }, 'searchQueryMetadataMismatch'],
    [{ retainedSourceRefs: ['SO999'] }, 'searchQuerySourceMismatch'],
  ]) {
    const evidence = { ...queryEvidence, searchQueries: [{ ...queryEvidence.searchQueries[0], ...patch }] };
    assert.equal(checkSearchQueryProvenance(evidence, records, 'chapter.yaml')[0]?.code, code);
  }
  assert.equal(checkSearchQueryProvenance(queryEvidence, [], 'chapter.yaml')[0]?.code, 'searchQueryProvenanceMissing');
  assert.equal(checkSearchQueryProvenance({ ...queryEvidence, searchQueries: [] }, records, 'chapter.yaml')[0]?.code, 'searchQueryProvenanceMissing');
  assert.equal(checkSearchQueryProvenance({
    ...queryEvidence, sources: [{ id: 'SO001', url: 'https://not-a-result.example/seeded' }],
  }, records, 'chapter.yaml')[0]?.code, 'searchQuerySourceMismatch');
  assert.deepEqual(executedSearchQueries({ searches: [{ query: queryRecord.query, error: 'provider failed' }] }), []);
  writeFileSync(join(folder, 'worker-results.json'), `${JSON.stringify({
    schemaVersion: 'chapter-worker-run-v1',
    workers: [],
    validations: [],
    ok: true,
  }, null, 2)}\n`);
  const finalizer = JSON.parse(run('run-report-finalizer.mjs', [
    '--report-folder', folder,
    '--dry-run',
    '--format', 'json',
  ]));
  const benchmarkFinalizer = JSON.parse(run('run-report-finalizer.mjs', [
    '--report-folder', folder,
    '--model-override', 'gemini-3.8-flash',
    '--effort-override', 'default',
    '--disable-escalation',
    '--dry-run',
    '--format', 'json',
  ]));
  const fakeCopilotPath = join(folder, 'fake-copilot.mjs');
  const fakeCopilotLogPath = join(folder, 'fake-copilot.log');
  const reviewFindingsPath = join(folder, 'source-review.json');
  const reviewFindings = {
    runId,
    issues: [{
      path: 'report-meta.yaml:summary.keyMetrics.revenueGrowthYoYPct',
      message: 'Half-year growth is not year-over-year growth.',
      fix: 'Use null unless the fetched evidence supplies a year-over-year comparison.',
    }],
  };
  const reviewArgs = [
    '--report-folder', folder, '--review-findings', reviewFindingsPath, '--dry-run', '--format', 'json',
  ];
  for (const invalid of [
    { ...reviewFindings, runId: '20990101000000-another-report' },
    { runId, issues: [] },
    { runId, issues: [{ ...reviewFindings.issues[0], path: 'full-report.yaml' }] },
    { runId, issues: [{ ...reviewFindings.issues[0], path: '../other/report-meta.yaml' }] },
    { runId, issues: [{ ...reviewFindings.issues[0], fix: '' }] },
    { runId, issues: [null] },
  ]) {
    writeFileSync(reviewFindingsPath, JSON.stringify(invalid));
    const result = spawnSync(process.execPath, [join(here, 'run-report-finalizer.mjs'), ...reviewArgs], { encoding: 'utf8' });
    assert.equal(result.status, 1, 'invalid review findings were accepted');
    assert.match(result.stderr, /invalid review findings/);
  }
  writeFileSync(reviewFindingsPath, JSON.stringify(reviewFindings));
  const reviewPlan = JSON.parse(run('run-report-finalizer.mjs', reviewArgs));
  assert.equal(reviewPlan.reviewFindingsPath, reviewFindingsPath);
  assert.equal(reviewPlan.reviewFindingCount, 1);
  assert.equal(finalizer.reviewFindingCount, 0);
  const outsideReview = spawnSync(process.execPath, [
    join(here, 'run-report-finalizer.mjs'), '--report-folder', folder,
    '--review-findings', join(folder, '..', 'another-run', 'source-review.json'), '--dry-run',
  ], { encoding: 'utf8' });
  assert.equal(outsideReview.status, 1);
  assert.match(outsideReview.stderr, /review findings must live under/);
  writeFileSync(join(folder, '_fetch-log.jsonl'), '{}\n');
  writeFileSync(fakeCopilotPath, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FAKE_COPILOT_LOG, \`\${JSON.stringify(process.argv.slice(2))}\\n\`);
process.exit(Number(process.env.FAKE_COPILOT_EXIT ?? 1));
`);
  chmodSync(fakeCopilotPath, 0o755);
  const fallbackProbe = spawnSync(process.execPath, [
    join(here, 'run-report-finalizer.mjs'),
    '--report-folder', folder,
    '--review-findings', reviewFindingsPath,
    '--timeout-seconds', '60',
    '--copilot-bin', fakeCopilotPath,
    '--format', 'json',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FAKE_COPILOT_LOG: fakeCopilotLogPath,
      STARTUP_FETCH_LOG_PATH: join(folder, '_fetch-log.jsonl'),
    },
  });
  const fallbackInvocations = readFileSync(fakeCopilotLogPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  for (const invocation of fallbackInvocations) {
    const prompt = invocation[invocation.indexOf('-p') + 1];
    assert(prompt.includes(reviewFindings.issues[0].message));
    assert(prompt.includes(reviewFindings.issues[0].fix));
    assert(prompt.includes('never rewrite unrelated passing content'));
    assert(prompt.includes('A schema pass alone does not establish factual accuracy'));
  }
  const quoteTextPath = join(folder, 'quote-source.txt');
  writeFileSync(quoteTextPath, 'The original source text.\n');
  const quoteBundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
  for (const chapter of roster.chapters) {
    const pool = quoteBundle.chapterPools.find((entry) => entry.key === chapter.key);
    pool.recommended[0].fetch.outputFile = quoteTextPath;
    writeFileSync(join(folder, chapter.file), JSON.stringify({
      localEvidence: {
        searchQueries: [queryRecord],
        sources: [{ id: `S${chapter.letter}001`, url: pool.recommended[0].url, keyQuote: 'Invented quotation.' }],
      },
    }));
  }
  quoteBundle.fetchedSources = quoteBundle.chapterPools.map((pool) => ({
    ...pool.recommended[0].fetch, url: pool.recommended[0].url,
  }));
  writeFileSync(bundlePath, JSON.stringify(quoteBundle));
  const quoteProbe = spawnSync(process.execPath, [
    join(here, 'run-chapter-workers.mjs'), '--report-folder', folder,
    '--copilot-bin', fakeCopilotPath, '--disable-escalation', '--format', 'json',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FAKE_COPILOT_LOG: join(folder, 'fake-quote-workers.log'),
      FAKE_COPILOT_EXIT: '0',
      STARTUP_FETCH_LOG_PATH: join(folder, '_fetch-log.jsonl'),
    },
  });
  assert.equal(quoteProbe.status, 1, quoteProbe.stderr);
  const quoteResults = JSON.parse(quoteProbe.stdout);
  assert.equal(quoteResults.validations.length, roster.totalChapters);
  assert(quoteResults.validations.every((entry) => !entry.ok && entry.issues?.[0]?.code === 'sourceQuoteMismatch'),
    'a success-shaped worker exit hid fabricated quotations');
  for (const file of ['report-meta.yaml', 'summary-card.yaml', 'full-report.yaml', 'evidence.yaml']) {
    writeFileSync(join(folder, file), '{}\n');
  }
  for (const compiledOnly of [false, true]) {
    if (compiledOnly) {
      for (const chapter of roster.chapters) {
        const path = join(folder, chapter.file);
        const document = JSON.parse(readFileSync(path, 'utf8'));
        document.localEvidence.sources[0].keyQuote = 'The original source text.';
        writeFileSync(path, JSON.stringify(document));
      }
      writeFileSync(join(folder, 'evidence.yaml'), JSON.stringify({
        sources: [{
          id: 'SO001', url: quoteBundle.fetchedSources[0].url, keyQuote: 'Invented compiled quotation.',
        }],
      }));
    }
    const script = join(here, 'run-report-finalizer.mjs');
    const argv = [
      process.execPath, script, '--report-folder', folder,
      '--copilot-bin', fakeCopilotPath, '--disable-escalation', '--format', 'json',
    ];
    const finalizerQuoteProbe = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const original = childProcess.spawnSync;
      childProcess.spawnSync = (binary, args, options) =>
        args[0] === ${JSON.stringify(join(here, 'check-report.mjs'))}
          ? { status: 0, stdout: '', stderr: '' }
          : original(binary, args, options);
      syncBuiltinESMExports();
      process.argv = ${JSON.stringify(argv)};
      await import(${JSON.stringify(pathToFileURL(script).href)});
    `], {
      encoding: 'utf8',
      env: {
        ...process.env,
        FAKE_COPILOT_LOG: join(folder, 'fake-quote-finalizer.log'),
        FAKE_COPILOT_EXIT: '0',
        STARTUP_FETCH_LOG_PATH: join(folder, '_fetch-log.jsonl'),
      },
    });
    assert.equal(finalizerQuoteProbe.status, 1, 'a success-shaped finalizer exit hid fabricated quotations');
    const output = JSON.parse(finalizerQuoteProbe.stdout);
    assert.equal(output.status, 'failed');
    assert.equal(output.reportCheck.ok, false);
    assert(output.reportCheck.quoteIssues.every((issue) => issue.code === 'sourceQuoteMismatch'));
    assert(output.reportCheck.quoteIssues.some((issue) => issue.path.startsWith(compiledOnly ? 'evidence.yaml:' : roster.chapters[0].file)));
  }
  for (const [keyQuote, valid] of [
    ['Invented compiled quotation.', false],
    ['The original source text.', true],
  ]) {
    writeFileSync(join(folder, 'evidence.yaml'), JSON.stringify({
      sources: [{ id: 'SO001', url: quoteBundle.fetchedSources[0].url, keyQuote }],
    }));
    const script = join(here, 'finalize-report.mjs');
    const directQuoteProbe = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      childProcess.spawnSync = () => ({ status: 0, stdout: '', stderr: '' });
      syncBuiltinESMExports();
      process.argv = ${JSON.stringify([process.execPath, script, folder])};
      await import(${JSON.stringify(pathToFileURL(script).href)});
    `], { encoding: 'utf8' });
    assert.equal(directQuoteProbe.status, valid ? 0 : 1, directQuoteProbe.stderr);
    if (valid) assert.match(directQuoteProbe.stdout, /pipeline complete/);
    else {
      assert.match(directQuoteProbe.stderr, /evidence\.yaml:.*sourceQuoteMismatch/);
      assert.doesNotMatch(directQuoteProbe.stdout, /pipeline complete/);
    }
  }
  const queryChapterPath = join(folder, roster.chapters[0].file);
  const queryChapter = JSON.parse(readFileSync(queryChapterPath, 'utf8'));
  queryChapter.localEvidence.searchQueries[0].query = 'Invented query';
  writeFileSync(queryChapterPath, JSON.stringify(queryChapter));
  for (const scriptName of ['run-chapter-workers.mjs', 'run-report-finalizer.mjs', 'finalize-report.mjs']) {
    const script = join(here, scriptName);
    const argv = scriptName === 'finalize-report.mjs'
      ? [process.execPath, script, folder]
      : [process.execPath, script, '--report-folder', folder, '--copilot-bin', fakeCopilotPath, '--disable-escalation', '--format', 'json'];
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const original = childProcess.spawnSync;
      childProcess.spawnSync = (binary, args, options) =>
        args[0] === ${JSON.stringify(join(here, 'check-report.mjs'))}
          ? { status: 0, stdout: '', stderr: '' }
          : original(binary, args, options);
      syncBuiltinESMExports();
      process.argv = ${JSON.stringify(argv)};
      await import(${JSON.stringify(pathToFileURL(script).href)});
    `], {
      encoding: 'utf8',
      env: {
        ...process.env,
        FAKE_COPILOT_LOG: join(folder, 'fake-query-provenance.log'),
        FAKE_COPILOT_EXIT: '0',
        STARTUP_FETCH_LOG_PATH: join(folder, '_fetch-log.jsonl'),
      },
    });
    assert.equal(probe.status, 1, `${scriptName} accepted an invented query`);
    assert.match(probe.stderr + probe.stdout, /searchQueryNotExecuted/);
  }
  const companyWorkflow = readFileSync(resolve('.github/workflows/company.yml'), 'utf8');
  const checks = [
    [plan.runId === basename(folder), 'runner emitted the wrong runId'],
    [plan.concurrency === 8, 'runner default concurrency is not 8'],
    [plan.timeoutSeconds === 900, 'runner default timeout is not 900 seconds'],
    [plan.workers.length === roster.totalChapters, 'runner did not schedule every chapter'],
    [plan.workers.every((worker) => worker.model === 'gemini-3.8-flash'), 'runner did not use Gemini'],
    [plan.workers.every((worker) => worker.reasoningEffort === 'default'), 'runner did not use Gemini default effort'],
    [plan.workers.every((worker) => worker.escalateTo === 'gpt-5.6-sol-fast'), 'runner did not retain the Sol Fast quality fallback'],
    [workerPools.every((pool) => pool.recommended.length === 1), 'worker pool retained an unsuccessful recommended source'],
    [workerPools.every((pool) => pool.reserve.length === 0), 'worker pool retained an unfetched reserve source'],
    [benchmarkPlan.workers.every((worker) => worker.model === 'gemini-3.8-flash'), 'benchmark model override did not reach every worker'],
    [benchmarkPlan.workers.every((worker) => worker.reasoningEffort === 'default'), 'benchmark effort override did not reach every worker'],
    [benchmarkPlan.workers.every((worker) => worker.escalateTo === null), 'benchmark override retained a hidden escalation'],
    [benchmarkPlan.escalationEnabled === false, 'benchmark plan did not disable escalation'],
    [finalizer.model === 'gpt-5.4-mini', 'finalizer did not use Mini'],
    [finalizer.reasoningEffort === 'medium', 'finalizer did not use Mini medium effort'],
    [finalizer.escalateTo === 'gpt-5.6-sol-fast', 'finalizer did not retain the Sol Fast quality fallback'],
    [finalizer.escalationReasoningEffort === 'xhigh', 'finalizer escalation effort is not xhigh'],
    [finalizer.timeoutSeconds === 900, 'finalizer default timeout is not 900 seconds'],
    [benchmarkFinalizer.model === 'gemini-3.8-flash', 'benchmark finalizer model override was ignored'],
    [benchmarkFinalizer.reasoningEffort === 'default', 'benchmark finalizer effort override was ignored'],
    [benchmarkFinalizer.escalateTo === null, 'benchmark finalizer retained a hidden escalation'],
    [benchmarkFinalizer.escalationEnabled === false, 'benchmark finalizer did not disable escalation'],
    [fallbackProbe.status === 1, 'synthetic finalizer failure did not remain a failure'],
    [fallbackInvocations.length === 2, 'finalizer did not make exactly one bounded fallback attempt'],
    [fallbackInvocations[0]?.includes('gpt-5.4-mini') && fallbackInvocations[0]?.includes('medium'), 'finalizer primary attempt did not use Mini/medium'],
    [fallbackInvocations[1]?.includes('gpt-5.6-sol-fast') && fallbackInvocations[1]?.includes('xhigh'), 'finalizer fallback did not use Sol Fast/xhigh'],
    [companyWorkflow.includes('create-report-run.mjs "$COMPANY"'), 'company workflow does not create reports deterministically'],
    [companyWorkflow.includes('npm run research:workers -- --report-folder "$REPORT_FOLDER"'), 'company workflow does not invoke the bounded worker runner directly'],
    [companyWorkflow.includes('npm run research:finalize -- --report-folder "$REPORT_FOLDER"'), 'company workflow does not invoke the bounded finalizer directly'],
    [!companyWorkflow.includes('copilot --yolo'), 'company workflow still uses a parent Copilot orchestration session'],
  ];
  const failures = checks.filter(([ok]) => !ok).map(([, message]) => message);
  if (failures.length) throw new Error(failures.join('; '));
  console.log(`[check-chapter-workers] ✓ ${plan.workers.length} independently routed workers + bounded finalizer (${basename(folder)})`);
} catch (error) {
  console.error(`[check-chapter-workers] ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(folder, { recursive: true, force: true });
}
