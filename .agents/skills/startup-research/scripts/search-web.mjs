#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import yaml from 'js-yaml';
import {
  EXIT,
  isRunId,
  researchCacheDir,
} from './utils.mjs';

const strategy = yaml.load(readFileSync(resolve('.agents/skills/startup-research/references/search-strategy.yaml'), 'utf8'));

function usage(code = EXIT.ok) {
  console.error('Usage: search-web.mjs --report-folder <path> --query <text> [--intent broad|freshness|primary|semantic|adverse] [--provider auto|anysearch|brave|tavily|exa] [--official-domain <domain>] [--max-results <1-10>] [--freshness <pd|pw|pm|py|YYYY-MM-DDtoYYYY-MM-DD>] [--no-cache]');
  process.exit(code);
}

function parseArgs(argv) {
  const args = { folder: '', query: '', intent: 'broad', provider: 'auto', officialDomain: '', maxResults: 10, freshness: '', noCache: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--report-folder') args.folder = argv[++i] ?? '';
    else if (arg === '--query') args.query = argv[++i] ?? '';
    else if (arg === '--intent') args.intent = argv[++i] ?? '';
    else if (arg === '--provider') args.provider = argv[++i] ?? '';
    else if (arg === '--official-domain') args.officialDomain = argv[++i] ?? '';
    else if (arg === '--max-results') args.maxResults = Number(argv[++i]);
    else if (arg === '--freshness') args.freshness = argv[++i] ?? '';
    else if (arg === '--no-cache') args.noCache = true;
    else if (arg === '-h' || arg === '--help') usage();
    else usage(EXIT.failure);
  }
  if (!args.folder || !args.query || !Number.isInteger(args.maxResults) || args.maxResults < 1 || args.maxResults > 10) usage(EXIT.failure);
  if (!strategy.routing[args.intent]) usage(EXIT.failure);
  if (!['auto', ...Object.keys(strategy.providers)].includes(args.provider)) usage(EXIT.failure);
  return args;
}

const highReputationDomains = new Set([
  'bloomberg.com',
  'ft.com',
  'jpmorgan.com',
  'reuters.com',
  'sec.gov',
  'techcrunch.com',
  'wsj.com',
]);
const lowSignalDomains = new Set([
  'facebook.com',
  'instagram.com',
  'tiktok.com',
  'youtube.com',
]);

function hostname(value) {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return ''; }
}

function sourceQuality(result, args) {
  const domain = hostname(result.url);
  let score = 0;
  const reasons = [];
  const official = args.officialDomain.toLowerCase().replace(/^www\./, '');
  if (official && (domain === official || domain.endsWith(`.${official}`))) {
    score += 40;
    reasons.push('official-domain');
  }
  if (domain.endsWith('.gov') || domain.endsWith('.gov.uk') || domain === 'sec.gov') {
    score += 35;
    reasons.push('government-or-regulator');
  }
  if (highReputationDomains.has(domain)) {
    score += 20;
    reasons.push('high-reputation-publisher');
  }
  if (lowSignalDomains.has(domain)) {
    score -= 25;
    reasons.push('low-signal-platform');
  }
  if ((result.content ?? result.snippet ?? '').length >= 200) {
    score += 5;
    reasons.push('substantive-preview');
  }
  const year = basename(resolve(args.folder)).slice(0, 4);
  if (`${result.title} ${result.snippet} ${result.content}`.includes(year)) {
    score += 5;
    reasons.push('current-run-year');
  }
  return {
    score,
    tier: score >= 25 ? 'high' : score >= 0 ? 'medium' : 'low',
    reasons,
  };
}

function providerAvailable(provider) {
  const config = strategy.providers[provider];
  return config.supportsAnonymous || Boolean(process.env[config.env]);
}

function selectProvider(args) {
  if (args.provider !== 'auto') {
    if (!providerAvailable(args.provider)) {
      throw new Error(`${args.provider} requires ${strategy.providers[args.provider].env}`);
    }
    return args.provider;
  }
  const provider = strategy.routing[args.intent].find(providerAvailable);
  if (!provider) throw new Error(`no configured provider is available for intent ${args.intent}`);
  return provider;
}

async function requestJson(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 500) }; }
  if (!response.ok) {
    const requestId = body?.request_id ?? body?.requestId ?? response.headers.get('x-request-id');
    throw new Error(`HTTP ${response.status}${requestId ? ` requestId=${requestId}` : ''}: ${body?.message ?? body?.error ?? 'search failed'}`);
  }
  return body;
}

async function searchAnysearch(args) {
  const headers = { 'content-type': 'application/json' };
  if (process.env.ANYSEARCH_API_KEY) headers.authorization = `Bearer ${process.env.ANYSEARCH_API_KEY}`;
  const body = await requestJson('https://api.anysearch.com/v1/search', {
    method: 'POST',
    headers,
    body: JSON.stringify({ query: args.query, max_results: args.maxResults, format: 'json' }),
  });
  return {
    requestId: body.request_id ?? null,
    results: (body.data?.results ?? []).map((item) => ({
      title: item.title ?? '',
      url: item.url,
      snippet: item.snippet ?? '',
      content: item.content ?? null,
      publishedDate: null,
      score: null,
    })),
    metadata: body.data?.metadata ?? {},
  };
}

