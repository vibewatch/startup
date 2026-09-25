#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
    [context.policy?.workerRouting?.model === 'gemini-3.8-flash', 'fast worker model is not gemini-3.8-flash'],
    [context.policy?.workerRouting?.reasoningEffort === 'default', 'fast worker reasoning effort is not default'],
    [context.policy?.workerRouting?.escalateTo === 'gpt-5.6-sol-fast', 'fast worker escalation is not gpt-5.6-sol-fast'],
    [context.policy?.finalizerRouting?.profile === 'report-finalization', 'runtime context did not select the report finalizer route'],
    [context.policy?.finalizerRouting?.model === 'gpt-5.4-mini', 'finalizer model is not gpt-5.4-mini'],
    [context.policy?.finalizerRouting?.reasoningEffort === 'medium', 'finalizer reasoning effort is not medium'],
    [context.policy?.finalizerRouting?.escalateTo === 'gpt-5.6-sol-fast', 'finalizer escalation is not gpt-5.6-sol-fast'],
  ];
  const failures = checks.filter(([ok]) => !ok).map(([, message]) => message);
  if (failures.length) throw new Error(failures.join('; '));
  writeFileSync(join(folder, 'report-meta.yaml'), '{}\n');
  const finalize = () => spawnSync(process.execPath, [
    join(here, 'finalize-report.mjs'), folder,
  ], { encoding: 'utf8' });
  for (const preassembled of [false, true]) {
    if (preassembled) writeFileSync(join(folder, 'summary-card.yaml'), '{}\n');
    const result = finalize();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /fast report is missing its search bundle/);
  }
  const assigned = 'https://example.com/assigned';
  const reserve = 'https://example.com/reserve';
  const sibling = 'https://example.com/sibling';
  const failed = 'https://example.com/failed';
  const selfPublished = 'https://startup.genisisiq.com/acme/';
  const redirected = 'https://example.com/redirected';
  const poolRedirected = 'https://example.com/pool-redirected';
  const prefetchedText = join(folder, 'prefetched.txt');
  const queryRecord = { query: 'Acme company', engine: 'anysearch', hits: 2, retainedSourceRefs: [] };
  writeFileSync(prefetchedText, 'Acme ARR is $10M. Growth is not audited.\n');
  writeFileSync(join(folder, 'search-bundle.json'), JSON.stringify({
    searches: [{
      query: queryRecord.query,
      response: { query: queryRecord.query, provider: queryRecord.engine, results: [{ url: assigned }, { url: reserve }] },
    }],
    fetchedSources: [
      { url: assigned, ok: true, outputFile: prefetchedText },
      { url: reserve, ok: true, outputFile: prefetchedText },
      { url: sibling, ok: true },
      { url: failed, ok: false },
      { url: selfPublished, ok: true },
      { url: redirected, finalUrl: selfPublished, ok: true },
      { url: poolRedirected, ok: true },
    ],
    chapterPools: [{
      key: context.chapter.key,
      recommended: [
        { url: assigned, fetch: { ok: true, outputFile: prefetchedText } },
        { url: failed, fetch: { ok: false } },
        { url: selfPublished, fetch: { ok: true } },
        { url: redirected, fetch: { ok: true } },
        { url: poolRedirected, fetch: { ok: true, finalUrl: selfPublished } },
      ],
      reserve: [{ url: reserve, fetch: { ok: true } }],
    }],
  }));
  for (const url of ['https://example.com/unfetched', failed, sibling, assigned, reserve, selfPublished, redirected, poolRedirected]) {
    writeFileSync(join(folder, context.chapter.file), JSON.stringify({
      localEvidence: { searchQueries: [queryRecord], sources: [{ id: 'SO001', url }] },
    }));
    const result = finalize();
    assert.notEqual(result.status, 0);
    if ([assigned, reserve].includes(url)) {
      assert.match(result.stderr, /missing chapter file\(s\) before strict sweep/);
      assert.doesNotMatch(result.stderr, /not successfully prefetched/);
    } else {
      assert.match(result.stderr, /not successfully prefetched/);
      assert.ok(result.stderr.includes(url));
      if (url === sibling) assert.match(result.stderr, /not eligible in this chapter's assigned pool/);
    }
  }
  for (const [keyQuote, valid] of [
    ['Acme ARR is $10M.', true],
    ['Acme ARR is $11M.', false],
    ['Acme ARR is $10M; growth has been independently verified.', false],
    ['Growth is not audited. ... Acme ARR is $10M.', false],
  ]) {
    writeFileSync(join(folder, context.chapter.file), JSON.stringify({
      localEvidence: { searchQueries: [queryRecord], sources: [{ id: 'SO001', url: assigned, keyQuote }] },
    }));
    const result = finalize();
    assert.notEqual(result.status, 0);
    if (valid) assert.match(result.stderr, /missing chapter file\(s\) before strict sweep/);
    else assert.match(result.stderr, /sourceQuoteMismatch/);
  }
  rmSync(prefetchedText);
  const missingText = finalize();
  assert.match(missingText.stderr, /sourceQuoteTextMissing/);
  const sourceRows = Array.from({ length: 8 }, (_, index) => ({
    id: `SO${String(index + 1).padStart(3, '0')}`,
    url: `https://example.com/source-${index}`,
  }));
  for (const duplicate of [true, false]) {
    sourceRows[7].url = duplicate ? `${sourceRows[0].url}?utm_source=alias` : 'https://example.com/source-7';
    writeFileSync(join(folder, context.chapter.file), JSON.stringify({ localEvidence: { sources: sourceRows } }));
    const result = spawnSync(process.execPath, [
      join(here, 'check-chapter.mjs'), folder, context.chapter.file, '--format', 'json',
    ], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    const findings = JSON.parse(result.stdout).issues.filter((issue) => issue.dimension === 'sources');
    if (duplicate) {
      assert(findings.some((issue) => issue.code === 'duplicateSourceUrl'));
      assert(findings.some((issue) => issue.actual === 7 && issue.required === 8));
    } else assert.deepEqual(findings, []);
  }
  console.log(`[check-research-profile] ✓ fast snapshot and preassembled-report source provenance verified (${basename(folder)})`);
} catch (error) {
  console.error(`[check-research-profile] ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(folder, { recursive: true, force: true });
}
