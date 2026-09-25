import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { canonicalCacheKey, isAccessErrorResponse, looksLikeBotChallenge, readerUrl } from '../../fetch-url/scripts/fetch.mjs';
import { checkFigureDeep } from './artifact-checks.mjs';
import { checkPrefetchedSourceQuotes, isVerbatimSourceQuote } from './source-quote-checks.mjs';

const accessErrorBodies = [
  '<html><head><title>Client Challenge</title></head><body>A required part of this site couldn’t load.</body></html>',
  "Title:\n\nURL Source: https://example.com/thread\n\nWarning: Target URL returned error 403: Forbidden\n\nMarkdown Content:\nYou've been blocked by network security.",
  'Title: Vercel Security Checkpoint\n\nURL Source: https://example.com/page\n\nWarning: Target URL returned error 429: Too Many Requests\n\nMarkdown Content:\nVercel Security Checkpoint',
];

test('HTTP-200 challenge pages are not successful source retrievals', () => {
  for (const body of accessErrorBodies) {
    assert.equal(looksLikeBotChallenge({ status: 200, body: Buffer.from(body) }), true, body);
  }
});

test('access-error detection preserves real articles about security and PDF bodies', () => {
  for (const body of [
    '<html><title>DataDome company overview</title><article>DataDome provides captcha and bot detection.</article></html>',
    '<html><title>Understanding Vercel Security Checkpoint</title><article>A technical article about browser challenges.</article></html>',
    'Security troubleshooting guide\n\nA required part of this site couldn’t load is a message that users may encounter.',
    Buffer.from('%PDF-1.7\nTitle: Vercel Security Checkpoint'),
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
    for (const [index, mode] of ['origin', 'reader', 'cache'].entries()) {
      const url = 'https://example.com/page';
      const log = join(folder, `${mode}.jsonl`);
      const requests = join(folder, `${mode}-requests.jsonl`);
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
