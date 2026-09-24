#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { normalizeDomain } from './utils.mjs';

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const buildPlanScript = join(scriptDir, 'build-search-plan.mjs');
const searchScript = join(scriptDir, 'search-web.mjs');
const fetchScript = resolve(scriptDir, '../../fetch-url/scripts/fetch.mjs');

function usage(code = 0) {
  console.error('Usage: execute-search-plan.mjs --report-folder <path> [--company <name>] [--website <url>] [--chapter <key|order>] [--profile fast|deep] [--provider <name>] [--fetch-concurrency <n>] [--no-prefetch] [--out <path>]');
  process.exit(code);
}

function parseArgs(argv) {
  const args = {
    folder: '',
    company: '',
    website: '',
    chapter: '',
    profile: 'deep',
    provider: 'auto',
    fetchConcurrency: 4,
    prefetch: true,
    out: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--report-folder') args.folder = argv[++i] ?? '';
    else if (arg === '--company') args.company = argv[++i] ?? '';
    else if (arg === '--website') args.website = argv[++i] ?? '';
    else if (arg === '--chapter') args.chapter = argv[++i] ?? '';
    else if (arg === '--profile') args.profile = argv[++i] ?? '';
    else if (arg === '--provider') args.provider = argv[++i] ?? '';
    else if (arg === '--fetch-concurrency') args.fetchConcurrency = Number(argv[++i] ?? 0);
    else if (arg === '--no-prefetch') args.prefetch = false;
    else if (arg === '--out') args.out = argv[++i] ?? '';
    else if (arg === '-h' || arg === '--help') usage();
    else usage(1);
  }
  if (!args.folder || !Number.isInteger(args.fetchConcurrency) || args.fetchConcurrency < 1) usage(1);
  return args;
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runWorker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, runWorker),
  );
  return results;
}

