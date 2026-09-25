#!/usr/bin/env node
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { promoteReserveEvidence, successfulPoolMetrics } from './search-pool-recovery.mjs';
import { canonicalSourceUrl } from './utils.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const urls = (entries) => new Set(entries.map((entry) => canonicalSourceUrl(entry.url)));

async function bootstrapFixture(name, { chapters = 1, sources = 12, failed = [], aliases = false }, verify) {
  const folder = resolve('.research-cache', `20990101000000-pool-check-${name}-${process.pid}`);
  const results = Array.from({ length: sources }, (_, index) => ({
    url: `https://publisher${index + 1}.example/acme`,
    title: `Acme evidence ${index + 1}`,
    sourceQuality: { tier: 'high', score: 100 - index, reasons: [] },
  }));
  const query = (id) => ({
    id, query: id, intent: 'broad', preferredProvider: 'fixture', maxResults: 10,
  });
  const plan = {
    company: { name: 'Acme', domain: 'acme.example' },
    strategy: {
      concurrency: 4,
      reportEvidenceTarget: { minDistinctDomains: chapters === 8 ? 18 : 0 },
    },
    globalQueries: [query('global')],
    chapters: Array.from({ length: chapters }, (_, index) => ({
      key: `chapter-${index + 1}`,
      evidenceTarget: { minSources: 8, minDomains: 4, minNetNewSources: 2 },
      queries: [query(`chapter-${index + 1}`)],
    })),
  };
  const original = {
    execFile: childProcess.execFile,
    argv: process.argv,
    exitCode: process.exitCode,
    log: console.log,
    error: console.error,
  };
  const fetchCalls = [];
  const diagnostics = [];
  function fakeExecFile() {
    throw new Error('Fixture only supports promisified subprocess calls');
  }
  fakeExecFile[promisify.custom] = async (_binary, args) => {
    let response;
    const script = basename(args[0]);
    if (script === 'build-search-plan.mjs') response = plan;
    else if (script === 'search-web.mjs') {
      const text = args[args.indexOf('--query') + 1];
      const start = text === 'global' ? 0 : (Number(text.split('-')[1]) - 1) * 7 + 3;
      response = {
        results: Array.from({ length: 10 }, (_, index) => {
          const result = results[(start + index) % results.length];
          return aliases && text !== 'global'
            ? { ...result, url: `${result.url.replace('https://', 'https://www.')}?utm_source=${text}` }
            : result;
        }),
      };
    } else if (script === 'fetch.mjs') {
      fetchCalls.push(args[1]);
      const ok = !failed.some((index) => (
        canonicalSourceUrl(results[index].url) === canonicalSourceUrl(args[1])
      ));
      response = {
        ok,
        status: ok ? 200 : 503,
        outputFile: { path: args[args.indexOf('--out') + 1] },
      };
    } else throw new Error(`Unexpected fixture subprocess: ${script}`);
    return { stdout: JSON.stringify(response), stderr: '' };
  };
  try {
    childProcess.execFile = fakeExecFile;
    syncBuiltinESMExports();
    const script = join(here, 'execute-search-plan.mjs');
    process.argv = [process.execPath, script, '--report-folder', folder, '--profile', 'fast'];
    process.exitCode = 0;
    console.log = () => {};
    console.error = (message) => diagnostics.push(message);
    await import(`${pathToFileURL(script).href}?fixture=${name}`);
    const exitCode = process.exitCode;
    const bundle = JSON.parse(readFileSync(join(folder, 'search-bundle.json'), 'utf8'));
    assert.equal(fetchCalls.length, new Set(fetchCalls.map(canonicalSourceUrl)).size,
      'bootstrap fetched a canonical URL more than once');
    for (const pool of bundle.chapterPools) {
      const recommendedUrls = urls(pool.recommended);
      assert.equal(recommendedUrls.size, pool.recommended.length, `${pool.key}: duplicate recommendations`);
      assert.equal(urls(pool.reserve).size, pool.reserve.length, `${pool.key}: duplicate reserves`);
      assert(pool.reserve.every((entry) => !recommendedUrls.has(canonicalSourceUrl(entry.url))),
        `${pool.key}: recommended/reserve overlap`);
      const successful = pool.recommended.filter((entry) => entry.fetch?.ok);
      assert.equal(pool.fetchedOk, urls(successful).size, `${pool.key}: inflated fetched source count`);
      for (const candidate of [...pool.recommended, ...pool.reserve]) {
        const fetched = bundle.fetchedSources.find((entry) => entry.url === candidate.url) ?? null;
        assert.deepEqual(candidate.fetch, fetched, `${pool.key}: missing or incorrect fetch metadata`);
        if (!['net-new', 'net-new-reserve'].includes(candidate.allocation)) continue;
        for (const sibling of bundle.chapterPools.filter((entry) => entry !== pool)) {
          assert(!urls([...sibling.recommended, ...sibling.reserve]).has(canonicalSourceUrl(candidate.url)),
            `${pool.key}: exclusive URL leaked to ${sibling.key}`);
        }
      }
    }
    await verify({ folder, bundle, exitCode, diagnostics });
  } finally {
    childProcess.execFile = original.execFile;
    syncBuiltinESMExports();
    process.argv = original.argv;
    process.exitCode = original.exitCode;
    console.log = original.log;
    console.error = original.error;
    rmSync(folder, { recursive: true, force: true });
  }
}

