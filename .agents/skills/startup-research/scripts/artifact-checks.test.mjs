import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import { canonicalCacheKey, cleanExtractedText, htmlToText, isAccessErrorResponse, looksLikeBotChallenge, readerUrl } from '../../fetch-url/scripts/fetch.mjs';
import { checkAuthoringInstructions, checkFigureDeep } from './artifact-checks.mjs';
import { KNOWN_DIMENSIONS, WARNING_DIMENSIONS } from './validation-catalog.mjs';
import { checkDistinctChapterSources, checkPrefetchedSourceQuotes, isVerbatimSourceQuote } from './source-quote-checks.mjs';
import { figureDetail, kpiContext } from '../../../../website/src/lib/figures.mjs';

for (const file of ['FigureRenderer.astro', 'DiligenceReport.astro']) {
  test(`figure caveats are not hidden by ${file} styles`, () => {
    const source = readFileSync(`website/src/components/${file}`, 'utf8');
    assert.equal(/\.figure-note[^{]*\{[^}]*\b(?:display:\s*none|visibility:\s*hidden)\b/.test(source), false,
      `${file}: figure approximation and evidence notes must remain visible`);
  });
}

test('KPI context preserves distinct qualifications without duplicating detail or tooltip notes', () => {
  const cases = [
    [{ context: 'Unaudited.' }, 'Unaudited.', 'Unaudited.'],
    [{ detail: 'Estimated.', context: 'Single geography.' }, 'Single geography.', 'Single geography.'],
    [{ detail: 'Estimated.', context: 'Estimated.' }, null, null],
    [{ note: 'Provisional.', context: 'Current cohort only.' }, 'Current cohort only.', 'Current cohort only.'],
    [{ note: 'Annualized.', context: 'Annualized.' }, 'Annualized.', null],
    [{ description: 'Estimated.', context: 'Estimated.' }, null, null],
    [{ summary: 'Limited sample.', context: 'Limited sample.' }, null, null],
    [{ detail: '', description: 'Known scope.', context: 'Known scope.' }, 'Known scope.', 'Known scope.'],
    [{ detail: 'Other detail.', note: 'Known scope.', context: 'Known scope.' }, 'Known scope.', 'Known scope.'],
    [{ detail: 'Original detail.' }, null, null],
    [{ detail: 'Original detail.', context: '' }, null, null],
    [{ detail: 'Original detail.', context: null }, null, null],
    [{ context: '<b>Not markup</b> & a condition.' }, '<b>Not markup</b> & a condition.', '<b>Not markup</b> & a condition.'],
  ];
  for (const [item, visible, tooltip] of cases) {
    const before = structuredClone(item);
    assert.deepEqual(kpiContext(Object.freeze(item)), { visible, tooltip });
    assert.deepEqual(item, before);
    const normalized = { ...item, detail: figureDetail(item) ?? item.summary };
    assert.deepEqual(kpiContext(Object.freeze(normalized)), { visible, tooltip });
  }
});

test('authoring-instruction checks reject leaked workflow directives in public prose', () => {
  const directives = [
    'The first pass through the chapter should answer the mission questions directly.',
    'The middle section should connect the claims to the tables so the reader can see the evidence.',
    'Refer to that chronology, but do not copy Company Overview claim ids.',
    ' \tDo not copy Company Overview claim IDs.',
    'If Financials needs a funding fact, mint a local Financials claim with its own sourceRefs.',
    'MINT A LOCAL COMPANY OVERVIEW CLAIM WITH ITS OWN SOURCEREFS.',
    'The middle section\nshould connect the claims\tto the tables.',
  ];
  for (const body of directives) {
    const doc = { sections: [{ body }] };
    const before = structuredClone(doc);
    const { errors } = checkAuthoringInstructions(doc, { path: 'chapter.yaml' });
    assert.equal(errors.length, 1, body);
    assert.equal(errors[0].path, 'chapter.yaml.sections[0].body');
    assert.equal(errors[0].dimension, 'authoringInstructions');
    assert.match(errors[0].fix, /source-backed/);
    assert.deepEqual(doc, before);
  }
  assert.equal(KNOWN_DIMENSIONS.has('authoringInstructions'), true);
  assert.equal(WARNING_DIMENSIONS.has('authoringInstructions'), false);
});

test('authoring-instruction checks cover assembled blocks, tables, figures and cover text', () => {
  const text = 'The middle section should connect the claims to the tables.';
  const doc = {
    chapters: [{ sections: [{ blocks: [{ body: text }, { items: [text] }] }] }],
    tables: [{ notes: text, rows: [[text]] }],
    figures: [{ summary: text, data: { nodes: [{ detail: text }] } }],
    summary: { headline: text, topRisks: [text] },
    coverFacts: [{ label: text }],
    companyProfile: { summary: text },
    appendices: [{ blocks: [{ body: text }] }],
  };
  const { errors } = checkAuthoringInstructions(doc);
  assert.equal(errors.length, 11);
  assert.equal(new Set(errors.map((error) => error.path)).size, 11);
});

test('authoring-instruction checks preserve analytical prose and research provenance', () => {
  const text = 'The first pass through the chapter should answer the mission questions directly.';
  const doc = {
    chapter: { summary: 'This chapter evaluates financing and customer concentration.' },
    sections: [{ body: 'Investors should request audited revenue, claims data, and customer references. The first pass through the production line controls yield.' }],
    tables: [
      { notes: 'Claims in this table refer to warranty compensation, not marketing assertions.' },
      { notes: 'Cash on hand and monthly burn rate are the most critical undisclosed financial items in this table; runway and capital adequacy cannot be independently assessed without them. The Company Overview chapter contains the round-by-round funding chronology; financing facts here are local Financials claims minted independently and do not copy Company Overview claim IDs.' },
      { notes: 'This table refers to the capital-formation chronology documented in Chapter 1 (Company Overview) for context; all funding claims here are independently minted local Financials claims with their own sourceRefs and do not copy Company Overview claim ids. Every metric is either third-party-reported with low confidence or entirely unavailable from public sources.' },
      { notes: 'Capital structure reconstructed from press releases, news articles, and S&P Capital IQ transaction data. No audited financial statements are available. Burn and runway figures are estimates derived from headcount data only. Refer to Company Overview chapter for full funding chronology; claims in this table mint local Financials claim IDs and do not copy Company Overview claim IDs.' },
    ],
    figures: [{ summary: 'The service connects insurance claims to the customer record.' }],
    localEvidence: {
      sources: [{ keyQuote: text }],
      researchQuestions: [{ question: text }],
    },
    sources: [{ keyQuote: text }],
    acknowledgedWarnings: [{ reason: text }],
  };
  assert.deepEqual(checkAuthoringInstructions(doc).errors, []);
  assert.deepEqual(checkAuthoringInstructions(null).errors, []);
});

test('authoring-instruction chapter failures cannot be acknowledged away', () => {
  const root = mkdtempSync(join(tmpdir(), 'authoring-instruction-check-'));
  const folder = join(root, '20260925000000-authoring-instructions');
  try {
    mkdirSync(folder);
    writeFileSync(join(folder, '01-company-overview.yaml'), yaml.dump({
      schemaVersion: 'report-v2', artifact: 'company-overview',
      slug: 'authoring-instructions', runDate: '2026-09-25',
      company: { name: 'Authoring instructions fixture' },
      chapter: { number: 1, title: 'Company Overview', summary: 'Isolated content-gate fixture.' },
      sections: [{
        id: 'analysis', title: 'Analysis',
        body: 'The first pass through the chapter should answer the mission questions directly.',
        claimRefs: [],
      }],
      tables: [], figures: [],
      localEvidence: { sources: [], claims: [], searchQueries: [], researchQuestions: [], gaps: [] },
      acknowledgedWarnings: [{
        dimension: 'authoringInstructions',
        reason: 'This fixture attempts to acknowledge a hard content failure.',
      }],
    }));
    for (const flags of [[], ['--strict']]) {
      const result = spawnSync(process.execPath, [
        '.agents/skills/startup-research/scripts/check-chapter.mjs',
        folder, '01-company-overview.yaml', '--format', 'json', ...flags,
      ], { encoding: 'utf8' });
      assert.equal(result.status, 1, result.stderr);
      const output = JSON.parse(result.stdout);
      const issues = output.issues.filter((issue) => issue.dimension === 'authoringInstructions');
      assert.equal(issues.length, 1);
      assert.ok(output.summary.failedDimensions.includes('authoringInstructions'));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('figure detail aliases preserve source text and existing precedence', () => {
  for (const [item, expected] of [
    [{ detail: 'Primary detail', description: 'Description', summary: 'Summary' }, 'Primary detail'],
    [{ description: 'Remaining manual touches become work queues.' }, 'Remaining manual touches become work queues.'],
    [{ detail: null, description: '人工介入率', summary: 'Summary' }, '人工介入率'],
    [{ summary: 'Do not add another visible field to flow or bar charts' }, undefined],
    [{ detail: '', description: 'Do not override an explicit blank' }, ''],
    [{}, undefined],
  ]) assert.equal(figureDetail(Object.freeze(item)), expected);
});

const accessErrorBodies = [
  '<html><head><title>Client Challenge</title></head><body>A required part of this site couldn’t load.</body></html>',
  "Title:\n\nURL Source: https://example.com/thread\n\nWarning: Target URL returned error 403: Forbidden\n\nMarkdown Content:\nYou've been blocked by network security.",
  'Title: Vercel Security Checkpoint\n\nURL Source: https://example.com/page\n\nWarning: Target URL returned error 429: Too Many Requests\n\nMarkdown Content:\nVercel Security Checkpoint',
  '<html><head><title>页面未找到</title></head><body><h1>404</h1><p>没有找到此种页面</p></body></html>',
  '404\n\n没有找到此种页面',
  '<html><title>404 - Page Not Found</title><body>This page is unavailable.</body></html>',
  '<html><head><title></title></head><body><div>Powered and protected by</div><div>Privacy</div></body></html>',
  '<html><body><!-- BEGIN WAYBACK TOOLBAR INSERT --><div id="wm-ipp-base">Wayback Machine: April 16, 2026</div><!-- END WAYBACK TOOLBAR INSERT --><div>Powered and protected by</div><div>Privacy</div></body></html>',
  'Powered and protected by\n\nPrivacy',
  'Title:\n\nURL Source: https://example.com/page\n\nMarkdown Content:\nPowered and protected by\n\nPrivacy',
  'Title:\n\nURL Source: https://example.com/page\n\nPublished Time: 2026-04-16\n\nMarkdown Content:\nPowered and protected by\n\nPrivacy',
];

const financialTables = '<table><tr><th>Metric</th><th>2026</th><th>2025</th></tr>'
  + '<tr><td>Revenue</td><td>$100</td><td>$100</td></tr>'
  + '<tr><td>Costs</td><td>$10</td><td>-$10</td></tr></table>'
  + '<table><tr><th>Metric</th><th>2026</th><th>2025</th></tr>'
  + '<tr><td>Revenue</td><td>€100</td><td>€100</td></tr></table>';

test('text cleaning preserves repeated evidence, table headings, currencies and signs', () => {
  for (const text of [
    htmlToText(financialTables),
    'ARR\n\nRevenue\n\nARR\n\nRevenue',
    'Not audited.\nNot audited.\nNOT AUDITED.',
    '10%\n10\n-10\n10%\n10x\n10x\n0\n0',
  ]) {
    assert.deepEqual(cleanExtractedText(text), { text, removedLines: 0, dedupedLines: 0 });
  }
});

test('text cleaning still removes known boilerplate without removing repeated evidence', () => {
  assert.deepEqual(cleanExtractedText('Accept all cookies\nRevenue\nMenu\nRevenue\nAccept all cookies'), {
    text: 'Revenue\nRevenue', removedLines: 3, dedupedLines: 0,
  });
});

test('fetch CLI preserves financial tables in main, full, cached and reader text', () => {
  const folder = mkdtempSync(join(tmpdir(), 'source-table-check-'));
  const tableText = htmlToText(financialTables);
  const html = '<html><head><title>Annual financial results</title></head><body><main><article>'
    + '<h1>Annual financial results</h1><p>These comparative financial statements report annual revenue and costs '
    + 'for both periods. Each column must retain its own reporting year, currency, amount and sign. '
    + 'The second table reports a different currency, not another copy of the first table.</p>'
    + '<p>The comparative presentation intentionally repeats the reporting years and revenue label. '
    + 'Equal revenue amounts in separate periods are separate observations. A negative cost amount must not '
    + 'be treated as equivalent to a positive cost amount, even when the absolute values are identical.</p>'
    + '<p>The currency symbols distinguish the two statements. Preserving each occurrence keeps the rows '
    + 'aligned with their columns and avoids changing the interpretation of the source financial statements.</p>'
    + financialTables + '</article></main></body></html>';
  const url = 'https://example.com/financials';
  try {
    for (const mode of ['main', 'full', 'cache', 'reader']) {
      const body = mode === 'reader'
        ? `Title: Annual financial results\n\nMarkdown Content:\n\n${tableText}` : html;
      if (mode === 'cache') {
        writeFileSync(join(folder, `${canonicalCacheKey(url)}.json`), JSON.stringify({
          requestedUrl: url, finalUrl: url, status: 200, ok: true,
          contentType: 'text/html', body: Buffer.from(html).toString('base64'),
          source: 'origin', fetchedAt: new Date().toISOString(),
        }));
      }
      const flags = [
        url, '--json', '--no-host-map', '--no-throttle', '--no-retry-profiles', '--no-wayback',
        ...(mode === 'cache' ? ['--cache-dir', folder] : ['--no-cache']),
        ...(mode === 'full' ? ['--full-text'] : []),
        ...(mode === 'reader' ? ['--via-reader'] : ['--no-reader']),
      ];
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import { main } from './.agents/skills/fetch-url/scripts/fetch.mjs';
        let requests = 0;
        globalThis.fetch = async (requestUrl) => {
          requests += 1;
          const response = new Response(${JSON.stringify(body)}, {
            status: 200, headers: { 'content-type': ${JSON.stringify(mode === 'reader' ? 'text/plain' : 'text/html')} },
          });
          Object.defineProperty(response, 'url', { value: String(requestUrl) });
          return response;
        };
        await main(${JSON.stringify(flags)});
        assert.equal(requests, ${mode === 'cache' ? 0 : 1});
      `], { encoding: 'utf8', env: { ...process.env, STARTUP_FETCH_LOG_PATH: '' } });
      assert.equal(result.status, 0, `${mode}: ${result.stderr}`);
      const output = JSON.parse(result.stdout);
      assert.equal(output.ok, true, mode);
      assert.equal(output.output.includes(tableText), true, `${mode}: ${output.output}`);
      assert.equal(output.extraction.cleaning.dedupedLines, 0, mode);
      assert.equal(output.cache.hit, mode === 'cache', mode);
      assert.equal(output.extraction.method, ['main', 'cache'].includes(mode) ? 'readability' : 'full-text', mode);
      assert.equal(output.retrievalSource, mode === 'reader' ? 'reader' : 'origin', mode);
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('fetch CLI preserves raw image bytes, metadata and provenance across output modes', () => {
  const folder = mkdtempSync(join(tmpdir(), 'source-binary-check-'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
  const url = 'https://example.com/chart.png';
  try {
    for (const mode of ['origin-file', 'cache-file', 'json', 'terminal', 'missing-type', 'octet-stream']) {
      const outputPath = join(folder, `${mode}.png`);
      const log = join(folder, `${mode}.jsonl`);
      const contentType = mode === 'missing-type' ? null : mode === 'octet-stream' ? 'application/octet-stream' : 'image/png';
      const fileMode = mode.endsWith('-file');
      if (mode === 'cache-file') {
        writeFileSync(join(folder, `${canonicalCacheKey(url)}.json`), JSON.stringify({
          requestedUrl: url, finalUrl: url, status: 200, ok: true,
          contentType, body: png.toString('base64'), source: 'origin',
          fetchedAt: new Date().toISOString(),
        }));
      }
      const flags = [
        url, '--raw', '--max-chars', '5', '--no-host-map', '--no-throttle',
        '--no-retry-profiles', '--no-reader', '--no-wayback',
        ...(mode === 'cache-file' ? ['--cache-dir', folder] : ['--no-cache']),
        ...(fileMode ? ['--out', outputPath] : []),
        ...(mode === 'terminal' ? [] : ['--json']),
      ];
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import { main } from './.agents/skills/fetch-url/scripts/fetch.mjs';
        let requests = 0;
        globalThis.fetch = async (requestUrl) => {
          requests++;
          const response = new Response(Buffer.from(${JSON.stringify(png.toString('base64'))}, 'base64'), {
            status: 200, headers: ${JSON.stringify(contentType ? { 'content-type': contentType } : {})},
          });
          Object.defineProperty(response, 'url', { value: String(requestUrl) });
          return response;
        };
        await main(${JSON.stringify(flags)});
        assert.equal(requests, ${mode === 'cache-file' ? 0 : 1});
      `], { encoding: 'utf8', env: { ...process.env, STARTUP_FETCH_LOG_PATH: log } });
      assert.equal(result.status, 0, `${mode}: ${result.stderr}`);
      const trail = JSON.parse(readFileSync(log, 'utf8').trim());
      assert.equal(trail.ok, true);
      assert.equal(trail.sha256, createHash('sha256').update(png).digest('hex'));
      assert.equal(trail.bytes, png.length);
      if (mode === 'terminal') {
        assert.match(result.stdout, /binary/i);
        assert.doesNotMatch(result.stdout, /\uFFFD|PNG|base64,/);
        continue;
      }
      const output = JSON.parse(result.stdout);
      assert.equal(output.format, 'binary', mode);
      assert.equal(output.outputKind, 'bytes', mode);
      assert.equal(output.outputBytes, png.length, mode);
      assert.equal(output.truncated, false, mode);
      assert.equal(output.title, null, mode);
      assert.equal(output.output, undefined, mode);
      assert.equal(output.cache.hit, mode === 'cache-file', mode);
      if (fileMode) {
        assert.deepEqual(readFileSync(outputPath), png, mode);
        assert.equal(output.outputFile.kind, 'bytes', mode);
        assert.equal(output.outputFile.bytes, png.length, mode);
        assert.equal(output.outputBase64, undefined, mode);
      } else {
        assert.deepEqual(Buffer.from(output.outputBase64, 'base64'), png, mode);
      }
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('fetch CLI keeps raw PDF and HTML files byte-exact without changing readable output', () => {
  const folder = mkdtempSync(join(tmpdir(), 'source-raw-check-'));
  const toolbar = '<!-- BEGIN WAYBACK TOOLBAR INSERT --><div id="wm-ipp-base">Archive</div><!-- END WAYBACK TOOLBAR INSERT -->';
  try {
    for (const mode of ['pdf', 'html', 'archive-html', 'html-json', 'html-text']) {
      const isPdf = mode === 'pdf';
      const raw = mode !== 'html-text';
      const fileMode = !['html-json', 'html-text'].includes(mode);
      const html = `<html><title>Original</title><body>${toolbar}<p>Original source content.</p></body></html>`;
      const body = Buffer.from(isPdf ? '%PDF-1.7\nOriginal binary \u00ff\n%%EOF' : html);
      const outputPath = join(folder, `${mode}.out`);
      const flags = [
        'https://example.com/source', '--json', '--no-cache', '--no-host-map',
        '--no-throttle', '--no-retry-profiles', '--no-reader', '--no-wayback',
        ...(raw ? ['--raw'] : []),
        ...(fileMode ? ['--out', outputPath, '--max-chars', '5'] : []),
        ...(mode === 'archive-html' ? ['--via-wayback'] : []),
      ];
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { main } from './.agents/skills/fetch-url/scripts/fetch.mjs';
        globalThis.fetch = async () => new Response(Buffer.from(${JSON.stringify(body.toString('base64'))}, 'base64'), {
          status: 200, headers: { 'content-type': ${JSON.stringify(isPdf ? 'application/pdf' : 'text/html')} },
        });
        await main(${JSON.stringify(flags)});
      `], { encoding: 'utf8', env: { ...process.env, STARTUP_FETCH_LOG_PATH: '' } });
      assert.equal(result.status, 0, `${mode}: ${result.stderr}`);
      const output = JSON.parse(result.stdout);
      assert.equal(output.format, isPdf ? 'pdf' : 'html', mode);
      assert.equal(output.truncated, false, mode);
      if (fileMode) {
        assert.deepEqual(readFileSync(outputPath), body, mode);
        assert.equal(output.outputFile.bytes, body.length, mode);
        assert.equal(output.outputFile.kind, isPdf ? 'pdf' : 'body', mode);
      } else if (raw) {
        assert.equal(output.output, html);
        assert.equal(output.outputKind, 'body');
      } else {
        assert.match(output.output, /Original source content\./);
        assert.doesNotMatch(output.output, /<p>|<html>/);
        assert.equal(output.outputKind, 'text');
      }
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('HTTP-200 challenge pages are not successful source retrievals', () => {
  for (const body of accessErrorBodies) {
    assert.equal(looksLikeBotChallenge({ status: 200, body: Buffer.from(body) }), true, body);
  }
  assert.equal(isAccessErrorResponse({ status: 200, title: '页面未找到', body: '' }), true);
});

test('access-error detection preserves real articles about security and PDF bodies', () => {
  for (const body of [
    '<html><title>DataDome company overview</title><article>DataDome provides captcha and bot detection.</article></html>',
    '<html><title>Understanding Vercel Security Checkpoint</title><article>A technical article about browser challenges.</article></html>',
    'Security troubleshooting guide\n\nA required part of this site couldn’t load is a message that users may encounter.',
    '<html><title>理解页面未找到错误</title><article>404 页面未找到是常见的网站错误。本文介绍如何排查。</article></html>',
    '<html><title>Understanding 404 - Page Not Found</title><article>A guide to error handling.</article></html>',
    '404 documents were processed, while three links returned page not found.',
    '404\n\n没有找到此种页面\n\nThis report analyzes the error rather than serving an error page.',
    '<html><title>Funding announcement</title><body><article>The company raised $150M.</article><div>Powered and protected by</div><div>Privacy</div></body></html>',
    '<html><body><!-- BEGIN WAYBACK TOOLBAR INSERT --><div id="wm-ipp-base">Wayback Machine</div><!-- END WAYBACK TOOLBAR INSERT --><article>The company raised $150M.</article><div>Powered and protected by</div><div>Privacy</div></body></html>',
    'Title: Funding announcement\n\nURL Source: https://example.com/page\n\nPublished Time: 2026-04-16\n\nMarkdown Content:\nThe company raised $150M.\nPowered and protected by\n\nPrivacy',
    'Powered and protected by\n\nPrivacy\n\nThis article explains the footer rather than serving a challenge page.',
    Buffer.from('%PDF-1.7\nTitle: Vercel Security Checkpoint'),
    Buffer.from('%PDF-1.7\nTitle: 页面未找到'),
    Buffer.from('%PDF-1.7\nPowered and protected by\n\nPrivacy'),
  ]) assert.equal(isAccessErrorResponse({ status: 200, body }), false);
});

test('reader URLs preserve the original scheme without adding a second one', () => {
  for (const url of ['http://example.com/page', 'https://example.com/page?q=1']) {
    assert.equal(readerUrl(url), `https://r.jina.ai/${url}`);
  }
});

test('fetch CLI rejects origin, reader, archived, and cached access-error pages with a failed fetch trail', () => {
  const folder = mkdtempSync(join(tmpdir(), 'source-fetch-check-'));
  try {
    const cases = accessErrorBodies.flatMap((_, index) =>
      ['origin', 'reader', 'archive', 'cache', 'archive-cache'].map((mode) => [index, mode]));
    for (const [index, mode] of cases) {
      const url = 'https://example.com/page';
      const log = join(folder, `${index}-${mode}.jsonl`);
      const requests = join(folder, `${index}-${mode}-requests.jsonl`);
      const cachedMode = mode === 'cache' || mode === 'archive-cache';
      const cacheSource = mode === 'archive-cache' ? 'wayback' : 'origin';
      if (cachedMode) {
        writeFileSync(join(folder, `${canonicalCacheKey(url, cacheSource)}.json`), JSON.stringify({
          requestedUrl: url, finalUrl: url, status: 200, ok: true,
          body: Buffer.from(accessErrorBodies[index]).toString('base64'),
          source: cacheSource, fetchedAt: new Date().toISOString(),
        }));
      }
      const flags = [
        url, '--json', '--no-host-map', '--no-throttle', '--no-retry-profiles', '--no-reader', '--no-wayback',
        ...(cachedMode ? ['--cache-dir', folder] : ['--no-cache']),
        ...(mode === 'reader' ? ['--via-reader'] : []),
        ...(mode === 'archive' || mode === 'archive-cache' ? ['--via-wayback'] : []),
      ];
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { appendFileSync } from 'node:fs';
        import { main } from './.agents/skills/fetch-url/scripts/fetch.mjs';
        globalThis.fetch = async (url) => {
          appendFileSync(${JSON.stringify(requests)}, JSON.stringify(url) + '\\n');
          return new Response(${JSON.stringify(accessErrorBodies[index])}, {
            status: 200, headers: { 'content-type': 'text/html' },
          });
        };
        await main(${JSON.stringify(flags)});
      `], { encoding: 'utf8', env: { ...process.env, STARTUP_FETCH_LOG_PATH: log } });
      assert.equal(result.status, 1, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.status, 200);
      assert.equal(output.ok, false);
      assert.equal(output.retrievalSource, mode.startsWith('archive') ? 'wayback' : mode === 'reader' ? 'reader' : 'origin');
      assert.match(output.error, /access-error/);
      const trail = JSON.parse(readFileSync(log, 'utf8').trim());
      assert.equal(trail.ok, false);
      assert.match(trail.error, /access-error/);
      assert.equal(readFileSync(requests, 'utf8').trim().split('\n').length, 1);
      if (cachedMode) assert.match(result.stderr, /cached access-error page is unusable/);
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('fetch CLI recovers an access-error page through a valid reader response', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { main } from './.agents/skills/fetch-url/scripts/fetch.mjs';
    const requests = [];
    globalThis.fetch = async (url) => {
      requests.push(url);
      return new Response(String(url).startsWith('https://r.jina.ai/')
        ? 'Title: Original article\\n\\nReadable original evidence, not an access-error page.'
        : ${JSON.stringify(accessErrorBodies[0])}, { status: 200 });
    };
    await main(['https://example.com/page', '--json', '--no-cache', '--no-host-map',
      '--no-throttle', '--no-retry-profiles', '--no-wayback']);
    assert.deepEqual(requests, ['https://example.com/page', 'https://r.jina.ai/https://example.com/page']);
  `], { encoding: 'utf8', env: { ...process.env, STARTUP_FETCH_LOG_PATH: '' } });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.retrievalSource, 'reader');
});

test('fetch CLI refreshes blocked reader and archive fallback caches', () => {
  const folder = mkdtempSync(join(tmpdir(), 'source-fallback-cache-check-'));
  const url = 'https://example.com/page';
  try {
    for (const variant of ['reader', 'wayback']) {
      writeFileSync(join(folder, `${canonicalCacheKey(url, variant)}.json`), JSON.stringify({
        requestedUrl: url, finalUrl: url, status: 200, ok: true,
        body: Buffer.from('Powered and protected by\n\nPrivacy').toString('base64'),
        source: variant, fetchedAt: new Date().toISOString(),
      }));
      const flags = [
        url, '--json', '--cache-dir', folder, '--no-host-map', '--no-throttle', '--no-retry-profiles',
        variant === 'reader' ? '--no-wayback' : '--no-reader',
      ];
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import { main } from './.agents/skills/fetch-url/scripts/fetch.mjs';
        const requests = [];
        globalThis.fetch = async (requestUrl) => {
          requests.push(String(requestUrl));
          return new Response(String(requestUrl) === ${JSON.stringify(url)}
            ? 'Access denied'
            : '<html><article>Verified original evidence: revenue was $150M.</article><div>Powered and protected by</div><div>Privacy</div></html>',
            { status: String(requestUrl) === ${JSON.stringify(url)} ? 403 : 200 });
        };
        await main(${JSON.stringify(flags)});
        assert.equal(requests.length, 2);
        assert.equal(requests[0], ${JSON.stringify(url)});
        assert.equal(requests[1].startsWith(${JSON.stringify(variant === 'reader' ? 'https://r.jina.ai/' : 'https://web.archive.org/web/')}), true);
      `], { encoding: 'utf8', env: { ...process.env, STARTUP_FETCH_LOG_PATH: '' } });
      assert.equal(result.status, 0, `${variant}: ${result.stderr}`);
      const output = JSON.parse(result.stdout);
      assert.equal(output.ok, true, variant);
      assert.equal(output.cache.hit, false, variant);
      assert.equal(output.retrievalSource, variant);
      assert.match(output.output, /Verified original evidence: revenue was \$150M/);
      assert.match(result.stderr, /cached access-error page is unusable/);
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('chapter fetch provenance requires an explicitly successful retrieval', () => {
  const root = mkdtempSync(join(tmpdir(), 'source-trail-check-'));
  const folder = join(root, '20260925000000-fetch-trail');
  const cases = [
    { name: 'success', records: [{ ok: true, status: 200 }], verified: true },
    { name: 'challenge', records: [{ ok: false, status: 200, error: 'Access-error page' }] },
    { name: 'network', records: [{ ok: false, status: 0, error: 'fetch failed' }] },
    { name: 'forbidden', records: [{ ok: false, status: 403 }] },
    { name: 'missing-ok', records: [{ status: 200 }] },
    { name: 'missing-status', records: [{ ok: true }] },
    { name: 'error-status', records: [{ ok: true, status: 503 }] },
    { name: 'explicit-error', records: [{ ok: true, status: 200, error: 'Unusable content' }] },
    { name: 'string-status', records: [{ ok: true, status: '200' }] },
    { name: 'truthy-ok', records: [{ ok: 'true', status: 200 }] },
    { name: 'unlogged', records: [] },
    { name: 'retry', records: [{ ok: false, status: 403 }, { ok: true, status: 200 }], verified: true },
    { name: 'later-failure', records: [{ ok: true, status: 200 }, { ok: false, status: 0 }], verified: true },
    {
      name: 'redirected', verified: true,
      records: [{ url: 'https://example.com/old-location', finalUrl: 'https://example.com/redirected', ok: true, status: 200 }],
    },
    {
      name: 'failed-redirect',
      records: [{ url: 'https://example.com/blocked-location', finalUrl: 'https://example.com/failed-redirect', ok: false, status: 422 }],
    },
    {
      name: 'canonical', verified: true, sourceUrl: 'https://www.example.com/canonical/?utm_source=fixture#section',
      records: [{ ok: true, status: 200 }],
    },
    {
      name: 'reader', verified: true,
      records: [{ finalUrl: 'https://r.jina.ai/https://example.com/reader', source: 'reader', ok: true, status: 200 }],
    },
  ];
  const sources = cases.map((item, index) => ({
    id: `SO${String(index + 1).padStart(3, '0')}`,
    url: item.sourceUrl ?? `https://example.com/${item.name}`,
    publisher: 'Fixture publisher', title: `Source ${item.name}`,
    date: '2026-09-25', accessDate: '2026-09-25', accessStatus: 'ok',
    sourceType: 'official', reputationTier: 'high', independence: 'company',
    stance: 'confirming', topics: ['fixture'],
  }));
  const trailPath = join(folder, 'fetch.jsonl');
  const trail = cases.flatMap((item) => item.records.map((record) => ({
    url: `https://example.com/${item.name}`, ...record,
  })));
  try {
    mkdirSync(folder);
    writeFileSync(trailPath, ['{malformed', 'null', '', ...trail.map((entry) => JSON.stringify(entry))].join('\n'));
    writeFileSync(join(folder, '01-company-overview.yaml'), yaml.dump({
      schemaVersion: 'report-v2', artifact: 'company-overview',
      slug: basename(folder).slice(15), runDate: '2026-09-25',
      company: { name: 'Fetch trail fixture' },
      chapter: { number: 1, title: 'Company Overview', summary: 'Isolated source-provenance fixture.' },
      sections: [], tables: [], figures: [],
      localEvidence: { sources, claims: [], searchQueries: [], researchQuestions: [], gaps: [] },
    }));
    const result = spawnSync(process.execPath, [
      '.agents/skills/startup-research/scripts/check-chapter.mjs',
      folder, '01-company-overview.yaml', '--format', 'json',
    ], { encoding: 'utf8', env: { ...process.env, STARTUP_FETCH_LOG_PATH: trailPath } });
    assert.equal(result.status, 1, result.stderr); // The small fixture intentionally misses content floors.
    assert.ok(result.stdout.trim(), result.stderr);
    const output = JSON.parse(result.stdout);
    const unverified = output.warnings.filter((issue) => issue.code === 'unverifiedSource');
    assert.deepEqual(unverified.map((issue) => issue.id),
      sources.filter((_, index) => !cases[index].verified).map((source) => source.id));
    assert.ok(unverified.every((issue) => issue.message.includes('successful')));
    assert.ok(unverified.every((issue) => issue.fix.includes('successful')));
    assert.equal(output.warnings.some((issue) => issue.code === 'fetchTrailMissing'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('source quotes allow typography, whitespace, and ordered omissions', () => {
  const source = 'The company’s ARR is $10M — not audited.\nThe estimate excludes debt.';
  for (const quote of [
    "The company's ARR is $10M - not audited.",
    "The company's ARR … not audited.",
    'ARR is $10M ... The estimate excludes debt.',
  ]) assert.equal(isVerbatimSourceQuote(quote, source), true, quote);
});

test('source quotes reject fabricated wording, reordered excerpts, and partial numbers', () => {
  for (const [quote, source] of [
    ['ARR is $11M.', 'ARR is $10M.'],
    ['ARR is audited.', 'ARR is not audited.'],
    ['The estimate excludes debt. ... ARR is $10M.', 'ARR is $10M. The estimate excludes debt.'],
    ['Revenue is $10', 'Revenue is $100M.'],
    ['Revenue is $1', 'Revenue is $1,000.'],
    ['Growth is 10', 'Growth is 10%.'],
    ['5M', '10.5M'],
    ['000', '1,000'],
    ['10M', '-10M'],
    ['10M', '$10M'],
    ['$10M', '-$10M'],
    ['Revenue is 102M.', 'Revenue is 10²M.'],
    ['2026', '12026'],
    ['...', 'A complete source.'],
  ]) assert.equal(isVerbatimSourceQuote(quote, source), false, quote);
});

test('chapter source quotas cannot be padded with duplicate URL aliases', () => {
  const sources = [
    { id: 'SV008', url: 'https://example.com/source' },
    { id: 'SV009', url: 'https://www.example.com/source/?utm_source=test#section' },
  ];
  const issues = checkDistinctChapterSources(sources, '08-valuation.yaml');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'duplicateSourceUrl');
  assert.match(issues[0].message, /SV008 and SV009/);
  assert.deepEqual(checkDistinctChapterSources([sources[0], { ...sources[1], url: 'https://example.com/other' }], '08-valuation.yaml'), []);
});

test('prefetched quotation checks require readable successful source text', () => {
  const folder = mkdtempSync(join(tmpdir(), 'source-quote-check-'));
  const outputFile = join(folder, 'source.txt');
  const url = 'https://example.com/source';
  const source = { id: 'SO001', url, keyQuote: 'ARR is $10M.' };
  try {
    writeFileSync(outputFile, source.keyQuote);
    assert.deepEqual(checkPrefetchedSourceQuotes([source], [{ url, ok: true, outputFile }], '01-company-overview.yaml'), []);
    for (const fetched of [[], [{ url, ok: false, outputFile }], [{ url, ok: true }]]) {
      assert.equal(checkPrefetchedSourceQuotes([source], fetched, '01-company-overview.yaml')[0].code, 'sourceQuoteTextMissing');
    }
    assert.equal(checkPrefetchedSourceQuotes(
      [{ ...source, keyQuote: 'ARR is $11M.' }],
      [{ url, ok: true, outputFile }],
      '01-company-overview.yaml',
    )[0].code, 'sourceQuoteMismatch');
    assert.deepEqual(checkPrefetchedSourceQuotes(
      [{ id: 'SO002', url, keyQuote: null }],
      [{ url, ok: true, outputFile }],
      '01-company-overview.yaml',
    ), []);
    const duplicate = { ...source, id: 'SO003', url: `${url}?utm_source=test` };
    const fetched = [{ url, ok: true, outputFile }];
    assert.deepEqual(checkPrefetchedSourceQuotes([source, duplicate], fetched, '01-company-overview.yaml')
      .map((issue) => issue.code), ['duplicateSourceUrl']);
    assert.deepEqual(checkPrefetchedSourceQuotes([source, { ...duplicate, id: 'SM001' }], fetched, 'evidence.yaml'), []);
    for (const body of accessErrorBodies) {
      writeFileSync(outputFile, body);
      for (const keyQuote of [body, null]) {
        assert.deepEqual(checkPrefetchedSourceQuotes(
          [{ ...source, keyQuote }],
          [{ url, ok: true, outputFile }],
          '01-company-overview.yaml',
        ).map((issue) => issue.code), ['sourceContentBlocked']);
      }
    }
    rmSync(outputFile);
    assert.equal(checkPrefetchedSourceQuotes([source], [{ url, ok: true, outputFile }], '01-company-overview.yaml')[0].code, 'sourceQuoteTextMissing');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

for (const field of ['items', 'nodes']) {
  const check = (touchpoints) => checkFigureDeep({
    id: 'FU001',
    type: 'journey-map',
    data: { [field]: [{ label: 'Expansion', touchpoints }] },
  }, { path: 'fixture.yaml' }).errors;

  test(`journey-map ${field} accepts text without coercing it`, () => {
    for (const touchpoints of [
      undefined,
      [],
      'Partner referral, technical evaluation, production deployment',
      yaml.load('- "JetBlue: 1 -> 10 airports -> all operations"'),
      yaml.load('- >-\n  Nigeria NiMet: agriculture DCAS -> oil and gas'),
      ['从一个枢纽扩展至全网络（JetBlue：1 → 10 个机场 → 全部运营）'],
    ]) {
      assert.deepEqual(check(touchpoints), []);
    }
  });

  test(`journey-map ${field} rejects malformed touchpoint lists`, () => {
    for (const touchpoints of [
      yaml.load('- Expansion from one hub (JetBlue: 1 -> 10 airports)'),
      yaml.load('- Nigeria NiMet: agriculture DCAS -> oil and gas'),
      yaml.load('- Nigeria NiMet:'),
      ['Valid text', null],
      [42],
      [true],
      [['Nested text']],
      42,
      true,
      { label: 'Not a list' },
      null,
    ]) {
      assert(check(touchpoints).some((error) => error.message.includes(
        `data.${field}[0].touchpoints must be text or an array of strings`,
      )), JSON.stringify(touchpoints));
    }
  });
}
