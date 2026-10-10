#!/usr/bin/env node
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  promoteReserveEvidence, recoverExclusiveEvidence, recoverRefreshEvidence, recoverReportDomains,
  replenishReserveEvidence, successfulPoolMetrics,
} from './search-pool-recovery.mjs';
import { canonicalSourceUrl, companySearchNames, getCoreArtifacts, isSelfPublishedReportUrl, loadWorkflowConfig } from './utils.mjs';
import { checkRun } from './check-report.mjs';
import { checkSearchQueryProvenance, executedSearchQueries } from './search-query-checks.mjs';
import { sourceQuality } from './source-quality.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const urls = (entries) => new Set(entries.map((entry) => canonicalSourceUrl(entry.url)));

async function bootstrapFixture(name, {
  chapters = 1, sources = 12, failed = [], lowSignal = [], aliases = false,
  selfPublished = [], redirects = [], company = { name: 'Acme', domain: 'acme.example' },
  resultOverrides = {},
  reportDomains, recoveryResults = [], refreshCandidates = [],
}, verify) {
  const folder = resolve('.research-cache', `20990101000000-pool-check-${name}-${process.pid}`);
  const results = Array.from({ length: sources }, (_, index) => ({
    url: selfPublished.includes(index)
      ? `https://startup.genisisiq.com/acme-${index}/`
      : `https://publisher${index + 1}.example/acme`,
    title: `${company.name} evidence ${index + 1}`,
    sourceQuality: { tier: lowSignal.includes(index) ? 'low' : 'high', score: 100 - index, reasons: [] },
    ...resultOverrides[index],
  }));
  const query = (id) => ({
    id, query: id, intent: 'broad', preferredProvider: 'fixture', maxResults: 10,
  });
  const plan = {
    company,
    refreshCandidates,
    strategy: {
      concurrency: 4,
      reportEvidenceTarget: { minDistinctDomains: reportDomains ?? (chapters === 8 ? 18 : 0) },
    },
    globalQueries: [query('global')],
    chapters: Array.from({ length: chapters }, (_, index) => ({
      key: `chapter-${index + 1}`,
      evidenceTarget: { minSources: 8, minDomains: 4, minNetNewSources: 2 },
      queries: [query(`chapter-${index + 1}`)],
    })),
    recoveryQueries: [
      { ...query('R-global'), scope: 'global', chapter: null, query: 'recover-global' },
      ...Array.from({ length: chapters }, (_, index) => ({
        ...query(`R-chapter-${index + 1}`), scope: 'chapter',
        chapter: `chapter-${index + 1}`, query: `recover-chapter-${index + 1}`,
      })),
    ],
  };
  const original = {
    execFile: childProcess.execFile,
    argv: process.argv,
    exitCode: process.exitCode,
    log: console.log,
    error: console.error,
  };
  const fetchCalls = [];
  const searchCalls = [];
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
      searchCalls.push(text);
      const start = text === 'global' ? 0 : (Number(text.split('-')[1]) - 1) * 7 + 3;
      response = {
        query: text,
        provider: 'fixture',
        results: text.startsWith('recover-') ? recoveryResults : Array.from({ length: 10 }, (_, index) => {
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
        finalUrl: redirects.some((index) => results[index].url === args[1])
          ? 'https://startup.genisisiq.com/acme/'
          : args[1],
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
    await verify({ folder, bundle, exitCode, diagnostics, fetchCalls, searchCalls });
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
  ...[
    ['Tines', 'fast', false],
    ['Acme Pharma', 'deep', false],
    ['Acme Logistics', 'fast', true],
    ['Harri', 'deep', true],
    ['Turso', 'fast', false],
  ].map(([company, profile, refresh], index) => [
    `company-neutral, dated discovery for ${company} (${profile}, ${refresh ? 'refresh' : 'fresh'})`,
    () => {
      const folder = resolve('.research-cache', `20990401000000-plan-check-${index}-${process.pid}`);
      try {
        mkdirSync(folder, { recursive: true });
        runJson('apply-research-profile.mjs', ['--report-folder', folder, '--profile', profile]);
        const website = `https://company${index}.example`;
        if (refresh) {
          const summaryCardPath = join(folder, 'previous-summary.yaml');
          writeFileSync(summaryCardPath, JSON.stringify({
            summary: { unresolvedGaps: ['Unverified 2020 revenue and current customer concentration'] },
          }));
          writeFileSync(join(folder, 'refresh-context.yaml'), JSON.stringify({
            previousReport: { company: { name: company, website }, summaryCardPath },
          }));
        }
        const plan = runJson('build-search-plan.mjs', [
          '--report-folder', folder, '--profile', profile,
          ...(refresh ? [] : ['--company', company, '--website', website]),
        ]);
        assert.equal(plan.runDate, '2099-04-01');
        assert.equal(plan.mode, refresh ? 'refresh' : 'fresh');
        assert.equal(plan.company.name, company);
        assert.equal(plan.chapters.length, 8);
        const policy = loadWorkflowConfig({ reportFolder: folder }).agentPolicy;
        const queries = [...plan.globalQueries, ...plan.chapters.flatMap((chapter) => chapter.queries)];
        assert.equal(plan.recoveryQueries.length, 9, 'supplemental discovery exceeded one round');
        for (const query of plan.recoveryQueries) {
          assert.equal(query.maxResults, profile === 'fast' ? 8 : 10);
          if (policy.volatileFactQueryTokens.some(token => query.query.toLowerCase().includes(token.toLowerCase()))) {
            assert.match(query.query, /\b2099\b/, 'supplemental volatile lookup lost the run year');
          }
        }
        for (const query of queries) {
          assert(query.query.includes(`"${company}"`), 'query lost the company identity');
          assert.doesNotMatch(query.query, /\b(?:SQLite|libSQL|database|serverless|Cloudflare D1|PlanetScale|Neon|Supabase)\b/i,
            'shared research terms assume an unrelated database industry or competitor set');
          const volatile = policy.volatileFactQueryTokens.some((token) => query.query.toLowerCase().includes(token.toLowerCase()));
          const dated = volatile || ['freshness', 'adverse'].includes(query.intent);
          if (dated) assert.match(query.query, /\b2099\b/, `undated current-evidence query: ${query.query}`);
          assert.equal((query.query.match(/\b2099\b/g) ?? []).length, dated ? 1 : 0,
            'query year was duplicated or added to a static lookup');
        }
        if (refresh) assert(queries.some((query) => /\b2020\b/.test(query.query)), 'refresh lost its prior evidence gap');
        for (const chapter of plan.chapters) {
          assert.equal(chapter.evidenceTarget.minSources >= (profile === 'fast' ? 8 : 25), true);
          assert.equal(chapter.evidenceTarget.minNetNewSources >= (profile === 'fast' ? 2 : 8), true);
          assert.equal(chapter.queries.length, (profile === 'fast' ? 2 : 5) + (refresh ? 1 : 0),
            'chapter discovery did not execute its configured breadth plus the retained gap');
          if (profile === 'deep') {
            for (const intent of ['broad', 'semantic', 'primary', 'freshness', 'adverse']) {
              assert(chapter.queries.some((query) => query.intent === intent),
                `${chapter.key}: deep discovery omitted ${intent} evidence`);
            }
          }
        }
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    },
  ]),
  ['company search aliases require the official domain and preserve qualified names', () => {
    for (const [name, domain, expected] of [
      ['Articulate Global', 'articulate.com', ['Articulate Global', 'articulate']],
      ['Enveda Biosciences', 'enveda.com', ['Enveda Biosciences', 'enveda']],
      ['Mujin, Inc.', 'mujin-corp.com', ['Mujin, Inc.', 'mujin']],
      ['Toss (Viva Republica)', 'toss.im', ['Toss (Viva Republica)', 'toss']],
      ['Energy Exploration Technologies, Inc. (EnergyX)', 'energyx.com',
        ['Energy Exploration Technologies, Inc. (EnergyX)', 'energyx']],
      ['Acme Robotics', 'acme.example', ['Acme Robotics']],
      ['Articulate Global', 'unrelated.example', ['Articulate Global']],
      ['Enveda Biosciences', 'unrelated.example', ['Enveda Biosciences']],
      ['Articulate Global', '', ['Articulate Global']],
      ['Acme', 'acme.example', ['Acme']],
    ]) assert.deepEqual(companySearchNames(name, domain), expected);
  }],
  ['refresh discovery covers retained gaps instead of repeating only the first across all chapters', () => {
    const folder = resolve('.research-cache', `20990401000000-gap-check-${process.pid}`);
    const gaps = ['Undisclosed revenue', 'Unconfirmed valuation', 'Unverified customer counts',
      'Unknown investment terms', 'Missing retention data'];
    try {
      mkdirSync(folder, { recursive: true });
      runJson('apply-research-profile.mjs', ['--report-folder', folder, '--profile', 'fast']);
      const summaryCardPath = join(folder, 'previous-summary.yaml');
      writeFileSync(summaryCardPath, JSON.stringify({ summary: { unresolvedGaps: gaps } }));
      writeFileSync(join(folder, 'refresh-context.yaml'), JSON.stringify({
        previousReport: { company: { name: 'Acme', website: 'https://acme.example' }, summaryCardPath },
      }));
      const plan = runJson('build-search-plan.mjs', ['--report-folder', folder, '--profile', 'fast']);
      assert.deepEqual(plan.strategy.previousUnresolvedGaps, gaps);
      for (const [index, chapter] of plan.chapters.entries()) {
        assert.equal(chapter.queries.length, 3, 'refresh exceeded the per-chapter query budget');
        assert(chapter.queries[0].query.includes(gaps[index % gaps.length]));
        assert.match(chapter.queries[0].query, /\b2099\b/);
      }
      const queries = [...plan.globalQueries, ...plan.chapters.flatMap(chapter => chapter.queries)];
      assert.equal(queries.length, 27);
      assert.equal(new Set(queries.map(query => query.query)).size, 24,
        'retained-gap discovery collapsed back to one shared query');
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }],
  ...[
    ['Articulate Global', 'articulate.com', 'articulate'],
    ['Enveda Biosciences', 'enveda.com', 'enveda'],
    ['Mujin, Inc.', 'mujin-corp.com', 'mujin'],
    ['Toss (Viva Republica)', 'toss.im', 'toss'],
    ['Energy Exploration Technologies, Inc. (EnergyX)', 'energyx.com', 'energyx'],
  ].map(([company, domain, brand], index) => [
    `formal-name discovery uses the domain-anchored ${brand} brand without Boolean ambiguity or expanded budgets`,
    () => {
      const folder = resolve('.research-cache', `20990401000000-brand-check-${index}-${process.pid}`);
      try {
        mkdirSync(folder, { recursive: true });
        runJson('apply-research-profile.mjs', ['--report-folder', folder, '--profile', 'fast']);
        const plan = runJson('build-search-plan.mjs', [
          '--report-folder', folder, '--profile', 'fast',
          '--company', company, '--website', `https://${domain}`,
        ]);
        const queries = [...plan.globalQueries, ...plan.chapters.flatMap(chapter => chapter.queries)];
        assert.equal(queries.length, 19);
        assert.equal(plan.company.name, company);
        for (const query of queries) {
          assert(query.query.startsWith(`"${brand}" `), query.query);
          assert(!query.query.includes(' OR '), query.query);
          assert.equal(query.maxResults, 8);
        }
        assert(plan.chapters.every(chapter =>
          chapter.queries.length === 2
          && chapter.evidenceTarget.minSources === 8
          && chapter.evidenceTarget.minDomains === 4
          && chapter.evidenceTarget.minNetNewSources === 2));
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    },
  ]),
  ['refresh query context comes only from the same retained company and stays bounded', () => {
    const folder = resolve('.research-cache', `20990401000000-entity-check-${process.pid}`);
    const company = { name: 'Game Science', website: 'https://www.gamesci.com.cn/',
      shortDescription: 'Chinese AAA game studio behind Black Myth: Wukong. Extra words test the exact twelve word cap.' };
    try {
      mkdirSync(folder, { recursive: true });
      runJson('apply-research-profile.mjs', ['--report-folder', folder, '--profile', 'fast']);
      writeFileSync(join(folder, 'refresh-context.yaml'), JSON.stringify({ previousReport: { company } }));
      const plan = runJson('build-search-plan.mjs', ['--report-folder', folder, '--profile', 'fast']);
      assert.equal(plan.company.searchContext.split(/\s+/).length, 12);
      assert(plan.company.searchContext.includes('Black Myth: Wukong.'));
      const queries = [...plan.globalQueries, ...plan.chapters.flatMap(chapter => chapter.queries)];
      assert.equal(queries.length, 19);
      assert.equal(plan.recoveryQueries.length, 9);
      for (const query of [...queries, ...plan.recoveryQueries]) {
        assert(query.query.startsWith(`"Game Science" ${plan.company.searchContext}`));
        assert.equal(query.maxResults, 8);
      }
      for (const overrides of [
        ['--company', 'Another Studio'],
        ['--website', 'https://unrelated.example'],
      ]) {
        const other = runJson('build-search-plan.mjs', [
          '--report-folder', folder, '--profile', 'fast', ...overrides,
        ]);
        assert.equal(other.company.searchContext, '', 'prior-company context leaked to a different identity');
        assert(!other.globalQueries.some(query => query.query.includes('Black Myth')));
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }],
  ['two-word company relevance rejects scattered and reversed generic words', () => bootstrapFixture(
    'entity-phrase', {
      company: { name: 'Game Science', domain: 'gamesci.com.cn' },
      resultOverrides: {
        0: { url: 'https://publisher1.example/science-is-an-infinite-sum-game',
          title: 'Science is an infinite sum game', snippet: 'Game Science' },
        1: { url: 'https://publisher2.example/game', title: 'Science interview' },
        2: { url: 'https://publisher3.example/game-science-company',
          title: 'Game Science announces next title' },
      },
    }, result => {
      assertFloors(result);
      assert(!result.bundle.candidates.some(entry => /publisher[12]\.example/.test(entry.url)));
      assert(result.bundle.candidates.some(entry => entry.url.includes('publisher3.example')));
    },
  )],
  ['refresh source discovery uses current quality policy, original URL provenance and six seeds per chapter', () => {
    const runId = `20990301000000-seed-source-${process.pid}`;
    const previousFolder = resolve('reports', runId);
    const folder = resolve('.research-cache', `20990401000000-seed-plan-${process.pid}`);
    try {
      mkdirSync(previousFolder);
      mkdirSync(folder, { recursive: true });
      runJson('apply-research-profile.mjs', ['--report-folder', folder, '--profile', 'fast']);
      const company = { name: 'Acme', website: 'https://acme.example', shortDescription: 'Factory automation' };
      const sources = Array.from({ length: 12 }, (_, index) => ({
        id: `SO${index}`, url: `https://source${index}.example/acme`, title: `Acme source ${index}`,
        date: `2099-02-${String(index + 1).padStart(2, '0')}`, accessStatus: 'ok',
        independence: 'independent', reputationTier: 'high', keyQuote: 'An old quotation must not be copied.',
      }));
      sources.push({ ...sources[0], url: 'https://linkedin.com/acme', id: 'SO-low' });
      sources.push({ ...sources[0], url: 'https://startup.genisisiq.com/acme', id: 'SO-circular' });
      sources.push({ ...sources[0], url: 'https://blocked.example/acme', id: 'SO-blocked', accessStatus: 'blocked' });
      sources.push({ ...sources[0], url: 'not a URL', id: 'SO-invalid' });
      writeFileSync(join(previousFolder, '01-company-overview.yaml'), JSON.stringify({ localEvidence: { sources } }));
      writeFileSync(join(previousFolder, '02-market-analysis.yaml'), JSON.stringify({ localEvidence: { sources } }));
      writeFileSync(join(folder, 'refresh-context.yaml'), JSON.stringify({ previousReport: { runId, company } }));
      const plan = runJson('build-search-plan.mjs', ['--report-folder', folder, '--profile', 'fast']);
      assert.equal(plan.refreshCandidates.length, 6);
      assert.equal(new Set(plan.refreshCandidates.map(entry => entry.url)).size, 6);
      for (const candidate of plan.refreshCandidates) {
        assert(!('keyQuote' in candidate));
        assert(!('independence' in candidate), 'prior issuer classification became current evidence');
        assert.equal(candidate.priorSources.length, 2);
        assert(candidate.priorSources.every(source => source.runId === runId && source.sourceId));
        assert(!/linkedin|startup\.genisisiq|blocked/.test(candidate.url));
      }
      const mismatched = runJson('build-search-plan.mjs', [
        '--report-folder', folder, '--profile', 'fast', '--website', 'https://another.example',
      ]);
      assert.deepEqual(mismatched.refreshCandidates, []);
      const quality = { highReputationDomains: ['reuters.com'], lowSignalDomains: ['linkedin.com'] };
      assert.equal(sourceQuality({ url: 'https://reuters.com/acme', title: 'Acme' },
        { officialDomain: 'acme.example', runYear: '2099' }, quality).score, 20);
      assert.equal(sourceQuality({ url: 'https://linkedin.com/acme', title: 'Acme' },
        { officialDomain: 'acme.example', runYear: '2099' }, quality).tier, 'low');
      assert.equal(sourceQuality({ url: 'https://acme.example', title: 'Acme 2099' },
        { officialDomain: 'acme.example', runYear: '2099' }, quality).score, 45);
    } finally {
      rmSync(previousFolder, { recursive: true, force: true });
      rmSync(folder, { recursive: true, force: true });
    }
  }],
  ['bounded refresh recovery refetches originals without inventing executed search results', () => {
    const seed = (id, tier = 'medium') => ({
      url: `https://${id}.example/acme`, title: 'Original source',
      sourceQuality: { tier }, priorSources: [{ runId: '20990301000000-acme',
        chapter: 'chapter-1', sourceId: `SO-${id}` }],
    });
    return bootstrapFixture('refresh-seeds', {
      sources: 10, failed: [0, 8, 9], refreshCandidates: [
        seed('seed1'), seed('seed2'), seed('low', 'low'),
        { ...seed('alias'), url: 'https://www.publisher1.example/acme/?utm_source=previous' },
        { ...seed('circular'), url: 'https://startup.genisisiq.com/acme' },
      ],
    }, result => {
      assertFloors(result);
      assert.equal(result.bundle.stats.refreshSeedPrefetchCount, 2);
      assert(result.fetchCalls.includes('https://seed1.example/acme'));
      assert(result.fetchCalls.includes('https://seed2.example/acme'));
      assert(!result.fetchCalls.some(url => /low\.example|startup\.genisisiq/.test(url)));
      const executed = executedSearchQueries(result.bundle);
      assert(executed.every(query => !query.resultUrls.some(url => url.includes('seed'))));
      const issues = checkSearchQueryProvenance({
        sources: [{ id: 'S1', url: 'https://seed1.example/acme' }],
        searchQueries: [{ ...executed[0], retainedSourceRefs: ['S1'] }],
      }, executed, 'fixture');
      assert(issues.some(issue => issue.code === 'searchQuerySourceMismatch'));
      assert(result.bundle.candidates.find(candidate => candidate.url.includes('seed1')).priorSources);
    });
  }],
  ['healthy refreshes do not fetch optional historical seeds', () => bootstrapFixture(
    'healthy-seeds', { refreshCandidates: [{
      url: 'https://seed.example/acme', sourceQuality: { tier: 'medium' },
      priorSources: [{ chapter: 'chapter-1' }],
    }] }, result => {
      assertFloors(result);
      assert.equal(result.bundle.stats.refreshSeedPrefetchCount, 0);
      assert(!result.fetchCalls.includes('https://seed.example/acme'));
    },
  )],
  ['source and report diversity use the same registrable domains as publication gates', () => {
    const first = { url: 'https://one.publisher.co.uk/acme', allocation: 'net-new' };
    const second = { url: 'https://two.publisher.co.uk/acme', allocation: 'net-new' };
    const third = { url: 'https://independent.example/acme', sourceQuality: { tier: 'medium' } };
    const fetched = new Map([first, second, third].map(entry => [entry.url, { ok: true }]));
    const pool = { key: 'test', evidenceTarget: { minSources: 2, minDomains: 2, minNetNewSources: 2, maxSources: 3 },
      recommended: [first, second], reserve: [] };
    assert.equal(successfulPoolMetrics(pool, fetched).successfulDomains.size, 1,
      'publisher subdomains inflated the chapter source floor');
    const recovered = recoverReportDomains([pool], [third], fetched, 2);
    assert.equal(successfulPoolMetrics(recovered[0], fetched).successfulDomains.size, 2);
    assert(recovered[0].recommended.find(entry => entry.url === third.url).requiredForReportDomains);
  }],
  ['refresh recovery retains two relevant original inputs without borrowing exclusive URLs or exceeding caps', () => {
    const seed = (id, chapters) => ({ url: `https://${id}.example/acme`, sourceQuality: { tier: 'medium' },
      priorSources: chapters.map(chapter => ({ chapter })) });
    const seeds = [seed('shared-original', ['one', 'two']), seed('one-original', ['one']),
      seed('two-exclusive', ['two']), seed('spare', ['one', 'two'])];
    const pools = ['one', 'two'].map(key => ({
      key, evidenceTarget: { minSources: 2, minDomains: 2, minNetNewSources: 1, maxSources: 3 },
      recommended: [{ url: `https://${key}.example/acme`, allocation: 'net-new' }], reserve: [],
    }));
    pools[1].reserve = [{ ...seeds[2], allocation: 'net-new-reserve' }];
    const fetched = new Map([...seeds, ...pools.flatMap(pool => pool.recommended)].map(entry => [entry.url, { ok: true }]));
    const before = structuredClone(pools);
    const recovered = recoverRefreshEvidence(pools, seeds, fetched);
    assert.deepEqual(pools, before);
    for (const pool of recovered) {
      assert.equal(pool.recommended.filter(entry => entry.requiredForRefreshEvidence).length, 2);
      assert.equal(pool.recommended.length, 3);
      assert(pool.reserve.every(entry => !urls(pool.recommended).has(entry.url)));
    }
    assert(!urls(recovered[0].recommended).has(seeds[2].url));
    assert.equal(recovered[1].recommended.find(entry => entry.url === seeds[2].url).allocation, 'net-new');
    const reassigned = recoverExclusiveEvidence(recovered.map(pool => ({ ...pool,
      evidenceTarget: { ...pool.evidenceTarget, minNetNewSources: 2 } })), seeds, fetched);
    assert(reassigned.every(pool => urls(pool.recommended).has(seeds[0].url)),
      'exclusive recovery removed another chapter mandatory original-source input');
  }],
  ['brand relevance accepts Articulate coverage but rejects snippet and one-surface leakage', () => bootstrapFixture(
    'brand-relevance', {
      company: { name: 'Articulate Global', domain: 'articulate.com' },
      resultOverrides: {
        0: { url: 'https://siliconangle.com/articulate-raises-1-5b/',
          title: 'Articulate raises $1.5B in funding for its cloud-based software' },
        1: { url: 'https://publisher2.example/another-company', title: 'Another company raises funding',
          snippet: 'Articulate Global cloud software' },
        2: { url: 'https://publisher3.example/another-company', title: 'Articulate raises funding' },
        3: { url: 'https://publisher4.example/articulate', title: 'Cloud software funding' },
      },
    }, result => {
      assertFloors(result);
      assert(result.bundle.candidates.some(entry => entry.url.includes('siliconangle.com')));
      for (const domain of ['publisher2.example', 'publisher3.example', 'publisher4.example']) {
        assert(!result.bundle.candidates.some(entry => entry.url.includes(domain)), domain);
      }
      assert(result.bundle.stats.rejectedIrrelevantCount >= 3);
    },
  )],
  ['qualified company names still reject a different business sharing the first word', () => bootstrapFixture(
    'brand-namesake', {
      company: { name: 'Acme Robotics', domain: 'acme.example' },
      resultOverrides: {
        0: { url: 'https://publisher1.example/acme-logistics', title: 'Acme Logistics raises funding',
          snippet: 'Acme Robotics funding news' },
      },
    }, result => {
      assertFloors(result);
      assert(!result.bundle.candidates.some(entry => entry.url.includes('publisher1.example')));
    },
  )],
  ['domain-anchored biosciences brand retains financing and product coverage', () => bootstrapFixture(
    'biosciences-brand', {
      company: { name: 'Enveda Biosciences', domain: 'enveda.com' },
      resultOverrides: {
        0: { url: 'https://www.bruker.com/en/landingpages/bdal/customer-insight-enveda.html',
          title: 'Customer Insight Enveda' },
        1: { url: 'https://www.businesswire.com/news/home/20250904184822/en/Enveda-Raises-150M',
          title: 'Enveda Raises $150M Series D Funding to Reach Unicorn Status' },
        2: { url: 'https://publisher3.example/enveda', title: 'Another company raises funding',
          snippet: 'Enveda Biosciences drug discovery' },
      },
    }, result => {
      assertFloors(result);
      assert(result.bundle.candidates.some(entry => entry.url.includes('bruker.com')));
      assert(result.bundle.candidates.some(entry => entry.url.includes('businesswire.com')));
      assert(!result.bundle.candidates.some(entry => entry.url.includes('publisher3.example')));
    },
  )],
  ['self-published URL matching preserves external sources', () => {
    for (const url of [
      'https://startup.genisisiq.com/acme/',
      'HTTPS://WWW.STARTUP.GENISISIQ.COM./zh/acme/?utm_source=search',
      'https://preview.startup.genisisiq.com/acme/',
    ]) assert.equal(isSelfPublishedReportUrl(url), true, url);
    for (const url of [
      'https://genisisiq.com/acme/',
      'https://startup.genisisiq.com.external.example/acme/',
      'https://external.example/startup.genisisiq.com/',
      'https://external.example/?url=https://startup.genisisiq.com/acme/',
    ]) assert.equal(isSelfPublishedReportUrl(url), false, url);
  }],
  ['report content gate rejects circular evidence without re-scoring historical contracts', () => {
    const runId = `20990101000000-pool-check-self-report-${process.pid}`;
    const folder = resolve('reports', runId);
    mkdirSync(folder);
    try {
      for (const artifact of getCoreArtifacts()) writeFileSync(join(folder, artifact.file), '{}\n');
      writeFileSync(join(folder, 'evidence.yaml'), JSON.stringify({
        sources: [{ id: 'SO001', url: 'https://startup.genisisiq.com/acme/' }],
      }));
      const full = checkRun(runId);
      assert.equal(full.checked, true);
      assert.equal(full.failures.filter((entry) => entry.code === 'circularReportSource').length, 1);
      const contract = checkRun(runId, { contentGates: false });
      assert.equal(contract.checked, true);
      assert(!contract.failures.some((entry) => entry.code === 'circularReportSource'));
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }],
  ['self-published reports never enter evidence pools', () => bootstrapFixture(
    'self-published', { selfPublished: [0] }, (result) => {
      assertFloors(result);
      assert(result.bundle.candidates.every((entry) => !entry.url.includes('startup.genisisiq.com')),
        'bootstrap admitted its own published report as evidence');
      assert(result.fetchCalls.every((url) => !url.includes('startup.genisisiq.com')));
      assert(result.bundle.stats.rejectedSelfPublishedCount > 0);
    },
  )],
  ['self-published redirects trigger reserve recovery', () => bootstrapFixture(
    'self-redirect', { redirects: [0] }, (result) => {
      assertFloors(result);
      const redirected = result.bundle.fetchedSources.find((entry) => entry.url === 'https://publisher1.example/acme');
      assert.equal(redirected.ok, false, 'redirect to this site counted as independent fetched evidence');
      assert.match(redirected.error, /self-published/);
      assert(result.bundle.stats.recoveryPrefetchCount > 0);
    },
  )],
  ['cached search results exclude self-published reports', () => {
    const runId = `20990101000000-pool-check-self-cache-${process.pid}`;
    const folder = resolve('.research-cache', runId);
    const cacheDir = join(folder, 'search-results');
    const query = 'Acme funding 2099';
    const cacheKey = createHash('sha256').update(JSON.stringify({
      provider: 'anysearch', query, intent: 'broad', officialDomain: '', maxResults: 10, freshness: '',
    })).digest('hex').slice(0, 20);
    try {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(cacheDir, `${cacheKey}.json`), JSON.stringify({
        fetchedAt: new Date().toISOString(),
        results: [
          { url: 'https://startup.genisisiq.com/acme/', title: 'Acme diligence' },
          { url: 'https://publisher.example/acme', title: 'Acme funding' },
        ],
      }));
      const result = runJson('search-web.mjs', ['--report-folder', folder, '--query', query]);
      assert.equal(result.cache, 'hit');
      assert.deepEqual(result.results.map((entry) => entry.url), ['https://publisher.example/acme']);
      assert.deepEqual(result.excludedResults, [{
        url: 'https://startup.genisisiq.com/acme/', reason: 'self-published-report',
      }]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }],
  ['fresh search excludes circular evidence before caching', () => {
    const folder = resolve('.research-cache', `20990101000000-pool-check-self-fresh-${process.pid}`);
    const script = join(here, 'search-web.mjs');
    const results = [
      { url: 'https://startup.genisisiq.com/acme/', title: 'Acme diligence' },
      { url: 'https://publisher.example/acme', title: 'Acme funding' },
    ];
    try {
      const result = childProcess.spawnSync(process.execPath, ['--input-type=module', '-e', `
        globalThis.fetch = async () => ({
          ok: true,
          text: async () => JSON.stringify({ data: { results: ${JSON.stringify(results)} } }),
        });
        process.argv = ${JSON.stringify([process.execPath, script, '--report-folder', folder, '--query', 'Acme funding 2099'])};
        await import(${JSON.stringify(pathToFileURL(script).href)});
      `], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const fresh = JSON.parse(result.stdout);
      assert.equal(fresh.cache, 'miss');
      assert.deepEqual(fresh.results.map((entry) => entry.url), ['https://publisher.example/acme']);
      assert.equal(fresh.excludedResults[0].reason, 'self-published-report');
      const cached = runJson('search-web.mjs', ['--report-folder', folder, '--query', 'Acme funding 2099']);
      assert.equal(cached.cache, 'hit');
      assert.deepEqual(cached.results, fresh.results);
      assert.deepEqual(cached.excludedResults, fresh.excludedResults);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }],
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
  ['workers reject circular evidence in old successful bundles', () => bootstrapFixture(
    'self-worker', {}, ({ bundle, folder }) => {
      const roster = runJson('load-chapter-runtime-context.mjs', ['--list', '--report-folder', folder]);
      const pool = bundle.chapterPools[0];
      const self = 'https://startup.genisisiq.com/acme/';
      for (const [url, fetchFinalUrl, globalFinalUrl] of [
        [self, null, null],
        ['https://redirect.example/acme', self, null],
        ['https://redirect.example/acme', null, self],
      ]) {
        const candidate = { url, fetch: { ok: true, finalUrl: fetchFinalUrl } };
        const contaminated = {
          ...bundle,
          fetchedSources: [...bundle.fetchedSources, { url, ok: true, finalUrl: globalFinalUrl }],
          chapterPools: roster.chapters.map((chapter) => ({
            ...pool, key: chapter.key, reserve: [...pool.reserve, candidate],
          })),
        };
        writeFileSync(join(folder, 'search-bundle.json'), JSON.stringify(contaminated));
        const result = childProcess.spawnSync(process.execPath, [
          join(here, 'run-chapter-workers.mjs'), '--report-folder', folder, '--dry-run', '--format', 'json',
        ], { encoding: 'utf8' });
        assert.notEqual(result.status, 0, 'worker received circular evidence from a stale bundle');
        assert.match(result.stderr, /self-published report evidence/);
        assert.match(result.stderr, /rerun research:bootstrap/);
      }
    },
  )],
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
    'exhausted', { sources: 10, failed: [0, 8, 9] }, ({ exitCode, diagnostics, bundle }) => {
      assert.equal(exitCode, 1);
      assert(diagnostics.some(line => line.includes('sources=7/8')), 'missing usable-source shortfall diagnostic');
      assert.equal(bundle.stats.recoveryQueryCount, 1, 'recovery must stop after one bounded search round');
    },
  )],
  ['low-signal scarcity is diagnosed without assigning disallowed sources', () => bootstrapFixture(
    'low-signal', { sources: 10, lowSignal: [1, 2, 3, 4, 5, 6, 7, 8, 9] }, ({ bundle, exitCode, diagnostics }) => {
      assert.equal(exitCode, 1);
      assert(diagnostics.some(line => line.includes('insufficient fetched evidence')));
      assert(bundle.chapterPools.every(pool =>
        [...pool.recommended, ...pool.reserve].every(candidate => candidate.sourceQuality.tier !== 'low')));
    },
  )],
  ['exhausted initial reserves recover through bounded redistribution', () => bootstrapFixture(
    'refill', { chapters: 8, sources: 64, failed: [0, 1, 3, 4] }, result => {
      assertFloors(result);
      assert(result.bundle.stats.recoveryPrefetchCount > 0);
      assert(result.bundle.chapterPools.every(pool => pool.reserve.length <= 6));
    },
  )],
  ['healthy evidence never launches supplemental searches', () => bootstrapFixture(
    'healthy-no-search', {}, result => {
      assertFloors(result);
      assert.equal(result.bundle.stats.recoveryQueryCount, 0);
      assert.equal(result.searchCalls.length, 2);
    },
  )],
  ['bounded supplemental discovery fetches original evidence and preserves query provenance', () => bootstrapFixture(
    'supplemental', {
      sources: 10, failed: [0, 8, 9],
      recoveryResults: [
        { url: 'https://new1.example/acme', title: 'Acme customer interview', sourceQuality: { tier: 'high' } },
        { url: 'https://new2.example/acme', title: 'Acme original reporting', sourceQuality: { tier: 'high' } },
        { url: 'https://startup.genisisiq.com/acme/', title: 'Acme report', sourceQuality: { tier: 'high' } },
        { url: 'https://unrelated.example/company', title: 'Another company', sourceQuality: { tier: 'high' } },
        { url: 'https://low.example/acme', title: 'Acme listing', sourceQuality: { tier: 'low' } },
      ],
    }, result => {
      assertFloors(result);
      assert.equal(result.bundle.stats.recoveryQueryCount, 1);
      assert.match(result.searchCalls.at(-1), /recover-chapter-1 -site:acme\.example/);
      assert.equal(result.bundle.searches.at(-1).response.provider, 'fixture');
      assert.equal(result.bundle.searches.at(-1).response.results.length, 5);
      const executed = executedSearchQueries(result.bundle, result.bundle.chapterPools[0])
        .find(record => record.query === result.searchCalls.at(-1));
      assert.equal(executed.engine, 'fixture');
      assert.equal(executed.hits, 5);
      assert(executed.resultUrls.some(url => url.includes('new1.example')));
      for (const domain of ['new1.example', 'new2.example']) {
        assert(result.fetchCalls.some(url => url.includes(domain)), 'new original source was not fetched');
        assert(result.bundle.candidates.find(candidate => candidate.url.includes(domain)).discoveredBy.includes('R-chapter-1'));
      }
      assert(!result.fetchCalls.some(url => /unrelated\.example|low\.example|startup\.genisisiq\.com/.test(url)));
    },
  )],
  ['report-wide domain ceiling fails before workers despite healthy chapter floors', () => bootstrapFixture(
    'domain-ceiling', { chapters: 2, sources: 12, reportDomains: 18 }, result => {
      assert.equal(result.exitCode, 1);
      assert(result.bundle.chapterPools.every(pool => pool.fetchedOk >= 8 && pool.fetchedNetNew >= 2));
      assert.equal(result.bundle.stats.recoveryQueryCount, 1);
      assert(result.diagnostics.some(line => line.includes('insufficient report-wide fetched domains')));
      assert(result.bundle.stats.fetchedReportDomains < 18);
    },
  )],
  ['supplemental domain recovery preserves the report floor instead of a raw-candidate proxy', () => bootstrapFixture(
    'domain-recovery', { reportDomains: 10 }, result => {
      assertFloors(result);
      assert.equal(result.bundle.stats.recoveryQueryCount, 1);
      assert.equal(result.bundle.stats.fetchedReportDomains, 10);
      assert(result.bundle.chapterPools[0].recommended.some(candidate => candidate.requiredForReportDomains));
    },
  )],
  ['exclusive recovery replaces shared donors safely and never invents another chapter net-new source', () => {
    const candidate = (id, allocation = 'shared') => ({
      url: `https://${id}.example/acme`, allocation, sourceQuality: { tier: 'high' },
    });
    const shared = candidate('shared');
    const spare = candidate('spare');
    const pools = [
      { key: 'deficient', evidenceTarget: { minSources: 2, minDomains: 2, minNetNewSources: 1 },
        recommended: [shared, candidate('local')], reserve: [] },
      { key: 'donor', evidenceTarget: { minSources: 2, minDomains: 2, minNetNewSources: 1 },
        recommended: [shared, candidate('exclusive', 'net-new')], reserve: [] },
    ];
    const candidates = [...pools.flatMap(pool => pool.recommended), spare];
    const fetched = new Map(candidates.map(entry => [entry.url, { ok: true }]));
    const before = structuredClone(pools);
    const repaired = recoverExclusiveEvidence(pools, candidates, fetched);
    assert.deepEqual(pools, before, 'exclusive repair mutated its input');
    assert.equal(successfulPoolMetrics(repaired[0], fetched).successfulNetNew, 1);
    assert.equal(successfulPoolMetrics(repaired[1], fetched).successfulNetNew, 1);
    assert.equal(successfulPoolMetrics(repaired[1], fetched).successfulDomains.size, 2);
    assert(!urls(repaired[1].recommended).has(shared.url));
    const noSpare = recoverExclusiveEvidence(pools, [shared, candidate('exclusive', 'net-new')], fetched);
    assert.equal(successfulPoolMetrics(noSpare[0], fetched).successfulNetNew, 0,
      'repair removed mandatory donor evidence without a replacement');
    const diversity = recoverReportDomains(repaired, candidates, fetched, 4);
    assert.equal(new Set(diversity.flatMap(pool => pool.recommended.map(entry => new URL(entry.url).hostname))).size, 4);
    assert.equal(recoverReportDomains(repaired.map(pool => ({ ...pool, evidenceTarget: { ...pool.evidenceTarget, maxSources: 2 } })),
      candidates, fetched, 4).flatMap(pool => pool.recommended).length, 4, 'domain repair exceeded source caps');
  }],
  ['exclusive recovery preserves donor external coverage and required evidence markers', () => {
    const candidate = (id, official = false) => ({
      url: `https://${id}.example/acme`, allocation: 'shared',
      sourceQuality: { tier: 'high', reasons: official ? ['official-domain'] : [] },
    });
    const shared = { ...candidate('shared'), allocation: 'report-diversity' };
    const officialSpare = candidate('official-spare', true);
    const externalSpare = candidate('external-spare');
    const pools = [
      { key: 'deficient', evidenceTarget: { minSources: 2, minDomains: 2, minNetNewSources: 1 },
        recommended: [shared, candidate('local', true)], reserve: [] },
      { key: 'donor', evidenceTarget: { minSources: 4, minDomains: 2, minNetNewSources: 1 },
        recommended: [{ ...shared, allocation: 'independent-candidate' },
          { ...candidate('exclusive'), allocation: 'net-new' },
          ...Array.from({ length: 3 }, (_, index) => candidate(`official${index}`, true))], reserve: [] },
    ];
    const fetched = new Map([...pools.flatMap(pool => pool.recommended), officialSpare, externalSpare]
      .map(entry => [entry.url, { ok: true }]));
    const blocked = recoverExclusiveEvidence(pools, [shared, officialSpare], fetched);
    assert(urls(blocked[1].recommended).has(shared.url), 'surplus source counts hid lost external coverage');
    const repaired = recoverExclusiveEvidence(pools, [shared, officialSpare, externalSpare], fetched);
    assert(!urls(repaired[1].recommended).has(shared.url));
    assert.equal(repaired[1].recommended.find(entry => entry.url === externalSpare.url).allocation,
      'independent-candidate', 'replacement lost the donor worker retention requirement');
    assert(repaired[0].recommended.find(entry => entry.url === shared.url).requiredForReportDomains,
      'exclusive conversion lost the report-diversity retention requirement');
  }],
  ['failed fetch rows do not consume usable-source recovery slots', () => {
    const local = { url: 'https://local.example/acme', allocation: 'net-new' };
    const failed = { url: 'https://failed.example/acme', allocation: 'net-new' };
    const spare = { url: 'https://spare.example/acme', sourceQuality: { tier: 'high' } };
    const pool = { key: 'deficient',
      evidenceTarget: { minSources: 2, minDomains: 2, minNetNewSources: 2, maxSources: 2 },
      recommended: [local, failed], reserve: [] };
    const fetched = new Map([[local.url, { ok: true }], [failed.url, { ok: false }], [spare.url, { ok: true }]]);
    const exclusive = recoverExclusiveEvidence([pool], [spare], fetched);
    assert.equal(successfulPoolMetrics(exclusive[0], fetched).successfulNetNew, 2);
    const diversity = recoverReportDomains([{ ...pool,
      reserve: [{ ...spare, allocation: 'net-new-reserve' }] }], [spare], fetched, 2);
    assert.equal(successfulPoolMetrics(diversity[0], fetched).successfulDomains.size, 2);
    assert.equal(successfulPoolMetrics(diversity[0], fetched).successful, 2);
    assert.equal(diversity[0].recommended.find(entry => entry.url === spare.url).allocation, 'net-new');
    assert.deepEqual(pool.recommended, [local, failed], 'recovery mutated original failed-fetch evidence');
  }],
  ['reserve refill redistributes only surplus backups within the six-source cap', () => {
    const candidate = (id, allocation = 'net-new', tier = 'high') => ({
      url: `https://${id}.example/acme`, allocation, sourceQuality: { tier },
    });
    const pools = [
      { key: 'failed', evidenceTarget: { minSources: 2, minDomains: 2, minNetNewSources: 2 },
        recommended: [candidate('failed')], reserve: [candidate('blocked', 'net-new-reserve')] },
      { key: 'healthy', evidenceTarget: { minSources: 1, minDomains: 1, minNetNewSources: 1 },
        recommended: [candidate('healthy')], reserve: [candidate('reserved', 'net-new-reserve')] },
    ];
    const fetched = new Map([['https://failed.example/acme', { ok: false }],
      ['https://blocked.example/acme', { ok: false }], ['https://healthy.example/acme', { ok: true }]]);
    const candidates = [candidate('blocked'), candidate('reserved'), candidate('low', 'reserve', 'low'),
      ...Array.from({ length: 10 }, (_, i) => candidate(`new${i}`))];
    const original = structuredClone(pools);
    const replenished = replenishReserveEvidence(pools, candidates, fetched);
    assert.deepEqual(pools, original, 'refill mutated its input');
    assert.deepEqual(replenished[1].recommended, pools[1].recommended, 'healthy recommended evidence must remain protected');
    assert.equal(replenished[1].reserve.length, 0, 'transferred backup must leave its former pool');
    assert.equal(replenished[0].reserve.length, 6);
    assert(replenished[0].reserve.every(entry =>
      (entry.url.includes('//new') || entry.url.includes('//reserved')) && entry.allocation === 'net-new-reserve'));
    for (const entry of replenished[0].reserve) fetched.set(entry.url, { ok: true });
    const recovery = promoteReserveEvidence(replenished[0], fetched);
    assert.equal(recovery.successful, 2);
    assert.equal(recovery.successfulNetNew, 2);
  }],
  ['shared recovery repairs source and domain floors without moving or inflating exclusive evidence', () => {
    const candidate = (id, allocation = 'shared', tier = 'high') => ({
      url: `https://${id}.example/evidence`, allocation, sourceQuality: { tier },
    });
    const own = [candidate('own1', 'net-new'), candidate('own2', 'net-new'),
      ...Array.from({ length: 5 }, (_, index) => ({
        ...candidate(`ordinary${index}`), url: `https://ordinary.example/evidence-${index}`,
      }))];
    const sibling = [candidate('exclusive1', 'net-new'), candidate('exclusive2', 'net-new'),
      ...Array.from({ length: 6 }, (_, index) => candidate(`shared${index}`))];
    const blocked = candidate('blocked', 'net-new-reserve');
    const pools = [
      { key: 'deficient', evidenceTarget: { minSources: 8, minDomains: 4, minNetNewSources: 2 },
        recommended: own, reserve: [blocked] },
      { key: 'healthy', evidenceTarget: { minSources: 8, minDomains: 4, minNetNewSources: 2 },
        recommended: sibling, reserve: [] },
    ];
    const low = candidate('low', 'shared', 'low');
    const failed = candidate('failed', 'shared');
    const candidates = [...own, ...sibling, blocked, low, failed];
    const fetched = new Map(candidates.map(entry => [entry.url, {
      ok: ![blocked.url, failed.url].includes(entry.url),
    }]));
    const original = structuredClone(pools);
    const replenished = replenishReserveEvidence(pools, candidates, fetched);
    assert.deepEqual(pools, original, 'shared recovery mutated its inputs');
    assert.deepEqual(replenished[1], pools[1], 'shared reuse moved another chapter\'s evidence');
    assert.equal(replenished[0].reserve.length, 6);
    assert(replenished[0].reserve.every(entry =>
      entry.url.includes('//shared') && entry.allocation === 'shared-recovery'));
    const recovery = promoteReserveEvidence(replenished[0], fetched);
    assert.equal(recovery.successful, 8);
    assert.equal(recovery.successfulDomains.size, 4);
    assert.equal(recovery.successfulNetNew, 2);
    assert.equal(recovery.promoted.length, 1);
    const extraOrdinary = { ...candidate('ordinary6'), url: 'https://ordinary.example/evidence-6' };
    fetched.set(extraOrdinary.url, { ok: true });
    const domainOnly = { ...pools[0], recommended: [...own, extraOrdinary] };
    const domainRefill = replenishReserveEvidence(
      [domainOnly, pools[1]], [...candidates, extraOrdinary], fetched,
    );
    const domainRecovery = promoteReserveEvidence(domainRefill[0], fetched);
    assert.equal(domainRecovery.successful, 9, 'domain-only recovery stopped at the source floor');
    assert.equal(domainRecovery.successfulDomains.size, 4);
    assert.equal(domainRecovery.successfulNetNew, 2);
    const insufficientNetNew = {
      ...pools[0],
      recommended: own.map(entry => entry.url === own[1].url ? { ...entry, allocation: 'shared' } : entry),
    };
    const short = replenishReserveEvidence([insufficientNetNew, pools[1]], candidates, fetched);
    const partial = promoteReserveEvidence(short[0], fetched);
    assert.equal(partial.successful, 8);
    assert.equal(partial.successfulNetNew, 1, 'shared recovery invented a net-new source');
    assert(partial.successfulNetNew < short[0].evidenceTarget.minNetNewSources);
    const netNewOnly = { ...insufficientNetNew, recommended: partial.recommended };
    const netNewRefill = replenishReserveEvidence([netNewOnly, pools[1]], candidates, fetched);
    assert.equal(netNewRefill[0].reserve.length, 0,
      'a net-new-only deficit allocated shared sources that cannot repair it');
  }],
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