async function searchBrave(args) {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', args.query);
  url.searchParams.set('count', String(args.maxResults));
  url.searchParams.set('extra_snippets', 'true');
  if (args.freshness) url.searchParams.set('freshness', args.freshness);
  const body = await requestJson(url, {
    headers: {
      accept: 'application/json',
      'x-subscription-token': process.env.BRAVE_SEARCH_API_KEY,
    },
  });
  return {
    requestId: body.request_id ?? null,
    results: (body.web?.results ?? []).map((item) => ({
      title: item.title ?? '',
      url: item.url,
      snippet: [item.description, ...(item.extra_snippets ?? [])].filter(Boolean).join('\n'),
      content: null,
      publishedDate: item.page_age ?? null,
      score: null,
    })),
    metadata: { moreResultsAvailable: body.query?.more_results_available ?? false },
  };
}

async function searchTavily(args) {
  const body = await requestJson('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      query: args.query,
      max_results: args.maxResults,
      search_depth: args.intent === 'semantic' ? 'advanced' : 'basic',
      include_raw_content: false,
    }),
  });
  return {
    requestId: body.request_id ?? body.id ?? null,
    results: (body.results ?? []).map((item) => ({
      title: item.title ?? '',
      url: item.url,
      snippet: item.content ?? '',
      content: item.raw_content ?? null,
      publishedDate: item.published_date ?? null,
      score: item.score ?? null,
    })),
    metadata: { responseTime: body.response_time ?? null, usage: body.usage ?? null },
  };
}

async function searchExa(args) {
  const body = await requestJson('https://api.exa.ai/search', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.EXA_API_KEY,
    },
    body: JSON.stringify({
      query: args.query,
      numResults: args.maxResults,
      type: args.intent === 'semantic' ? 'deep-lite' : 'auto',
      contents: { highlights: { maxCharacters: 1200 } },
    }),
  });
  return {
    requestId: body.requestId ?? null,
    results: (body.results ?? []).map((item) => ({
      title: item.title ?? '',
      url: item.url,
      snippet: (item.highlights ?? []).join('\n'),
      content: item.text ?? null,
      publishedDate: item.publishedDate ?? null,
      score: item.score ?? null,
    })),
    metadata: { costDollars: body.costDollars ?? null, searchTime: body.searchTime ?? null },
  };
}

const args = parseArgs(process.argv.slice(2));
const runId = basename(resolve(args.folder));
if (!isRunId(runId)) {
  console.error(`[search-web] report folder must end in a valid runId: ${args.folder}`);
  process.exit(EXIT.failure);
}
let provider;
try {
  provider = selectProvider(args);
} catch (err) {
  console.error(`[search-web] ${err.message}`);
  process.exit(EXIT.failure);
}
const cacheDir = join(researchCacheDir(runId), 'search-results');
mkdirSync(cacheDir, { recursive: true });
const cacheKey = createHash('sha256')
  .update(JSON.stringify({ provider, query: args.query, intent: args.intent, officialDomain: args.officialDomain, maxResults: args.maxResults, freshness: args.freshness }))
  .digest('hex')
  .slice(0, 20);
const cachePath = join(cacheDir, `${cacheKey}.json`);
if (!args.noCache && existsSync(cachePath)) {
  const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
  const ageMs = Date.now() - Date.parse(cached.fetchedAt);
  if (ageMs < strategy.budgets.cacheTtlHours * 3_600_000) {
    console.log(JSON.stringify({ ...cached, cache: 'hit' }, null, 2));
    process.exit(EXIT.ok);
  }
}
const searchers = {
  anysearch: searchAnysearch,
  brave: searchBrave,
  tavily: searchTavily,
  exa: searchExa,
};
try {
  const startedAt = Date.now();
  const response = await searchers[provider](args);
  const rankedResults = response.results
    .map((result) => ({ ...result, sourceQuality: sourceQuality(result, args) }))
    .sort((a, b) => b.sourceQuality.score - a.sourceQuality.score);
  const output = {
    schemaVersion: 'startup-search-result-v1',
    provider,
    intent: args.intent,
    query: args.query,
    fetchedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    requestId: response.requestId,
    results: rankedResults,
    metadata: response.metadata,
    cache: 'miss',
    evidenceRule: 'Fetch retained URLs with fetch-url before adding them to localEvidence.sources.',
  };
  writeFileSync(cachePath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(output, null, 2));
} catch (err) {
  console.error(`[search-web] ${provider} failed: ${err.message}`);
  process.exit(EXIT.failure);
}