function assertFloors({ bundle, exitCode, diagnostics }) {
  assert.equal(exitCode, 0, diagnostics.join('\n'));
  for (const pool of bundle.chapterPools) {
    assert(pool.fetchedOk >= pool.evidenceTarget.minSources, `${pool.key}: source floor not met`);
    assert(pool.fetchedDomains >= pool.evidenceTarget.minDomains, `${pool.key}: domain floor not met`);
    assert(pool.fetchedNetNew >= pool.evidenceTarget.minNetNewSources, `${pool.key}: net-new floor not met`);
  }
}

function runJson(script, args) {
  const result = childProcess.spawnSync(process.execPath, [join(here, script), ...args], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

const tests = [
  ['unique recovery metrics', () => {
    const first = { url: 'https://one.example/acme', allocation: 'net-new' };
    const alias = { url: 'https://www.one.example/acme/?utm_source=test', allocation: 'net-new' };
    const second = { url: 'https://two.example/acme', allocation: 'net-new-reserve' };
    const pool = {
      evidenceTarget: { minSources: 2, minDomains: 2, minNetNewSources: 2 },
      recommended: [first, alias],
      reserve: [first, second, second],
    };
    const fetched = new Map([first, alias, second].map((entry) => [entry.url, { ok: true }]));
    assert.equal(successfulPoolMetrics(pool, fetched).successful, 1);
    assert.equal(successfulPoolMetrics(pool, fetched).successfulNetNew, 1);
    const recovery = promoteReserveEvidence(pool, fetched);
    assert.equal(recovery.promoted.length, 1);
    assert.equal(recovery.promoted[0].allocation, 'net-new');
    assert.equal(recovery.successful, 2);
    assert.equal(recovery.successfulNetNew, 2);
    assert.equal(recovery.recommended.length, 2);
    assert.equal(recovery.reserve.length, 0);
  }],
  ['domain-only recovery', () => {
    const candidates = ['https://one.example/a', 'https://one.example/b', 'https://two.example/a'];
    const pool = {
      evidenceTarget: { minSources: 2, minDomains: 2, minNetNewSources: 2 },
      recommended: candidates.slice(0, 2).map((url) => ({ url, allocation: 'net-new' })),
      reserve: [{ url: candidates[2], allocation: 'reserve' }],
    };
    const recovery = promoteReserveEvidence(pool, new Map(candidates.map((url) => [url, { ok: true }])));
    assert.equal(recovery.successful, 3);
    assert.equal(recovery.successfulDomains.size, 2);
    assert.equal(recovery.successfulNetNew, 2);
  }],
  ['net-new-only recovery', () => {
    const pool = {
      evidenceTarget: { minSources: 2, minDomains: 2, minNetNewSources: 2 },
      recommended: [
        { url: 'https://one.example/acme', allocation: 'net-new' },
        { url: 'https://two.example/acme', allocation: 'net-new' },
        { url: 'https://three.example/acme', allocation: 'chapter' },
      ],
      reserve: [
        { url: 'https://four.example/acme', allocation: 'net-new-reserve' },
        { url: 'https://five.example/acme', allocation: 'reserve' },
      ],
    };
    const fetched = new Map([...pool.recommended, ...pool.reserve].map((candidate) => [
      candidate.url, { ok: candidate.url !== 'https://two.example/acme' },
    ]));
    const recovery = promoteReserveEvidence(pool, fetched);
    assert.equal(recovery.promoted.length, 1);
    assert.equal(recovery.promoted[0].allocation, 'net-new');
    assert.equal(recovery.successful, 3);
    assert.equal(recovery.successfulNetNew, 2);
  }],
  ['recovery preserves usable backups', () => bootstrapFixture('recovery', { failed: [0] }, (result) => {
    assertFloors(result);
    const { bundle, folder } = result;
    const pool = bundle.chapterPools[0];
    assert.equal(pool.fetchedOk, 8);
    assert.equal(urls(pool.recommended.filter((entry) => entry.fetch?.ok)).size, 8);
    const successfulReserves = pool.reserve.filter((entry) => entry.fetch?.ok);
    assert(successfulReserves.length > 0, 'fixture did not exercise successful leftover reserves');
    const roster = runJson('load-chapter-runtime-context.mjs', ['--list', '--report-folder', folder]);
    bundle.chapterPools = roster.chapters.map((chapter) => ({ ...pool, key: chapter.key }));
    writeFileSync(join(folder, 'search-bundle.json'), JSON.stringify(bundle));
    const workers = runJson('run-chapter-workers.mjs', ['--report-folder', folder, '--dry-run', '--format', 'json']);
    const input = JSON.parse(readFileSync(workers.workers[0].poolPath, 'utf8'));
    assert.deepEqual(urls(input.reserve), urls(successfulReserves), 'worker lost successful reserve evidence');
    assert([...input.recommended, ...input.reserve].every((entry) => entry.fetch?.ok));
  })],
  ['mandatory floors precede backups', () => bootstrapFixture(
    'scarce', { chapters: 8, sources: 24 }, assertFloors,
  )],
  ['canonical discovery deduplication', () => bootstrapFixture(
    'aliases', { aliases: true }, (result) => {
      assertFloors(result);
      assert.equal(result.bundle.stats.uniqueUrlCount, 12);
    },
  )],
  ['two failed net-new sources recover', () => bootstrapFixture(
    'two-failures', { failed: [0, 3] }, assertFloors,
  )],
  ['surplus reserves stay exclusive', () => bootstrapFixture(
    'surplus', { chapters: 8, sources: 64 }, (result) => {
      assertFloors(result);
      for (const pool of result.bundle.chapterPools) {
        assert.equal(pool.fetchedOk, 8, 'healthy pool promoted unnecessary evidence');
        assert.equal(pool.reserve.filter((entry) => entry.allocation === 'net-new-reserve').length, 2);
        assert(pool.reserve.length <= 6, 'reserve budget exceeded');
      }
    },
  )],
  ['exhausted net-new evidence fails early', () => bootstrapFixture(
    'exhausted', { sources: 10, failed: [0, 8, 9] }, ({ exitCode, diagnostics }) => {
      assert.equal(exitCode, 1);
      assert(diagnostics.some((line) => line.includes('net-new=1/2')), 'missing net-new shortfall diagnostic');
    },
  )],
];

const failures = [];
for (const [name, test] of tests) {
  try {
    await test();
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
}
if (failures.length) {
  for (const failure of failures) console.error(`[check-search-pools] ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`[check-search-pools] passed ${tests.length} allocation, recovery, and worker-input checks`);
}