function flattenQueries(plan) {
  const all = [
    ...(plan.globalQueries ?? []).map((query) => ({
      scope: 'global',
      chapter: null,
      ...query,
    })),
    ...plan.chapters.flatMap((chapter) => chapter.queries.map((query) => ({
      scope: 'chapter',
      chapter: chapter.key,
      ...query,
    }))),
  ];
  const seen = new Set();
  return all.filter((entry) => {
    const key = entry.query.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const companyStopwords = new Set([
  'and', 'company', 'corp', 'corporation', 'inc', 'limited', 'llc', 'ltd',
  'technologies', 'technology', 'the',
]);

function normalizedWords(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function companyRelevant(result, company) {
  const resultDomain = normalizeDomain(result.url);
  if (company.domain && (
    resultDomain === company.domain
    || resultDomain.endsWith(`.${company.domain}`)
  )) return true;
  const companyWords = normalizedWords(company.name)
    .filter((word) => word.length >= 2 && !companyStopwords.has(word));
  if (companyWords.length === 0) return true;
  // Search snippets can contain namesakes or query-term leakage. Require the
  // company identity in the result title/URL unless it is an official domain.
  const haystack = new Set(normalizedWords([
    result.title,
    result.url,
  ].filter(Boolean).join(' ')));
  const matches = companyWords.filter((word) => haystack.has(word)).length;
  const requiredMatches = companyWords.length === 1 ? 1 : Math.min(2, companyWords.length);
  return matches >= requiredMatches;
}

const args = parseArgs(process.argv.slice(2));
const folder = resolve(args.folder);
const planArgs = [
  buildPlanScript,
  '--report-folder', folder,
  '--profile', args.profile,
];
if (args.company) planArgs.push('--company', args.company);
if (args.website) planArgs.push('--website', args.website);
if (args.chapter) planArgs.push('--chapter', args.chapter);

const planResult = await execFileAsync(process.execPath, planArgs, {
  maxBuffer: 10 * 1024 * 1024,
});
const plan = JSON.parse(planResult.stdout);
const queries = flattenQueries(plan);
const disabledProviders = new Set();

function providerOrder(query) {
  if (args.provider !== 'auto') return [args.provider];
  return [...new Set([
    query.preferredProvider,
    ...(query.fallbackProviders ?? []),
  ].filter(Boolean))];
}

function isPermanentProviderFailure(message) {
  return /requires \w+|HTTP (?:401|402|403)\b/i.test(message);
}

function isTransientProviderFailure(message) {
  return /HTTP (?:408|409|425|429|5\d\d)\b|timed? ?out|ECONNRESET|fetch failed/i.test(message);
}

const searches = await runPool(queries, plan.strategy.concurrency, async (query) => {
  const startedAt = Date.now();
  let lastError = '';
  const providersTried = [];
  let attempts = 0;
  for (const provider of providerOrder(query)) {
    if (disabledProviders.has(provider)) continue;
    const searchArgs = [
      searchScript,
      '--report-folder', folder,
      '--query', query.query,
      '--intent', query.intent,
      '--provider', provider,
      '--max-results', String(query.maxResults),
    ];
    if (plan.company.domain) searchArgs.push('--official-domain', plan.company.domain);
    if (query.intent === 'freshness') searchArgs.push('--freshness', 'pm');
    const maxAttempts = args.provider === 'auto' ? 2 : 3;
    for (let providerAttempt = 1; providerAttempt <= maxAttempts; providerAttempt += 1) {
      attempts += 1;
      if (!providersTried.includes(provider)) providersTried.push(provider);
      try {
        const result = await execFileAsync(process.execPath, searchArgs, {
          maxBuffer: 10 * 1024 * 1024,
        });
        return {
          ...query,
          attempts,
          providersTried,
          durationMs: Date.now() - startedAt,
          response: JSON.parse(result.stdout),
        };
      } catch (error) {
        lastError = String(error.stderr || error.message || error).trim();
        if (isPermanentProviderFailure(lastError)) {
          disabledProviders.add(provider);
          break;
        }
        if (!isTransientProviderFailure(lastError) || providerAttempt === maxAttempts) break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, providerAttempt * 1000));
      }
    }
  }
  return {
    ...query,
    attempts,
    providersTried,
    durationMs: Date.now() - startedAt,
    error: lastError,
    response: null,
  };
});

const candidates = new Map();
let rejectedIrrelevantCount = 0;
for (const search of searches) {
  for (const result of search.response?.results ?? []) {
    if (!companyRelevant(result, plan.company)) {
      rejectedIrrelevantCount += 1;
      continue;
    }
    const existing = candidates.get(result.url);
    if (existing) existing.discoveredBy.push(search.id);
    else candidates.set(result.url, { ...result, discoveredBy: [search.id] });
  }
}

function uniqueResults(searchList) {
  const seen = new Set();
  const results = [];
  for (const search of searchList) {
    for (const result of search.response?.results ?? []) {
      if (!companyRelevant(result, plan.company)) continue;
      if (seen.has(result.url)) continue;
      seen.add(result.url);
      results.push(result);
    }
  }
  return results.sort((left, right) => (
    (right.sourceQuality?.score ?? 0) - (left.sourceQuality?.score ?? 0)
  ));
}

const globalCandidates = uniqueResults(
  searches.filter((search) => search.scope === 'global'),
);
const allCandidates = [...candidates.values()];
const directByChapter = new Map(plan.chapters.map((chapter) => [
  chapter.key,
  uniqueResults(searches.filter((search) => search.chapter === chapter.key)),
]));
const allocatedNetNewOwner = new Map();
const allocatedNetNewDomains = new Set();
const isOfficialCandidate = (candidate) => (
  candidate.sourceQuality?.reasons?.includes('official-domain')
);
const netNewByChapter = new Map();
for (const chapter of plan.chapters) {
  const direct = directByChapter.get(chapter.key) ?? [];
  const preferredCandidates = [...direct, ...allCandidates].filter(
    (candidate) => candidate.sourceQuality?.tier !== 'low',
  );
  const netNew = [];
  const localNetNew = new Set();
  const netNewCandidates = [...preferredCandidates, ...direct, ...allCandidates];
  for (const candidate of netNewCandidates) {
    if (allocatedNetNewOwner.has(candidate.url) || localNetNew.has(candidate.url)) continue;
    const domain = normalizeDomain(candidate.url);
    if (!domain || allocatedNetNewDomains.has(domain)) continue;
    netNew.push(candidate);
    localNetNew.add(candidate.url);
    if (netNew.length >= chapter.evidenceTarget.minNetNewSources) break;
  }
  for (const candidate of netNewCandidates) {
    if (netNew.length >= chapter.evidenceTarget.minNetNewSources) break;
    if (allocatedNetNewOwner.has(candidate.url) || localNetNew.has(candidate.url)) continue;
    netNew.push(candidate);
    localNetNew.add(candidate.url);
  }
  for (const candidate of netNew) {
    allocatedNetNewOwner.set(candidate.url, chapter.key);
    const domain = normalizeDomain(candidate.url);
    if (domain) allocatedNetNewDomains.add(domain);
  }
  netNewByChapter.set(chapter.key, netNew);
}

const chapterPools = plan.chapters.map((chapter) => {
  const direct = directByChapter.get(chapter.key) ?? [];
  const netNew = netNewByChapter.get(chapter.key) ?? [];
  const availableToChapter = (candidate) => {
    const owner = allocatedNetNewOwner.get(candidate.url);
    return !owner || owner === chapter.key;
  };
  const selected = new Map(
    netNew.map((candidate) => [candidate.url, { ...candidate, allocation: 'net-new' }]),
  );
  const directFill = direct
    .filter((candidate) => candidate.sourceQuality?.tier !== 'low' && availableToChapter(candidate))
    .map((candidate) => ({ ...candidate, allocation: 'chapter' }));
  const sharedFill = globalCandidates
    .filter((candidate) => candidate.sourceQuality?.tier !== 'low' && availableToChapter(candidate))
    .map((candidate) => ({ ...candidate, allocation: 'shared' }));
  const otherFill = allCandidates
    .filter((candidate) => candidate.sourceQuality?.tier !== 'low' && availableToChapter(candidate))
    .map((candidate) => ({ ...candidate, allocation: 'reserve' }));
  const lowSignalFill = [];
  const domainFill = [
    ...directFill,
    ...sharedFill,
    ...otherFill,
    ...lowSignalFill,
  ];
  const sourceFill = [
    ...sharedFill,
    ...directFill,
    ...otherFill,
    ...lowSignalFill,
  ];
  const reserveFill = [
    ...directFill,
    ...sharedFill,
    ...otherFill,
    ...lowSignalFill,
  ];
  const selectedDomains = new Set(
    [...selected.values()].map((candidate) => normalizeDomain(candidate.url)).filter(Boolean),
  );
  for (const candidate of domainFill) {
    if (selectedDomains.size >= chapter.evidenceTarget.minDomains) break;
    const domain = normalizeDomain(candidate.url);
    if (!domain || selectedDomains.has(domain) || selected.has(candidate.url)) continue;
    selected.set(candidate.url, candidate);
    selectedDomains.add(domain);
  }
  const minExternalCandidates = Math.ceil(chapter.evidenceTarget.minSources / 2);
  const externalFill = [
    ...directFill,
    ...sharedFill,
    ...otherFill,
  ].filter((candidate) => !isOfficialCandidate(candidate));
  for (const candidate of externalFill) {
    const selectedExternal = [...selected.values()].filter(
      (entry) => !isOfficialCandidate(entry),
    ).length;
    if (selectedExternal >= minExternalCandidates) break;
    if (!selected.has(candidate.url)) {
      selected.set(candidate.url, {
        ...candidate,
        allocation: 'independent-candidate',
      });
    }
  }
  for (const candidate of sourceFill) {
    if (selected.size >= chapter.evidenceTarget.minSources) break;
    if (!selected.has(candidate.url)) selected.set(candidate.url, candidate);
  }
  const reserveCandidates = reserveFill
    .filter((candidate) => !selected.has(candidate.url));
  const reserve = [];
  const reserveDomains = new Set(selectedDomains);
  for (const candidate of reserveCandidates) {
    const domain = normalizeDomain(candidate.url);
    if (!domain || reserveDomains.has(domain)) continue;
    reserve.push(candidate);
    reserveDomains.add(domain);
    if (reserve.length >= 6) break;
  }
  for (const candidate of reserveCandidates) {
    if (reserve.length >= 6) break;
    if (reserve.some((entry) => entry.url === candidate.url)) continue;
    reserve.push(candidate);
  }
  return {
    key: chapter.key,
    evidenceTarget: chapter.evidenceTarget,
    recommended: [...selected.values()],
    reserve,
    recommendedDomains: new Set(
      [...selected.values()].map((candidate) => normalizeDomain(candidate.url)).filter(Boolean),
    ).size,
  };
});

for (const pool of chapterPools) {
  for (const candidate of [...pool.recommended, ...pool.reserve]) {
    const owner = allocatedNetNewOwner.get(candidate.url);
    if (owner && owner !== pool.key) {
      throw new Error(`[execute-search-plan] net-new URL reserved for ${owner} leaked into ${pool.key}: ${candidate.url}`);
    }
  }
}

function poolDomainCounts() {
  const counts = new Map();
  for (const pool of chapterPools) {
    for (const candidate of pool.recommended) {
      const domain = normalizeDomain(candidate.url);
      if (domain) counts.set(domain, (counts.get(domain) ?? 0) + 1);
    }
  }
  return counts;
}

const reportDomainTarget = plan.strategy.reportEvidenceTarget?.minDistinctDomains ?? 0;
const chapterQueryIds = new Map(
  plan.chapters.map((chapter) => [
    chapter.key,
    new Set(chapter.queries.map((query) => query.id)),
  ]),
);
for (const candidate of allCandidates
  .filter((entry) => (
    entry.sourceQuality?.tier !== 'low'
    && !allocatedNetNewOwner.has(entry.url)
  ))
  .sort((left, right) => (
    (right.sourceQuality?.score ?? 0) - (left.sourceQuality?.score ?? 0)
  ))) {
  const domainCounts = poolDomainCounts();
  if (domainCounts.size >= reportDomainTarget) break;
  const candidateDomain = normalizeDomain(candidate.url);
  if (!candidateDomain || domainCounts.has(candidateDomain)) continue;
  const matchingPools = chapterPools.filter((pool) => {
    const ids = chapterQueryIds.get(pool.key) ?? new Set();
    return candidate.discoveredBy?.some((id) => ids.has(id));
  });
  const pools = matchingPools.length ? matchingPools : chapterPools;
  let replaced = false;
  for (const pool of pools) {
    if (pool.recommended.some((entry) => entry.url === candidate.url)) continue;
    const replaceIndex = pool.recommended
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => (
        entry.allocation !== 'net-new'
        && (domainCounts.get(normalizeDomain(entry.url)) ?? 0) > 1
      ))
      .sort((left, right) => (
        (left.entry.sourceQuality?.score ?? 0) - (right.entry.sourceQuality?.score ?? 0)
      ))[0]?.index;
    if (replaceIndex === undefined) continue;
    pool.recommended[replaceIndex] = {
      ...candidate,
      allocation: 'report-diversity',
    };
    pool.recommendedDomains = new Set(
      pool.recommended.map((entry) => normalizeDomain(entry.url)).filter(Boolean),
    ).size;
    replaced = true;
    break;
  }
  if (!replaced) continue;
}

if (args.profile === 'fast') {
  for (const pool of chapterPools) {
    const lowSignalUrls = pool.recommended
      .filter((candidate) => candidate.sourceQuality?.tier === 'low')
      .map((candidate) => candidate.url);
    if (lowSignalUrls.length > 0) {
      throw new Error(
        `fast profile assigned low-signal evidence to ${pool.key}: ${lowSignalUrls.join(', ')}`,
      );
    }
  }
}

const fetchedSources = [];
let recoveryPrefetchCount = 0;
if (args.prefetch) {
  const fetchDir = resolve('.research-cache', basename(folder), 'fetched');
  const fetchLog = process.env.STARTUP_FETCH_LOG_PATH
    || resolve('.research-cache', basename(folder), '_fetch-log.jsonl');
  await mkdir(fetchDir, { recursive: true });
  const fetchCandidates = async (targets) => runPool(
    targets,
    args.fetchConcurrency,
    async ({ candidate, chapters }) => {
      const file = join(
        fetchDir,
        `${createHash('sha256').update(candidate.url).digest('hex').slice(0, 16)}.txt`,
      );
      try {
        const result = await execFileAsync(process.execPath, [
          fetchScript,
          candidate.url,
          '--json',
          '--out',
          file,
        ], {
          env: { ...process.env, STARTUP_FETCH_LOG_PATH: fetchLog },
          maxBuffer: 10 * 1024 * 1024,
        });
        const response = JSON.parse(result.stdout);
        return {
          url: candidate.url,
          chapters,
          ok: response.ok === true,
          status: response.status,
          finalUrl: response.finalUrl,
          title: response.title,
          source: response.source,
          outputFile: response.outputFile?.path ?? file,
          elapsedMs: response.elapsedMs,
        };
      } catch (error) {
        return {
          url: candidate.url,
          chapters,
          ok: false,
          status: null,
          error: String(error.stderr || error.message || error).trim(),
        };
      }
    },
  );
  const byUrl = new Map();
  for (const pool of chapterPools) {
    for (const candidate of pool.recommended) {
      if (!byUrl.has(candidate.url)) {
        byUrl.set(candidate.url, { candidate, chapters: [] });
      }
      byUrl.get(candidate.url).chapters.push(pool.key);
    }
  }
  const fetchTargets = [...byUrl.values()];
  const fetched = await fetchCandidates(fetchTargets);
  fetchedSources.push(...fetched);
  const fetchedByUrl = new Map(fetchedSources.map((entry) => [entry.url, entry]));
  const recoveryByUrl = new Map();
  for (const pool of chapterPools) {
    const successfulCandidates = pool.recommended.filter(
      (candidate) => fetchedByUrl.get(candidate.url)?.ok,
    );
    const successfulDomains = new Set(
      successfulCandidates.map((candidate) => normalizeDomain(candidate.url)).filter(Boolean),
    );
    const needsRecovery = (
      successfulCandidates.length < pool.evidenceTarget.minSources
      || successfulDomains.size < pool.evidenceTarget.minDomains
    );
    if (!needsRecovery) continue;
    for (const candidate of pool.reserve.filter((entry) => entry.sourceQuality?.tier !== 'low')) {
      if (!recoveryByUrl.has(candidate.url)) {
        recoveryByUrl.set(candidate.url, { candidate, chapters: [] });
      }
      recoveryByUrl.get(candidate.url).chapters.push(pool.key);
    }
  }
  const recoveryTargets = [...recoveryByUrl.values()]
    .filter(({ candidate }) => !fetchedByUrl.has(candidate.url));
  if (recoveryTargets.length > 0) {
    const recoveryFetched = await fetchCandidates(recoveryTargets);
    recoveryPrefetchCount = recoveryFetched.length;
    fetchedSources.push(...recoveryFetched);
    for (const entry of recoveryFetched) fetchedByUrl.set(entry.url, entry);
  }
  for (const pool of chapterPools) {
    const promoted = [];
    let successful = pool.recommended.filter(
      (candidate) => fetchedByUrl.get(candidate.url)?.ok,
    ).length;
    const successfulDomains = new Set(
      pool.recommended
        .filter((candidate) => fetchedByUrl.get(candidate.url)?.ok)
        .map((candidate) => normalizeDomain(candidate.url))
        .filter(Boolean),
    );
    for (const candidate of pool.reserve) {
      if (
        successful >= pool.evidenceTarget.minSources
        && successfulDomains.size >= pool.evidenceTarget.minDomains
      ) break;
      if (!fetchedByUrl.get(candidate.url)?.ok) continue;
      const domain = normalizeDomain(candidate.url);
      const addsNeededDomain = (
        successfulDomains.size < pool.evidenceTarget.minDomains
        && domain
        && !successfulDomains.has(domain)
      );
      if (successful >= pool.evidenceTarget.minSources && !addsNeededDomain) continue;
      promoted.push({
        ...candidate,
        allocation: 'reserve-recovery',
      });
      successful += 1;
      if (domain) successfulDomains.add(domain);
    }
    const promotedUrls = new Set(promoted.map((candidate) => candidate.url));
    pool.reserve = pool.reserve.filter((candidate) => !promotedUrls.has(candidate.url));
    pool.recommended.push(...promoted);
    pool.fetchedOk = pool.recommended.filter(
      (candidate) => fetchedByUrl.get(candidate.url)?.ok,
    ).length;
    pool.fetchedDomains = new Set(
      pool.recommended
        .filter((candidate) => fetchedByUrl.get(candidate.url)?.ok)
        .map((candidate) => normalizeDomain(candidate.url))
        .filter(Boolean),
    ).size;
    pool.recommended = pool.recommended.map((candidate) => ({
      ...candidate,
      fetch: fetchedByUrl.get(candidate.url) ?? null,
    }));
    pool.recommendedDomains = new Set(
      pool.recommended.map((candidate) => normalizeDomain(candidate.url)).filter(Boolean),
    ).size;
  }
}

const bundle = {
  schemaVersion: 'startup-search-bundle-v1',
  generatedAt: new Date().toISOString(),
  plan,
  stats: {
    queryCount: searches.length,
    successfulQueryCount: searches.filter((search) => search.response).length,
    failedQueryCount: searches.filter((search) => !search.response).length,
    rejectedIrrelevantCount,
    uniqueUrlCount: candidates.size,
    cacheHits: searches.filter((search) => search.response?.cache?.hit).length,
    aggregateSearchDurationMs: searches.reduce((total, search) => total + search.durationMs, 0),
    prefetchedUrlCount: fetchedSources.length,
    successfulPrefetchCount: fetchedSources.filter((source) => source.ok).length,
    recoveryPrefetchCount,
  },
  searches,
  failures: searches
    .filter((search) => !search.response)
    .map(({ id, scope, chapter, intent, query, attempts, providersTried, error }) => ({
      id,
      scope,
      chapter,
      intent,
      query,
      attempts,
      providersTried,
      error,
    })),
  chapterPools,
  fetchedSources,
  candidates: [...candidates.values()],
};
const out = resolve(args.out || join('.research-cache', basename(folder), 'search-bundle.json'));
await mkdir(dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(bundle, null, 2)}\n`);
console.log(JSON.stringify({
  out,
  profile: args.profile,
  queryCount: bundle.stats.queryCount,
  uniqueUrlCount: bundle.stats.uniqueUrlCount,
  cacheHits: bundle.stats.cacheHits,
  failedQueryCount: bundle.stats.failedQueryCount,
  prefetchedUrlCount: bundle.stats.prefetchedUrlCount,
  successfulPrefetchCount: bundle.stats.successfulPrefetchCount,
}));

const globalFailure = bundle.failures.some((failure) => failure.scope === 'global');
const minimumSuccess = Math.ceil(queries.length * 0.8);
const insufficientPools = args.prefetch
  ? bundle.chapterPools.filter(
    (pool) => (
      pool.fetchedOk < pool.evidenceTarget.minSources
      || pool.fetchedDomains < pool.evidenceTarget.minDomains
    ),
  )
  : [];
if (insufficientPools.length > 0) {
  console.error(
    `[execute-search-plan] insufficient fetched evidence: ${
      insufficientPools
        .map((pool) => (
          `${pool.key} sources=${pool.fetchedOk}/${pool.evidenceTarget.minSources}`
          + ` domains=${pool.fetchedDomains}/${pool.evidenceTarget.minDomains}`
        ))
        .join(', ')
    }; inspect ${out}`,
  );
  process.exitCode = 1;
} else if (globalFailure || bundle.stats.successfulQueryCount < minimumSuccess) {
  console.error(`[execute-search-plan] insufficient discovery coverage: ${bundle.stats.successfulQueryCount}/${queries.length} queries succeeded; inspect ${out}`);
  process.exitCode = 1;
} else if (bundle.failures.length) {
  console.error(`[execute-search-plan] warning: ${bundle.failures.length} chapter query failed after retries; continuing with ${bundle.stats.uniqueUrlCount} explicit candidates. Inspect ${out}.`);
}
