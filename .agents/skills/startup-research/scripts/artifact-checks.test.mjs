import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { canonicalCacheKey, cleanExtractedText, htmlToText, isAccessErrorResponse, looksLikeBotChallenge, readerUrl } from '../../fetch-url/scripts/fetch.mjs';
import { checkFigureDeep } from './artifact-checks.mjs';
import { checkDistinctChapterSources, checkPrefetchedSourceQuotes, isVerbatimSourceQuote } from './source-quote-checks.mjs';

const accessErrorBodies = [
  '<html><head><title>Client Challenge</title></head><body>A required part of this site couldn’t load.</body></html>',
  "Title:\n\nURL Source: https://example.com/thread\n\nWarning: Target URL returned error 403: Forbidden\n\nMarkdown Content:\nYou've been blocked by network security.",
  'Title: Vercel Security Checkpoint\n\nURL Source: https://example.com/page\n\nWarning: Target URL returned error 429: Too Many Requests\n\nMarkdown Content:\nVercel Security Checkpoint',
  '<html><head><title>页面未找到</title></head><body><h1>404</h1><p>没有找到此种页面</p></body></html>',
  '404\n\n没有找到此种页面',
  '<html><title>404 - Page Not Found</title><body>This page is unavailable.</body></html>',
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
    Buffer.from('%PDF-1.7\nTitle: Vercel Security Checkpoint'),
    Buffer.from('%PDF-1.7\nTitle: 页面未找到'),
  ]) assert.equal(isAccessErrorResponse({ status: 200, body }), false);
});

test('reader URLs preserve the original scheme without adding a second one', () => {
  for (const url of ['http://example.com/page', 'https://example.com/page?q=1']) {
    assert.equal(readerUrl(url), `https://r.jina.ai/${url}`);
  }
});

test('fetch CLI rejects origin, reader, and cached access-error pages with a failed fetch trail', () => {
  const folder = mkdtempSync(join(tmpdir(), 'source-fetch-check-'));
  try {
    const cases = accessErrorBodies.flatMap((_, index) =>
      ['origin', 'reader', 'cache'].map((mode) => [index, mode]));
    for (const [index, mode] of cases) {
      const url = 'https://example.com/page';
      const log = join(folder, `${index}-${mode}.jsonl`);
      const requests = join(folder, `${index}-${mode}-requests.jsonl`);
      if (mode === 'cache') {
        writeFileSync(join(folder, `${canonicalCacheKey(url)}.json`), JSON.stringify({
          requestedUrl: url, finalUrl: url, status: 200, ok: true,
          body: Buffer.from(accessErrorBodies[index]).toString('base64'),
          source: 'origin', fetchedAt: new Date().toISOString(),
        }));
      }
      const flags = [
        url, '--json', '--no-host-map', '--no-throttle', '--no-retry-profiles', '--no-reader', '--no-wayback',
        ...(mode === 'cache' ? ['--cache-dir', folder] : ['--no-cache']),
        ...(mode === 'reader' ? ['--via-reader'] : []),
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
      assert.match(output.error, /access-error/);
      const trail = JSON.parse(readFileSync(log, 'utf8').trim());
      assert.equal(trail.ok, false);
      assert.match(trail.error, /access-error/);
      assert.equal(readFileSync(requests, 'utf8').trim().split('\n').length, 1);
      if (mode === 'cache') assert.match(result.stderr, /cached access-error page is unusable/);
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
